// TOTP (RFC 6238) derivation for MFA-enabled UniFi accounts.
//
// UniFi SSO accounts with MFA enabled reject password-only logins to
// /api/auth/login with {"code":"MFA_AUTH_REQUIRED"}. Deriving the code
// in-process from the account's TOTP seed keeps model methods runnable
// unattended — no authenticator app in the loop. Zero dependencies:
// HMAC-SHA1 comes from WebCrypto.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Decode a base32 (RFC 4648) secret into bytes.
 *
 * Tolerates lowercase, embedded whitespace and trailing `=` padding, which is
 * how TOTP seeds are usually presented by authenticator apps.
 *
 * @param input Base32-encoded secret.
 * @returns The decoded bytes.
 * @throws If the input is empty or contains a non-base32 character.
 */
export function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const clean = input.toUpperCase().replace(/\s+/g, "").replace(/=+$/, "");
  if (clean.length === 0) throw new Error("Empty base32 secret");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  // Back the view with a concrete ArrayBuffer so it satisfies BufferSource.
  const view = new Uint8Array(new ArrayBuffer(out.length));
  view.set(out);
  return view;
}

/**
 * Derive an RFC 6238 TOTP code (HMAC-SHA1) from a base32 secret.
 *
 * `nowMs` is injectable rather than read internally so the function is
 * deterministic and testable against the RFC's reference vectors; callers
 * normally omit it.
 *
 * @param secret Base32-encoded shared secret.
 * @param nowMs Current time in milliseconds since the epoch.
 * @param stepSeconds Time step; the RFC default is 30 seconds.
 * @param digits Code length; the RFC default is 6.
 * @returns The zero-padded numeric code.
 */
export async function totpCode(
  secret: string,
  nowMs: number = Date.now(),
  stepSeconds = 30,
  digits = 6,
): Promise<string> {
  const counter = Math.floor(nowMs / 1000 / stepSeconds);
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);

  const key = await crypto.subtle.importKey(
    "raw",
    base32Decode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const offset = sig[sig.length - 1] & 0x0f;
  const bin = ((sig[offset] & 0x7f) << 24) |
    (sig[offset + 1] << 16) |
    (sig[offset + 2] << 8) |
    sig[offset + 3];
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}
