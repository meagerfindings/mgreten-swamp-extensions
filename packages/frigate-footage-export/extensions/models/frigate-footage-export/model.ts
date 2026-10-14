/**
 * Generic Frigate footage and event export model.
 *
 * Queries events and recording availability without transferring video. Export
 * creation is explicit and dry-run-first; Frigate performs the server-side
 * rendering and keeps the resulting files under its own export management.
 *
 * @module
 */
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  apiBaseUrl: z.string().url().describe(
    "Frigate API root, including /api (for example https://frigate.example.com/api)",
  ),
  apiToken: z.string().default("").meta({ sensitive: true }).describe(
    "Optional Frigate bearer token. Supply with a Swamp vault expression, never inline.",
  ),
  requestTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const EventSchema = z.object({
  id: z.string(),
  camera: z.string(),
  label: z.string(),
  startTime: z.number(),
  endTime: z.number().nullable(),
  hasClip: z.boolean(),
  hasSnapshot: z.boolean(),
  zones: z.array(z.string()),
  severity: z.string().nullable(),
});
type Event = z.infer<typeof EventSchema>;

const EventQuerySchema = z.object({
  queriedAt: z.iso.datetime(),
  after: z.number(),
  before: z.number(),
  cameras: z.array(z.string()),
  labels: z.array(z.string()),
  requireClip: z.boolean(),
  limit: z.number().int().positive(),
  events: z.array(EventSchema),
  count: z.number().int().nonnegative(),
  possiblyTruncated: z.boolean(),
});

const RecordingWindowSchema = z.object({
  inspectedAt: z.iso.datetime(),
  camera: z.string(),
  after: z.number(),
  before: z.number(),
  segmentCount: z.number().int().nonnegative(),
  segments: z.array(z.unknown()),
});

const ExportPlanItemSchema = z.object({
  camera: z.string(),
  startTime: z.number(),
  endTime: z.number(),
  name: z.string(),
  playback: z.enum(["realtime", "timelapse_25x"]),
  source: z.enum(["recordings", "preview"]),
  chapters: z.enum(["none", "recording_segments"]).nullable(),
});
type ExportPlanItem = z.infer<typeof ExportPlanItemSchema>;
type ExportPlanArgs = {
  topic: string;
  cameras: string[];
  startTime: number;
  endTime: number;
  playback: "realtime" | "timelapse_25x";
  source: "recordings" | "preview";
  chapters: "none" | "recording_segments" | null;
};
type ExportRunItem = {
  camera: string;
  name: string;
  status: "planned" | "created" | "failed";
  exportId?: string;
  inProgress?: boolean;
  error?: string;
};

const ExportPlanSchema = z.object({
  plannedAt: z.iso.datetime(),
  topic: z.string(),
  items: z.array(ExportPlanItemSchema).min(1),
});
type ExportPlan = z.infer<typeof ExportPlanSchema>;

const ExportResultSchema = z.object({
  attemptedAt: z.iso.datetime(),
  dryRun: z.boolean(),
  topic: z.string(),
  planned: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(z.object({
    camera: z.string(),
    name: z.string(),
    status: z.enum(["planned", "created", "failed"]),
    exportId: z.string().optional(),
    inProgress: z.boolean().optional(),
    error: z.string().optional(),
  })),
});

interface Context {
  globalArgs: GlobalArgs;
  signal: AbortSignal;
  logger: {
    info: (message: string, props?: Record<string, unknown>) => void;
    warning?: (message: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    value: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}
type Handles = { dataHandles: Array<{ name: string }> };

/** Normalize an API root without changing its path prefix. */
export function normalizeApiBase(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Produce a Frigate-safe, human-readable export name (max 256 characters). */
export function buildExportName(
  topic: string,
  camera: string,
  startTime: number,
): string {
  const safeTopic = topic.trim().replace(/[^a-zA-Z0-9._ -]+/g, "-").replace(
    /\s+/g,
    " ",
  );
  const safeCamera = camera.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  const stamp = new Date(startTime * 1_000).toISOString().replace(/[:.]/g, "-");
  return `${safeTopic || "frigate-export"} - ${safeCamera} - ${stamp}`.slice(
    0,
    256,
  );
}

/** Create one export request per requested camera. */
export function buildExportPlan(input: {
  topic: string;
  cameras: string[];
  startTime: number;
  endTime: number;
  playback: "realtime" | "timelapse_25x";
  source: "recordings" | "preview";
  chapters: "none" | "recording_segments" | null;
}): ExportPlan {
  if (input.endTime <= input.startTime) {
    throw new Error("endTime must be later than startTime.");
  }
  const cameras = [
    ...new Set(input.cameras.map((camera) => camera.trim()).filter(Boolean)),
  ];
  if (cameras.length === 0) throw new Error("At least one camera is required.");
  return {
    plannedAt: new Date().toISOString(),
    topic: input.topic.trim() || "Frigate export",
    items: cameras.map((camera) => ({
      camera,
      startTime: input.startTime,
      endTime: input.endTime,
      name: buildExportName(input.topic, camera, input.startTime),
      playback: input.playback,
      source: input.source,
      chapters: input.chapters,
    })),
  };
}

/** Fetch JSON while enforcing timeout, authentication, and actionable errors. */
async function frigateJson<T>(
  globalArgs: GlobalArgs,
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    globalArgs.requestTimeoutMs,
  );
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (globalArgs.apiToken) {
      headers.set("Authorization", `Bearer ${globalArgs.apiToken}`);
    }
    const response = await fetch(
      `${normalizeApiBase(globalArgs.apiBaseUrl)}${path}`,
      {
        ...init,
        headers,
        signal: controller.signal,
      },
    );
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `Frigate ${
          init.method ?? "GET"
        } ${path} failed with HTTP ${response.status}: ${body.slice(0, 500)}`,
      );
    }
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(
        `Frigate ${init.method ?? "GET"} ${path} returned invalid JSON.`,
      );
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** Safely map Frigate's evolving event payload to the public resource contract. */
export function toEvent(value: unknown): Event {
  const raw = value as Record<string, unknown>;
  const data =
    (raw.data && typeof raw.data === "object" ? raw.data : {}) as Record<
      string,
      unknown
    >;
  return EventSchema.parse({
    id: String(raw.id ?? ""),
    camera: String(raw.camera ?? ""),
    label: String(raw.label ?? ""),
    startTime: Number(raw.start_time),
    endTime: typeof raw.end_time === "number" ? raw.end_time : null,
    hasClip: Boolean(raw.has_clip),
    hasSnapshot: Boolean(raw.has_snapshot),
    zones: Array.isArray(raw.zones) ? raw.zones.map(String) : [],
    severity: typeof data.max_severity === "string" ? data.max_severity : null,
  });
}

/** Model definition for bounded Frigate event and footage-export operations. */
export const model = {
  type: "@mgreten/frigate-footage-export",
  version: "2026.07.19.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    eventQuery: {
      description: "Filtered Frigate event metadata; no media is downloaded",
      schema: EventQuerySchema,
      lifetime: "1d" as const,
      garbageCollection: 20,
    },
    recordingWindow: {
      description:
        "Frigate recording segment metadata for one camera and time window",
      schema: RecordingWindowSchema,
      lifetime: "1d" as const,
      garbageCollection: 50,
    },
    exportPlan: {
      description: "Dry-run plan for one Frigate export per camera",
      schema: ExportPlanSchema,
      lifetime: "1d" as const,
      garbageCollection: 20,
    },
    exportResult: {
      description:
        "Server-side Frigate export creation outcome; video stays in Frigate",
      schema: ExportResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    listEvents: {
      description:
        "List event metadata by time, camera, and object label without downloading media.",
      arguments: z.object({
        after: z.number().describe("Unix start timestamp in seconds."),
        before: z.number().describe("Unix end timestamp in seconds."),
        cameras: z.array(z.string().min(1)).default([]),
        labels: z.array(z.string().min(1)).default([]),
        requireClip: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      execute: async (
        args: {
          after: number;
          before: number;
          cameras: string[];
          labels: string[];
          requireClip: boolean;
          limit: number;
        },
        context: Context,
      ): Promise<Handles> => {
        if (args.before <= args.after) {
          throw new Error("before must be later than after.");
        }
        const query = new URLSearchParams({
          after: String(args.after),
          before: String(args.before),
          limit: String(args.limit),
          include_thumbnails: "0",
          timezone: "utc",
        });
        if (args.cameras.length) query.set("cameras", args.cameras.join(","));
        if (args.labels.length) query.set("labels", args.labels.join(","));
        if (args.requireClip) query.set("has_clip", "1");
        context.logger.info(
          "Listing Frigate events for {cameraCount} camera filter(s) and {labelCount} label filter(s)",
          { cameraCount: args.cameras.length, labelCount: args.labels.length },
        );
        const response = await frigateJson<unknown[]>(
          context.globalArgs,
          `/events?${query}`,
          {},
          context.signal,
        );
        const events = response.map(toEvent);
        const result = {
          queriedAt: new Date().toISOString(),
          ...args,
          events,
          count: events.length,
          possiblyTruncated: events.length >= args.limit,
        };
        const handle = await context.writeResource(
          "eventQuery",
          "latest",
          result,
        );
        context.logger.info("Found {count} Frigate events", {
          count: events.length,
        });
        return { dataHandles: [handle] };
      },
    },
    inspectRecordings: {
      description:
        "Inspect recording metadata for one camera/time window before requesting an export.",
      arguments: z.object({
        camera: z.string().min(1),
        after: z.number(),
        before: z.number(),
      }),
      execute: async (
        args: { camera: string; after: number; before: number },
        context: Context,
      ): Promise<Handles> => {
        if (args.before <= args.after) {
          throw new Error("before must be later than after.");
        }
        context.logger.info("Inspecting Frigate recordings for {camera}", {
          camera: args.camera,
        });
        const query = new URLSearchParams({
          after: String(args.after),
          before: String(args.before),
        });
        const raw = await frigateJson<unknown>(
          context.globalArgs,
          `/${encodeURIComponent(args.camera)}/recordings?${query}`,
          {},
          context.signal,
        );
        const segments = Array.isArray(raw) ? raw : [];
        const handle = await context.writeResource(
          "recordingWindow",
          "latest",
          {
            inspectedAt: new Date().toISOString(),
            ...args,
            segmentCount: segments.length,
            segments,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    planExports: {
      description:
        "Create a dry-run plan for a named Frigate export per camera. This never creates footage exports.",
      arguments: z.object({
        topic: z.string().min(1).max(160),
        cameras: z.array(z.string().min(1)).min(1),
        startTime: z.number(),
        endTime: z.number(),
        playback: z.enum(["realtime", "timelapse_25x"]).default("realtime"),
        source: z.enum(["recordings", "preview"]).default("recordings"),
        chapters: z.enum(["none", "recording_segments"]).nullable().default(
          "recording_segments",
        ),
      }),
      execute: async (
        args: ExportPlanArgs,
        context: Context,
      ): Promise<Handles> => {
        const plan = buildExportPlan(args);
        context.logger.info("Planned {count} Frigate export(s) for {topic}", {
          count: plan.items.length,
          topic: plan.topic,
        });
        const handle = await context.writeResource(
          "exportPlan",
          "latest",
          plan,
        );
        return { dataHandles: [handle] };
      },
    },
    createExports: {
      description:
        "Create named, server-side Frigate exports from an explicit plan. dryRun=true by default.",
      arguments: z.object({
        plan: ExportPlanSchema,
        dryRun: z.boolean().default(true),
        confirm: z.boolean().default(false).describe(
          "Set true with dryRun=false to acknowledge server-side export creation.",
        ),
      }),
      execute: async (
        args: { plan: ExportPlan; dryRun: boolean; confirm: boolean },
        context: Context,
      ): Promise<Handles> => {
        if (!args.dryRun && !args.confirm) {
          throw new Error(
            "Set confirm=true before creating server-side Frigate exports.",
          );
        }
        context.logger.info("{mode} {count} Frigate export(s)", {
          mode: args.dryRun ? "Planning" : "Creating",
          count: args.plan.items.length,
        });
        const results: ExportRunItem[] = await Promise.all(
          args.plan.items.map(
            async (item: ExportPlanItem): Promise<ExportRunItem> => {
              if (args.dryRun) {
                return {
                  camera: item.camera,
                  name: item.name,
                  status: "planned" as const,
                };
              }
              try {
                const exportData = await frigateJson<Record<string, unknown>>(
                  context.globalArgs,
                  `/export/${
                    encodeURIComponent(item.camera)
                  }/start/${item.startTime}/end/${item.endTime}`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      name: item.name,
                      playback: item.playback,
                      source: item.source,
                      chapters: item.chapters,
                    }),
                  },
                  context.signal,
                );
                return {
                  camera: item.camera,
                  name: item.name,
                  status: "created" as const,
                  exportId: typeof exportData.id === "string"
                    ? exportData.id
                    : undefined,
                  inProgress: typeof exportData.in_progress === "boolean"
                    ? exportData.in_progress
                    : undefined,
                };
              } catch (error) {
                context.logger.warning?.("Frigate export failed for {camera}", {
                  camera: item.camera,
                });
                return {
                  camera: item.camera,
                  name: item.name,
                  status: "failed" as const,
                  error: error instanceof Error ? error.message : String(error),
                };
              }
            },
          ),
        );
        const result = {
          attemptedAt: new Date().toISOString(),
          dryRun: args.dryRun,
          topic: args.plan.topic,
          planned: args.plan.items.length,
          created:
            results.filter((result) => result.status === "created").length,
          failed: results.filter((result) => result.status === "failed").length,
          results,
        };
        const handle = await context.writeResource(
          "exportResult",
          "latest",
          result,
        );
        context.logger.info(
          "Frigate export run complete: {created} created, {failed} failed",
          { created: result.created, failed: result.failed },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
