import { z } from "npm:zod@4";
import { Client } from "npm:@modelcontextprotocol/sdk@1.17.5/client/index.js";
import { StreamableHTTPClientTransport } from "npm:@modelcontextprotocol/sdk@1.17.5/client/streamableHttp.js";
import { XMLParser } from "npm:fast-xml-parser@4.5.3";
import { setTimeout as delay } from "node:timers/promises";

/** Read Granola directly over MCP; Amp owns the existing OAuth login/refresh. */

const NonEmptyText = z.string().trim().min(1);
const MeetingId = z.string().uuid();
const DateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}, "must be a real YYYY-MM-DD date");
const TimeText = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

/** Legacy agent fields remain accepted for existing model definitions. */
export const GlobalArgsSchema = z.object({
  cliAgentModel: NonEmptyText.default("cli-agent"),
  agentModel: NonEmptyText.default("low"),
  ampPath: NonEmptyText.default("amp"),
  timeZone: NonEmptyText.default("America/Denver"),
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
  meeting: Pick<z.infer<typeof MeetingListItemSchema>, "date" | "title">,
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

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
type MethodContext = {
  globalArgs: GlobalArgs;
  logger: {
    info: (message: string, properties?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

type GranolaTool = "list_meetings" | "get_meetings" | "get_meeting_transcript";
type CallGranola = (
  tool: GranolaTool,
  args: Record<string, unknown>,
) => Promise<string>;
type Connection = { call: CallGranola; close: () => Promise<void> };

async function connectGranola(g: GlobalArgs): Promise<Connection> {
  const url = "https://mcp.granola.ai/mcp";
  const home = Deno.env.get("HOME");
  if (!home) {
    throw new Error("Granola requires the local user's Amp OAuth login");
  }
  const dataHome = Deno.env.get("XDG_DATA_HOME") ?? `${home}/.local/share`;
  const tokenKey = `mcp-oauth-token@${url}#granola`;
  const readToken = async () => {
    // Reuse the existing credential in memory only. Never copy it into Swamp data.
    const secrets = JSON.parse(
      await Deno.readTextFile(`${dataHome}/amp/secrets.json`),
    );
    const stored = secrets[tokenKey];
    return z.object({ accessToken: NonEmptyText, expiresAt: z.number() })
      .parse(typeof stored === "string" ? JSON.parse(stored) : stored);
  };
  let token = await readToken();
  if (token.expiresAt < Date.now() + 60_000) {
    // Amp alone owns refresh-token rotation and its cross-process OAuth lock.
    const result = await new Deno.Command(g.ampPath, {
      args: ["mcp", "doctor", "granola"],
      cwd: g.cwd,
      stdout: "null",
      stderr: "null",
      signal: AbortSignal.timeout(g.wallTimeoutMs),
    }).output();
    if (!result.success) {
      throw new Error(
        "Granola OAuth refresh failed; run amp mcp doctor granola",
      );
    }
    token = await readToken();
    if (token.expiresAt <= Date.now()) {
      throw new Error("Granola OAuth login is expired");
    }
  }
  const client = new Client({ name: "swamp-granola", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token.accessToken}` } },
  });
  try {
    await client.connect(transport, { timeout: g.wallTimeoutMs });
  } catch (error) {
    await client.close();
    throw error;
  }
  return {
    close: () => client.close(),
    call: async (name, args) => {
      const result = await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: g.wallTimeoutMs },
      );
      if (result.isError) {
        throw new Error(`Granola ${name} returned a tool error`);
      }
      return (result.content as Array<{ type: string; text?: string }>).filter((
        part,
      ) => part.type === "text")
        .map((part) => part.text ?? "").join("\n");
    },
  };
}

const xml = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
});

function meetingsXml(text: string) {
  const root = text.match(/<meetings_data\b[\s\S]*?<\/meetings_data>/)?.[0];
  if (!root) throw new Error("Granola returned no meetings_data envelope");
  // Notes are Markdown, not XML. Preserve literal markup/whitespace verbatim.
  const protectedRoot = root.replace(
    /<(summary|private_notes|known_participants)\b([^>]*?)(?<!\/)>([\s\S]*?)<\/\1>/g,
    (_match, tag, attributes, body) =>
      `<${tag}${attributes}><![CDATA[${
        body.replaceAll("]]>", "]]]]><![CDATA[>")
      }]]></${tag}>`,
  );
  const parsed = xml.parse(protectedRoot).meetings_data;
  const meetings = parsed.meeting === undefined
    ? []
    : Array.isArray(parsed.meeting)
    ? parsed.meeting
    : [parsed.meeting];
  const count = Number(parsed["@_count"]);
  if (!Number.isInteger(count) || count !== meetings.length) {
    throw new Error("Granola meeting count mismatch");
  }
  return meetings as Array<Record<string, unknown>>;
}

function meetingDate(meeting: Record<string, unknown>, timeZone: string) {
  const instant = new Date(
    String(meeting["@_meeting_at"] ?? meeting["@_created_at"]),
  );
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (name: string) =>
    parts.find((part) => part.type === name)!.value;
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}:${value("minute")}`,
  };
}

function sectionText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && "#text" in value) {
    return String(value["#text"]).trim();
  }
  return "";
}

function participants(meeting: Record<string, unknown>): string[] {
  const text = sectionText(meeting.known_participants);
  return text ? text.split(/(?<=\)),\s*/).map((name) => name.trim()) : [];
}

async function readList(
  call: CallGranola,
  filters: z.infer<typeof ListFiltersSchema>,
  timeZone: string,
) {
  const meetings: z.infer<typeof MeetingListItemSchema>[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const text = await call("list_meetings", {
      ...granolaFilters(filters),
      ...(cursor ? { cursor } : {}),
    });
    meetings.push(
      ...meetingsXml(text).map((meeting) => ({
        meetingId: String(meeting["@_id"]),
        title: String(meeting["@_title"] ?? ""),
        date: meetingDate(meeting, timeZone).date,
        attendees: participants(meeting),
      })),
    );
    const page = text.match(/<pagination\b[^>]*\/>/)?.[0];
    if (!page) throw new Error("Granola list returned no pagination status");
    const pagination = xml.parse(page).pagination;
    if (pagination["@_has_more"] === "false") break;
    if (pagination["@_has_more"] !== "true") {
      throw new Error("Granola list returned an invalid pagination status");
    }
    cursor = pagination["@_next_cursor"];
    if (!cursor || seen.has(cursor)) {
      throw new Error("Granola list pagination did not advance");
    }
    seen.add(cursor);
  } while (cursor);
  return MeetingListResponseSchema.parse({ meetings });
}

async function readDetails(call: CallGranola, ids: string[], timeZone: string) {
  const meetings = meetingsXml(await call("get_meetings", { meeting_ids: ids }))
    .map((meeting) => ({
      meetingId: String(meeting["@_id"]),
      title: String(meeting["@_title"] ?? ""),
      ...meetingDate(meeting, timeZone),
      participants: participants(meeting),
      privateNotes: sectionText(meeting.private_notes) ||
        "No private notes provided.",
      summary: sectionText(meeting.summary) ||
        "No summary is stored for this meeting.",
    }));
  const result = MeetingDetailsResponseSchema.parse({ meetings });
  assertExactIds(ids, result.meetings);
  return result;
}

async function readTranscript(call: CallGranola, id: string) {
  let offset = 0;
  let transcript = "";
  do {
    const page = z.object({
      id: MeetingId,
      transcript: z.string().nullable(),
      truncated: z.boolean().optional(),
      offset: z.number().optional(),
      next_offset: z.number().optional(),
      total_chars: z.number().optional(),
      transcript_unavailable: z.object({ reason: z.string() }).optional(),
    }).parse(
      JSON.parse(
        await call("get_meeting_transcript", {
          meeting_id: id,
          offset,
          include_timestamps: false,
        }),
      ),
    );
    assertExactIds([id], [{ meetingId: page.id }]);
    if (
      page.transcript === null &&
      page.transcript_unavailable?.reason === "no_transcript" && offset === 0
    ) {
      return {
        meetingId: id,
        transcript: "No transcript is stored for this meeting.",
      };
    }
    if (
      page.transcript === null ||
      (page.offset !== undefined && page.offset !== offset)
    ) throw new Error(`Granola transcript page is invalid for ${id}`);
    transcript += page.transcript;
    if (!page.truncated) {
      if (
        page.total_chars !== undefined && transcript.length !== page.total_chars
      ) throw new Error(`Granola transcript is incomplete for ${id}`);
      return TranscriptSchema.parse({ meetingId: id, transcript });
    }
    if (
      page.next_offset === undefined ||
      page.next_offset !== transcript.length || page.next_offset <= offset
    ) {
      throw new Error(
        `Granola transcript pagination did not advance for ${id}`,
      );
    }
    offset = page.next_offset;
  } while (true);
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

/** Construct the model with an injectable read-only MCP connection. */
export function createModel(
  connect: (g: GlobalArgs) => Promise<Connection> = connectGranola,
) {
  async function usingConnection<T>(
    context: MethodContext,
    task: (call: CallGranola, g: GlobalArgs) => Promise<T>,
  ): Promise<T> {
    const g = GlobalArgsSchema.parse(context.globalArgs);
    const connection = await connect(g);
    try {
      return await task(connection.call, g);
    } finally {
      await connection.close();
    }
  }
  return {
    type: "@mgreten/granola-mcp",
    version: "2026.09.10.1",
    globalArguments: GlobalArgsSchema,
    upgrades: [
      {
        toVersion: "2026.09.10.1",
        description:
          "Preserve complete Granola Enhanced notes during retrieval",
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
        description: "List Granola meeting metadata directly through MCP",
        arguments: ListFiltersSchema,
        execute: async (
          args: z.infer<typeof ListFiltersSchema>,
          context: MethodContext,
        ) =>
          usingConnection(context, async (call, g) => {
            logStart(context, "listMeetings");
            const response = await readList(
              call,
              ListFiltersSchema.parse(args),
              g.timeZone,
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
          }),
      },
      getMeetings: {
        description:
          "Retrieve details without transcripts for one to ten Granola meetings",
        arguments: z.object({ meetingIds: UniqueMeetingIdsSchema }),
        execute: async (
          args: { meetingIds: string[] },
          context: MethodContext,
        ) =>
          usingConnection(context, async (call, g) => {
            const ids = UniqueMeetingIdsSchema.parse(args.meetingIds);
            logStart(context, "getMeetings", ids.length);
            const response = await readDetails(call, ids, g.timeZone);
            const result = await writeValidated(
              context,
              "meetingDetails",
              "meeting-details",
              response,
              MeetingDetailsResponseSchema,
            );
            logDone(context, "getMeetings", response.meetings.length);
            return result;
          }),
      },
      getTranscript: {
        description: "Retrieve one complete Granola transcript",
        arguments: z.object({ meetingId: MeetingId }),
        execute: async (args: { meetingId: string }, context: MethodContext) =>
          usingConnection(context, async (call) => {
            logStart(context, "getTranscript", 1);
            const response = {
              transcripts: [
                await readTranscript(call, MeetingId.parse(args.meetingId)),
              ],
            };
            const result = await writeValidated(
              context,
              "transcript",
              `transcript-${args.meetingId}`,
              response,
              TranscriptResponseSchema,
            );
            logDone(context, "getTranscript", 1);
            return result;
          }),
      },
      syncMeetings: {
        description:
          "List, select at most ten missing IDs, then retrieve complete notes directly through MCP",
        arguments: SyncArgsSchema,
        execute: async (
          args: z.infer<typeof SyncArgsSchema>,
          context: MethodContext,
        ) =>
          usingConnection(context, async (call, g) => {
            const parsedArgs = SyncArgsSchema.parse(args);
            const filters = ListFiltersSchema.parse({
              timeRange: parsedArgs.timeRange,
              workspaceOnly: parsedArgs.workspaceOnly,
              involvement: parsedArgs.involvement,
            });
            logStart(context, "syncMeetings");
            const listed = await readList(call, filters, g.timeZone);
            const excluded = new Set(
              extractMeetingIds(parsedArgs.existingFiles),
            );
            const selected = listed.meetings.filter((meeting) =>
              !excluded.has(meeting.meetingId.toLowerCase()) &&
              !matchesExistingFile(meeting, parsedArgs.existingFiles)
            )
              .slice(0, parsedArgs.maxMeetings).map((meeting) =>
                meeting.meetingId
              );
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
            const response = await readDetails(call, selected, g.timeZone);
            const notes: z.infer<typeof NoteRecordSchema>[] = [];
            for (const meeting of response.meetings) {
              notes.push(
                normalizeMeeting({
                  ...meeting,
                  ...await readTranscript(call, meeting.meetingId),
                }),
              );
            }
            const result = await writeValidated(
              context,
              "syncedNotes",
              "synced-notes",
              { notes },
              SyncedNotesSchema,
            );
            logDone(context, "syncMeetings", notes.length);
            return result;
          }),
      },
    },
  };
}

/** Direct, read-only Granola MCP data-source model. */
export const model = createModel();
