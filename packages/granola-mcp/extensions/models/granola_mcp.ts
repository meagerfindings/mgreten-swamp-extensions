import { z } from "npm:zod@4";

/** Read Granola meeting data through an Amp cli-agent child invocation. */

/** Exact Granola MCP tools exposed to every Amp child. */
export const GRANOLA_TOOLS = [
  "mcp__granola__list_meetings",
  "mcp__granola__get_meetings",
  "mcp__granola__get_meeting_transcript",
] as const;

const NonEmptyText = z.string().trim().min(1);
const MeetingId = z.string().uuid();
const DateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}, "must be a real YYYY-MM-DD date");
const TimeText = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

/** Amp-only model configuration. */
export const GlobalArgsSchema = z.object({
  cliAgentModel: NonEmptyText.default("cli-agent"),
  agentModel: NonEmptyText.default("low"),
  cwd: NonEmptyText.optional(),
  wallTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(600_000),
  idleTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(600_000),
}).strict();

/** Optional filters describing the connected user's meeting involvement. */
export const InvolvementSchema = z.object({
  capturedByMe: z.boolean().optional(),
  listedAsParticipant: z.boolean().optional(),
}).strict();

/** Public meeting-list filters translated to Granola snake_case arguments. */
export const ListFiltersSchema = z.object({
  timeRange: z.enum(["this_week", "last_week", "last_30_days"]).default(
    "last_30_days",
  ),
  workspaceOnly: z.literal(true).optional(),
  involvement: InvolvementSchema.optional(),
});

/** Strict meeting metadata item returned by a list invocation. */
export const MeetingListItemSchema = z.object({
  meetingId: MeetingId,
  title: NonEmptyText,
  date: DateText.optional(),
  attendees: z.array(NonEmptyText).default([]),
}).strict();

/** Strict meeting details without transcript content. */
export const MeetingDetailsSchema = z.object({
  meetingId: MeetingId,
  title: NonEmptyText,
  date: DateText,
  time: TimeText,
  participants: z.array(NonEmptyText),
  privateNotes: NonEmptyText,
  summary: NonEmptyText,
}).strict();

/** Strict transcript payload for one meeting. */
export const TranscriptSchema = z.object({
  meetingId: MeetingId,
  transcript: NonEmptyText,
}).strict();

function uniqueMeetingIds<T extends { meetingId: string }>(
  items: T[],
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const id = item.meetingId.toLowerCase();
    if (seen.has(id)) {
      ctx.addIssue({
        code: "custom",
        path: [index, "meetingId"],
        message: "duplicate meeting ID",
      });
    }
    seen.add(id);
  }
}

/** Strict and case-insensitively unique list response. */
export const MeetingListResponseSchema = z.object({
  meetings: z.array(MeetingListItemSchema),
}).strict()
  .superRefine((value, ctx) => uniqueMeetingIds(value.meetings, ctx));
/** Strict and case-insensitively unique details response. */
export const MeetingDetailsResponseSchema = z.object({
  meetings: z.array(MeetingDetailsSchema),
}).strict()
  .superRefine((value, ctx) => uniqueMeetingIds(value.meetings, ctx));
/** Strict and case-insensitively unique transcript response. */
export const TranscriptResponseSchema = z.object({
  transcripts: z.array(TranscriptSchema),
}).strict()
  .superRefine((value, ctx) => uniqueMeetingIds(value.transcripts, ctx));

/** Combined detail and transcript shape used only after sync retrieval. */
export const RawMeetingSchema = MeetingDetailsSchema.extend({
  transcript: NonEmptyText,
}).strict();
/** Data-only normalized meeting note; this schema does not write files. */
export const NoteRecordSchema = RawMeetingSchema.extend({
  markdown: NonEmptyText,
  suggestedFile: NonEmptyText,
  dailyLink: NonEmptyText,
}).strict();

const UniqueMeetingIdsSchema = z.array(MeetingId).min(1).max(10).superRefine(
  (ids, ctx) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      const normalized = id.toLowerCase();
      if (seen.has(normalized)) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: "duplicate meeting ID",
        });
      }
      seen.add(normalized);
    });
  },
);

/** Extract and case-insensitively deduplicate UUIDs found in caller paths. */
export function extractMeetingIds(existingFiles: string[]): string[] {
  const ids = new Set<string>();
  const uuid =
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
  for (const file of existingFiles) {
    for (const match of file.matchAll(uuid)) ids.add(match[0].toLowerCase());
  }
  return [...ids];
}

/** Match legacy Obsidian exports that predate UUID-bearing filenames. */
export function matchesExistingFile(
  meeting: z.infer<typeof MeetingListItemSchema>,
  existingFiles: string[],
): boolean {
  if (!meeting.date) return false;
  const normalize = (value: string) =>
    value.normalize("NFKD").toLocaleLowerCase("en-US").replace(
      /[^a-z0-9]/g,
      "",
    );
  const prefix = normalize(`granola/${meeting.date} ${meeting.title}`);
  return existingFiles.some((file) => normalize(file).startsWith(prefix));
}

/** Produce a path-safe title component without Markdown/path metacharacters. */
export function sanitizeTitle(title: string): string {
  return title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "").slice(0, 120) ||
    "Untitled meeting";
}

/** Escape line breaks, pipes, brackets, and backslashes in Markdown inline text. */
export function escapeMarkdownInline(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/([\\|\[\]])/g, "\\$1").trim();
}

/** Build the suggested data-only note path for a validated meeting. */
export function suggestedPath(
  meeting: z.infer<typeof RawMeetingSchema>,
): string {
  return `Granola/${meeting.date} ${
    sanitizeTitle(meeting.title)
  } ${meeting.meetingId.toLowerCase()}.md`;
}

/** Validate and normalize a complete meeting into safe Markdown data. */
export function normalizeMeeting(
  input: unknown,
): z.infer<typeof NoteRecordSchema> {
  const meeting = RawMeetingSchema.parse(input);
  const suggestedFile = suggestedPath(meeting);
  const title = escapeMarkdownInline(meeting.title);
  const participants = meeting.participants.map(escapeMarkdownInline).join(
    ", ",
  );
  return NoteRecordSchema.parse({
    ...meeting,
    meetingId: meeting.meetingId.toLowerCase(),
    suggestedFile,
    dailyLink: `- ${meeting.time} - [[${suggestedFile.slice(0, -3)}|${title}]]`,
    markdown:
      `# ${title}\n\n- **Date:** ${meeting.date}\n- **Time:** ${meeting.time}\n- **Participants:** ${participants}\n- **Granola meeting ID:** ${meeting.meetingId.toLowerCase()}\n\n## Private Notes\n\n${meeting.privateNotes}\n\n## Summary\n\n${meeting.summary}\n\n## Transcript\n\n${meeting.transcript}\n`,
  });
}

function granolaFilters(
  filters: z.infer<typeof ListFiltersSchema>,
): Record<string, unknown> {
  return {
    time_range: filters.timeRange,
    ...(filters.workspaceOnly === undefined
      ? {}
      : { workspace_only: filters.workspaceOnly }),
    ...(filters.involvement === undefined ? {} : {
      involvement: {
        ...(filters.involvement.capturedByMe === undefined
          ? {}
          : { captured_by_me: filters.involvement.capturedByMe }),
        ...(filters.involvement.listedAsParticipant === undefined
          ? {}
          : { listed_as_participant: filters.involvement.listedAsParticipant }),
      },
    }),
  };
}

/** Build a strict one-tool metadata-list prompt with snake_case arguments. */
export function buildListPrompt(
  filters: z.infer<typeof ListFiltersSchema>,
): string {
  return `Call mcp__granola__list_meetings exactly once with this exact snake_case argument JSON: ${
    JSON.stringify(granolaFilters(filters))
  }. Do not call any other tool. Return only JSON {"meetings":[{"meetingId":"UUID","title":"non-empty","date":"YYYY-MM-DD or omitted","attendees":["non-empty"]}]}. Never return an error envelope as data.`;
}

/** Build a strict one-call batched meeting-details prompt. */
export function buildDetailsPrompt(ids: string[]): string {
  return `Call mcp__granola__get_meetings exactly once with this exact snake_case argument JSON: ${
    JSON.stringify({ meeting_ids: ids })
  }. Do not call any other tool. Return every and only requested ID, case-insensitively, as JSON {"meetings":[{"meetingId":"UUID","title":"non-empty","date":"YYYY-MM-DD","time":"HH:mm","participants":["non-empty"],"privateNotes":"non-empty","summary":"non-empty"}]}. Map the meeting's complete user-visible Enhanced note to summary, preserving its Markdown; do not replace it with a generated synopsis. Map only explicitly private user notes to privateNotes, or use "No private notes provided." when none exist. Do not include transcripts. Never return an error envelope as data.`;
}

/** Build a strict one-call transcript prompt for one ID. */
export function buildTranscriptPrompt(id: string): string {
  return `Call mcp__granola__get_meeting_transcript exactly once with this exact snake_case argument JSON: ${
    JSON.stringify({ meeting_id: id })
  }. Do not call any other tool. Return only JSON {"transcripts":[{"meetingId":"${id}","transcript":"complete non-empty verbatim transcript"}]}. Never return an error envelope as data.`;
}

/** Build sync stage two's exact batched-details and per-ID transcript task. */
export function buildRetrievalPrompt(ids: string[]): string {
  return `Retrieve exactly these meeting IDs: ${
    JSON.stringify(ids)
  }. First call mcp__granola__get_meetings exactly once with ${
    JSON.stringify({ meeting_ids: ids })
  }. Then call mcp__granola__get_meeting_transcript exactly once per ID with {"meeting_id":"<that exact ID>"}; make no other tool calls. Return every and only requested ID, case-insensitively, as JSON {"meetings":[{"meetingId":"UUID","title":"non-empty","date":"YYYY-MM-DD","time":"HH:mm","participants":["non-empty"],"privateNotes":"non-empty","summary":"non-empty","transcript":"complete non-empty verbatim transcript"}]}. Map each meeting's complete user-visible Enhanced note to summary, preserving its Markdown; do not replace it with a generated synopsis. Map only explicitly private user notes to privateNotes, or use "No private notes provided." when none exist. Never return an error envelope as data.`;
}

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
type ResourceHandle = { specName: string; name: string };
type DataRecord = { name?: string; attributes?: unknown; content?: unknown };
type MethodContext = {
  globalArgs: GlobalArgs;
  logger: {
    info: (message: string, properties?: Record<string, unknown>) => void;
  };
  runModel: (
    options: {
      definition: string;
      method: string;
      arguments: Record<string, unknown>;
    },
  ) => Promise<
    { ok: true; resources: ResourceHandle[] } | {
      ok: false;
      error: { message: string };
    }
  >;
  readModelData: (
    modelName: string,
    specName: string,
  ) => Promise<DataRecord[] | undefined>;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

function rejectErrorEnvelope(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (
    "error" in object || "errors" in object || object.ok === false ||
    object.success === false ||
    object.status === "error" || object.status === "failed"
  ) throw new Error("Granola agent returned an error envelope");
}

async function invoke(
  context: MethodContext,
  prompt: string,
): Promise<unknown> {
  const g = GlobalArgsSchema.parse(context.globalArgs);
  const invocation = `granola-${crypto.randomUUID()}`;
  const args: Record<string, unknown> = {
    prompt,
    provider: "amp",
    model: g.agentModel,
    toolAllowlist: [...GRANOLA_TOOLS],
    toolProfile: "readonly",
    sandboxMode: "off",
    sandboxNetwork: "allow",
    wallTimeoutMs: g.wallTimeoutMs,
    idleTimeoutMs: g.idleTimeoutMs,
    tags: { source: "granola-mcp" },
  };
  if (g.cwd) args.cwd = g.cwd;
  const run = await context.runModel({
    definition: g.cliAgentModel,
    method: "invokeAndParse",
    arguments: args,
  });
  if (!run.ok) {
    throw new Error(`cli-agent invocation failed: ${run.error.message}`);
  }
  const handle = run.resources.find((resource) =>
    resource.specName === "invocation"
  );
  if (!handle) throw new Error("cli-agent returned no invocation resource");
  const records = await context.readModelData(g.cliAgentModel, "invocation") ??
    [];
  const record = records.find((candidate) => candidate.name === handle.name);
  const attributes = record?.attributes ?? record?.content;
  if (!attributes || typeof attributes !== "object") {
    throw new Error("cli-agent invocation resource could not be read");
  }
  const parsed = attributes as Record<string, unknown>;
  if (parsed.success !== true) {
    throw new Error(
      `cli-agent invocation was unsuccessful: ${
        String(parsed.failureClass ?? "unknown error")
      }`,
    );
  }
  if (parsed.parsedResponse === undefined) {
    throw new Error("cli-agent returned no parsedResponse");
  }
  rejectErrorEnvelope(parsed.parsedResponse);
  context.logger.info("Granola child invocation completed", {
    invocation,
    childResource: handle.name,
  });
  return parsed.parsedResponse;
}

function assertExactIds(
  requested: string[],
  returned: Array<{ meetingId: string }>,
): void {
  const expected = new Set(requested.map((id) => id.toLowerCase()));
  const actual = new Set(returned.map((item) => item.meetingId.toLowerCase()));
  if (
    actual.size !== returned.length || expected.size !== actual.size ||
    [...expected].some((id) => !actual.has(id))
  ) {
    throw new Error("Granola response IDs did not exactly match requested IDs");
  }
}

async function writeValidated(
  context: MethodContext,
  spec: string,
  prefix: string,
  value: unknown,
  schema: z.ZodType,
): Promise<{ dataHandles: Record<string, unknown>[] }> {
  const validated = schema.parse(value) as Record<string, unknown>;
  const handle = await context.writeResource(
    spec,
    `${prefix}-${crypto.randomUUID()}`,
    validated,
  );
  return { dataHandles: [handle] };
}

function logStart(
  context: MethodContext,
  method: string,
  count?: number,
): void {
  context.logger.info("Granola method started", {
    method,
    ...(count === undefined ? {} : { meetingCount: count }),
  });
}

function logDone(context: MethodContext, method: string, count: number): void {
  context.logger.info("Granola method completed", {
    method,
    meetingCount: count,
  });
}

const SyncedNotesSchema = z.object({ notes: z.array(NoteRecordSchema) })
  .strict();
const SyncArgsSchema = ListFiltersSchema.extend({
  existingFiles: z.array(z.string()),
  maxMeetings: z.number().int().min(1).max(10).default(10),
});

/** Amp-only Granola MCP data-source model. */
export const model = {
  type: "@mgreten/granola-mcp",
  version: "2026.09.10.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.09.10.1",
      description: "Preserve complete Granola Enhanced notes during retrieval",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    meetingList: {
      description: "Validated Granola meeting list",
      schema: MeetingListResponseSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
    meetingDetails: {
      description: "Validated Granola meeting details without transcripts",
      schema: MeetingDetailsResponseSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    transcript: {
      description: "Validated Granola transcript",
      schema: TranscriptResponseSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    syncedNotes: {
      description: "Normalized data-only notes for selected new meetings",
      schema: SyncedNotesSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    listMeetings: {
      description: "List Granola meeting metadata through Amp",
      arguments: ListFiltersSchema,
      execute: async (
        args: z.infer<typeof ListFiltersSchema>,
        context: MethodContext,
      ) => {
        logStart(context, "listMeetings");
        const response = MeetingListResponseSchema.parse(
          await invoke(context, buildListPrompt(ListFiltersSchema.parse(args))),
        );
        const result = await writeValidated(
          context,
          "meetingList",
          "meeting-list",
          response,
          MeetingListResponseSchema,
        );
        logDone(context, "listMeetings", response.meetings.length);
        return result;
      },
    },
    getMeetings: {
      description:
        "Retrieve details without transcripts for one to ten Granola meetings",
      arguments: z.object({ meetingIds: UniqueMeetingIdsSchema }),
      execute: async (
        args: { meetingIds: string[] },
        context: MethodContext,
      ) => {
        const ids = UniqueMeetingIdsSchema.parse(args.meetingIds);
        logStart(context, "getMeetings", ids.length);
        const response = MeetingDetailsResponseSchema.parse(
          await invoke(context, buildDetailsPrompt(ids)),
        );
        assertExactIds(ids, response.meetings);
        const result = await writeValidated(
          context,
          "meetingDetails",
          "meeting-details",
          response,
          MeetingDetailsResponseSchema,
        );
        logDone(context, "getMeetings", response.meetings.length);
        return result;
      },
    },
    getTranscript: {
      description: "Retrieve one complete Granola transcript",
      arguments: z.object({ meetingId: MeetingId }),
      execute: async (args: { meetingId: string }, context: MethodContext) => {
        logStart(context, "getTranscript", 1);
        const response = TranscriptResponseSchema.parse(
          await invoke(context, buildTranscriptPrompt(args.meetingId)),
        );
        assertExactIds([args.meetingId], response.transcripts);
        const result = await writeValidated(
          context,
          "transcript",
          `transcript-${args.meetingId}`,
          response,
          TranscriptResponseSchema,
        );
        logDone(context, "getTranscript", 1);
        return result;
      },
    },
    syncMeetings: {
      description:
        "List, select at most ten missing IDs, then retrieve their details and transcripts in one child task",
      arguments: SyncArgsSchema,
      execute: async (
        args: z.infer<typeof SyncArgsSchema>,
        context: MethodContext,
      ) => {
        const parsedArgs = SyncArgsSchema.parse(args);
        const filters = ListFiltersSchema.parse({
          timeRange: parsedArgs.timeRange,
          workspaceOnly: parsedArgs.workspaceOnly,
          involvement: parsedArgs.involvement,
        });
        logStart(context, "syncMeetings");
        const listed = MeetingListResponseSchema.parse(
          await invoke(context, buildListPrompt(filters)),
        );
        const excluded = new Set(extractMeetingIds(parsedArgs.existingFiles));
        const selected = listed.meetings.filter((meeting) =>
          !excluded.has(meeting.meetingId.toLowerCase()) &&
          !matchesExistingFile(meeting, parsedArgs.existingFiles)
        )
          .slice(0, parsedArgs.maxMeetings).map((meeting) => meeting.meetingId);
        if (selected.length === 0) {
          const result = await writeValidated(
            context,
            "syncedNotes",
            "synced-notes",
            { notes: [] },
            SyncedNotesSchema,
          );
          logDone(context, "syncMeetings", 0);
          return result;
        }
        const response = z.object({ meetings: z.array(RawMeetingSchema) })
          .strict()
          .superRefine((value, ctx) => uniqueMeetingIds(value.meetings, ctx))
          .parse(await invoke(context, buildRetrievalPrompt(selected)));
        assertExactIds(selected, response.meetings);
        const notes = response.meetings.map(normalizeMeeting);
        const result = await writeValidated(
          context,
          "syncedNotes",
          "synced-notes",
          { notes },
          SyncedNotesSchema,
        );
        logDone(context, "syncMeetings", notes.length);
        return result;
      },
    },
  },
};
