import { z } from "npm:zod@4";
import { setTimeout as delay } from "node:timers/promises";

const Text = z.string().trim().min(1);
const MeetingId = z.string().uuid();
const DateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}, "must be a real YYYY-MM-DD date");

/** REST credentials are supplied by the caller's vault, never by an agent login. */
export const GlobalArgsSchema = z.object({
  apiKey: Text.optional().meta({ sensitive: true }),
  timeZone: Text.default("America/Denver"),
  wallTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(600_000),
}).strict();

// Nested Swamp runs may include global arguments; strip them here.
const SyncArgsSchema = z.object({
  createdAfter: z.iso.datetime({ offset: true }),
  existingFiles: z.array(z.string()),
  maxMeetings: z.number().int().min(1).max(10).default(10),
});
const RawMeetingSchema = z.object({
  meetingId: MeetingId,
  title: Text,
  date: DateText,
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  participants: z.array(Text),
  privateNotes: Text,
  summary: Text,
  transcript: Text,
}).strict();
const NoteRecordSchema = RawMeetingSchema.extend({
  markdown: Text,
  suggestedFile: Text,
  dailyLink: Text,
}).strict();
const SyncedNotesSchema = z.object({
  notes: z.array(NoteRecordSchema),
  truncated: z.boolean(),
})
  .strict();

/** Extract and case-insensitively deduplicate existing meeting UUIDs. */
export function extractMeetingIds(existingFiles: string[]): string[] {
  const ids = new Set<string>();
  const uuid =
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
  for (const file of existingFiles) {
    for (const match of file.matchAll(uuid)) ids.add(match[0].toLowerCase());
  }
  return [...ids];
}

/** Also recognize legacy date-title exports that predate UUID filenames. */
export function matchesExistingFile(
  meeting: { date: string; title: string },
  existingFiles: string[],
): boolean {
  const normalize = (value: string) =>
    value.normalize("NFKD").toLocaleLowerCase("en-US").replace(
      /[^a-z0-9]/g,
      "",
    );
  const prefix = normalize(`granola/${meeting.date} ${meeting.title}`);
  return existingFiles.some((file) => normalize(file).startsWith(prefix));
}

/** Produce a safe filename component without changing the meeting identity. */
export function sanitizeTitle(title: string): string {
  return title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "").slice(0, 120) ||
    "Untitled meeting";
}

/** Escape user text used in Markdown headings and links. */
export function escapeMarkdownInline(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/([\\|\[\]])/g, "\\$1").trim();
}

/** Normalize a note as data only; the extension never writes vault files. */
export function normalizeMeeting(
  input: unknown,
): z.infer<typeof NoteRecordSchema> {
  const meeting = RawMeetingSchema.parse(input);
  const suggestedFile = `Granola/${meeting.date} ${
    sanitizeTitle(meeting.title)
  } ${meeting.meetingId.toLowerCase()}.md`;
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

function meetingDate(instant: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const value = (name: string) =>
    parts.find((part) => part.type === name)!.value;
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}:${value("minute")}`,
  };
}

const ApiNoteId = z.string().regex(/^not_[a-zA-Z0-9]{14}$/i);
const ApiListPage = z.object({
  notes: z.array(
    z.object({ id: ApiNoteId, deleted_at: z.string().nullable() }),
  ),
  hasMore: z.boolean(),
  cursor: z.string().nullable(),
});
const ApiNote = z.object({
  id: ApiNoteId,
  title: z.string().nullable(),
  web_url: z.url(),
  created_at: z.iso.datetime({ offset: true }),
  deleted_at: z.string().nullable(),
  calendar_event: z.object({
    scheduled_start_time: z.iso.datetime({ offset: true }).nullable(),
  }).nullable(),
  attendees: z.array(
    z.object({ name: z.string().nullable(), email: z.string() }),
  ),
  summary_markdown: z.string().nullable(),
  summary_text: z.string(),
  private_notes_markdown: z.string().nullable(),
  private_notes_text: z.string().nullable(),
});
const ApiTranscriptPage = z.object({
  transcript: z.array(z.object({
    text: z.string(),
    speaker: z.object({
      source: z.string(),
      attribution: z.enum(["me", "them"]).optional(),
      name: z.string().optional(),
      diarization_label: z.string().optional(),
    }),
  })),
  hasMore: z.boolean(),
  cursor: z.string().nullable(),
});

function nextCursor(
  page: { hasMore: boolean; cursor: string | null },
  seen: Set<string>,
) {
  if (!page.hasMore) return undefined;
  if (!page.cursor || seen.has(page.cursor)) {
    throw new Error("Granola API pagination did not advance");
  }
  seen.add(page.cursor);
  return page.cursor;
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

async function readNotes(
  args: z.infer<typeof SyncArgsSchema>,
  g: GlobalArgs,
  request: typeof fetch,
) {
  if (!g.apiKey) {
    throw new Error("syncApiMeetings requires a vault-backed apiKey");
  }
  const signal = AbortSignal.timeout(g.wallTimeoutMs);
  const get = async (path: string, params: Record<string, string> = {}) => {
    const url = new URL(path, "https://public-api.granola.ai");
    url.search = new URLSearchParams(params).toString();
    for (let attempt = 0; attempt < 3; attempt++) {
      await delay(220, undefined, { signal });
      signal.throwIfAborted();
      let response: Response;
      try {
        response = await request(url, {
          headers: { Authorization: `Bearer ${g.apiKey}` },
          redirect: "error",
          signal,
        });
      } catch {
        throw new Error(`Granola API GET ${path} failed (network or timeout)`);
      }
      if (response.ok) {
        try {
          return await response.json();
        } catch {
          throw new Error(`Granola API GET ${path}: invalid JSON or timeout`);
        }
      }
      const retryAfter = response.headers.get("Retry-After");
      await response.body?.cancel();
      if (response.status !== 429 || attempt === 2) {
        throw new Error(`Granola API GET ${path}: HTTP ${response.status}`);
      }
      const retryDelay = retryAfter
        ? (/^\d+(\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Date.parse(retryAfter) - Date.now())
        : 1000 * 2 ** attempt;
      if (!Number.isFinite(retryDelay) || retryDelay > 60_000) {
        throw new Error("Granola API HTTP 429; retry later per Retry-After");
      }
      await delay(Math.max(0, retryDelay), undefined, { signal });
    }
    throw new Error("Granola API retries exhausted");
  };
  const candidates: string[] = [];
  const listed = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = ApiListPage.parse(
      await get("/v1/notes", {
        created_after: new Date(args.createdAfter).toISOString().replace(
          /\.\d{3}Z$/,
          "Z",
        ),
        page_size: "30",
        ...(cursor ? { cursor } : {}),
      }),
    );
    for (const note of page.notes) {
      if (listed.has(note.id.toLowerCase())) {
        throw new Error("Granola API returned duplicate note IDs");
      }
      listed.add(note.id.toLowerCase());
      if (note.deleted_at === null) candidates.push(note.id);
    }
    cursor = nextCursor(page, cursors);
  } while (cursor);
  const excluded = new Set(extractMeetingIds(args.existingFiles));
  const identities = new Set<string>();
  const notes: z.infer<typeof NoteRecordSchema>[] = [];
  let truncated = false;
  for (const id of candidates) {
    const note = ApiNote.parse(await get(`/v1/notes/${id}`));
    if (note.id.toLowerCase() !== id.toLowerCase()) {
      throw new Error("Granola API returned the wrong note ID");
    }
    if (note.deleted_at !== null) continue;
    const web = new URL(note.web_url);
    if (web.origin !== "https://notes.granola.ai") {
      throw new Error("Granola API returned an unsupported meeting web URL");
    }
    const meetingId = MeetingId.parse(web.pathname.match(/^\/d\/([^/]+)$/)?.[1])
      .toLowerCase();
    if (identities.has(meetingId)) {
      throw new Error("Duplicate Granola web UUID");
    }
    identities.add(meetingId);
    const metadata = {
      meetingId,
      title: note.title?.trim() || "Untitled meeting",
      ...meetingDate(
        note.calendar_event?.scheduled_start_time ?? note.created_at,
        g.timeZone,
      ),
    };
    if (
      excluded.has(meetingId) ||
      matchesExistingFile(metadata, args.existingFiles)
    ) continue;
    if (notes.length === args.maxMeetings) {
      truncated = true;
      break;
    }
    const lines: string[] = [];
    const transcriptCursors = new Set<string>();
    cursor = undefined;
    do {
      const page = ApiTranscriptPage.parse(
        await get(`/v1/notes/${id}/transcript`, {
          page_size: "100",
          ...(cursor ? { cursor } : {}),
        }),
      );
      for (const item of page.transcript) {
        const speaker = item.speaker;
        const label = speaker.name || speaker.diarization_label ||
          (speaker.attribution === "me"
            ? "Me"
            : speaker.attribution === "them"
            ? "Them"
            : "Unknown speaker");
        lines.push(`${label}: ${item.text}`);
      }
      cursor = nextCursor(page, transcriptCursors);
    } while (cursor);
    notes.push(normalizeMeeting({
      ...metadata,
      participants: note.attendees.map((person) => person.name || person.email),
      privateNotes: note.private_notes_markdown?.trim() ||
        note.private_notes_text?.trim() ||
        (note.private_notes_markdown === null &&
            note.private_notes_text === null
          ? "Private notes unavailable through this API key."
          : "No private notes provided."),
      summary: note.summary_markdown || note.summary_text ||
        "No summary is stored for this meeting.",
      transcript: lines.length
        ? lines.join("\n")
        : "No transcript is stored for this meeting.",
    }));
  }
  return { notes, truncated };
}

/** Build the REST-only model with an injectable HTTP client for offline tests. */
export function createModel(request: typeof fetch = fetch) {
  return {
    type: "@mgreten/granola-api",
    version: "2026.10.29.1",
    globalArguments: GlobalArgsSchema,
    resources: {
      syncedNotes: {
        description: "Normalized data-only notes for selected new meetings",
        schema: SyncedNotesSchema,
        lifetime: "30d" as const,
        garbageCollection: 20,
      },
    },
    methods: {
      syncApiMeetings: {
        description:
          "Read Granola REST notes with a vault API key; never writes vault files",
        arguments: SyncArgsSchema,
        execute: async (
          args: z.infer<typeof SyncArgsSchema>,
          context: MethodContext,
        ) => {
          context.logger.info("granola_api_sync_started", {
            method: "syncApiMeetings",
          });
          const result = await readNotes(
            SyncArgsSchema.parse(args),
            GlobalArgsSchema.parse(context.globalArgs),
            request,
          );
          const handle = await context.writeResource(
            "syncedNotes",
            `api-synced-notes-${crypto.randomUUID()}`,
            SyncedNotesSchema.parse(result),
          );
          context.logger.info("granola_api_sync_completed", {
            meetingCount: result.notes.length,
            truncated: result.truncated,
          });
          return { dataHandles: [handle] };
        },
      },
    },
  };
}

/** Registered Swamp extension model. */
export const model = {
  ...createModel(),
  type: "@mgreten/granola-api",
  version: "2026.10.29.1",
};
