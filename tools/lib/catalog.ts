import { parse, stringify } from "jsr:@std/yaml@1.0.5";
import { contentHash } from "./calver.ts";

export interface CatalogEntry {
  name: string;
  path: string;
  manifest: string;
  version: string;
  contentHash: string;
  tests: "deterministic" | "none";
  dependsOn: string[];
  source: { repo: string; ref: string };
}

export interface Catalog {
  schemaVersion: 1;
  visibility: "public" | "private";
  scope: string;
  publish: "registry" | "none";
  packages: CatalogEntry[];
}

export async function readCatalog(root: string): Promise<Catalog> {
  return parse(await Deno.readTextFile(`${root}/catalog.yaml`)) as Catalog;
}

const HEADER = `# Public @mgreten catalog: the single source of truth for what this repo
# may publish. Entries are written by tools/import-package.ts and the gate;
# do not hand-edit version or contentHash.
`;

export async function writeCatalog(root: string, c: Catalog): Promise<void> {
  c.packages.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  await Deno.writeTextFile(`${root}/catalog.yaml`, HEADER + stringify(c, { lineWidth: -1 }));
}

/** Tracked files under a package directory, from the git index. */
export async function packageFiles(root: string, pkgPath: string): Promise<string[]> {
  const out = await new Deno.Command("git", {
    args: ["-C", root, "ls-files", "-z", "--", pkgPath],
    stdout: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout).split("\0").filter(Boolean).sort();
}

/** Content hash over tracked package files; paths are relative to the package dir. */
export async function hashPackage(root: string, pkgPath: string, manifest: string): Promise<string> {
  const files = await packageFiles(root, pkgPath);
  const prefix = pkgPath.replace(/\/?$/, "/");
  return contentHash(
    await Promise.all(files.map(async (f) => ({ path: f.slice(prefix.length), bytes: await Deno.readFile(`${root}/${f}`) }))),
    manifest.slice(prefix.length),
  );
}

export function readManifestFields(text: string): { name?: string; version?: string; dependencies?: string[] } {
  const m = parse(text) as Record<string, unknown>;
  return {
    name: typeof m.name === "string" ? m.name : undefined,
    version: m.version === undefined ? undefined : String(m.version),
    dependencies: Array.isArray(m.dependencies) ? m.dependencies.map(String) : [],
  };
}
