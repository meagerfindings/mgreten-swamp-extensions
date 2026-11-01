/**
 * Import one package's history into packages/<short>/ of this monorepo.
 *
 *   deno run -A tools/import-package.ts <short> [--state-dir /tmp/ext-import]
 *       [--mailmap <file outside this repo>] [--require-current] [--repoint]
 *
 * --require-current: refuse (exit 3, nothing merged) when the source manifest
 *   version is behind the registry's latest; the registry then holds content
 *   this source does not, and the true source must be found first.
 * --repoint: after the import commit, a second commit points the manifest's
 *   repository at the public monorepo. The catalog keeps the source's content
 *   hash, so the gate sees a content change and ext-publish releases it.
 *
 * Steps, all deterministic for a pinned source ref:
 *  1. Fetch the pinned ref from the source URL into a cache repo under the
 *     state dir. The source checkout is never opened or modified.
 *  2. Copy that ref into a fresh staging repo and run git filter-repo with
 *     exactly the paths in tools/sources.yaml, renaming them under
 *     packages/<short>/.
 *  3. Run the privacy scan over the full filtered history. Any hit blocks the
 *     import: nothing is merged, the catalog is untouched, and the redacted
 *     report (hits mapped back to source commits) is written to the state dir.
 *  4. If clean, merge the filtered history into the current branch with
 *     --allow-unrelated-histories and add the package to catalog.yaml in the
 *     same commit. Trailers record source, ref, and scan rules version.
 *
 * Idempotent: if HEAD already has an import commit for <short> at the same
 * ref, it exits 0 without changes. A different ref is refused (re-import is a
 * separate, explicit operation).
 *
 * Exit codes: 0 imported or already imported, 1 blocked by privacy scan,
 * 2 error, 3 source behind the registry (--require-current).
 */
import { parse } from "jsr:@std/yaml@1.0.5";
import { applyAllowlist, type AllowEntry, type RuleSet, scanHistory } from "./privacy-scan.ts";
import { hashPackage, readCatalog, readManifestFields, writeCatalog } from "./lib/catalog.ts";
import { compareCalVer } from "./lib/calver.ts";
import { PUBLIC_REPOSITORY } from "./gate.ts";

export interface ImportOptions {
  mailmap?: string | null;
  requireCurrent?: boolean;
  repoint?: boolean;
  swamp?: string;
}

interface Source {
  name: string;
  short: string;
  source: string;
  ref: string;
  manifest: string;
  paths: Array<{ from: string; to: string }>;
}

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

async function run(args: string[], opts: { cwd?: string; allowFail?: boolean } = {}): Promise<string> {
  const out = await new Deno.Command(args[0], {
    args: args.slice(1),
    cwd: opts.cwd,
    stdout: "piped",
    stderr: "piped",
    env: { GIT_TERMINAL_PROMPT: "0" },
  }).output();
  const so = new TextDecoder().decode(out.stdout);
  if (!out.success && !opts.allowFail) {
    throw new Error(`${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr).trim()}`);
  }
  return so;
}

function argValue(name: string, fallback: string): string {
  const i = Deno.args.indexOf(name);
  return i >= 0 && Deno.args[i + 1] ? Deno.args[i + 1] : fallback;
}

async function exists(p: string): Promise<boolean> {
  return await Deno.stat(p).then(() => true, () => false);
}

export async function importPackage(short: string, stateDir: string, opts: ImportOptions = {}): Promise<number> {
  const mailmap = opts.mailmap ?? null;
  const sources = parse(await Deno.readTextFile(`${root}/tools/sources.yaml`)) as { packages: Source[] };
  const src = sources.packages.find((p) => p.short === short);
  if (!src) throw new Error(`no entry for ${short} in tools/sources.yaml`);
  if (!/^[0-9a-f]{40}$/.test(src.ref)) throw new Error(`${short}: ref must be a full commit SHA`);
  const pkgDir = `packages/${short}`;

  // Idempotency: look for an existing import commit for this package.
  const prior = (await run(["git", "-C", root, "log", "--format=%H%x00%(trailers:key=Imported-Ref,valueonly)", `--grep=^Imported-Package: ${short}$`, "HEAD"], { allowFail: true })).trim();
  if (prior) {
    const ref = prior.split("\0")[1]?.trim();
    if (ref === src.ref) {
      console.log(`${short}: already imported at ${src.ref.slice(0, 12)}; nothing to do`);
      return 0;
    }
    throw new Error(`${short}: already imported at ${ref}; refusing to re-import at ${src.ref}`);
  }
  if (await exists(`${root}/${pkgDir}`)) throw new Error(`${pkgDir} exists without an import commit; refusing`);
  if ((await run(["git", "-C", root, "status", "--porcelain"])).trim()) throw new Error("monorepo worktree is dirty; commit or stash first");

  // 1. Cache repo keyed by source URL; fetch only the pinned ref.
  const cacheKey = src.source.replace(/[^A-Za-z0-9]+/g, "_");
  const cache = `${stateDir}/cache/${cacheKey}.git`;
  if (!await exists(cache)) await run(["git", "init", "-q", "--bare", cache]);
  const hasRef = (await new Deno.Command("git", { args: ["-C", cache, "cat-file", "-e", `${src.ref}^{commit}`], stderr: "null" }).output()).success;
  if (!hasRef) await run(["git", "-C", cache, "fetch", "-q", "--no-tags", src.source, src.ref]);

  // 2. Fresh staging repo containing only the pinned ref, then filter.
  const staging = `${stateDir}/staging/${short}`;
  await Deno.remove(staging, { recursive: true }).catch(() => {});
  await Deno.mkdir(staging, { recursive: true });
  await run(["git", "init", "-q", "-b", "import", staging]);
  await run(["git", "-C", staging, "fetch", "-q", "--no-tags", cache, src.ref]);
  await run(["git", "-C", staging, "update-ref", "refs/heads/import", src.ref]);
  const filterArgs = ["git", "filter-repo", "--force", "--quiet", "--refs", "refs/heads/import"];
  for (const p of src.paths) filterArgs.push("--path", p.from);
  for (const p of src.paths) filterArgs.push("--path-rename", `${p.from}:${pkgDir}/${p.to}`);
  // Optional identity rewrite. The mailmap must live outside this public repo
  // because it names the identities being replaced; only its hash is recorded.
  let mailmapHash: string | null = null;
  if (mailmap) {
    filterArgs.push("--mailmap", mailmap);
    const d = await crypto.subtle.digest("SHA-256", await Deno.readFile(mailmap));
    mailmapHash = "sha256:" + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  }
  await run(filterArgs, { cwd: staging });
  const head = (await run(["git", "-C", staging, "rev-parse", "--verify", "-q", "refs/heads/import"], { allowFail: true })).trim();
  if (!head) throw new Error(`${short}: filtered history is empty; check paths in tools/sources.yaml`);

  // 3. Privacy scan over the full filtered history.
  const rules: RuleSet = JSON.parse(await Deno.readTextFile(`${root}/tools/privacy-rules.json`));
  const allow: AllowEntry[] = await Deno.readTextFile(`${root}/tools/privacy-allowlist.json`).then((t) => JSON.parse(t).entries ?? [], () => []);
  const scan = await scanHistory(staging, pkgDir, rules);
  const hits = applyAllowlist(scan.hits, allow);
  // Map rewritten commits back to source commits for the report.
  const map = new Map<string, string>();
  const commitMap = await Deno.readTextFile(`${staging}/.git/filter-repo/commit-map`).catch(() => "");
  for (const line of commitMap.split("\n").slice(1)) {
    const [oldC, newC] = line.split(" ");
    if (oldC && newC) map.set(newC.slice(0, 12), oldC.slice(0, 12));
  }
  const report = {
    package: src.name,
    source: src.source,
    ref: src.ref,
    rulesVersion: rules.rulesVersion,
    commitsScanned: scan.commits,
    blobsScanned: scan.blobs,
    gitleaks: scan.gitleaks,
    status: hits.length ? "blocked" : "clean",
    hits: hits.map((h) => ({ ...h, path: h.path.startsWith(`${pkgDir}/`) ? h.path.slice(pkgDir.length + 1) : h.path, sourceCommit: map.get(h.commit) ?? null })),
  };
  await Deno.mkdir(`${stateDir}/reports`, { recursive: true });
  await Deno.writeTextFile(`${stateDir}/reports/${short}.json`, JSON.stringify(report, null, 2) + "\n");
  if (hits.length) {
    const byRule = new Map<string, number>();
    for (const h of hits) byRule.set(`${h.category}/${h.rule}`, (byRule.get(`${h.category}/${h.rule}`) ?? 0) + 1);
    console.log(`${short}: BLOCKED by privacy scan (${hits.length} hits; ${[...byRule].map(([k, n]) => `${k}×${n}`).join(", ")}). Not merged. Report: ${stateDir}/reports/${short}.json`);
    return 1;
  }

  // Manifest present and named right at the filtered head, before any merge.
  const manifestAtHead = (await run(["git", "-C", staging, "show", `import:${pkgDir}/${src.manifest}`], { allowFail: true }));
  if (!manifestAtHead) throw new Error(`${short}: manifest ${src.manifest} missing at ${src.ref.slice(0, 12)}; imported nothing`);
  const headFields = readManifestFields(manifestAtHead);
  if (headFields.name !== src.name) throw new Error(`${short}: manifest name ${headFields.name} != ${src.name}`);
  if (opts.requireCurrent) {
    const swamp = opts.swamp ?? `${Deno.env.get("HOME")}/.local/bin/swamp`;
    const info = await new Deno.Command(swamp, { args: ["extension", "info", src.name, "--json"], stdout: "piped", stderr: "null", env: { DENO_TLS_CA_STORE: "mozilla" } }).output();
    if (!info.success) throw new Error(`${short}: registry lookup failed; cannot check --require-current`);
    const latest = JSON.parse(new TextDecoder().decode(info.stdout)).latestVersion as string | null;
    if (latest && headFields.version && compareCalVer(headFields.version, latest) < 0) {
      await Deno.writeTextFile(`${stateDir}/reports/${short}.json`, JSON.stringify({ ...report, status: "drift", sourceVersion: headFields.version, registryLatest: latest }, null, 2) + "\n");
      console.log(`${short}: DRIFT source ${headFields.version} < registry ${latest}. Not merged.`);
      return 3;
    }
  }

  // 4. Merge clean history and add the catalog entry in one commit.
  await run(["git", "-C", root, "fetch", "-q", "--no-tags", staging, "refs/heads/import"]);
  await run(["git", "-C", root, "merge", "-q", "--no-ff", "--no-commit", "--allow-unrelated-histories", "FETCH_HEAD"]);
  const manifestPath = `${pkgDir}/${src.manifest}`;
  const manifestText = await Deno.readTextFile(`${root}/${manifestPath}`).catch(() => null);
  if (manifestText === null) {
    await run(["git", "-C", root, "merge", "--abort"]);
    throw new Error(`${short}: manifest ${src.manifest} missing at ${src.ref.slice(0, 12)}; imported nothing`);
  }
  const m = readManifestFields(manifestText);
  if (m.name !== src.name) {
    await run(["git", "-C", root, "merge", "--abort"]);
    throw new Error(`${short}: manifest name ${m.name} != ${src.name}`);
  }
  const catalog = await readCatalog(root);
  const files = (await run(["git", "-C", root, "ls-files", "--", pkgDir])).split("\n");
  catalog.packages = catalog.packages.filter((p) => p.name !== src.name);
  catalog.packages.push({
    name: src.name,
    path: pkgDir,
    manifest: manifestPath,
    version: m.version ?? "",
    contentHash: await hashPackage(root, pkgDir, manifestPath),
    tests: files.some((f) => f.endsWith("_test.ts")) ? "deterministic" : "none",
    dependsOn: m.dependencies ?? [],
    source: { repo: src.source, ref: src.ref },
  });
  await writeCatalog(root, catalog);
  await run(["git", "-C", root, "add", "catalog.yaml"]);
  const msg = `import(${short}): ${src.name} with history\n\n` +
    `Filtered from ${src.source} at ${src.ref} (${scan.commits} commits).\n` +
    `Privacy scan clean over full history (rules ${rules.rulesVersion}).\n\n` +
    `Imported-Package: ${short}\nImported-From: ${src.source}\nImported-Ref: ${src.ref}\nPrivacy-Rules: ${rules.rulesVersion}\n` +
    (mailmapHash ? `Identity-Rewrite: mailmap ${mailmapHash}\n` : "");
  await run(["git", "-C", root, "commit", "-q", "-m", msg]);
  if (opts.repoint) {
    const text = await Deno.readTextFile(`${root}/${manifestPath}`);
    const line = `repository: "${PUBLIC_REPOSITORY}"`;
    const next = /^repository:.*$/m.test(text)
      ? text.replace(/^repository:.*$/m, line)
      : text.replace(/^(version:.*)$/m, `$1\n${line}`);
    if (next !== text) {
      await Deno.writeTextFile(`${root}/${manifestPath}`, next);
      await run(["git", "-C", root, "commit", "-q", "-m", `chore(${short}): point repository at the monorepo`, "--", manifestPath]);
    }
  }
  console.log(`${short}: imported ${scan.commits} commits, clean, catalog version ${m.version}`);
  return 0;
}

if (import.meta.main) {
  const valued = ["--state-dir", "--mailmap"];
  const short = Deno.args.find((a, i) => !a.startsWith("--") && !valued.includes(Deno.args[i - 1]));
  if (!short) {
    console.error("usage: import-package.ts <short> [--state-dir dir] [--mailmap file] [--require-current] [--repoint]");
    Deno.exit(2);
  }
  try {
    Deno.exit(await importPackage(short, argValue("--state-dir", "/tmp/ext-import"), {
      mailmap: argValue("--mailmap", "") || null,
      requireCurrent: Deno.args.includes("--require-current"),
      repoint: Deno.args.includes("--repoint"),
    }));
  } catch (e) {
    console.error(`import error: ${(e as Error).message}`);
    Deno.exit(2);
  }
}
