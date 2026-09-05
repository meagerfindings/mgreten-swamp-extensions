import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { scheduleApprovedPost } from "./zernio_publisher.ts";

const config = {
  apiKey: "write-secret",
  credentialSource: "vault" as const,
  profileId: "profile-1",
  allowedAccounts: [{ platform: "facebook" as const, accountId: "facebook-1" }],
  apiBaseUrl: "https://zernio.example/api/v1",
};
const args = {
  approvalDigest: "a".repeat(64),
  idempotencyKey: "8a7a67c6-b31a-4a14-87c4-f70cf92f0351",
  content: "Approved scheduled post",
  scheduledFor: "2030-01-01T12:00:00Z",
  timezone: "America/Chicago",
  platforms: [{ platform: "facebook" as const, accountId: "facebook-1" }],
  mediaItems: [],
};

function context() {
  const writes: Record<string, unknown>[] = [];
  return {
    writes,
    value: {
      globalArgs: config,
      logger: { info: () => undefined },
      writeResource: async (
        _spec: string,
        _name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push(data);
        return { name: "receipt" };
      },
    },
  };
}

Deno.test("scheduleApprovedPost POSTs only a future schedule with idempotency and redacts its receipt", async () => {
  const ctx = context();
  let request: Request | undefined;
  await scheduleApprovedPost(
    { ...config, ...args },
    ctx.value,
    async (input, init) => {
      request = new Request(input, init);
      return new Response(
        JSON.stringify({ post: { _id: "post-1", status: "scheduled" } }),
        { status: 201 },
      );
    },
  );
  assertEquals(request?.method, "POST");
  assertEquals(request?.headers.get("x-request-id"), args.idempotencyKey);
  assertEquals(JSON.parse(await request!.text()).publishNow, undefined);
  assertEquals(ctx.writes[0].zernioPostId, "post-1");
  assertEquals(JSON.stringify(ctx.writes[0]).includes("write-secret"), false);
});

Deno.test("scheduleApprovedPost rejects a target outside its allowlist before any request", async () => {
  const ctx = context();
  await assertRejects(
    () =>
      scheduleApprovedPost({
        ...config,
        ...args,
        platforms: [{ platform: "instagram", accountId: "instagram-1" }],
      }, ctx.value),
    Error,
    "outside the configured allowlist",
  );
});
