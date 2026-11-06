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

/**
 * Literal `\n` / `\r` / `\t` / `\uXXXX` sequences in caption text are almost
 * always shell or JSON double-encoding artifacts (the value was escaped one
 * extra time between the caller and this model). Zernio stores such sequences
 * verbatim and publishes them literally, so reject them before scheduling.
 */
const mangledEscapePattern = /\\[nrt]|\\u[0-9a-fA-F]{4}/;

export function rejectMangledEscapes(value: string, field: string): void {
  if (mangledEscapePattern.test(value)) {
    throw new Error(
      `${field} contains a literal escape sequence (for example \\n or \\u201c) instead of a real ` +
        "newline or character. The caption would publish with visible backslash artifacts. " +
        "Pass the text with real newlines and characters - prefer --input-file (YAML) or JSON input - and schedule again.",
    );
  }
}
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
  rejectMangledEscapes(input.content, "content");
  input.mediaItems.forEach((item, index) => {
    if (item.altText !== undefined) {
      rejectMangledEscapes(item.altText, `mediaItems[${index}].altText`);
    }
  });
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

/** Schedule-only Zernio publishing model; cannot publish immediately and rejects mangled caption text. */
export const model = {
  type: "@mgreten/zernio-publisher",
  version: "2026.09.06.1",
  upgrades: [
    {
      toVersion: "2026.09.06.1",
      description:
        "Reject literal escape sequences in captions; no schema changes",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
  ],
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
