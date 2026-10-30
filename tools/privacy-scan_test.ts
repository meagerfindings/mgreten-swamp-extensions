import { assertEquals } from "@std/assert";
import { type RuleSet, scanText } from "./privacy-scan.ts";

const rules: RuleSet = JSON.parse(await Deno.readTextFile(new URL("./privacy-rules.json", import.meta.url)));
const at = { path: "x.ts", commit: "abc" };
const ids = async (scope: "content" | "path" | "metadata", t: string) =>
  (await scanText(rules, scope, t, at)).map((h) => h.rule).sort();

Deno.test("hits never carry the matched value", async () => {
  const secret = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  const hits = await scanText(rules, "content", `const t = "${secret}";\n`, at);
  assertEquals(hits.map((h) => h.rule), ["github-token"]);
  assertEquals(JSON.stringify(hits).includes(secret), false);
  assertEquals(hits[0].line, 1);
});

Deno.test("placeholder secrets are ignored, real-looking ones are not", async () => {
  assertEquals(await ids("content", `apiKey: "your-api-key-goes-here-123456"`), []);
  assertEquals(await ids("content", `apiKey: "Zx81kQp2Lr7Vb3Nc9Wd4Ty6Hs0Jm5Fa"`), ["generic-secret-assignment"]);
});

Deno.test("CompanyCam markers, tailnet hosts, and LAN IPs are caught; public IPs are not", async () => {
  assertEquals(await ids("metadata", "Mat <mat@companycam.com>\nfix"), ["companycam"]);
  assertEquals(await ids("content", "url = 'https://roccinante.tail001dd.ts.net:3002'"), ["homelab-hostname", "tailnet-host"]);
  assertEquals(await ids("content", "host 192.168.1.20 and 100.101.4.9"), ["rfc1918-ip", "tailscale-cgnat-ip"]);
  assertEquals(await ids("content", "dns 8.8.8.8 and version 10.2.3.4.5 and 1.100.64.1"), []);
});

Deno.test("Granola transcript content reports the path once with no line", async () => {
  const transcript = "Me: hello\nThem: hi there\nMe: agenda\n";
  const hits = await scanText(rules, "content", transcript, at);
  assertEquals(hits.map((h) => [h.rule, h.line]), [["granola-speaker-turns", null]]);
  // Two speaker lines are not enough to call it a transcript.
  assertEquals(await ids("content", "Me: one\nThem: two\n"), []);
});
