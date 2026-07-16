/**
 * Colorado homeschool attendance and learning session tracker backed by Grist.
 *
 * Tracks students, school years, subjects, capture events from multiple sources
 * (Discord, Todoist, voice, manual, etc.), computes attendance days, and generates
 * compliance summaries. Test entries are first-class and excluded from exports by default.
 *
 * Colorado defaults: 172 required instructional days, 4 avg contact hours/day.
 * These are configurable per school year in Grist — not hardcoded.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Global args
// ---------------------------------------------------------------------------

/** Global arguments required by every method. */
const GlobalArgsSchema = z.object({
  gristBaseUrl: z.string().url().describe(
    "Grist base URL (e.g. https://grist.example.com)",
  ),
  gristDocId: z.string().describe("Grist document ID"),
  gristApiToken: z.string().meta({ sensitive: true }).describe(
    "Grist API token — use vault expression",
  ),
  timezone: z.string().default("America/Denver"),
  defaultSchoolYear: z.string().optional().describe(
    "Default school year (e.g. 2026-2027)",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Grist schema definition
// ---------------------------------------------------------------------------

/** Column definition for building/verifying Grist tables. */
interface ColumnDef {
  id: string;
  label: string;
  type: string;
}

/** Expected Grist table schema for all homeschool tracking tables. */
const EXPECTED_SCHEMA: Record<string, ColumnDef[]> = {
  Students: [
    { id: "name", label: "Name", type: "Text" },
    { id: "birthday", label: "Birthday", type: "Text" },
    { id: "grade_level", label: "Grade Level", type: "Text" },
    { id: "active", label: "Active", type: "Bool" },
    { id: "notes", label: "Notes", type: "Text" },
  ],
  SchoolYears: [
    { id: "name", label: "Name", type: "Text" },
    { id: "start_date", label: "Start Date", type: "Text" },
    { id: "end_date", label: "End Date", type: "Text" },
    {
      id: "required_instructional_days",
      label: "Required Instructional Days",
      type: "Int",
    },
    {
      id: "target_avg_hours_per_day",
      label: "Target Avg Hours/Day",
      type: "Numeric",
    },
    { id: "active", label: "Active", type: "Bool" },
    { id: "notes", label: "Notes", type: "Text" },
  ],
  Subjects: [
    { id: "name", label: "Name", type: "Text" },
    { id: "category", label: "Category", type: "Text" },
    { id: "active", label: "Active", type: "Bool" },
    { id: "notes", label: "Notes", type: "Text" },
  ],
  Resources: [
    { id: "title", label: "Title", type: "Text" },
    { id: "type", label: "Type", type: "Text" },
    { id: "url", label: "URL", type: "Text" },
    { id: "notes", label: "Notes", type: "Text" },
    { id: "active", label: "Active", type: "Bool" },
  ],
  CaptureEvents: [
    { id: "source", label: "Source", type: "Text" },
    { id: "source_message_id", label: "Source Message ID", type: "Text" },
    { id: "captured_by", label: "Captured By", type: "Text" },
    { id: "captured_at", label: "Captured At", type: "Text" },
    { id: "event_date", label: "Event Date", type: "Text" },
    { id: "raw_text", label: "Raw Text", type: "Text" },
    { id: "transcript", label: "Transcript", type: "Text" },
    { id: "audio_url", label: "Audio URL", type: "Text" },
    { id: "status", label: "Status", type: "Text" },
    { id: "is_test", label: "Is Test", type: "Bool" },
    { id: "test_reason", label: "Test Reason", type: "Text" },
    { id: "notes", label: "Notes", type: "Text" },
  ],
  LearningSessions: [
    { id: "student", label: "Student", type: "Text" },
    { id: "date", label: "Date", type: "Text" },
    { id: "school_year", label: "School Year", type: "Text" },
    { id: "subject", label: "Subject", type: "Text" },
    { id: "minutes", label: "Minutes", type: "Int" },
    { id: "description", label: "Description", type: "Text" },
    { id: "resource", label: "Resource", type: "Text" },
    { id: "capture_event_id", label: "Capture Event ID", type: "Int" },
    { id: "captured_by", label: "Captured By", type: "Text" },
    { id: "confidence", label: "Confidence", type: "Numeric" },
    { id: "review_status", label: "Review Status", type: "Text" },
    { id: "approved_by", label: "Approved By", type: "Text" },
    { id: "approved_at", label: "Approved At", type: "Text" },
    { id: "is_test", label: "Is Test", type: "Bool" },
    { id: "test_reason", label: "Test Reason", type: "Text" },
    { id: "notes", label: "Notes", type: "Text" },
  ],
  AttendanceDays: [
    { id: "student", label: "Student", type: "Text" },
    { id: "date", label: "Date", type: "Text" },
    { id: "school_year", label: "School Year", type: "Text" },
    { id: "total_minutes", label: "Total Minutes", type: "Int" },
    { id: "total_hours", label: "Total Hours", type: "Numeric" },
    {
      id: "counts_as_instructional_day",
      label: "Counts as Instructional Day",
      type: "Bool",
    },
    { id: "review_status", label: "Review Status", type: "Text" },
    { id: "source_session_count", label: "Source Session Count", type: "Int" },
    { id: "computed_at", label: "Computed At", type: "Text" },
    { id: "is_test", label: "Is Test", type: "Bool" },
    { id: "test_reason", label: "Test Reason", type: "Text" },
    { id: "notes", label: "Notes", type: "Text" },
  ],
  ComplianceSnapshots: [
    { id: "school_year", label: "School Year", type: "Text" },
    { id: "generated_at", label: "Generated At", type: "Text" },
    { id: "include_tests", label: "Include Tests", type: "Bool" },
    { id: "student", label: "Student", type: "Text" },
    {
      id: "instructional_days_completed",
      label: "Instructional Days Completed",
      type: "Int",
    },
    {
      id: "required_instructional_days",
      label: "Required Instructional Days",
      type: "Int",
    },
    { id: "total_minutes", label: "Total Minutes", type: "Int" },
    { id: "total_hours", label: "Total Hours", type: "Numeric" },
    {
      id: "avg_hours_per_instructional_day",
      label: "Avg Hours/Instructional Day",
      type: "Numeric",
    },
    { id: "on_track", label: "On Track", type: "Bool" },
    { id: "summary_markdown", label: "Summary Markdown", type: "Text" },
    { id: "warnings_json", label: "Warnings JSON", type: "Text" },
    { id: "is_test", label: "Is Test", type: "Bool" },
    { id: "test_reason", label: "Test Reason", type: "Text" },
  ],
};

// ---------------------------------------------------------------------------
// Resource output schemas
// ---------------------------------------------------------------------------

/** Schema for validateConfig output. */
const ConfigValidationSchema = z.object({
  reachable: z.boolean(),
  docId: z.string(),
  docName: z.string(),
  timestamp: z.string(),
  message: z.string(),
});

/** Schema for ensureSchema output. */
const SchemaValidationSchema = z.object({
  existingTables: z.array(z.string()),
  missingTables: z.array(z.string()),
  missingColumns: z.record(z.array(z.string())),
  tablesCreated: z.array(z.string()),
  columnsAdded: z.record(z.array(z.string())),
  manualStepsNeeded: z.array(z.string()),
  dryRun: z.boolean(),
  timestamp: z.string(),
});

/** Schema for addCaptureEvent output. */
const CaptureEventSchema = z.object({
  gristRowId: z.number().optional(),
  source: z.string(),
  eventDate: z.string().optional(),
  status: z.string(),
  isTest: z.boolean(),
  dryRun: z.boolean(),
  timestamp: z.string(),
});

/** Schema for addLearningSessions output. */
const LearningSessionsSchema = z.object({
  sessionsAdded: z.number(),
  gristRowIds: z.array(z.number()),
  isTest: z.boolean(),
  dryRun: z.boolean(),
  timestamp: z.string(),
});

/** Schema for computeAttendanceDays output. */
const AttendanceDaysSchema = z.object({
  schoolYear: z.string(),
  student: z.string().optional(),
  daysComputed: z.number(),
  daysCreated: z.number(),
  daysUpdated: z.number(),
  includeTests: z.boolean(),
  dryRun: z.boolean(),
  timestamp: z.string(),
});

/** Schema for summarizeProgress output. */
const ProgressSummarySchema = z.object({
  schoolYear: z.string(),
  student: z.string().optional(),
  instructionalDaysCompleted: z.number(),
  requiredInstructionalDays: z.number(),
  totalMinutes: z.number(),
  totalHours: z.number(),
  avgHoursPerInstructionalDay: z.number(),
  percentComplete: z.number(),
  onTrack: z.boolean(),
  lowConfidenceCount: z.number(),
  needsReviewCount: z.number(),
  warnings: z.array(z.string()),
  summaryMarkdown: z.string(),
  includeTests: z.boolean(),
  timestamp: z.string(),
});

/** Schema for exportSchoolYear resource output. */
const SchoolYearExportSchema = z.object({
  schoolYear: z.string(),
  student: z.string().optional(),
  sessionCount: z.number(),
  attendanceDayCount: z.number(),
  includeTests: z.boolean(),
  format: z.string(),
  timestamp: z.string(),
});

/** Schema for addTestEntries and listTestEntries output. */
const TestEntriesSchema = z.object({
  schoolYear: z.string(),
  captureEventsCount: z.number(),
  learningSessionsCount: z.number(),
  attendanceDaysCount: z.number(),
  gristRowIds: z.object({
    captureEvents: z.array(z.number()),
    learningSessions: z.array(z.number()),
    attendanceDays: z.array(z.number()),
  }),
  dryRun: z.boolean(),
  timestamp: z.string(),
});

// ---------------------------------------------------------------------------
// Grist API client
// ---------------------------------------------------------------------------

/** A single Grist record with numeric id and field map. */
interface GristRecord {
  id: number;
  fields: Record<string, unknown>;
}

/** Grist API client returned by makeGristClient. */
interface GristClient {
  getDoc(): Promise<{ id: string; name: string }>;
  getTables(): Promise<Array<{ id: string }>>;
  getColumns(
    tableId: string,
  ): Promise<Array<{ id: string; fields: Record<string, unknown> }>>;
  getRecords(
    tableId: string,
    filter?: Record<string, unknown[]>,
  ): Promise<GristRecord[]>;
  addRecords(
    tableId: string,
    records: Record<string, unknown>[],
  ): Promise<number[]>;
  updateRecords(
    tableId: string,
    records: Array<{ id: number; fields: Record<string, unknown> }>,
  ): Promise<void>;
  createTable(tableId: string, columns: ColumnDef[]): Promise<void>;
  addColumns(tableId: string, columns: ColumnDef[]): Promise<void>;
}

/** Strip /o/<org> suffix and trailing slash from a Grist base URL. */
function normalizeGristUrl(url: string): string {
  return url.replace(/\/o\/[^/]+\/?$/, "").replace(/\/$/, "");
}

/** Build a Grist API client for the given document. */
function makeGristClient(
  baseUrl: string,
  docId: string,
  apiToken: string,
): GristClient {
  const base = normalizeGristUrl(baseUrl);
  const docBase = `${base}/api/docs/${docId}`;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };

  async function req<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${docBase}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Grist API ${method} ${path} failed with ${res.status}: ${text}`,
      );
    }
    return res.json() as Promise<T>;
  }

  return {
    async getDoc(): Promise<{ id: string; name: string }> {
      return await req<{ id: string; name: string }>("GET", "");
    },
    async getTables(): Promise<Array<{ id: string }>> {
      const data = await req<{ tables: Array<{ id: string }> }>(
        "GET",
        "/tables",
      );
      return data.tables;
    },
    async getColumns(
      tableId: string,
    ): Promise<Array<{ id: string; fields: Record<string, unknown> }>> {
      const data = await req<
        { columns: Array<{ id: string; fields: Record<string, unknown> }> }
      >(
        "GET",
        `/tables/${tableId}/columns`,
      );
      return data.columns;
    },
    async getRecords(
      tableId: string,
      filter?: Record<string, unknown[]>,
    ): Promise<GristRecord[]> {
      let path = `/tables/${tableId}/records`;
      if (filter && Object.keys(filter).length > 0) {
        path += `?filter=${encodeURIComponent(JSON.stringify(filter))}`;
      }
      const data = await req<{ records: GristRecord[] }>("GET", path);
      return data.records;
    },
    async addRecords(
      tableId: string,
      records: Record<string, unknown>[],
    ): Promise<number[]> {
      const body = { records: records.map((fields) => ({ fields })) };
      const data = await req<{ records: Array<{ id: number }> }>(
        "POST",
        `/tables/${tableId}/records`,
        body,
      );
      return data.records.map((r) => r.id);
    },
    async updateRecords(
      tableId: string,
      records: Array<{ id: number; fields: Record<string, unknown> }>,
    ): Promise<void> {
      await req("PATCH", `/tables/${tableId}/records`, { records });
    },
    async createTable(tableId: string, columns: ColumnDef[]): Promise<void> {
      await req("POST", "/tables", {
        tables: [{
          id: tableId,
          columns: columns.map((c) => ({
            id: c.id,
            fields: { label: c.label, type: c.type },
          })),
        }],
      });
    },
    async addColumns(tableId: string, columns: ColumnDef[]): Promise<void> {
      await req("POST", `/tables/${tableId}/columns`, {
        columns: columns.map((c) => ({
          id: c.id,
          fields: { label: c.label, type: c.type },
        })),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Infer school year for a date from SchoolYears records, falling back to defaultSchoolYear. */
function inferSchoolYear(
  date: string,
  schoolYears: GristRecord[],
  defaultSchoolYear?: string,
): string | undefined {
  for (const sy of schoolYears) {
    const f = sy.fields;
    const start = f["start_date"] as string | undefined;
    const end = f["end_date"] as string | undefined;
    const name = f["name"] as string | undefined;
    if (start && end && name && date >= start && date <= end) {
      return name;
    }
  }
  return defaultSchoolYear;
}

/** Build CSV from an array of records (header from first record's keys). */
function toCsv(records: Record<string, unknown>[]): string {
  if (records.length === 0) return "";
  const keys = Object.keys(records[0]);
  const escape = (v: unknown): string => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const lines = [
    keys.join(","),
    ...records.map((r) => keys.map((k) => escape(r[k])).join(",")),
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Method argument schemas
// ---------------------------------------------------------------------------

const EnsureSchemaArgs = z.object({
  dryRun: z.boolean().default(false),
  createMissing: z.boolean().default(false),
});

const AddCaptureEventArgs = z.object({
  source: z.string(),
  sourceMessageId: z.string().optional(),
  capturedBy: z.string().optional(),
  capturedAt: z.string().optional(),
  eventDate: z.string().optional(),
  rawText: z.string().optional(),
  transcript: z.string().optional(),
  audioUrl: z.string().optional(),
  status: z.string().default("new"),
  isTest: z.boolean().default(false),
  testReason: z.string().optional(),
  dryRun: z.boolean().default(false),
  notes: z.string().optional(),
});

const SessionItemSchema = z.object({
  student: z.string(),
  date: z.string(),
  schoolYear: z.string().optional(),
  subject: z.string(),
  minutes: z.number().int().positive(),
  description: z.string().optional(),
  resource: z.string().optional(),
  captureEventId: z.number().optional(),
  capturedBy: z.string().optional(),
  confidence: z.number().optional(),
  reviewStatus: z.enum(["draft", "needs_review", "approved", "rejected"])
    .default("needs_review"),
  isTest: z.boolean().optional(),
  testReason: z.string().optional(),
  notes: z.string().optional(),
});

const AddLearningSessionsArgs = z.object({
  sessions: z.array(SessionItemSchema),
  defaultIsTest: z.boolean().default(false),
  testReason: z.string().optional(),
  dryRun: z.boolean().default(false),
});

const ComputeAttendanceDaysArgs = z.object({
  schoolYear: z.string().optional(),
  student: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  includeTests: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  minMinutesForDay: z.number().int().default(60).describe(
    "Minimum total minutes to count as an instructional day",
  ),
});

const SummarizeProgressArgs = z.object({
  schoolYear: z.string().optional(),
  student: z.string().optional(),
  includeTests: z.boolean().default(false),
});

const ExportSchoolYearArgs = z.object({
  schoolYear: z.string().optional(),
  student: z.string().optional(),
  includeTests: z.boolean().default(false),
  format: z.enum(["json", "markdown", "csv"]).default("json"),
});

const AddTestEntriesArgs = z.object({
  schoolYear: z.string(),
  students: z.array(z.string()).default(["TestStudent"]),
  testReason: z.string().default("smoke test"),
  dryRun: z.boolean().default(false),
});

const ListTestEntriesArgs = z.object({
  schoolYear: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Model export
// ---------------------------------------------------------------------------

/** Colorado homeschool attendance tracker extension model. */
export const model = {
  type: "@mgreten/colorado-homeschool-attendance",
  version: "2026.07.16.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    configValidation: {
      description: "Grist connectivity and doc validation result",
      schema: ConfigValidationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    schemaValidation: {
      description: "Grist schema check and setup result",
      schema: SchemaValidationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    captureEvent: {
      description: "Last capture event written",
      schema: CaptureEventSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    learningSessions: {
      description: "Last batch of learning sessions written",
      schema: LearningSessionsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    attendanceDays: {
      description: "Last attendance day computation result",
      schema: AttendanceDaysSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    progressSummary: {
      description: "School year progress summary",
      schema: ProgressSummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    schoolYearExport: {
      description: "School year export metadata",
      schema: SchoolYearExportSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    testEntries: {
      description: "Test entry management result",
      schema: TestEntriesSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  files: {
    export: {
      description: "Exported school year data file (JSON/markdown/CSV)",
      contentType: "application/json",
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },

  methods: {
    /** Verify Grist connectivity: validates base URL, token presence, and document access. */
    validateConfig: {
      description:
        "Verify Grist base URL, API token, and document accessibility. Does not mutate data.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, ...args: unknown[]) => void;
            error: (msg: string, ...args: unknown[]) => void;
          };
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { gristBaseUrl, gristDocId, gristApiToken } = context.globalArgs;
        if (!gristApiToken) throw new Error("gristApiToken is required");
        const client = makeGristClient(gristBaseUrl, gristDocId, gristApiToken);
        const doc = await client.getDoc();
        context.logger.info("Grist doc reachable: {name}", { name: doc.name });
        const handle = await context.writeResource(
          "configValidation",
          "config-validation",
          {
            reachable: true,
            docId: doc.id,
            docName: doc.name,
            timestamp: new Date().toISOString(),
            message: `Connected to Grist document "${doc.name}"`,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    /** Check and optionally create missing Grist tables and columns. */
    ensureSchema: {
      description:
        "Verify or create the required Grist tables and columns. Use dryRun=true to preview without changes.",
      arguments: EnsureSchemaArgs,
      execute: async (
        args: z.infer<typeof EnsureSchemaArgs>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: { info: (msg: string, ...args: unknown[]) => void };
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { gristBaseUrl, gristDocId, gristApiToken } = context.globalArgs;
        const client = makeGristClient(gristBaseUrl, gristDocId, gristApiToken);

        const existingTablesList = await client.getTables();
        const existingTableIds = new Set(existingTablesList.map((t) => t.id));

        const missingTables: string[] = [];
        const missingColumns: Record<string, string[]> = {};
        const tablesCreated: string[] = [];
        const columnsAdded: Record<string, string[]> = {};

        for (
          const [tableName, expectedCols] of Object.entries(EXPECTED_SCHEMA)
        ) {
          if (!existingTableIds.has(tableName)) {
            missingTables.push(tableName);
            if (args.createMissing && !args.dryRun) {
              await client.createTable(tableName, expectedCols);
              tablesCreated.push(tableName);
              context.logger.info("Created table {table}", {
                table: tableName,
              });
            }
          } else {
            const existingCols = await client.getColumns(tableName);
            const existingColIds = new Set(existingCols.map((c) => c.id));
            const missing = expectedCols.filter((c) =>
              !existingColIds.has(c.id)
            );
            if (missing.length > 0) {
              missingColumns[tableName] = missing.map((c) => c.id);
              if (args.createMissing && !args.dryRun) {
                await client.addColumns(tableName, missing);
                columnsAdded[tableName] = missing.map((c) => c.id);
                context.logger.info("Added {count} columns to {table}", {
                  count: missing.length,
                  table: tableName,
                });
              }
            }
          }
        }

        const manualStepsNeeded = [
          "Create Grist pages/views manually via the Grist UI:",
          "  - 'Current Year Dashboard': filtered view of AttendanceDays + LearningSessions for the active school year",
          "  - '2026-2027 Attendance': AttendanceDays filtered to school_year=2026-2027",
          "  - '2026-2027 Learning Sessions': LearningSessions filtered to school_year=2026-2027",
          "  - 'Needs Review': LearningSessions filtered to review_status=needs_review, is_test=false",
          "  - 'Test Entries': LearningSessions + CaptureEvents filtered to is_test=true",
          "  - 'Monthly Check': LearningSessions grouped by month",
          "  - 'By Student': AttendanceDays grouped by student",
          "  - 'By Subject': LearningSessions grouped by subject",
          "  - 'Archive / Exports': ComplianceSnapshots table view",
        ];

        const handle = await context.writeResource(
          "schemaValidation",
          "schema-validation",
          {
            existingTables: [...existingTableIds],
            missingTables,
            missingColumns,
            tablesCreated,
            columnsAdded,
            manualStepsNeeded,
            dryRun: args.dryRun,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    /** Add a single capture event from any source (Discord, Todoist, voice, manual, etc.). */
    addCaptureEvent: {
      description:
        "Add a capture event from any source. Use isTest=true for smoke testing. Use dryRun=true to preview.",
      arguments: AddCaptureEventArgs,
      execute: async (
        args: z.infer<typeof AddCaptureEventArgs>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: { info: (msg: string, ...args: unknown[]) => void };
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { gristBaseUrl, gristDocId, gristApiToken } = context.globalArgs;
        const client = makeGristClient(gristBaseUrl, gristDocId, gristApiToken);

        const fields: Record<string, unknown> = {
          source: args.source,
          source_message_id: args.sourceMessageId ?? "",
          captured_by: args.capturedBy ?? "",
          captured_at: args.capturedAt ?? new Date().toISOString(),
          event_date: args.eventDate ?? "",
          raw_text: args.rawText ?? "",
          transcript: args.transcript ?? "",
          audio_url: args.audioUrl ?? "",
          status: args.status,
          is_test: args.isTest,
          test_reason: args.testReason ?? "",
          notes: args.notes ?? "",
        };

        let gristRowId: number | undefined;
        if (!args.dryRun) {
          const ids = await client.addRecords("CaptureEvents", [fields]);
          gristRowId = ids[0];
          context.logger.info("Added CaptureEvent row {id}", {
            id: gristRowId,
          });
        }

        const handle = await context.writeResource(
          "captureEvent",
          "capture-event-latest",
          {
            gristRowId,
            source: args.source,
            eventDate: args.eventDate,
            status: args.status,
            isTest: args.isTest,
            dryRun: args.dryRun,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    /** Add one or more learning sessions to Grist. School year is inferred when omitted. */
    addLearningSessions: {
      description:
        "Add learning sessions in bulk. isTest and dryRun are supported. School year is inferred from dates when possible.",
      arguments: AddLearningSessionsArgs,
      execute: async (
        args: z.infer<typeof AddLearningSessionsArgs>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: { info: (msg: string, ...args: unknown[]) => void };
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { gristBaseUrl, gristDocId, gristApiToken, defaultSchoolYear } =
          context.globalArgs;
        const client = makeGristClient(gristBaseUrl, gristDocId, gristApiToken);

        let schoolYears: GristRecord[] = [];
        const needsInference = args.sessions.some((s) => !s.schoolYear);
        if (needsInference) {
          schoolYears = await client.getRecords("SchoolYears");
        }

        const records: Record<string, unknown>[] = args.sessions.map((s) => {
          const sy = s.schoolYear ??
            inferSchoolYear(s.date, schoolYears, defaultSchoolYear) ?? "";
          const isTest = s.isTest !== undefined ? s.isTest : args.defaultIsTest;
          return {
            student: s.student,
            date: s.date,
            school_year: sy,
            subject: s.subject,
            minutes: s.minutes,
            description: s.description ?? "",
            resource: s.resource ?? "",
            capture_event_id: s.captureEventId ?? 0,
            captured_by: s.capturedBy ?? "",
            confidence: s.confidence ?? 1.0,
            review_status: s.reviewStatus,
            approved_by: s.approvedBy ?? "",
            approved_at: s.approvedAt ?? "",
            is_test: isTest,
            test_reason: s.testReason ?? args.testReason ?? "",
            notes: s.notes ?? "",
          };
        });

        let gristRowIds: number[] = [];
        if (!args.dryRun) {
          gristRowIds = await client.addRecords("LearningSessions", records);
          context.logger.info("Added {count} LearningSessions", {
            count: gristRowIds.length,
          });
        }

        const allTest = records.every((r) => r["is_test"] === true);
        const handle = await context.writeResource(
          "learningSessions",
          "learning-sessions-latest",
          {
            sessionsAdded: records.length,
            gristRowIds,
            isTest: allTest,
            dryRun: args.dryRun,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    /** Aggregate learning sessions into attendance days and upsert into Grist. */
    computeAttendanceDays: {
      description:
        "Aggregate learning sessions into per-student per-day attendance records. Excludes test entries by default.",
      arguments: ComputeAttendanceDaysArgs,
      execute: async (
        args: z.infer<typeof ComputeAttendanceDaysArgs>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: { info: (msg: string, ...args: unknown[]) => void };
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { gristBaseUrl, gristDocId, gristApiToken, defaultSchoolYear } =
          context.globalArgs;
        const schoolYear = args.schoolYear ?? defaultSchoolYear;
        if (!schoolYear) {
          throw new Error(
            "schoolYear is required (or set defaultSchoolYear global arg)",
          );
        }
        const client = makeGristClient(gristBaseUrl, gristDocId, gristApiToken);

        const allSessions = await client.getRecords("LearningSessions", {
          school_year: [schoolYear],
        });
        let sessions = allSessions;
        if (!args.includeTests) {
          sessions = sessions.filter((r) => !r.fields["is_test"]);
        }
        if (args.student) {
          sessions = sessions.filter((r) =>
            r.fields["student"] === args.student
          );
        }
        if (args.fromDate) {
          sessions = sessions.filter((r) =>
            (r.fields["date"] as string) >= args.fromDate!
          );
        }
        if (args.toDate) {
          sessions = sessions.filter((r) =>
            (r.fields["date"] as string) <= args.toDate!
          );
        }

        // Group by student::date
        const grouped = new Map<
          string,
          { minutes: number; count: number; isTest: boolean }
        >();
        for (const s of sessions) {
          const key = `${s.fields["student"]}::${s.fields["date"]}`;
          const existing = grouped.get(key);
          if (existing) {
            existing.minutes += (s.fields["minutes"] as number) ?? 0;
            existing.count += 1;
          } else {
            grouped.set(key, {
              minutes: (s.fields["minutes"] as number) ?? 0,
              count: 1,
              isTest: (s.fields["is_test"] as boolean) ?? false,
            });
          }
        }

        // Fetch existing AttendanceDays to enable upsert
        const existingDays = await client.getRecords("AttendanceDays", {
          school_year: [schoolYear],
        });
        const existingMap = new Map<string, number>();
        for (const d of existingDays) {
          const key = `${d.fields["student"]}::${d.fields["date"]}`;
          existingMap.set(key, d.id);
        }

        const now = new Date().toISOString();
        const toCreate: Record<string, unknown>[] = [];
        const toUpdate: Array<{ id: number; fields: Record<string, unknown> }> =
          [];

        for (const [key, data] of grouped.entries()) {
          const [student, date] = key.split("::");
          const totalMinutes = data.minutes;
          const totalHours = Math.round((totalMinutes / 60) * 100) / 100;
          const countsAsDay = totalMinutes >= args.minMinutesForDay;
          const fields: Record<string, unknown> = {
            student,
            date,
            school_year: schoolYear,
            total_minutes: totalMinutes,
            total_hours: totalHours,
            counts_as_instructional_day: countsAsDay,
            review_status: "draft",
            source_session_count: data.count,
            computed_at: now,
            is_test: data.isTest,
            test_reason: "",
            notes: "",
          };
          const existingId = existingMap.get(key);
          if (existingId !== undefined) {
            toUpdate.push({ id: existingId, fields });
          } else {
            toCreate.push(fields);
          }
        }

        if (!args.dryRun) {
          if (toCreate.length > 0) {
            await client.addRecords("AttendanceDays", toCreate);
          }
          if (toUpdate.length > 0) {
            await client.updateRecords("AttendanceDays", toUpdate);
          }
          context.logger.info(
            "Attendance: {created} created, {updated} updated",
            {
              created: toCreate.length,
              updated: toUpdate.length,
            },
          );
        }

        const handle = await context.writeResource(
          "attendanceDays",
          "attendance-days-latest",
          {
            schoolYear,
            student: args.student,
            daysComputed: grouped.size,
            daysCreated: toCreate.length,
            daysUpdated: toUpdate.length,
            includeTests: args.includeTests,
            dryRun: args.dryRun,
            timestamp: now,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    /** Generate a progress summary for a school year and persist a compliance snapshot. */
    summarizeProgress: {
      description:
        "Summarize attendance progress for a school year. Excludes test entries by default. Also saves a ComplianceSnapshot to Grist.",
      arguments: SummarizeProgressArgs,
      execute: async (
        args: z.infer<typeof SummarizeProgressArgs>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: { info: (msg: string, ...args: unknown[]) => void };
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { gristBaseUrl, gristDocId, gristApiToken, defaultSchoolYear } =
          context.globalArgs;
        const schoolYear = args.schoolYear ?? defaultSchoolYear;
        if (!schoolYear) throw new Error("schoolYear is required");
        const client = makeGristClient(gristBaseUrl, gristDocId, gristApiToken);

        // Fetch school year config
        const allSchoolYears = await client.getRecords("SchoolYears");
        const syRecord = allSchoolYears.find((r) =>
          r.fields["name"] === schoolYear
        );
        const requiredDays =
          (syRecord?.fields["required_instructional_days"] as number) ?? 172;

        // Fetch attendance days
        let attendanceDays = await client.getRecords("AttendanceDays", {
          school_year: [schoolYear],
        });
        if (!args.includeTests) {
          attendanceDays = attendanceDays.filter((r) => !r.fields["is_test"]);
        }
        if (args.student) {
          attendanceDays = attendanceDays.filter((r) =>
            r.fields["student"] === args.student
          );
        }

        const instructionalDays =
          attendanceDays.filter((r) => r.fields["counts_as_instructional_day"])
            .length;
        const totalMinutes = attendanceDays.reduce(
          (sum, r) => sum + ((r.fields["total_minutes"] as number) ?? 0),
          0,
        );
        const totalHours = Math.round((totalMinutes / 60) * 100) / 100;
        const avgHours = instructionalDays > 0
          ? Math.round((totalHours / instructionalDays) * 100) / 100
          : 0;
        const percentComplete =
          Math.round((instructionalDays / requiredDays) * 1000) / 10;
        const onTrack = instructionalDays >= requiredDays;

        // Fetch learning sessions for review counts
        let sessions = await client.getRecords("LearningSessions", {
          school_year: [schoolYear],
        });
        if (!args.includeTests) {
          sessions = sessions.filter((r) => !r.fields["is_test"]);
        }
        if (args.student) {
          sessions = sessions.filter((r) =>
            r.fields["student"] === args.student
          );
        }

        const lowConfidenceCount = sessions.filter((r) => {
          const c = r.fields["confidence"] as number | undefined;
          return c !== undefined && c < 0.7;
        }).length;
        const needsReviewCount =
          sessions.filter((r) => r.fields["review_status"] === "needs_review")
            .length;

        const warnings: string[] = [];
        if (instructionalDays < requiredDays * 0.5 && percentComplete < 50) {
          warnings.push(
            `Only ${instructionalDays}/${requiredDays} instructional days completed (${percentComplete}%)`,
          );
        }
        if (needsReviewCount > 0) {
          warnings.push(`${needsReviewCount} sessions need review`);
        }
        if (lowConfidenceCount > 0) {
          warnings.push(
            `${lowConfidenceCount} sessions have low confidence scores`,
          );
        }

        const studentLabel = args.student ? ` (${args.student})` : "";
        const summaryMarkdown = [
          `## Colorado Homeschool Progress — ${schoolYear}${studentLabel}`,
          "",
          `| Metric | Value |`,
          `|--------|-------|`,
          `| Instructional Days Completed | ${instructionalDays} / ${requiredDays} |`,
          `| Progress | ${percentComplete}% |`,
          `| Total Hours | ${totalHours} |`,
          `| Avg Hours/Instructional Day | ${avgHours} |`,
          `| On Track | ${onTrack ? "✓ Yes" : "✗ No"} |`,
          `| Sessions Needing Review | ${needsReviewCount} |`,
          "",
          warnings.length > 0
            ? `### Warnings\n${warnings.map((w) => `- ${w}`).join("\n")}`
            : "",
          "",
          "_This summary is not legal advice. Verify compliance requirements with Colorado law._",
        ].join("\n");

        const now = new Date().toISOString();

        // Persist compliance snapshot
        await client.addRecords("ComplianceSnapshots", [{
          school_year: schoolYear,
          generated_at: now,
          include_tests: args.includeTests,
          student: args.student ?? "",
          instructional_days_completed: instructionalDays,
          required_instructional_days: requiredDays,
          total_minutes: totalMinutes,
          total_hours: totalHours,
          avg_hours_per_instructional_day: avgHours,
          on_track: onTrack,
          summary_markdown: summaryMarkdown,
          warnings_json: JSON.stringify(warnings),
          is_test: false,
          test_reason: "",
        }]);

        const handle = await context.writeResource(
          "progressSummary",
          "progress-summary-latest",
          {
            schoolYear,
            student: args.student,
            instructionalDaysCompleted: instructionalDays,
            requiredInstructionalDays: requiredDays,
            totalMinutes,
            totalHours,
            avgHoursPerInstructionalDay: avgHours,
            percentComplete,
            onTrack,
            lowConfidenceCount,
            needsReviewCount,
            warnings,
            summaryMarkdown,
            includeTests: args.includeTests,
            timestamp: now,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    /** Export a school year's sessions and attendance as JSON, markdown, or CSV. Excludes tests by default. */
    exportSchoolYear: {
      description:
        "Export learning sessions and attendance for a school year. Test entries excluded by default. Produces a downloadable file artifact.",
      arguments: ExportSchoolYearArgs,
      execute: async (
        args: z.infer<typeof ExportSchoolYearArgs>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          createFileWriter: (
            spec: string,
            name: string,
            overrides?: { contentType?: string },
          ) => {
            writeText: (text: string) => Promise<{ name: string }>;
          };
          logger: { info: (msg: string, ...args: unknown[]) => void };
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { gristBaseUrl, gristDocId, gristApiToken, defaultSchoolYear } =
          context.globalArgs;
        const schoolYear = args.schoolYear ?? defaultSchoolYear;
        if (!schoolYear) throw new Error("schoolYear is required");
        const client = makeGristClient(gristBaseUrl, gristDocId, gristApiToken);

        let sessions = await client.getRecords("LearningSessions", {
          school_year: [schoolYear],
        });
        let attendanceDays = await client.getRecords("AttendanceDays", {
          school_year: [schoolYear],
        });

        if (!args.includeTests) {
          sessions = sessions.filter((r) => !r.fields["is_test"]);
          attendanceDays = attendanceDays.filter((r) => !r.fields["is_test"]);
        }
        if (args.student) {
          sessions = sessions.filter((r) =>
            r.fields["student"] === args.student
          );
          attendanceDays = attendanceDays.filter((r) =>
            r.fields["student"] === args.student
          );
        }

        const contentTypeMap: Record<string, string> = {
          json: "application/json",
          markdown: "text/markdown",
          csv: "text/csv",
        };
        const contentType = contentTypeMap[args.format] ?? "application/json";

        let fileContent: string;
        if (args.format === "json") {
          fileContent = JSON.stringify(
            {
              schoolYear,
              sessions: sessions.map((r) => r.fields),
              attendanceDays: attendanceDays.map((r) => r.fields),
            },
            null,
            2,
          );
        } else if (args.format === "csv") {
          const sessionRows = sessions.map((r) =>
            r.fields as Record<string, unknown>
          );
          fileContent = `# Learning Sessions\n${
            toCsv(sessionRows)
          }\n\n# Attendance Days\n${
            toCsv(
              attendanceDays.map((r) => r.fields as Record<string, unknown>),
            )
          }`;
        } else {
          const lines = [
            `# ${schoolYear} Homeschool Export`,
            "",
            `## Learning Sessions (${sessions.length})`,
            "",
            ...sessions.map((r) => {
              const f = r.fields;
              return `- **${f["date"]}** ${f["student"]}: ${f["subject"]} — ${
                f["minutes"]
              } min${f["description"] ? ` (${f["description"]})` : ""}`;
            }),
            "",
            `## Attendance Days (${attendanceDays.length})`,
            "",
            ...attendanceDays.map((r) => {
              const f = r.fields;
              return `- **${f["date"]}** ${f["student"]}: ${
                f["total_hours"]
              }h — ${
                f["counts_as_instructional_day"] ? "counts" : "does not count"
              }`;
            }),
          ];
          fileContent = lines.join("\n");
        }

        const fileWriter = context.createFileWriter(
          "export",
          "school-year-export-file",
          { contentType },
        );
        const fileHandle = await fileWriter.writeText(fileContent);

        const handle = await context.writeResource(
          "schoolYearExport",
          "school-year-export-latest",
          {
            schoolYear,
            student: args.student,
            sessionCount: sessions.length,
            attendanceDayCount: attendanceDays.length,
            includeTests: args.includeTests,
            format: args.format,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle, fileHandle] };
      },
    },

    /** Create realistic test entries (CaptureEvents + LearningSessions + AttendanceDays) marked isTest=true. */
    addTestEntries: {
      description:
        "Create test entries for smoke testing the pipeline. All entries have isTest=true and are excluded from progress summaries and exports by default.",
      arguments: AddTestEntriesArgs,
      execute: async (
        args: z.infer<typeof AddTestEntriesArgs>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: { info: (msg: string, ...args: unknown[]) => void };
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { gristBaseUrl, gristDocId, gristApiToken } = context.globalArgs;
        const client = makeGristClient(gristBaseUrl, gristDocId, gristApiToken);
        const now = new Date();
        const today = now.toISOString().slice(0, 10);
        const yesterday = new Date(now.getTime() - 86400000).toISOString()
          .slice(0, 10);
        const testDates = [yesterday, today];
        const testSubjects = [["Math", "Reading", "Science"], [
          "Writing",
          "History",
          "Art",
        ]];

        const captureEventFields: Record<string, unknown>[] = [];
        const sessionFields: Record<string, unknown>[] = [];

        for (const student of args.students) {
          for (let i = 0; i < 2; i++) {
            captureEventFields.push({
              source: "manual",
              source_message_id: `test-${student}-${i}`,
              captured_by: "addTestEntries",
              captured_at: now.toISOString(),
              event_date: testDates[i],
              raw_text: `Test capture for ${student} on ${testDates[i]}`,
              transcript: "",
              audio_url: "",
              status: "extracted",
              is_test: true,
              test_reason: args.testReason,
              notes: "Created by addTestEntries smoke test",
            });
            for (const subject of testSubjects[i]) {
              sessionFields.push({
                student,
                date: testDates[i],
                school_year: args.schoolYear,
                subject,
                minutes: 45,
                description: `Test ${subject.toLowerCase()} session`,
                resource: "",
                capture_event_id: 0,
                captured_by: "addTestEntries",
                confidence: 1.0,
                review_status: "approved",
                approved_by: "addTestEntries",
                approved_at: now.toISOString(),
                is_test: true,
                test_reason: args.testReason,
                notes: "Created by addTestEntries smoke test",
              });
            }
          }
        }

        let captureEventIds: number[] = [];
        let sessionIds: number[] = [];
        let attendanceDayIds: number[] = [];

        if (!args.dryRun) {
          captureEventIds = await client.addRecords(
            "CaptureEvents",
            captureEventFields,
          );
          sessionIds = await client.addRecords(
            "LearningSessions",
            sessionFields,
          );

          // Build attendance days from test sessions
          const grouped = new Map<string, number>();
          for (const s of sessionFields) {
            const key = `${s["student"]}::${s["date"]}`;
            grouped.set(
              key,
              (grouped.get(key) ?? 0) + (s["minutes"] as number),
            );
          }
          const adFields: Record<string, unknown>[] = [];
          for (const [key, minutes] of grouped.entries()) {
            const [student, date] = key.split("::");
            adFields.push({
              student,
              date,
              school_year: args.schoolYear,
              total_minutes: minutes,
              total_hours: Math.round((minutes / 60) * 100) / 100,
              counts_as_instructional_day: minutes >= 60,
              review_status: "approved",
              source_session_count: testSubjects[0].length,
              computed_at: now.toISOString(),
              is_test: true,
              test_reason: args.testReason,
              notes: "Created by addTestEntries smoke test",
            });
          }
          attendanceDayIds = await client.addRecords(
            "AttendanceDays",
            adFields,
          );
          context.logger.info(
            "Test entries created: {ce} events, {ls} sessions, {ad} days",
            {
              ce: captureEventIds.length,
              ls: sessionIds.length,
              ad: attendanceDayIds.length,
            },
          );
        }

        const handle = await context.writeResource(
          "testEntries",
          "test-entries-latest",
          {
            schoolYear: args.schoolYear,
            captureEventsCount: captureEventFields.length,
            learningSessionsCount: sessionFields.length,
            attendanceDaysCount: args.students.length * testDates.length,
            gristRowIds: {
              captureEvents: captureEventIds,
              learningSessions: sessionIds,
              attendanceDays: attendanceDayIds,
            },
            dryRun: args.dryRun,
            timestamp: now.toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    /** List all test entries, optionally filtered by school year. */
    listTestEntries: {
      description:
        "List all records marked isTest=true across CaptureEvents, LearningSessions, and AttendanceDays.",
      arguments: ListTestEntriesArgs,
      execute: async (
        args: z.infer<typeof ListTestEntriesArgs>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: { info: (msg: string, ...args: unknown[]) => void };
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { gristBaseUrl, gristDocId, gristApiToken } = context.globalArgs;
        const client = makeGristClient(gristBaseUrl, gristDocId, gristApiToken);

        let captureEvents = await client.getRecords("CaptureEvents");
        let sessions = await client.getRecords("LearningSessions");
        let attendanceDays = await client.getRecords("AttendanceDays");

        // Filter to test records client-side (boolean filter in Grist is unreliable)
        captureEvents = captureEvents.filter((r) =>
          r.fields["is_test"] === true
        );
        sessions = sessions.filter((r) => r.fields["is_test"] === true);
        attendanceDays = attendanceDays.filter((r) =>
          r.fields["is_test"] === true
        );

        if (args.schoolYear) {
          sessions = sessions.filter((r) =>
            r.fields["school_year"] === args.schoolYear
          );
          attendanceDays = attendanceDays.filter((r) =>
            r.fields["school_year"] === args.schoolYear
          );
        }

        context.logger.info(
          "Test entries: {ce} events, {ls} sessions, {ad} days",
          {
            ce: captureEvents.length,
            ls: sessions.length,
            ad: attendanceDays.length,
          },
        );

        const handle = await context.writeResource(
          "testEntries",
          "test-entries-list-latest",
          {
            schoolYear: args.schoolYear ?? "all",
            captureEventsCount: captureEvents.length,
            learningSessionsCount: sessions.length,
            attendanceDaysCount: attendanceDays.length,
            gristRowIds: {
              captureEvents: captureEvents.map((r) => r.id),
              learningSessions: sessions.map((r) => r.id),
              attendanceDays: attendanceDays.map((r) => r.id),
            },
            dryRun: false,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
