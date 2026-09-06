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

Deno.test("scheduleApprovedPost accepts real newlines and Unicode characters in content", async () => {
  const ctx = context();
  await scheduleApprovedPost(
    {
      ...config,
      ...args,
      content: "Moment Savor\n\n“The ordinary days are the ones we miss.”",
    },
    ctx.value,
    async (_input, init) => {
      return new Response(
        JSON.stringify({ post: { _id: "post-newlines", status: "scheduled" } }),
        { status: 201 },
      );
    },
  );
  assertEquals(ctx.writes[0].zernioPostId, "post-newlines");
});

Deno.test("scheduleApprovedPost rejects literal escape sequences in content before any request", async () => {
  const ctx = context();
  let requested = false;
  await assertRejects(
    () =>
      scheduleApprovedPost({
        ...config,
        ...args,
        content: "Moment Savor\\n\\nThe ordinary days",
      }, ctx.value, async () => {
        requested = true;
        return new Response("{}", { status: 201 });
      }),
    Error,
    "literal escape sequence",
  );
  assertEquals(requested, false);
  assertEquals(ctx.writes.length, 0);
});

Deno.test("scheduleApprovedPost rejects literal unicode escapes in media alt text before any request", async () => {
  const ctx = context();
  let requested = false;
  await assertRejects(
    () =>
      scheduleApprovedPost({
        ...config,
        ...args,
        mediaItems: [{
          type: "image" as const,
          url: "https://example.test/image.png",
          altText: "Moment Savor - \\u201cThe ordinary days\\u201d",
        }],
      }, ctx.value, async () => {
        requested = true;
        return new Response("{}", { status: 201 });
      }),
    Error,
    "mediaItems[0].altText",
  );
  assertEquals(requested, false);
  assertEquals(ctx.writes.length, 0);
});
