/**
 * ext-publish: the stage after ext-gate. For each catalog package whose gate
 * results (from the same workflow run) are all green and whose content hash
 * changed, apply the CalVer bump, `swamp extension push`, then verify the
 * registry shows the version and the monorepo repository URL.
 *
 * Safety rules:
 *  - Live publishing needs `enabled` (the workflow's extPublishEnabled tag).
 *    Otherwise the run is a dry run: the bump is applied in a throwaway git
 *    worktree and only `swamp extension push --dry-run` runs there.
 *  - Idempotent: a version the registry already has is never pushed again.
 *  - An unknown push outcome (timeout, unparseable output) halts the run and
 *    every later run until the registry shows that version or a human passes
 *    clearUnknown. Nothing is retried automatically.
 *  - Any definite failure stops further pushes in the same run.
 *
 * The pure decision functions are exported for tests; I/O is injected.
 */
import { compareCalVer, decideVersion } from "./lib/calver.ts";
import { type Catalog, hashPackage, readCatalog, writeCatalog } from "./lib/catalog.ts";
import { applyRelease } from "./lib/release.ts";
import { type AutoPushResult, pushReleaseCommits } from "./lib/autopush.ts";
import { exec, PUBLIC_REPOSITORY, type PackageResult, STEPS } from "./gate.ts";

export type RegistryInfo = { latest: string | null; repository: string | null };
export type PushOutcome =
  | { kind: "pushed" }
  | { kind: "exists" }
  | { kind: "failed"; detail: string }
  | { kind: "unknown"; detail: string };

export interface Io {
  /** Read-only registry lookup; throws when the lookup itself fails. */
  info(name: string): Promise<RegistryInfo>;
  push(root: string, manifest: string, extensionsDir: string, dryRun: boolean): Promise<PushOutcome>;
  /** Live mode only: commit the version bump in root; returns the new commit SHA. */
  commit(root: string, paths: string[], message: string): Promise<string>;
  /** Live mode only: push exactly this run's release commits (lib/autopush.ts). */
  autoPush(root: string, runShas: string[]): Promise<AutoPushResult>;
  /** Dry-run mode: a disposable checkout of HEAD to apply bumps in. */
  scratch(root: string): Promise<{ dir: string; dispose: () => Promise<void> }>;
  clean(root: string): Promise<boolean>;
}

export interface UnknownOutcome {
  name: string;
  version: string;
  detail: string;
  at: string;
}

export interface Previous {
  greenSince?: string | null;
  lastNotifiedAt?: string | null;
  lastNotifiedSignature?: string | null;
  unknown?: UnknownOutcome | null;
}

export type Outcome =
  | "no-op"
  | "blocked-gate"
  | "drift"
  | "ready-awaiting-activation"
  | "published"
  | "already-published"
  | "failed"
  | "unknown"
  | "skipped-after-stop"
  | "halted-unknown";

export interface PackageRun {
  name: string;
  failedSteps: string[];
  action: string;
  version: string;
  outcome: Outcome;
  detail: string;
}

export interface PublishRun {
  runAt: string;
  today: string;
  gateRunId: string;
  mode: "live" | "dry-run";
  ok: boolean;
  repoCommitsOk: boolean;
  packages: PackageRun[];
  readyAwaitingActivation: string[];
  failures: string[];
  unknown: UnknownOutcome | null;
  observationStart: string;
  greenSince: string | null;
  observationDays: number;
  a7Eligible: boolean;
  autoPush: AutoPushResult | null;
  signature: string;
  notify: boolean;
  lastNotifiedAt: string | null;
  lastNotifiedSignature: string | null;
  title: string;
  message: string;
}

export interface GateStepRecord {
  step: string;
  packages: PackageResult[];
}

const DAY_MS = 86_400_000;

function days(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS);
}

/** Notify on a new or changed signature, then at most every 24 h while it persists. */
export function notifyDecision(prev: Previous | null, signature: string, now: string) {
  if (!signature) return { notify: false, lastNotifiedAt: null, lastNotifiedSignature: null };
  const same = prev?.lastNotifiedSignature === signature && !!prev?.lastNotifiedAt;
  if (same && Date.parse(now) - Date.parse(prev!.lastNotifiedAt!) < DAY_MS) {
    return { notify: false, lastNotifiedAt: prev!.lastNotifiedAt!, lastNotifiedSignature: signature };
  }
  return { notify: true, lastNotifiedAt: now, lastNotifiedSignature: signature };
}

/** Consecutive green runs; A7 can be proposed after 7 days green inside the observation window. */
export function observation(prev: Previous | null, green: boolean, today: string, observationStart: string) {
  const greenSince = green ? (prev?.greenSince ?? today) : null;
  const from = greenSince && greenSince > observationStart ? greenSince : observationStart;
  const observationDays = greenSince ? Math.max(0, days(from, today)) : 0;
  return { greenSince, observationDays, a7Eligible: observationDays >= 7 };
}

/** Index gate records by step then package; null when a step is missing. */
export function indexGate(records: GateStepRecord[]): Map<string, Map<string, PackageResult>> | string {
  const byStep = new Map<string, Map<string, PackageResult>>();
  for (const r of records) byStep.set(r.step, new Map(r.packages.map((p) => [p.name, p])));
  const missing = STEPS.filter((s) => !byStep.has(s));
  return missing.length ? `gate results missing for step(s) ${missing.join(", ")}` : byStep;
}

export interface PublishOptions {
  root: string;
  today: string;
  now: string;
  gateRunId: string;
  enabled: boolean;
  observationStart: string;
  gate: GateStepRecord[];
  previous: Previous | null;
  clearUnknown: boolean;
  io: Io;
}

export async function runPublish(o: PublishOptions): Promise<PublishRun> {
  const live = o.enabled;
  const packages: PackageRun[] = [];
  const failures: string[] = [];
  let unknown: UnknownOutcome | null = null;
  let stopped = false;
  let repoCommitsOk = true;
  const releaseShas: string[] = [];
  let autoPush: AutoPushResult | null = null;

  const finish = (): PublishRun => {
    const ready = packages.filter((p) => p.outcome === "ready-awaiting-activation").map((p) => `${p.name}@${p.version}`);
    const ok = failures.length === 0 && !unknown;
    const obs = observation(o.previous, ok, o.today, o.observationStart);
    // A skip caused by a failed run is already reported by that failure.
    const pushSkipped = autoPush?.status === "skipped" && failures.length === 0 && !unknown ? [`push-skipped:${autoPush.detail}`] : [];
    const sig = [...failures.map((f) => `fail:${f}`), ...(unknown ? [`unknown:${unknown.name}@${unknown.version}`] : []), ...ready.map((r) => `ready:${r}`), ...pushSkipped].sort().join("|");
    const n = notifyDecision(o.previous, sig, o.now);
    const title = unknown
      ? "ext-publish halted: unknown push outcome"
      : failures.length
      ? `ext-publish: ${failures.length} failure(s)`
      : pushSkipped.length
      ? "ext-publish: published, but git auto-push skipped"
      : `ext-publish: ${ready.length} package(s) ready, awaiting activation`;
    const lines = [
      ...(unknown ? [`UNKNOWN ${unknown.name}@${unknown.version}: ${unknown.detail}. Check the registry; rerun with clearUnknown after resolving.`] : []),
      ...failures.map((f) => `FAIL ${f}`),
      ...(ready.length ? [`Ready (extPublishEnabled is false): ${ready.join(", ")}`] : []),
      ...(pushSkipped.length ? [`Release commits not pushed: ${autoPush!.detail}. Push main by hand.`] : []),
      `Observation since ${o.observationStart}: ${obs.greenSince ? `${obs.observationDays} green day(s)` : "not green"}${obs.a7Eligible ? "; A7 can be proposed" : ""}.`,
    ];
    return {
      runAt: o.now,
      today: o.today,
      gateRunId: o.gateRunId,
      mode: live ? "live" : "dry-run",
      ok,
      repoCommitsOk,
      packages,
      autoPush,
      readyAwaitingActivation: ready,
      failures,
      unknown,
      observationStart: o.observationStart,
      ...obs,
      signature: sig,
      ...n,
      title,
      message: lines.join("\n"),
    };
  };

  // A previous unknown outcome blocks everything until resolved.
  if (o.previous?.unknown && !o.clearUnknown) {
    const u = o.previous.unknown;
    let resolved = false;
    try {
      const info = await o.io.info(u.name);
      resolved = info.latest === u.version && info.repository === PUBLIC_REPOSITORY;
    } catch { /* still unknown */ }
    if (!resolved) {
      unknown = u;
      const c = await readCatalog(o.root);
      for (const p of c.packages) packages.push({ name: p.name, failedSteps: [], action: "-", version: p.version, outcome: "halted-unknown", detail: `halted: unresolved unknown outcome for ${u.name}@${u.version}` });
      return finish();
    }
  }

  const gate = indexGate(o.gate);
  if (typeof gate === "string") {
    failures.push(`(gate): ${gate}`);
    return finish();
  }
  const repoCommits = gate.get("privacy")!.get("(repo commits)");
  if (repoCommits && !repoCommits.ok) {
    repoCommitsOk = false;
    failures.push(`(repo commits): ${repoCommits.detail}`);
    stopped = true; // never publish from a repo whose own history failed the scan
  }

  if (live && !await o.io.clean(o.root)) {
    failures.push("(repo): working tree not clean; live publish refuses to run");
    return finish();
  }
  const scratch = live ? null : await o.io.scratch(o.root);
  const workRoot = scratch?.dir ?? o.root;
  try {
    const catalog: Catalog = await readCatalog(workRoot);
    for (const p of catalog.packages) {
      const failedSteps = STEPS.filter((s) => gate.get(s)!.get(p.name)?.ok !== true);
      const run: PackageRun = { name: p.name, failedSteps, action: "-", version: p.version, outcome: "no-op", detail: "" };
      packages.push(run);
      if (failedSteps.length) {
        run.outcome = "blocked-gate";
        run.detail = failedSteps.map((s) => `${s}: ${gate.get(s)!.get(p.name)?.detail ?? "no result"}`).join("; ");
        failures.push(`${p.name}: gate ${failedSteps.join(",")}`);
        continue;
      }
      const hash = await hashPackage(workRoot, p.path, p.manifest);
      const gateHash = gate.get("version")!.get(p.name)?.data?.contentHash;
      if (gateHash !== hash) {
        run.outcome = "failed";
        run.detail = "stale gate result: content changed after the gate ran";
        failures.push(`${p.name}: stale gate result`);
        continue;
      }
      let info: RegistryInfo;
      try {
        info = await o.io.info(p.name);
      } catch (e) {
        run.outcome = "failed";
        run.detail = `registry lookup failed: ${(e as Error).message}`;
        failures.push(`${p.name}: registry lookup failed`);
        continue;
      }
      const d = decideVersion({ contentHash: hash, recordedHash: p.contentHash || null, currentVersion: p.version, registryLatest: info.latest, today: o.today });
      run.action = d.action;
      run.version = d.version;
      if (d.action === "drift") {
        run.outcome = "drift";
        run.detail = d.reason;
        failures.push(`${p.name}: drift`);
        continue;
      }
      if (d.action === "unchanged" || d.action === "baseline") {
        run.detail = d.reason;
        continue;
      }
      // release (content changed) or pending (bumped, not yet in registry).
      if (stopped) {
        run.outcome = "skipped-after-stop";
        run.detail = "an earlier failure stopped publishing in this run";
        continue;
      }
      if (info.latest !== null && compareCalVer(info.latest, d.version) >= 0) {
        // Registry already has this version (or newer): never push it again.
        run.outcome = info.latest === d.version && info.repository === PUBLIC_REPOSITORY ? "already-published" : "failed";
        run.detail = `registry latest ${info.latest}, repository ${info.repository}`;
        if (run.outcome === "failed") {
          failures.push(`${p.name}: registry ahead or wrong repository`);
          stopped = true;
        }
        continue;
      }
      if (d.action === "release") {
        await applyRelease(workRoot, catalog, p.name, d.version);
        await writeCatalog(workRoot, catalog);
        if (live) {
          releaseShas.push(await o.io.commit(workRoot, [p.manifest, "catalog.yaml"], `release(${p.path.split("/").pop()}): ${p.name} ${d.version}\n\nApplied by ext-publish (gate run ${o.gateRunId}).`));
        }
      }
      const outcome = await o.io.push(workRoot, p.manifest, p.path, !live);
      if (outcome.kind === "unknown") {
        unknown = { name: p.name, version: d.version, detail: outcome.detail, at: o.now };
        run.outcome = "unknown";
        run.detail = outcome.detail;
        stopped = true;
        continue;
      }
      if (outcome.kind === "failed") {
        run.outcome = "failed";
        run.detail = outcome.detail;
        failures.push(`${p.name}: push ${live ? "" : "--dry-run "}failed`);
        stopped = true;
        continue;
      }
      if (!live) {
        run.outcome = "ready-awaiting-activation";
        run.detail = `dry-run build ok at ${d.version}`;
        continue;
      }
      let after: RegistryInfo | null = null;
      try {
        after = await o.io.info(p.name);
      } catch { /* verification itself failed */ }
      if (after && after.latest === d.version && after.repository === PUBLIC_REPOSITORY) {
        run.outcome = outcome.kind === "pushed" ? "published" : "already-published";
        run.detail = `registry latest ${after.latest}`;
      } else {
        // The push said it worked (or already existed) but the registry does
        // not confirm it: that is an unknown outcome, not a retryable failure.
        unknown = { name: p.name, version: d.version, detail: `push ${outcome.kind} but registry shows ${after?.latest ?? "lookup failed"} / ${after?.repository ?? "-"}`, at: o.now };
        run.outcome = "unknown";
        run.detail = unknown.detail;
        stopped = true;
      }
    }
  } finally {
    await scratch?.dispose();
  }
  // Push this run's release commits only after a fully clean live run: a
  // failed or unknown registry push leaves a release commit for a version the
  // registry may not have, and that must not reach git unreviewed.
  if (live && releaseShas.length) {
    if (failures.length || unknown) {
      autoPush = { status: "skipped", detail: "run had failures or an unknown outcome", originBefore: null, headAfter: null, commits: releaseShas.length };
    } else {
      autoPush = await o.io.autoPush(o.root, releaseShas);
      if (autoPush.status === "failed") failures.push(`(auto-push): ${autoPush.detail}`);
    }
  }
  return finish();
}

/** Real I/O against git and the swamp CLI. */
export function realIo(swamp: string, pushTimeoutMs = 300_000): Io {
  const swampEnv = { DENO_TLS_CA_STORE: "mozilla" };
  return {
    async info(name) {
      const r = await exec([swamp, "extension", "info", name, "--json"], "/", swampEnv);
      if (r.code !== 0) {
        if (/not found|does not exist/i.test(r.stderr)) return { latest: null, repository: null };
        throw new Error((r.stderr.trim().split("\n").pop() ?? `exit ${r.code}`).slice(0, 200));
      }
      const j = JSON.parse(r.stdout);
      return { latest: j.latestVersion ?? null, repository: j.repository ?? null };
    },
    async push(root, manifest, extensionsDir, dryRun) {
      const args = ["extension", "push", manifest, "--extensions-dir", extensionsDir, "--yes", "--json"];
      if (dryRun) args.push("--dry-run");
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), pushTimeoutMs);
      let out: Deno.CommandOutput;
      try {
        out = await new Deno.Command(swamp, { args, cwd: root, stdout: "piped", stderr: "piped", env: swampEnv, signal: ac.signal }).output();
      } catch (e) {
        return { kind: "unknown", detail: `push did not complete: ${(e as Error).message}` };
      } finally {
        clearTimeout(timer);
      }
      if (out.signal) return { kind: "unknown", detail: `push killed by ${out.signal} (timeout ${pushTimeoutMs} ms)` };
      const stdout = new TextDecoder().decode(out.stdout);
      const stderr = new TextDecoder().decode(out.stderr);
      let status: string | undefined;
      try {
        status = JSON.parse(stdout).status;
      } catch { /* not JSON */ }
      let error: string | undefined;
      try {
        error = JSON.parse(stderr).error;
      } catch { /* not JSON */ }
      const expected = dryRun ? "dry_run" : "pushed";
      if (out.code === 0 && status === expected) return { kind: "pushed" };
      if (out.code !== 0 && error && /already exists/.test(error)) return dryRun ? { kind: "pushed" } : { kind: "exists" };
      // A definite, registry-side refusal before upload is a failure; anything
      // else (exit 0 with an odd status, unparseable output) is unknown.
      if (out.code !== 0 && error && (status === "blocked" || status === "failed" || status === "dry_run")) return { kind: "failed", detail: error.slice(0, 300) };
      return { kind: "unknown", detail: `exit ${out.code}, status ${status ?? "?"}, ${(error ?? stderr.trim().split("\n").pop() ?? "").slice(0, 200)}` };
    },
    async commit(root, paths, message) {
      for (const args of [["add", "--", ...paths], ["commit", "-q", "-m", message, "--", ...paths]]) {
        const r = await exec(["git", "-C", root, ...args], root);
        if (r.code !== 0) throw new Error(`git ${args[0]}: ${r.stderr.trim()}`);
      }
      return (await exec(["git", "-C", root, "rev-parse", "HEAD"], root)).stdout.trim();
    },
    autoPush(root, runShas) {
      return pushReleaseCommits(root, runShas);
    },
    async scratch(root) {
      const dir = await Deno.makeTempDir({ prefix: "ext-publish-" });
      const r = await exec(["git", "-C", root, "worktree", "add", "-q", "--detach", dir, "HEAD"], root);
      if (r.code !== 0) throw new Error(`git worktree add: ${r.stderr.trim()}`);
      return {
        dir,
        dispose: async () => {
          await exec(["git", "-C", root, "worktree", "remove", "--force", dir], root);
          await Deno.remove(dir, { recursive: true }).catch(() => {});
        },
      };
    },
    async clean(root) {
      return (await exec(["git", "-C", root, "status", "--porcelain"], root)).stdout.trim() === "";
    },
  };
}
