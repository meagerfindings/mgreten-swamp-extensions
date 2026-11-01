/**
 * Write one package's release version into its manifest and the catalog,
 * and record the content hash that version ships. The manifest's version
 * line is excluded from the hash, so this write never changes the hash.
 */
import { type Catalog, hashPackage } from "./catalog.ts";

export async function applyRelease(root: string, catalog: Catalog, name: string, version: string): Promise<void> {
  const p = catalog.packages.find((x) => x.name === name);
  if (!p) throw new Error(`${name} not in catalog`);
  const file = `${root}/${p.manifest}`;
  const text = await Deno.readTextFile(file);
  if (!/^version:.*$/m.test(text)) throw new Error(`${p.manifest}: no top-level version line`);
  await Deno.writeTextFile(file, text.replace(/^version:.*$/m, `version: "${version}"`));
  p.version = version;
  p.contentHash = await hashPackage(root, p.path, p.manifest);
}
