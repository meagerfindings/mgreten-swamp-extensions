import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { contentHash, decideVersion, nextCalVer } from "./calver.ts";

Deno.test("nextCalVer starts a new day at .1", () => {
  assertEquals(nextCalVer("2026-10-30", ["2026.10.14.2"]), "2026.10.30.1");
  assertEquals(nextCalVer("2026-10-30", [null]), "2026.10.30.1");
});

Deno.test("nextCalVer bumps N on the same day using numeric order", () => {
  // String sorting would pick .9 over .10 and return .10 again.
  assertEquals(
    nextCalVer("2026-10-30", ["2026.10.30.9", "2026.10.30.10"]),
    "2026.10.30.11",
  );
});

Deno.test("nextCalVer stays above a registry version dated after today", () => {
  assertEquals(nextCalVer("2026-10-30", ["2026.10.14.1", "2026.11.02.3"]), "2026.11.02.4");
});

Deno.test("nextCalVer rejects malformed input", () => {
  assertThrows(() => nextCalVer("2026-10-30", ["2026.10.30"]));
  assertThrows(() => nextCalVer("20261030", []));
});

const base = {
  contentHash: "sha256:new",
  currentVersion: "2026.10.14.1",
  registryLatest: "2026.10.14.1",
  today: "2026-10-30",
};

Deno.test("decideVersion: unchanged hash keeps the version", () => {
  const d = decideVersion({ ...base, recordedHash: "sha256:new" });
  assertEquals([d.action, d.version], ["unchanged", "2026.10.14.1"]);
});

Deno.test("decideVersion: an applied bump not yet in the registry is pending, not unchanged", () => {
  const d = decideVersion({ ...base, recordedHash: "sha256:new", currentVersion: "2026.10.30.1" });
  assertEquals([d.action, d.version], ["pending", "2026.10.30.1"]);
  // Never published at all.
  assertEquals(decideVersion({ ...base, recordedHash: "sha256:new", registryLatest: null }).action, "pending");
});

Deno.test("decideVersion: changed hash releases above manifest and registry", () => {
  const d = decideVersion({
    ...base,
    recordedHash: "sha256:old",
    // Manifest ahead of the registry (an unpublished local bump): go above both.
    currentVersion: "2026.10.30.2",
    registryLatest: "2026.10.30.1",
  });
  assertEquals([d.action, d.version], ["release", "2026.10.30.3"]);
});

Deno.test("decideVersion: no recorded hash is a baseline, or drift when behind registry", () => {
  assertEquals(decideVersion({ ...base, recordedHash: null }).action, "baseline");
  assertEquals(
    decideVersion({ ...base, recordedHash: null, registryLatest: null }).action,
    "baseline",
  );
  const drift = decideVersion({
    ...base,
    recordedHash: null,
    currentVersion: "2026.08.26.1",
  });
  assertEquals([drift.action, drift.version], ["drift", "2026.08.26.1"]);
  // A changed hash must not release over newer registry content either.
  const changedButBehind = decideVersion({ ...base, recordedHash: "sha256:old", currentVersion: "2026.08.26.1" });
  assertEquals(changedButBehind.action, "drift");
});

const enc = (s: string) => new TextEncoder().encode(s);
const manifest = (v: string) => `manifestVersion: 1\nname: "@mgreten/x"\nversion: "${v}"\nmodels:\n  - x.ts\n`;

Deno.test("contentHash ignores the manifest version line only", async () => {
  const a = await contentHash(
    [{ path: "manifest.yaml", bytes: enc(manifest("2026.10.14.1")) }, { path: "x.ts", bytes: enc("export {}\n") }],
    "manifest.yaml",
  );
  const bumped = await contentHash(
    [{ path: "x.ts", bytes: enc("export {}\n") }, { path: "manifest.yaml", bytes: enc(manifest("2026.10.30.1")) }],
    "manifest.yaml",
  );
  assertEquals(a, bumped);

  const codeChange = await contentHash(
    [{ path: "manifest.yaml", bytes: enc(manifest("2026.10.14.1")) }, { path: "x.ts", bytes: enc("export {};\n") }],
    "manifest.yaml",
  );
  assertNotEquals(a, codeChange);

  // A `version:` line in a non-manifest file is content, not metadata.
  const v1 = await contentHash([{ path: "fixture.yaml", bytes: enc("version: 1\n") }], "manifest.yaml");
  const v2 = await contentHash([{ path: "fixture.yaml", bytes: enc("version: 2\n") }], "manifest.yaml");
  assertNotEquals(v1, v2);

  // Renaming a file with identical bytes is a change.
  const renamed = await contentHash(
    [{ path: "manifest.yaml", bytes: enc(manifest("2026.10.14.1")) }, { path: "y.ts", bytes: enc("export {}\n") }],
    "manifest.yaml",
  );
  assertNotEquals(a, renamed);
});
