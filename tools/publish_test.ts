import { assertEquals } from "@std/assert";
import { hashPackage, readCatalog, writeCatalog } from "./lib/catalog.ts";
import { PUBLIC_REPOSITORY, STEPS } from "./gate.ts";
import { type GateStepRecord, type Io, notifyDecision, observation, type PushOutcome, type RegistryInfo, runPublish } from "./publish.ts";

async function git(dir: string, ...args: string[]) {
  const r = await new Deno.Command("git", { args: ["-C", dir, ...args], stdout: "null", stderr: "piped" }).output();
  if (!r.success) throw new Error(new TextDecoder().decode(r.stderr));
}

/** A two-package catalog repo. `changed` packages get an edit after their hash was recorded. */
const temps: string[] = [];
globalThis.addEventListener("unload", () => {
  for (const d of temps) Deno.removeSync(d, { recursive: true });
});

async function fixture(changed: string[]): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "ext-publish-test-" });
  temps.push(root);
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.email", "t@example.org");
  await git(root, "config", "user.name", "t");
  const packages = [];
  for (const short of ["alpha", "beta"]) {
    const dir = `${root}/packages/${short}`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(`${dir}/manifest.yaml`, `manifestVersion: 1\nname: "@mgreten/${short}"\nversion: "2026.10.14.1"\nrepository: "${PUBLIC_REPOSITORY}"\nmodels:\n  - ${short}.ts\n`);
    await Deno.writeTextFile(`${dir}/${short}.ts`, "export const v = 1;\n");
    packages.push({ name: `@mgreten/${short}`, path: `packages/${short}`, manifest: `packages/${short}/manifest.yaml`, version: "2026.10.14.1", contentHash: "", tests: "deterministic", dependsOn: [], source: { repo: "x", ref: "y" } });
  }
  await Deno.writeTextFile(`${root}/catalog.yaml`, "");
  await git(root, "add", "-A");
  const catalog = { schemaVersion: 1 as const, visibility: "public" as const, scope: "@mgreten", publish: "registry" as const, packages };
  for (const p of catalog.packages) p.contentHash = await hashPackage(root, p.path, p.manifest);
  await writeCatalog(root, catalog as never);
  for (const short of changed) await Deno.writeTextFile(`${root}/packages/${short}/${short}.ts`, "export const v = 2;\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "fixture");
  return root;
}

async function greenGate(root: string, red: Record<string, string> = {}): Promise<GateStepRecord[]> {
  const c = await readCatalog(root);
  const records: GateStepRecord[] = [];
  for (const step of STEPS) {
    const packages = await Promise.all(c.packages.map(async (p) => ({
      name: p.name,
      ok: red[p.name] !== step,
      detail: red[p.name] === step ? "red" : "ok",
      data: { contentHash: await hashPackage(root, p.path, p.manifest) },
    })));
    if (step === "privacy") packages.push({ name: "(repo commits)", ok: true, detail: "clean", data: { contentHash: "" } });
    records.push({ step, packages });
  }
  return records;
}

class FakeIo implements Io {
  pushes: Array<{ manifest: string; dryRun: boolean; version: string }> = [];
  commits: string[] = [];
  constructor(public registry: Record<string, RegistryInfo>, public outcomes: Record<string, PushOutcome> = {}) {}
  info(name: string) {
    return Promise.resolve(this.registry[name] ?? { latest: null, repository: null });
  }
  async push(root: string, manifest: string, _dir: string, dryRun: boolean) {
    const version = /^version: "(.*)"$/m.exec(await Deno.readTextFile(`${root}/${manifest}`))![1];
    this.pushes.push({ manifest, dryRun, version });
    const name = `@mgreten/${manifest.split("/")[1]}`;
    const o = this.outcomes[name] ?? { kind: "pushed" };
    if (o.kind === "pushed" && !dryRun) this.registry[name] = { latest: version, repository: PUBLIC_REPOSITORY };
    return o;
  }
  autoPushes: string[][] = [];
  commit(_root: string, _paths: string[], message: string) {
    this.commits.push(message.split("\n")[0]);
    return Promise.resolve(`sha-${this.commits.length}`);
  }
  autoPush(_root: string, runShas: string[]) {
    this.autoPushes.push(runShas);
    return Promise.resolve({ status: "pushed" as const, detail: "ok", originBefore: "a", headAfter: "b", commits: runShas.length });
  }
  async scratch(root: string) {
    const dir = await Deno.makeTempDir();
    await new Deno.Command("cp", { args: ["-R", `${root}/.`, dir] }).output();
    return { dir, dispose: () => Deno.remove(dir, { recursive: true }) };
  }
  clean() {
    return Promise.resolve(true);
  }
}

const reg = (latest: string) => ({ latest, repository: PUBLIC_REPOSITORY });
const base = { today: "2026-11-01", now: "2026-11-01T07:00:00Z", gateRunId: "run-1", observationStart: "2026-11-01", previous: null, clearUnknown: false };

Deno.test("disabled: changed package is built at its next version in a scratch copy, never pushed live", async () => {
  const root = await fixture(["alpha"]);
  const io = new FakeIo({ "@mgreten/alpha": reg("2026.10.14.1"), "@mgreten/beta": reg("2026.10.14.1") });
  const r = await runPublish({ ...base, root, enabled: false, gate: await greenGate(root), io });
  assertEquals(r.mode, "dry-run");
  assertEquals(r.packages.map((p) => [p.name, p.outcome, p.version]), [
    ["@mgreten/alpha", "ready-awaiting-activation", "2026.11.01.1"],
    ["@mgreten/beta", "no-op", "2026.10.14.1"],
  ]);
  assertEquals(io.pushes, [{ manifest: "packages/alpha/manifest.yaml", dryRun: true, version: "2026.11.01.1" }]);
  assertEquals(io.commits, []);
  // The real checkout is untouched.
  assertEquals((await readCatalog(root)).packages[0].version, "2026.10.14.1");
  assertEquals([r.ok, r.notify, r.readyAwaitingActivation], [true, true, ["@mgreten/alpha@2026.11.01.1"]]);
});

Deno.test("live: publishes, commits the bump, verifies; a second run is a no-op", async () => {
  const root = await fixture(["alpha"]);
  const io = new FakeIo({ "@mgreten/alpha": reg("2026.10.14.1"), "@mgreten/beta": reg("2026.10.14.1") });
  const r1 = await runPublish({ ...base, root, enabled: true, gate: await greenGate(root), io });
  assertEquals(r1.packages[0].outcome, "published");
  assertEquals(io.commits, ["release(alpha): @mgreten/alpha 2026.11.01.1"]);
  assertEquals((await readCatalog(root)).packages[0].version, "2026.11.01.1");
  // Same content, version now in the registry: nothing to push.
  const r2 = await runPublish({ ...base, root, enabled: true, gate: await greenGate(root), io });
  assertEquals(r2.packages.map((p) => p.outcome), ["no-op", "no-op"]);
  assertEquals(io.pushes.length, 1);
  // Only the first run made a release commit, so only it auto-pushes.
  assertEquals(io.autoPushes, [["sha-1"]]);
  assertEquals([r1.autoPush?.status, r2.autoPush], ["pushed", null]);
});

Deno.test("unknown push outcome stops the run and halts later runs until the registry confirms", async () => {
  const root = await fixture(["alpha", "beta"]);
  const io = new FakeIo({ "@mgreten/alpha": reg("2026.10.14.1"), "@mgreten/beta": reg("2026.10.14.1") }, { "@mgreten/alpha": { kind: "unknown", detail: "timeout" } });
  const r1 = await runPublish({ ...base, root, enabled: true, gate: await greenGate(root), io });
  assertEquals(r1.packages.map((p) => p.outcome), ["unknown", "skipped-after-stop"]);
  assertEquals([r1.ok, r1.notify, r1.unknown?.version], [false, true, "2026.11.01.1"]);
  assertEquals(io.pushes.length, 1);

  // Next run: registry still does not show it, so nothing is pushed (no retry).
  const r2 = await runPublish({ ...base, now: "2026-11-01T11:00:00Z", root, enabled: true, gate: await greenGate(root), io, previous: r1 });
  assertEquals(r2.packages.map((p) => p.outcome), ["halted-unknown", "halted-unknown"]);
  assertEquals([io.pushes.length, r2.notify], [1, false]); // deduped within 24 h

  // The push had in fact landed: the run resolves it and carries on with beta only.
  io.registry["@mgreten/alpha"] = reg("2026.11.01.1");
  const r3 = await runPublish({ ...base, now: "2026-11-01T15:00:00Z", root, enabled: true, gate: await greenGate(root), io, previous: r2 });
  assertEquals(r3.packages.map((p) => p.outcome), ["no-op", "published"]);
});

Deno.test("red gate or definite push failure blocks; later packages are not pushed", async () => {
  const root = await fixture(["alpha", "beta"]);
  const io = new FakeIo({ "@mgreten/alpha": reg("2026.10.14.1"), "@mgreten/beta": reg("2026.10.14.1") }, { "@mgreten/alpha": { kind: "failed", detail: "quality" } });
  const red = await runPublish({ ...base, root, enabled: true, gate: await greenGate(root, { "@mgreten/beta": "tests" }), io });
  assertEquals(red.packages.map((p) => p.outcome), ["failed", "blocked-gate"]);
  assertEquals(io.pushes.length, 1);
  // The failed package's release commit exists locally but is never pushed to git.
  assertEquals(io.autoPushes, []);
  assertEquals(red.autoPush?.status, "skipped");
  assertEquals(red.ok, false);
});

Deno.test("gate results from another run or missing steps publish nothing", async () => {
  const root = await fixture(["alpha"]);
  const io = new FakeIo({});
  const r = await runPublish({ ...base, root, enabled: true, gate: (await greenGate(root)).slice(0, 3), io });
  assertEquals([r.ok, r.packages.length, io.pushes.length], [false, 0, 0]);
});

Deno.test("notifyDecision dedupes the same signature for 24 h and notifies on change", () => {
  const first = notifyDecision(null, "ready:a@1", "2026-11-01T01:00:00Z");
  assertEquals(first.notify, true);
  assertEquals(notifyDecision(first, "ready:a@1", "2026-11-01T21:00:00Z").notify, false);
  assertEquals(notifyDecision(first, "ready:a@1", "2026-11-02T01:00:00Z").notify, true);
  assertEquals(notifyDecision(first, "ready:a@1|ready:b@1", "2026-11-01T05:00:00Z").notify, true);
  assertEquals(notifyDecision(first, "", "2026-11-01T05:00:00Z").notify, false);
});

Deno.test("observation counts green days from the later of start and streak; red resets", () => {
  assertEquals(observation(null, true, "2026-11-01", "2026-11-01"), { greenSince: "2026-11-01", observationDays: 0, a7Eligible: false });
  assertEquals(observation({ greenSince: "2026-11-01" }, true, "2026-11-08", "2026-11-01").a7Eligible, true);
  assertEquals(observation({ greenSince: "2026-11-01" }, true, "2026-11-07", "2026-11-01").a7Eligible, false);
  assertEquals(observation({ greenSince: "2026-11-01" }, false, "2026-11-08", "2026-11-01").greenSince, null);
  assertEquals(observation({ greenSince: "2026-10-20" }, true, "2026-11-05", "2026-11-01").observationDays, 4);
});
