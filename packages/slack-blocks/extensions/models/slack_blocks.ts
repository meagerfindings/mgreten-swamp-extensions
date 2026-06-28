/**
 * Post Block Kit messages to Slack via the Slack Web API, with optional file
 * attachments uploaded through the modern `files.getUploadURLExternal` flow.
 *
 * Intended for swamp models that need richer alert formatting than plain text —
 * structured fields, image blocks, action buttons, threaded replies — without
 * each consumer re-implementing the Slack auth and three-step file-upload
 * dance.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Schema for global arguments shared across all methods on this model. */
const GlobalArgsSchema: z.ZodObject<{
  botToken: z.ZodString;
  defaultChannel: z.ZodOptional<z.ZodString>;
}> = z.object({
  botToken: z
    .string()
    .describe(
      "Slack bot token (xoxb-...). Needs scopes: chat:write, files:write.",
    )
    .meta({ sensitive: true }),
  defaultChannel: z
    .string()
    .optional()
    .describe(
      "Channel ID or name used when a method call omits `channel`.",
    ),
});

/** Schema for a single Block Kit block — accepts any shape; Slack validates block structure. */
const BlockSchema: z.ZodRecord<z.ZodString, z.ZodUnknown> = z.record(
  z.string(),
  z.unknown(),
);

/** Schema for an audited Slack message record. */
const SlackMessageSchema = z.object({
  channel: z.string(),
  ts: z.string().nullable(),
  threadTs: z.string().nullable(),
  text: z.string(),
  blockCount: z.number(),
  fileCount: z.number(),
  fileIds: z.array(z.string()),
  httpStatus: z.number(),
  success: z.boolean(),
  slackError: z.string().nullable(),
  sentAt: z.string(),
});

/** Schema for a Slack `auth.test` response surfaced by `verifyAuth`. */
const AuthTestSchema = z.object({
  ok: z.boolean(),
  team: z.string().nullable(),
  user: z.string().nullable(),
  teamId: z.string().nullable(),
  userId: z.string().nullable(),
  botId: z.string().nullable(),
  checkedAt: z.string(),
  slackError: z.string().nullable(),
});

type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

type SlackFileSpec = {
  path: string;
  filename?: string;
  altText?: string;
  title?: string;
};

type UploadedFile = {
  id: string;
  title: string;
};

/**
 * Resolve a channel name from explicit arg or globalArgs.defaultChannel.
 *
 * @param explicit - Channel passed to a method call.
 * @param fallback - Value of `globalArgs.defaultChannel`.
 * @returns The channel to use for the API call.
 * @throws When neither is set.
 */
function resolveChannel(
  explicit: string | undefined,
  fallback: string | undefined,
): string {
  const channel = explicit || fallback;
  if (!channel) {
    throw new Error(
      "No channel: pass `channel` to the method or set `defaultChannel` in globalArgs.",
    );
  }
  return channel;
}

/**
 * Call a Slack Web API method via JSON POST.
 *
 * @param method - Slack method name (e.g. "chat.postMessage").
 * @param body - JSON-serializable request body.
 * @param token - Bot token (xoxb-...).
 * @returns Parsed JSON response plus HTTP status.
 */
async function slackApiPost(
  method: string,
  body: Record<string, unknown>,
  token: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json() as Record<string, unknown>;
  return { status: response.status, data };
}

/**
 * Upload one file to Slack and share it into a channel thread.
 *
 * Three-step flow:
 *   1. `files.getUploadURLExternal` returns a one-time upload URL and file ID.
 *   2. POST the bytes to that URL.
 *   3. `files.completeUploadExternal` finalizes the upload AND shares the file
 *      into the given channel + thread. The share target must be supplied at
 *      finalization time — `completeUploadExternal` can only be called once
 *      per file, and there is no separate "share a finalized file" API.
 *
 * @param file - File spec with local path and optional metadata.
 * @param channelId - Channel to share the file into.
 * @param threadTs - Thread ts to share the file under (required so the file
 *   does not also create a top-level channel post).
 * @param token - Bot token.
 * @returns The uploaded file's Slack ID and resolved title.
 */
async function uploadFile(
  file: SlackFileSpec,
  channelId: string,
  threadTs: string,
  token: string,
): Promise<UploadedFile> {
  const bytes = await Deno.readFile(file.path);
  const filename = file.filename ||
    file.path.split("/").pop() ||
    "upload.bin";
  const title = file.title || filename;

  const params = new URLSearchParams({
    filename,
    length: String(bytes.byteLength),
  });
  const getUrlResp = await fetch(
    `https://slack.com/api/files.getUploadURLExternal?${params.toString()}`,
    {
      method: "GET",
      headers: { "Authorization": `Bearer ${token}` },
    },
  );
  const getUrlData = await getUrlResp.json() as Record<string, unknown>;
  if (!getUrlData.ok) {
    throw new Error(
      `getUploadURLExternal failed for ${filename}: ${
        String(getUrlData.error ?? "unknown")
      }`,
    );
  }
  const uploadUrl = String(getUrlData.upload_url);
  const fileId = String(getUrlData.file_id);

  const putResp = await fetch(uploadUrl, {
    method: "POST",
    body: bytes,
  });
  if (!putResp.ok) {
    throw new Error(
      `Upload PUT failed for ${filename} (HTTP ${putResp.status})`,
    );
  }
  // Drain the body so Deno does not leak the response.
  await putResp.body?.cancel();

  const completeResp = await slackApiPost(
    "files.completeUploadExternal",
    {
      files: [{ id: fileId, title }],
      channel_id: channelId,
      thread_ts: threadTs,
    },
    token,
  );
  if (!completeResp.data.ok) {
    throw new Error(
      `completeUploadExternal failed for ${filename}: ${
        String(completeResp.data.error ?? "unknown")
      }`,
    );
  }

  return { id: fileId, title };
}

/**
 * Swamp model for posting Block Kit messages and file attachments to Slack.
 */
export const model = {
  type: "@mgreten/slack-blocks",
  version: "2026.06.27.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    slackMessage: {
      description:
        "Audit record of a posted Slack message: channel, ts, file count, success.",
      schema: SlackMessageSchema,
      lifetime: "14d" as const,
      garbageCollection: 100,
    },
    authCheck: {
      description: "Result of an auth.test verification call.",
      schema: AuthTestSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    send: {
      description:
        "Post a Block Kit message to Slack via chat.postMessage. `text` is required as the notification/accessibility fallback.",
      arguments: z.object({
        channel: z.string().optional().describe(
          "Channel ID or name (defaults to globalArgs.defaultChannel).",
        ),
        text: z.string().describe(
          "Plain-text fallback shown in notifications and accessibility tools.",
        ),
        blocks: z.array(BlockSchema).describe(
          "Array of Block Kit block objects.",
        ),
        threadTs: z.string().optional().describe(
          "Parent message ts to reply in a thread.",
        ),
      }),
      execute: async (
        args: {
          channel?: string;
          text: string;
          blocks: Record<string, unknown>[];
          threadTs?: string;
        },
        context: MethodContext,
      ) => {
        const channel = resolveChannel(
          args.channel,
          context.globalArgs.defaultChannel,
        );

        context.logger.info("Posting Slack message to {channel}", { channel });

        const body: Record<string, unknown> = {
          channel,
          text: args.text,
          blocks: args.blocks,
        };
        if (args.threadTs) body.thread_ts = args.threadTs;

        const { status, data } = await slackApiPost(
          "chat.postMessage",
          body,
          context.globalArgs.botToken,
        );

        const success = Boolean(data.ok);
        const slackError = success ? null : String(data.error ?? "unknown");
        if (!success) {
          context.logger.warning(
            "Slack chat.postMessage failed: {error}",
            { error: slackError },
          );
        }

        const record = {
          channel,
          ts: typeof data.ts === "string" ? data.ts : null,
          threadTs: args.threadTs ?? null,
          text: args.text,
          blockCount: args.blocks.length,
          fileCount: 0,
          fileIds: [],
          httpStatus: status,
          success,
          slackError,
          sentAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "slackMessage",
          `message-${Date.now()}`,
          record as unknown as Record<string, unknown>,
        );

        return { dataHandles: [handle] };
      },
    },
    sendWithFiles: {
      description:
        "Post a Block Kit message, then upload local files and share them as a thread reply under that message. Result: one thread containing the alert message followed by the file attachments. Slack's API does not support embedding files directly inside a Block Kit message, so the files land as a sibling thread reply (never as a top-level channel post).",
      arguments: z.object({
        channel: z.string().optional().describe(
          "Channel ID or name (defaults to globalArgs.defaultChannel).",
        ),
        text: z.string().describe(
          "Plain-text fallback shown in notifications.",
        ),
        blocks: z.array(BlockSchema).describe(
          "Block Kit blocks for the message body.",
        ),
        files: z.array(
          z.object({
            path: z.string().describe("Absolute or cwd-relative file path."),
            filename: z.string().optional().describe(
              "Overrides the on-disk filename when uploading.",
            ),
            title: z.string().optional().describe(
              "Display title in Slack (defaults to filename).",
            ),
            altText: z.string().optional().describe(
              "Reserved for future image-block wiring; currently unused.",
            ),
          }),
        ).min(1).describe(
          "Files to upload and attach as a thread reply under the posted message.",
        ),
        threadTs: z.string().optional().describe(
          "Optional outer thread ts. When set, both the Block Kit message and the file attachments are placed inside that existing thread.",
        ),
      }),
      execute: async (
        args: {
          channel?: string;
          text: string;
          blocks: Record<string, unknown>[];
          files: SlackFileSpec[];
          threadTs?: string;
        },
        context: MethodContext,
      ) => {
        const channel = resolveChannel(
          args.channel,
          context.globalArgs.defaultChannel,
        );
        const token = context.globalArgs.botToken;

        context.logger.info(
          "Posting Slack message to {channel}, will attach {count} file(s) under its thread",
          { channel, count: args.files.length },
        );

        const messageBody: Record<string, unknown> = {
          channel,
          text: args.text,
          blocks: args.blocks,
        };
        if (args.threadTs) messageBody.thread_ts = args.threadTs;

        const { status, data } = await slackApiPost(
          "chat.postMessage",
          messageBody,
          token,
        );

        const success = Boolean(data.ok);
        const slackError = success ? null : String(data.error ?? "unknown");
        const messageTs = typeof data.ts === "string" ? data.ts : null;

        if (!success) {
          context.logger.warning(
            "Slack chat.postMessage failed: {error}",
            { error: slackError },
          );
        }

        const uploaded: UploadedFile[] = [];
        const uploadErrors: string[] = [];

        // Share each file into the just-posted message's thread. If the
        // message itself failed, skip uploads entirely — there is no thread
        // to share into.
        if (success && messageTs) {
          for (const file of args.files) {
            try {
              const result = await uploadFile(
                file,
                channel,
                messageTs,
                token,
              );
              uploaded.push(result);
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              context.logger.warning(
                "File upload failed: {error}",
                { error: errorMsg },
              );
              uploadErrors.push(errorMsg);
            }
          }
        }

        const fileIds = uploaded.map((u) => u.id);

        const record = {
          channel,
          ts: messageTs,
          threadTs: args.threadTs ?? null,
          text: args.text,
          blockCount: args.blocks.length,
          fileCount: fileIds.length,
          fileIds,
          httpStatus: status,
          success: success && uploadErrors.length === 0,
          slackError: slackError ??
            (uploadErrors.length > 0
              ? `file_upload_failed: ${uploadErrors.join("; ")}`
              : null),
          sentAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "slackMessage",
          `message-${Date.now()}`,
          record as unknown as Record<string, unknown>,
        );

        return { dataHandles: [handle] };
      },
    },
    verifyAuth: {
      description:
        "Call auth.test to confirm the bot token works. Useful after vault setup.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const { data } = await slackApiPost(
          "auth.test",
          {},
          context.globalArgs.botToken,
        );

        const ok = Boolean(data.ok);
        const slackError = ok ? null : String(data.error ?? "unknown");
        if (!ok) {
          context.logger.warning("Slack auth.test failed: {error}", {
            error: slackError,
          });
        }

        const record = {
          ok,
          team: typeof data.team === "string" ? data.team : null,
          user: typeof data.user === "string" ? data.user : null,
          teamId: typeof data.team_id === "string" ? data.team_id : null,
          userId: typeof data.user_id === "string" ? data.user_id : null,
          botId: typeof data.bot_id === "string" ? data.bot_id : null,
          checkedAt: new Date().toISOString(),
          slackError,
        };

        const handle = await context.writeResource(
          "authCheck",
          `auth-${Date.now()}`,
          record as unknown as Record<string, unknown>,
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
