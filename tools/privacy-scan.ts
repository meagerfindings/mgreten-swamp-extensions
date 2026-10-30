/**
 * Privacy scan over the FULL git history of a package, not just HEAD.
 *
 *   deno run -A tools/privacy-scan.ts --repo <git dir> [--path <prefix>]
 *       [--rules tools/privacy-rules.json] [--allowlist tools/privacy-allowlist.json]
 *       [--json <out file>]
 *
 * Scans every blob that ever existed under --path, every such path name, and
 * the author/committer/message of every commit that touched it. Uses gitleaks
 * for secrets too when it is installed; the pinned regex set always runs.
 *
 * Never prints a matched value: each hit carries rule, category, path, commit,
 * line, and a sha256 fingerprint of the match. Granola hits report only the
 * path and commit. Exit 0 = clean, 1 = blocked, 2 = usage or git error.
 */

export interface Rule {
  id: string;
  category: string;
  scopes: Array<"content" | "path" | "metadata">;
  pattern: string;
  flags?: string;
  minMatches?: number;
  excludeValues?: boolean;
}

export interface RuleSet {
  rulesVersion: string;
  valueExclude: string;
  rules: Rule[];
}

export interface Hit {
  rule: string;
  category: string;
  scope: "content" | "path" | "metadata";
  path: string;
  commit: string;
  line: number | null;
  fingerprint: string;
}

export interface AllowEntry {
  rule: string;
  path: string;
  fingerprint: string;
  reason: string;
}

const MAX_BLOB = 5 * 1024 * 1024;

async function sha12(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return "sha256:" + [...new Uint8Array(d)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Scan one text for one scope. Pure, so it is testable without git. */
export async function scanText(
  rules: RuleSet,
  scope: Hit["scope"],
  text: string,
  where: { path: string; commit: string },
): Promise<Hit[]> {
  const exclude = new RegExp(rules.valueExclude.replace(/^\(\?i\)/, ""), "i");
  const hits: Hit[] = [];
  for (const r of rules.rules) {
    if (!r.scopes.includes(scope)) continue;
    const flags = (r.flags ?? "").replace("g", "") + "g";
    const re = new RegExp(r.pattern, flags);
    const matches = [...text.matchAll(re)].filter((m) =>
      !(r.excludeValues || r.category === "secret") || !exclude.test(m[0])
    );
    if (matches.length === 0 || matches.length < (r.minMatches ?? 1)) continue;
    if (r.category === "granola") {
      // One hit per path; no line or excerpt so content is never reproduced.
      hits.push({ rule: r.id, category: r.category, scope, ...where, line: null, fingerprint: await sha12(`${r.id}:${where.path}`) });
      continue;
    }
    for (const m of matches) {
      hits.push({
        rule: r.id,
        category: r.category,
        scope,
        ...where,
        line: scope === "content" ? lineOf(text, m.index ?? 0) : null,
        fingerprint: await sha12(m[0]),
      });
    }
  }
  return hits;
}

async function git(repo: string, args: string[]): Promise<Uint8Array> {
  const out = await new Deno.Command("git", { args: ["-C", repo, ...args], stdout: "piped", stderr: "piped" }).output();
  if (!out.success) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`);
  return out.stdout;
}
const text = (b: Uint8Array) => new TextDecoder().decode(b);

async function gitleaksHits(repo: string, path: string | null): Promise<Hit[] | null> {
  try {
    const report = await Deno.makeTempFile({ suffix: ".json" });
    const args = ["git", repo, "--redact", "--no-banner", "--exit-code", "0", "--report-format", "json", "--report-path", report];
    if (path) args.push("--log-opts", `--all -- ${path}`);
    const out = await new Deno.Command("gitleaks", { args, stdout: "null", stderr: "null" }).output();
    if (!out.success) return null;
    const found = JSON.parse(await Deno.readTextFile(report)) as Array<{ RuleID: string; File: string; Commit: string; StartLine: number; Fingerprint: string }>;
    await Deno.remove(report);
    return Promise.all(found.map(async (f) => ({
      rule: `gitleaks:${f.RuleID}`, category: "secret", scope: "content" as const,
      path: f.File, commit: f.Commit.slice(0, 12), line: f.StartLine, fingerprint: await sha12(f.Fingerprint),
    })));
  } catch {
    return null; // not installed
  }
}

export async function scanHistory(
  repo: string,
  path: string | null,
  rules: RuleSet,
): Promise<{ hits: Hit[]; commits: number; blobs: number; gitleaks: boolean }> {
  const spec = path ? ["--", path] : [];
  const commits = text(await git(repo, ["rev-list", "--reverse", "--all", ...spec])).split("\n").filter(Boolean);
  const hits: Hit[] = [];
  const seenBlob = new Set<string>();
  const seenPath = new Set<string>();
  for (const c of commits) {
    const short = c.slice(0, 12);
    const meta = text(await git(repo, ["log", "-1", "--format=%an <%ae>%n%cn <%ce>%n%B", c]));
    hits.push(...await scanText(rules, "metadata", meta, { path: "(commit header/message)", commit: short }));
    const tree = text(await git(repo, ["ls-tree", "-r", "-z", c, ...(path ? ["--", path] : [])])).split("\0").filter(Boolean);
    for (const entry of tree) {
      const [info, p] = entry.split("\t");
      const [, type, blob] = info.split(" ");
      if (type !== "blob") continue;
      if (!seenPath.has(p)) {
        seenPath.add(p);
        hits.push(...await scanText(rules, "path", p, { path: p, commit: short }));
      }
      if (seenBlob.has(blob)) continue;
      seenBlob.add(blob);
      const size = Number(text(await git(repo, ["cat-file", "-s", blob])).trim());
      if (size > MAX_BLOB) continue;
      const body = text(await git(repo, ["cat-file", "blob", blob]));
      hits.push(...await scanText(rules, "content", body, { path: p, commit: short }));
    }
  }
  const leaks = await gitleaksHits(repo, path);
  if (leaks) hits.push(...leaks);
  // Deterministic order and de-duplication.
  const key = (h: Hit) => [h.category, h.rule, h.path, h.commit, String(h.line).padStart(8, "0"), h.fingerprint].join("|");
  const uniq = new Map(hits.map((h) => [key(h), h]));
  return { hits: [...uniq.values()].sort((a, b) => key(a) < key(b) ? -1 : 1), commits: commits.length, blobs: seenBlob.size, gitleaks: leaks !== null };
}

export function applyAllowlist(hits: Hit[], allow: AllowEntry[]): Hit[] {
  return hits.filter((h) => !allow.some((a) => a.rule === h.rule && a.fingerprint === h.fingerprint && a.path === h.path));
}

function arg(name: string): string | null {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? Deno.args[i + 1] ?? null : null;
}

if (import.meta.main) {
  const repo = arg("--repo");
  if (!repo) {
    console.error("usage: privacy-scan.ts --repo <git dir> [--path <prefix>] [--rules f] [--allowlist f] [--json out]");
    Deno.exit(2);
  }
  const here = new URL(".", import.meta.url).pathname;
  const rules: RuleSet = JSON.parse(await Deno.readTextFile(arg("--rules") ?? `${here}privacy-rules.json`));
  const allowPath = arg("--allowlist") ?? `${here}privacy-allowlist.json`;
  const allow: AllowEntry[] = await Deno.readTextFile(allowPath).then((t) => JSON.parse(t).entries ?? [], () => []);
  const path = arg("--path");
  try {
    const r = await scanHistory(repo, path, rules);
    const hits = applyAllowlist(r.hits, allow);
    const summary = {
      rulesVersion: rules.rulesVersion,
      path,
      commitsScanned: r.commits,
      blobsScanned: r.blobs,
      gitleaks: r.gitleaks,
      status: hits.length === 0 ? "clean" : "blocked",
      hitCount: hits.length,
      byCategory: hits.reduce<Record<string, number>>((acc, h) => ((acc[h.category] = (acc[h.category] ?? 0) + 1), acc), {}),
      hits,
    };
    const out = arg("--json");
    if (out) await Deno.writeTextFile(out, JSON.stringify(summary, null, 2) + "\n");
    console.log(`privacy-scan ${summary.status}: ${r.commits} commits, ${r.blobs} blobs, ${hits.length} hits (rules ${rules.rulesVersion}${r.gitleaks ? ", gitleaks" : ", gitleaks not installed"})`);
    for (const h of hits) {
      console.log(`  [${h.category}] ${h.rule} ${h.path}${h.line ? `:${h.line}` : ""} @${h.commit} ${h.fingerprint}`);
    }
    Deno.exit(hits.length === 0 ? 0 : 1);
  } catch (e) {
    console.error(`privacy-scan error: ${(e as Error).message}`);
    Deno.exit(2);
  }
}
