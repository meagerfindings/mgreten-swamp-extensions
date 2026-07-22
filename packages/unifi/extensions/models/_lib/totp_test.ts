import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { base32Decode, totpCode } from "./totp.ts";

// RFC 6238 Appendix B reference vectors (SHA-1, secret "12345678901234567890").
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

Deno.test("totpCode matches RFC 6238 vector at T=59", async () => {
  assertEquals(await totpCode(RFC_SECRET, 59_000, 30, 8), "94287082");
});

Deno.test("totpCode matches RFC 6238 vector at T=1111111109", async () => {
  assertEquals(await totpCode(RFC_SECRET, 1_111_111_109_000, 30, 8), "07081804");
});

Deno.test("totpCode matches RFC 6238 vector at T=1234567890", async () => {
  assertEquals(await totpCode(RFC_SECRET, 1_234_567_890_000, 30, 8), "89005924");
});

Deno.test("totpCode defaults to 6 digits and zero-pads", async () => {
  const code = await totpCode(RFC_SECRET, 59_000);
  assertEquals(code, "287082");
  assertEquals(code.length, 6);
});

Deno.test("totpCode is stable within a 30s step and rolls at the boundary", async () => {
  const a = await totpCode(RFC_SECRET, 30_000);
  const b = await totpCode(RFC_SECRET, 59_999);
  const c = await totpCode(RFC_SECRET, 60_000);
  assertEquals(a, b);
  assertEquals(a === c, false);
});

Deno.test("base32Decode handles padding, lowercase and whitespace", () => {
  assertEquals(base32Decode("MZXW6==="), base32Decode("mzxw6"));
  assertEquals(base32Decode("MZXW 6"), base32Decode("MZXW6"));
});

Deno.test("base32Decode rejects invalid input", () => {
  assertThrows(() => base32Decode("MZXW1"), Error, "Invalid base32");
  assertThrows(() => base32Decode(""), Error, "Empty base32");
});
