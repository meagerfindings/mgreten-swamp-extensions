/**
 * ext-gate checks for every catalog package. Each step is a fan-out over the
 * catalog and returns one result per package. Used by the @mgreten/ext-gate
 * model (extensions/models/ext_gate.ts) and runnable directly:
 *
 *   deno run -A tools/gate.ts [consistency|tests|version|privacy|dry-run|all]
 *       [--today YYYY-MM-DD] [--json out.json]
 *
 * Read-only: never edits files, never pushes. `swamp extension push` is only
 * ever called with --dry-run.
 */
import { decideVersion, type VersionDecision } from "./lib/calver.ts";
import { type Catalog, hashPackage, readCatalog, readManifestFields } from "./lib/catalog.ts";
import { applyAllowlist, type AllowEntry, type Hit, type RuleSet, scanHistory, scanText } from "./privacy-scan.ts";

export type Step = "consistency" | "tests" | "version" | "privacy" | "dry-run";
export const STEPS: Step[] = ["consistency", "tests", "version", "privacy", "dry-run"];

export interface PackageResult {
  name: string;
  ok: boolean;
  detail: string;
  data?: Record<string, unknown>;
}

export interface GateEnv {
  root: string;
  today: string;
  swamp: string;
  deno: string;
}

const PUBLIC_REPOSITORY = "https://github.com/meagerfindings/mgreten-swamp-extensions";
const FORBIDDEN_DEP_SCOPES = ["@companycam/", "@matg/"];

async function exec(args: string[], cwd: string, env: Record<string, string> = {}) {
  const out = await new Deno.Command(args[0], { args: args.slice(1), cwd, stdout: "piped", stderr: "piped", env }).output();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
}

const swampEnv = { DENO_TLS_CA_STORE: "mozilla" };

async function consistency(env: GateEnv, c: Catalog): Promise<PackageResult[]> {
  const res: PackageResult[] = [];
  for (const p of c.packages) {
    const problems: string[] = [];
    if (!p.name.startsWith(`${c.scope}/`)) problems.push(`name not in scope ${c.scope}`);
    if (p.path !== `packages/${p.name.split("/").pop()}`) problems.push(`path ${p.path} != packages/<short>`);
    const text = await Deno.readTextFile(`${env.root}/${p.manifest}`).catch(() => null);
    if (text === null) {
      res.push({ name: p.name, ok: false, detail: `manifest missing: ${p.manifest}` });
      continue;
    }
    if (!p.manifest.startsWith(`${p.path}/`)) problems.push("manifest outside package path");
    const m = readManifestFields(text);
    const repo = /^repository:\s*["']?([^"'\s]+)/m.exec(text)?.[1] ?? null;
    if (m.name !== p.name) problems.push(`manifest name ${m.name} != catalog`);
    if (m.version !== p.version) problems.push(`manifest version ${m.version} != catalog ${p.version}`);
    const deps = m.dependencies ?? [];
    if (JSON.stringify([...deps].sort()) !== JSON.stringify([...p.dependsOn].sort())) problems.push("dependsOn != manifest dependencies");
    for (const d of deps) if (FORBIDDEN_DEP_SCOPES.some((s) => d.startsWith(s))) problems.push(`private-scope dependency ${d}`);
    if (c.visibility === "public" && repo !== PUBLIC_REPOSITORY) problems.push(`repository ${repo} is not the public monorepo`);
    const hash = await hashPackage(env.root, p.path, p.manifest);
    if (hash !== p.contentHash) problems.push("contentHash stale (content changed since recorded)");
    res.push({ name: p.name, ok: problems.length === 0, detail: problems.join("; ") || "consistent", data: { contentHash: hash, repository: repo } });
  }
  const names = c.packages.map((p) => p.name);
  if (new Set(names).size !== names.length) res.push({ name: "(catalog)", ok: false, detail: "duplicate package names" });
  return res;
}

async function tests(env: GateEnv, c: Catalog): Promise<PackageResult[]> {
  const res: PackageResult[] = [];
  for (const p of c.packages) {
    if (p.tests === "none") {
      res.push({ name: p.name, ok: false, detail: "tests: none (manual publish only)" });
      continue;
    }
    const r = await exec([env.deno, "test", "-A", "--frozen", "--no-prompt", p.path], env.root, { NO_COLOR: "1" });
    const summary = /(ok|FAILED) \| (\d+) passed.*?\| (\d+) failed/.exec(r.stdout + r.stderr);
    res.push({
      name: p.name,
      ok: r.code === 0,
      detail: summary ? `${summary[2]} passed, ${summary[3]} failed` : `deno test exit ${r.code}: ${(r.stderr.trim().split("\n").pop() ?? "").slice(0, 200)}`,
    });
  }
  return res;
}

export async function registryLatest(env: GateEnv, name: string): Promise<string | null> {
  const r = await exec([env.swamp, "extension", "info", name, "--json"], env.root, swampEnv);
  if (r.code !== 0) return null;
  try {
    return (JSON.parse(r.stdout).latestVersion as string | null) ?? null;
  } catch {
    return null;
  }
}

async function version(env: GateEnv, c: Catalog): Promise<PackageResult[]> {
  const res: PackageResult[] = [];
  for (const p of c.packages) {
    const hash = await hashPackage(env.root, p.path, p.manifest);
    const latest = await registryLatest(env, p.name);
    const d: VersionDecision = decideVersion({
      contentHash: hash,
      recordedHash: p.contentHash || null,
      currentVersion: p.version,
      registryLatest: latest,
      today: env.today,
    });
    res.push({
      name: p.name,
      // "release" means content changed but the bump is not applied yet.
      ok: d.action === "unchanged" || d.action === "pending" || d.action === "baseline",
      detail: d.action === "release" ? `release ${d.version} needed: run deno task apply-versions --today ${env.today}` : `${d.action}: ${d.reason}`,
      data: { action: d.action, version: d.version, currentVersion: p.version, registryLatest: latest, contentHash: hash },
    });
  }
  return res;
}

async function privacy(env: GateEnv, c: Catalog): Promise<PackageResult[]> {
  const rules: RuleSet = JSON.parse(await Deno.readTextFile(`${env.root}/tools/privacy-rules.json`));
  const allow: AllowEntry[] = await Deno.readTextFile(`${env.root}/tools/privacy-allowlist.json`).then((t) => JSON.parse(t).entries ?? [], () => []);
  const res: PackageResult[] = [];
  for (const p of c.packages) {
    const s = await scanHistory(env.root, p.path, rules);
    const hits = applyAllowlist(s.hits, allow);
    res.push({
      name: p.name,
      ok: hits.length === 0,
      detail: hits.length ? `${hits.length} hits` : `clean (${s.commits} commits, ${s.blobs} blobs, rules ${rules.rulesVersion})`,
      data: { hits: hits.map(({ rule, category, path, commit, line, fingerprint }) => ({ rule, category, path, commit, line, fingerprint })) },
    });
  }
  // Path-limited history skips this repo's own commits (scaffold, merges),
  // so check every commit's identity and message here as well.
  const shas = (await exec(["git", "rev-list", "--all"], env.root)).stdout.split("\n").filter(Boolean);
  const meta: Hit[] = [];
  for (const c of shas) {
    const header = (await exec(["git", "log", "-1", "--format=%an <%ae>%n%cn <%ce>%n%B", c], env.root)).stdout;
    meta.push(...await scanText(rules, "metadata", header, { path: "(commit header/message)", commit: c.slice(0, 12) }));
  }
  const metaHits = applyAllowlist(meta, allow);
  res.push({
    name: "(repo commits)",
    ok: metaHits.length === 0,
    detail: metaHits.length ? `${metaHits.length} commit metadata hits` : `clean (${shas.length} commits)`,
    data: { hits: metaHits.map(({ rule, category, commit, fingerprint }) => ({ rule, category, commit, fingerprint })) },
  });
  return res;
}

async function dryRun(env: GateEnv, c: Catalog): Promise<PackageResult[]> {
  const res: PackageResult[] = [];
  for (const p of c.packages) {
    const args = [env.swamp, "extension", "push", p.manifest, "--extensions-dir", p.path, "--dry-run", "--yes", "--json"];
    if (!args.includes("--dry-run")) throw new Error("refusing to push without --dry-run");
    const r = await exec(args, env.root, swampEnv);
    let status = "unknown";
    let built = false;
    try {
      const j = JSON.parse(r.stdout);
      status = j.status;
      built = j.status === "dry_run";
    } catch { /* non-JSON output */ }
    const err = (() => {
      try {
        return JSON.parse(r.stderr).error as string;
      } catch {
        return r.stderr.trim().split("\n").pop() ?? "";
      }
    })();
    // "Version already exists" means the archive built and only the version
    // is taken; the version step decides whether a new one is needed.
    const versionTaken = /already exists/.test(err);
    res.push({
      name: p.name,
      ok: built && (r.code === 0 || versionTaken),
      detail: built ? (r.code === 0 ? "dry-run build ok" : versionTaken ? "dry-run build ok; current version already in registry" : `dry-run: ${err.slice(0, 200)}`) : `dry-run ${status}: ${err.slice(0, 200)}`,
    });
  }
  return res;
}

export async function runStep(step: Step, env: GateEnv): Promise<PackageResult[]> {
  const c = await readCatalog(env.root);
  switch (step) {
    case "consistency":
      return consistency(env, c);
    case "tests":
      return tests(env, c);
    case "version":
      return version(env, c);
    case "privacy":
      return privacy(env, c);
    case "dry-run":
      return dryRun(env, c);
  }
}

if (import.meta.main) {
  const arg = (n: string) => {
    const i = Deno.args.indexOf(n);
    return i >= 0 ? Deno.args[i + 1] : undefined;
  };
  const which = Deno.args[0] && !Deno.args[0].startsWith("--") ? Deno.args[0] : "all";
  const today = arg("--today");
  if (!today) {
    console.error("--today YYYY-MM-DD is required (the gate never reads the clock)");
    Deno.exit(2);
  }
  const env: GateEnv = {
    root: new URL("..", import.meta.url).pathname.replace(/\/$/, ""),
    today,
    swamp: Deno.env.get("SWAMP_BIN") ?? `${Deno.env.get("HOME")}/.local/bin/swamp`,
    deno: Deno.env.get("DENO_BIN") ?? Deno.execPath(),
  };
  const steps = which === "all" ? STEPS : [which as Step];
  const out: Record<string, PackageResult[]> = {};
  for (const s of steps) {
    out[s] = await runStep(s, env);
    for (const r of out[s]) console.log(`${r.ok ? "PASS" : "FAIL"} ${s.padEnd(11)} ${r.name}: ${r.detail}`);
  }
  const jsonOut = arg("--json");
  if (jsonOut) await Deno.writeTextFile(jsonOut, JSON.stringify(out, null, 2) + "\n");
  Deno.exit(Object.values(out).flat().every((r) => r.ok) ? 0 : 1);
}
