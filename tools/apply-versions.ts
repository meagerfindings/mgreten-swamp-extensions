/**
 * Apply the gate's CalVer decision: for each catalog package whose content
 * changed ("release"), write the next YYYY.MM.DD.N into its manifest and the
 * catalog and record the new content hash; for "baseline", record the hash.
 * Drift, unchanged, and pending packages are left alone. Local file edits
 * only; never commits, pushes, or publishes.
 *
 *   deno run -A tools/apply-versions.ts --today YYYY-MM-DD
 */
import { decideVersion } from "./lib/calver.ts";
import { hashPackage, readCatalog, writeCatalog } from "./lib/catalog.ts";
import { type GateEnv, registryLatest } from "./gate.ts";

const i = Deno.args.indexOf("--today");
const today = i >= 0 ? Deno.args[i + 1] : undefined;
if (!today) {
  console.error("--today YYYY-MM-DD is required");
  Deno.exit(2);
}
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const env: GateEnv = {
  root,
  today,
  swamp: Deno.env.get("SWAMP_BIN") ?? `${Deno.env.get("HOME")}/.local/bin/swamp`,
  deno: Deno.execPath(),
};
const catalog = await readCatalog(root);
for (const p of catalog.packages) {
  const hash = await hashPackage(root, p.path, p.manifest);
  const d = decideVersion({
    contentHash: hash,
    recordedHash: p.contentHash || null,
    currentVersion: p.version,
    registryLatest: await registryLatest(env, p.name),
    today,
  });
  if (d.action === "release") {
    const file = `${root}/${p.manifest}`;
    const text = await Deno.readTextFile(file);
    if (!/^version:.*$/m.test(text)) throw new Error(`${p.manifest}: no top-level version line`);
    await Deno.writeTextFile(file, text.replace(/^version:.*$/m, `version: "${d.version}"`));
    p.version = d.version;
    p.contentHash = hash; // version line is excluded from the hash, so it is unchanged by the write
  } else if (d.action === "baseline") {
    p.contentHash = hash;
  }
  console.log(`${d.action.padEnd(9)} ${p.name} ${d.version}${d.action === "drift" ? ` (${d.reason})` : ""}`);
}
await writeCatalog(root, catalog);
