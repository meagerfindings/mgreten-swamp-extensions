import { z } from "npm:zod@4";

const id = z.string().trim().min(1).max(200);
const platform = z.enum(["facebook", "instagram"]);
const configSchema = z.strictObject({
  apiKey: z.string().min(1).meta({ sensitive: true }),
  credentialSource: z.literal("vault"),
  profileId: id,
  allowedAccounts: z.array(z.strictObject({ platform, accountId: id })).min(1)
    .max(20),
  apiBaseUrl: z.url().default("https://zernio.com/api/v1"),
});
const argumentsSchema = configSchema.extend({
  approvalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.uuid(),
  content: z.string().trim().min(1).max(63206),
  scheduledFor: z.iso.datetime(),
  timezone: z.string().trim().min(1).max(100),
  platforms: z.array(z.strictObject({ platform, accountId: id })).min(1).max(2),
  mediaItems: z.array(
    z.strictObject({
      type: z.enum(["image", "video"]),
      url: z.url(),
      altText: z.string().max(2000).optional(),
    }),
  ).max(10).default([]),
});
const receiptSchema = z.strictObject({
  provider: z.literal("zernio"),
  approvalDigest: z.string(),
  idempotencyKey: z.string(),
  zernioPostId: id,
  status: z.string(),
  scheduledFor: z.string(),
  observedAt: z.iso.datetime(),
});
type Context = {
  globalArgs: z.infer<typeof configSchema>;
  logger: { info(message: string): void };
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
  signal?: AbortSignal;
};

/** Schedule an approved Facebook/Instagram post. Immediate publishing is intentionally unavailable. */
export async function scheduleApprovedPost(
  args: z.infer<typeof argumentsSchema>,
  context: Context,
  fetcher: typeof fetch = fetch,
) {
  const input = argumentsSchema.parse({ ...context.globalArgs, ...args });
  const allowed = new Set(
    input.allowedAccounts.map((a) => `${a.platform}:${a.accountId}`),
  );
  if (
    input.platforms.some((a) => !allowed.has(`${a.platform}:${a.accountId}`))
  ) throw new Error("Post target is outside the configured allowlist");
  if (new Date(input.scheduledFor).getTime() <= Date.now()) {
    throw new Error("scheduledFor must be in the future");
  }
  const response = await fetcher(new URL("posts", `${input.apiBaseUrl}/`), {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
      "x-request-id": input.idempotencyKey,
    },
    body: JSON.stringify({
      content: input.content,
      scheduledFor: input.scheduledFor,
      timezone: input.timezone,
      platforms: input.platforms,
      mediaItems: input.mediaItems,
    }),
    signal: context.signal,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !body || typeof body !== "object") {
    throw new Error(`Zernio schedule failed (${response.status})`);
  }
  const post = (body as { post?: Record<string, unknown> }).post;
  if (!post) throw new Error("Zernio schedule response did not contain a post");
  const postId = typeof post._id === "string" ? post._id : null;
  if (!postId) {
    throw new Error("Zernio schedule response did not contain a post ID");
  }
  return context.writeResource(
    "scheduledPost",
    `zernio-post-${postId}`,
    receiptSchema.parse({
      provider: "zernio",
      approvalDigest: input.approvalDigest,
      idempotencyKey: input.idempotencyKey,
      zernioPostId: postId,
      status: typeof post.status === "string" ? post.status : "scheduled",
      scheduledFor: input.scheduledFor,
      observedAt: new Date().toISOString(),
    }),
  );
}

export const model = {
  type: "@mgreten/zernio-publisher",
  version: "2026.09.05.1",
  globalArguments: configSchema,
  resources: {
    scheduledPost: {
      description: "Redacted Zernio schedule receipt",
      schema: receiptSchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
  },
  methods: {
    scheduleApprovedPost: {
      description: "Schedule an approved post; cannot publish immediately",
      arguments: argumentsSchema,
      execute: async (
        args: z.infer<typeof argumentsSchema>,
        context: Context,
      ) => ({ dataHandles: [await scheduleApprovedPost(args, context)] }),
    },
  },
};
