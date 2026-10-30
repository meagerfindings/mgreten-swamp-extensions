/**
 * Send push notifications via ntfy.sh from swamp workflows and models.
 * Supports the public ntfy.sh service and self-hosted ntfy instances.
 *
 * @module
 */

import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  ntfyUrl: z.string().default("https://ntfy.sh"),
  defaultTopic: z.string().describe("NTFY topic to send to (e.g. 'my-alerts')"),
});

const NotificationSchema = z.object({
  topic: z.string(),
  title: z.string(),
  message: z.string(),
  priority: z.number().min(1).max(5),
  tags: z.array(z.string()).optional(),
  sentAt: z.string(),
  httpStatus: z.number(),
  success: z.boolean(),
});

const OutboxPayloadSchema = z.object({
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(4096),
}).strict().meta({ sensitive: true });

const OutboxOptionsSchema = z.object({
  topic: z.string().min(1).max(256).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  tags: z.array(z.string().min(1).max(64)).max(20).optional(),
  actions: z.array(
    z.object({
      action: z.string().min(1).max(32),
      label: z.string().min(1).max(100),
      url: z.string().url().max(2048),
    }).strict(),
  ).max(3).optional(),
}).strict();

const OutboxTransportArgumentsSchema = z.object({
  payload: OutboxPayloadSchema,
  idempotencyKey: z.string().min(1).max(256),
  options: OutboxOptionsSchema,
  ntfyUrl: z.string().optional().describe(
    "Runtime-populated model configuration; callers should omit",
  ),
  defaultTopic: z.string().optional().describe(
    "Runtime-populated model configuration; callers should omit",
  ),
}).strict();

type SendArguments = {
  topic?: string;
  title: string;
  message: string;
  priority?: number;
  tags?: string[];
  actions?: Array<{ action: string; label: string; url: string }>;
};

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

async function sendNotification(
  args: SendArguments,
  context: MethodContext,
  throwOnFailure = false,
): Promise<{ dataHandles: Record<string, unknown>[] }> {
  const topic = args.topic || context.globalArgs.defaultTopic;
  const priority = args.priority ?? 3;
  const ntfyUrl = `${context.globalArgs.ntfyUrl}/${encodeURIComponent(topic)}`;

  context.logger.info("Sending NTFY notification to topic {topic}", { topic });

  const headers: Record<string, string> = {
    "Title": args.title,
    "Priority": String(priority),
  };
  if (args.tags && args.tags.length > 0) headers["Tags"] = args.tags.join(",");
  if (args.actions && args.actions.length > 0) {
    headers["Actions"] = args.actions
      .map((action) => `${action.action}, ${action.label}, ${action.url}`)
      .join("; ");
  }

  let httpStatus = 0;
  let success = false;
  let failureMessage = "NTFY request failed before receiving a response";

  try {
    const response = await fetch(ntfyUrl, {
      method: "POST",
      headers,
      body: args.message,
      signal: AbortSignal.timeout(30_000),
    });
    httpStatus = response.status;
    success = response.ok;

    if (success) {
      context.logger.info("Notification sent successfully (HTTP {status})", {
        status: httpStatus,
      });
    } else {
      failureMessage = `NTFY returned HTTP ${httpStatus} ${response.statusText}`
        .trim();
      context.logger.warning("NTFY returned HTTP {status} {statusText}", {
        status: httpStatus,
        statusText: response.statusText,
      });
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    failureMessage = `NTFY request failed: ${errorMsg}`;
    context.logger.error("Failed to send NTFY notification: {error}", {
      error: errorMsg,
    });
  }

  if (throwOnFailure && !success) throw new Error(failureMessage);

  const handle = await context.writeResource(
    "notification",
    `notification-${Date.now()}-${crypto.randomUUID()}`,
    {
      topic,
      title: args.title,
      message: args.message,
      priority,
      tags: args.tags,
      sentAt: new Date().toISOString(),
      httpStatus,
      success,
    },
  );

  return { dataHandles: [handle] };
}

/** Swamp model for sending push notifications via ntfy.sh. */
export const model = {
  type: "@mgreten/ntfy-notify",
  version: "2026.08.23.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.08.23.1",
      description: "Add the generic outbox transport compatibility method",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    notification: {
      description: "Record of a sent NTFY notification",
      schema: NotificationSchema,
      lifetime: "7d" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    send: {
      description: "Send a notification to NTFY via HTTP POST",
      arguments: z.object({
        topic: z.string().optional().describe(
          "NTFY topic (defaults to globalArgs.defaultTopic)",
        ),
        title: z.string().describe("Notification title"),
        message: z.string().describe("Notification body message"),
        priority: z.number().min(1).max(5).optional().default(3).describe(
          "Priority 1 (min) to 5 (max)",
        ),
        tags: z.array(z.string()).optional().describe(
          "Optional emoji/tag strings",
        ),
        actions: z.array(z.object({
          action: z.string().describe("Action type (e.g. 'view')"),
          label: z.string().describe("Button label"),
          url: z.string().describe("URL to open"),
        })).optional().describe(
          "Clickable action buttons",
        ),
      }),
      execute: async (
        args: SendArguments,
        context: MethodContext,
      ) => await sendNotification(args, context),
    },
    sendOutboxTransport: {
      description:
        "Send a generic notification-outbox payload through NTFY (at-least-once)",
      arguments: OutboxTransportArgumentsSchema,
      execute: async (
        args: z.infer<typeof OutboxTransportArgumentsSchema>,
        context: MethodContext,
      ): Promise<{ dataHandles: Record<string, unknown>[] }> => {
        context.logger.info(
          "Sending outbox notification through NTFY (idempotency is caller-managed)",
        );
        return await sendNotification(
          { ...args.payload, ...args.options },
          context,
          true,
        );
      },
    },
  },
};
