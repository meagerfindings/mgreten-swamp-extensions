/**
 * Content-hash based CalVer decisions for catalog packages.
 *
 * A package gets a new version only when the bytes it would ship change.
 * The manifest's own `version:` line is excluded from the hash, so writing a
 * bumped version back into the manifest never changes the hash again.
 */

export type CalVer = [number, number, number, number];

const CALVER_RE = /^(\d{4})\.(\d{2})\.(\d{2})\.(\d+)$/;

export function parseCalVer(v: string): CalVer {
  const m = CALVER_RE.exec(v.trim().replace(/^["']|["']$/g, ""));
  if (!m) throw new Error(`not a CalVer YYYY.MM.DD.N version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

export function formatCalVer(v: CalVer): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${v[0]}.${p2(v[1])}.${p2(v[2])}.${v[3]}`;
}

export function compareCalVer(a: string, b: string): number {
  const x = parseCalVer(a);
  const y = parseCalVer(b);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * The next free version above every version in `floor` (nulls ignored).
 * `today` is an ISO date (YYYY-MM-DD) supplied by the caller; this module
 * never reads the clock.
 */
export function nextCalVer(today: string, floor: Array<string | null>): string {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!d) throw new Error(`today must be YYYY-MM-DD, got ${today}`);
  const todayDay = `${d[1]}.${d[2]}.${d[3]}`;
  const known = floor.filter((v): v is string => !!v).sort(compareCalVer);
  const top = known.at(-1);
  if (!top) return `${todayDay}.1`;
  const parsed = parseCalVer(top);
  const n = parsed[3];
  const topDay = formatCalVer(parsed).split(".").slice(0, 3).join(".");
  // Same day, or a floor dated in the future (clock skew): bump N on that day.
  if (topDay >= todayDay) return `${topDay}.${n + 1}`;
  return `${todayDay}.1`;
}

export type VersionAction = "unchanged" | "baseline" | "release" | "drift";

export interface VersionInput {
  contentHash: string;
  /** Hash recorded in catalog.yaml at the last release or import; null if never recorded. */
  recordedHash: string | null;
  /** Version in the package manifest (== catalog version when consistent). */
  currentVersion: string;
  /** Latest version in the registry; null when unpublished. */
  registryLatest: string | null;
  today: string;
}

export interface VersionDecision {
  action: VersionAction;
  version: string;
  reason: string;
}

export function decideVersion(i: VersionInput): VersionDecision {
  const behind = i.registryLatest !== null &&
    compareCalVer(i.currentVersion, i.registryLatest) < 0;
  if (i.recordedHash === null) {
    if (behind) {
      return {
        action: "drift",
        version: i.currentVersion,
        reason:
          `no recorded hash and source ${i.currentVersion} is behind registry ${i.registryLatest}; reconcile the true source before releasing`,
      };
    }
    return {
      action: "baseline",
      version: i.currentVersion,
      reason: "first gate run: record this hash as the released content",
    };
  }
  if (i.recordedHash === i.contentHash) {
    return {
      action: "unchanged",
      version: i.currentVersion,
      reason: "content hash matches the recorded release",
    };
  }
  return {
    action: "release",
    version: nextCalVer(i.today, [i.currentVersion, i.registryLatest]),
    reason: "content hash changed",
  };
}

/** Drop the top-level `version:` line so version bumps never change the hash. */
export function normalizeManifest(text: string): string {
  return text.split("\n").filter((l) => !/^version\s*:/.test(l)).join("\n");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Hash a package from (relative path, bytes) pairs. Order-independent;
 * `manifestPath` (relative) is normalized before hashing.
 */
export async function contentHash(
  files: Array<{ path: string; bytes: Uint8Array }>,
  manifestPath: string,
): Promise<string> {
  const enc = new TextEncoder();
  const lines: string[] = [];
  for (const f of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const bytes = f.path === manifestPath
      ? enc.encode(normalizeManifest(new TextDecoder().decode(f.bytes)))
      : f.bytes;
    lines.push(`${f.path}\0${await sha256Hex(bytes)}\n`);
  }
  return `sha256:${await sha256Hex(enc.encode(lines.join("")))}`;
}
