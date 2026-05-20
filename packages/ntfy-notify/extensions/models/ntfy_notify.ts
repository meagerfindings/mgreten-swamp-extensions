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
}).passthrough();

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

/** Swamp model for sending push notifications via ntfy.sh. */
export const model = {
  type: "@mgreten/ntfy-notify",
  version: "2026.05.20.1",
  globalArguments: GlobalArgsSchema,
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
      }),
      execute: async (
        args: {
          topic?: string;
          title: string;
          message: string;
          priority?: number;
          tags?: string[];
        },
        context: MethodContext,
      ) => {
        const topic = args.topic || context.globalArgs.defaultTopic;
        const priority = args.priority ?? 3;
        const ntfyUrl = `${context.globalArgs.ntfyUrl}/${topic}`;

        context.logger.info("Sending NTFY notification to {url}", {
          url: ntfyUrl,
        });

        const headers: Record<string, string> = {
          "Title": args.title,
          "Priority": String(priority),
        };
        if (args.tags && args.tags.length > 0) {
          headers["Tags"] = args.tags.join(",");
        }

        let httpStatus = 0;
        let success = false;

        try {
          const response = await fetch(ntfyUrl, {
            method: "POST",
            headers,
            body: args.message,
          });
          httpStatus = response.status;
          success = response.ok;

          if (success) {
            context.logger.info(
              "Notification sent successfully (HTTP {status})",
              { status: httpStatus },
            );
          } else {
            const responseBody = await response.text();
            context.logger.warning("NTFY returned HTTP {status}: {body}", {
              status: httpStatus,
              body: responseBody.slice(0, 500),
            });
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          context.logger.error("Failed to send NTFY notification: {error}", {
            error: errorMsg,
          });
        }

        const notification = {
          topic,
          title: args.title,
          message: args.message,
          priority,
          tags: args.tags,
          sentAt: new Date().toISOString(),
          httpStatus,
          success,
        };

        const handle = await context.writeResource(
          "notification",
          `notification-${Date.now()}`,
          notification as unknown as Record<string, unknown>,
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
