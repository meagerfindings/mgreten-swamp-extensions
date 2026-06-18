/**
 * Generic Grist REST API model — list tables, manage columns, read and write records.
 *
 * Provides low-level Grist document operations suitable as a foundation for
 * domain-specific Grist-backed extensions. Supports self-hosted and cloud Grist.
 *
 * Auth: pass your Grist API token via vault expression:
 *   --global-arg 'gristApiToken=${{ vault.get(my-vault, GRIST_API_TOKEN) }}'
 *
 * @module
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Global args
// ---------------------------------------------------------------------------

/** Global arguments required by every method. */
const GlobalArgsSchema = z.object({
  gristBaseUrl: z
    .string()
    .url()
    .describe("Grist base URL (e.g. https://grist.example.com)"),
  gristDocId: z.string().describe("Grist document ID"),
  gristApiToken: z
    .string()
    .meta({ sensitive: true })
    .describe("Grist API token — use vault expression"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ---------------------------------------------------------------------------
// Resource output schemas
// ---------------------------------------------------------------------------

/** Schema for checkApi output. */
const ApiStatusSchema = z.object({
  docId: z.string(),
  docName: z.string(),
  reachable: z.boolean(),
  timestamp: z.string(),
});

/** Schema for listTables output. */
const TableListSchema = z.object({
  tables: z.array(z.string()),
  count: z.number(),
  timestamp: z.string(),
});

/** Schema for getColumns output. */
const ColumnListSchema = z.object({
  tableId: z.string(),
  columns: z.array(
    z.object({ id: z.string(), type: z.string(), label: z.string() }),
  ),
  count: z.number(),
  timestamp: z.string(),
});

/** Schema for getRecords output. */
const RecordsSchema = z.object({
  tableId: z.string(),
  records: z.array(
    z.object({ id: z.number(), fields: z.record(z.unknown()) }),
  ),
  count: z.number(),
  timestamp: z.string(),
});

/** Schema for addRecords output. */
const AddResultSchema = z.object({
  tableId: z.string(),
  rowIds: z.array(z.number()),
  count: z.number(),
  dryRun: z.boolean(),
  timestamp: z.string(),
});

/** Schema for updateRecords output. */
const UpdateResultSchema = z.object({
  tableId: z.string(),
  rowIds: z.array(z.number()),
  count: z.number(),
  dryRun: z.boolean(),
  timestamp: z.string(),
});

/** Schema for createTable output. */
const TableCreateSchema = z.object({
  tableId: z.string(),
  dryRun: z.boolean(),
  timestamp: z.string(),
});

/** Schema for addColumns output. */
const ColumnAddSchema = z.object({
  tableId: z.string(),
  columnsAdded: z.array(z.string()),
  dryRun: z.boolean(),
  timestamp: z.string(),
});

// ---------------------------------------------------------------------------
// Grist API client
// ---------------------------------------------------------------------------

/** A single Grist record with its numeric row id and field map. */
interface GristRecord {
  id: number;
  fields: Record<string, unknown>;
}

/** A Grist column descriptor as returned by the columns endpoint. */
interface GristColumn {
  id: string;
  fields: Record<string, unknown>;
}

/** Column definition used when creating tables or adding columns. */
interface ColumnSpec {
  id: string;
  label: string;
  type: string;
}

/** Strip /o/<org> suffix and trailing slash from a Grist base URL. */
function normalizeGristUrl(url: string): string {
  return url.replace(/\/o\/[^/]+\/?$/, "").replace(/\/$/, "");
}

/** Build a minimal Grist document API client. */
function makeClient(baseUrl: string, docId: string, apiToken: string): {
  getDoc(): Promise<{ id: string; name: string }>;
  getTables(): Promise<Array<{ id: string }>>;
  getColumns(tableId: string): Promise<GristColumn[]>;
  getRecords(
    tableId: string,
    filter?: Record<string, unknown[]>,
    limit?: number,
  ): Promise<GristRecord[]>;
  addRecords(
    tableId: string,
    records: Record<string, unknown>[],
  ): Promise<number[]>;
  updateRecords(
    tableId: string,
    records: Array<{ id: number; fields: Record<string, unknown> }>,
  ): Promise<void>;
  createTable(tableId: string, columns: ColumnSpec[]): Promise<void>;
  addColumns(tableId: string, columns: ColumnSpec[]): Promise<void>;
} {
  const base = normalizeGristUrl(baseUrl);
  const docBase = `${base}/api/docs/${docId}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiToken}`,
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
    async getColumns(tableId: string): Promise<GristColumn[]> {
      const data = await req<{ columns: GristColumn[] }>(
        "GET",
        `/tables/${tableId}/columns`,
      );
      return data.columns;
    },
    async getRecords(
      tableId: string,
      filter?: Record<string, unknown[]>,
      limit?: number,
    ): Promise<GristRecord[]> {
      const params = new URLSearchParams();
      if (filter && Object.keys(filter).length > 0) {
        params.set("filter", JSON.stringify(filter));
      }
      if (limit !== undefined) params.set("limit", String(limit));
      const qs = params.toString();
      const data = await req<{ records: GristRecord[] }>(
        "GET",
        `/tables/${tableId}/records${qs ? `?${qs}` : ""}`,
      );
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
    async createTable(tableId: string, columns: ColumnSpec[]): Promise<void> {
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
    async addColumns(tableId: string, columns: ColumnSpec[]): Promise<void> {
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
// Method argument schemas
// ---------------------------------------------------------------------------

const GetColumnsArgs = z.object({
  tableId: z.string().describe("Table ID to inspect"),
});

const GetRecordsArgs = z.object({
  tableId: z.string(),
  filter: z
    .record(z.array(z.unknown()))
    .optional()
    .describe(
      "Grist filter: keys are column IDs, values are arrays of allowed values",
    ),
  limit: z.number().int().optional().describe("Maximum records to return"),
});

const AddRecordsArgs = z.object({
  tableId: z.string(),
  records: z
    .array(z.record(z.unknown()))
    .describe("Array of field objects to insert"),
  dryRun: z.boolean().default(false),
});

const UpdateRecordsArgs = z.object({
  tableId: z.string(),
  records: z.array(
    z.object({ id: z.number(), fields: z.record(z.unknown()) }),
  ),
  dryRun: z.boolean().default(false),
});

const ColumnSpecSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z
    .string()
    .describe(
      "Grist column type: Text, Int, Numeric, Bool, Date, DateTime, Choice, ChoiceList",
    ),
});

const CreateTableArgs = z.object({
  tableId: z.string(),
  columns: z.array(ColumnSpecSchema),
  dryRun: z.boolean().default(false),
});

const AddColumnsArgs = z.object({
  tableId: z.string(),
  columns: z.array(ColumnSpecSchema),
  dryRun: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Model export
// ---------------------------------------------------------------------------

/** Generic Grist REST API model for reading and writing document data. */
export const model = {
  type: "@mgreten/grist",
  version: "2026.06.18.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    apiStatus: {
      description: "Grist API connectivity result",
      schema: ApiStatusSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    tableList: {
      description: "List of tables in the Grist document",
      schema: TableListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    columnList: {
      description: "Columns for a Grist table",
      schema: ColumnListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    records: {
      description: "Records fetched from a Grist table",
      schema: RecordsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    addResult: {
      description: "Result of an addRecords operation",
      schema: AddResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    updateResult: {
      description: "Result of an updateRecords operation",
      schema: UpdateResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    tableCreate: {
      description: "Result of a createTable operation",
      schema: TableCreateSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    columnAdd: {
      description: "Result of an addColumns operation",
      schema: ColumnAddSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    /** Verify Grist connectivity: checks base URL, token, and document access. */
    checkApi: {
      description:
        "Verify Grist base URL, API token, and document accessibility. Does not mutate.",
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
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { gristBaseUrl, gristDocId, gristApiToken } = context.globalArgs;
        const client = makeClient(gristBaseUrl, gristDocId, gristApiToken);
        const doc = await client.getDoc();
        context.logger.info("Grist reachable: {name}", { name: doc.name });
        const handle = await context.writeResource("apiStatus", "api-status", {
          docId: doc.id,
          docName: doc.name,
          reachable: true,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    /** List all table IDs in the Grist document. */
    listTables: {
      description: "List all table IDs in the Grist document.",
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
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { gristBaseUrl, gristDocId, gristApiToken } = context.globalArgs;
        const client = makeClient(gristBaseUrl, gristDocId, gristApiToken);
        const tables = await client.getTables();
        const ids = tables.map((t) => t.id);
        context.logger.info("Found {count} tables", { count: ids.length });
        const handle = await context.writeResource("tableList", "table-list", {
          tables: ids,
          count: ids.length,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    /** List all columns for a specific Grist table. */
    getColumns: {
      description: "List all columns (id, label, type) for a Grist table.",
      arguments: GetColumnsArgs,
      execute: async (
        args: z.infer<typeof GetColumnsArgs>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { gristBaseUrl, gristDocId, gristApiToken } = context.globalArgs;
        const client = makeClient(gristBaseUrl, gristDocId, gristApiToken);
        const cols = await client.getColumns(args.tableId);
        const mapped = cols.map((c) => ({
          id: c.id,
          type: String(c.fields["type"] ?? ""),
          label: String(c.fields["label"] ?? c.id),
        }));
        context.logger.info("Found {count} columns in {table}", {
          count: mapped.length,
          table: args.tableId,
        });
        const handle = await context.writeResource(
          "columnList",
          `column-list-${args.tableId}`,
          {
            tableId: args.tableId,
            columns: mapped,
            count: mapped.length,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    /** Fetch records from a Grist table with optional server-side filtering. */
    getRecords: {
      description:
        "Fetch records from a Grist table. Filter keys are column IDs; values are arrays of allowed values.",
      arguments: GetRecordsArgs,
      execute: async (
        args: z.infer<typeof GetRecordsArgs>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { gristBaseUrl, gristDocId, gristApiToken } = context.globalArgs;
        const client = makeClient(gristBaseUrl, gristDocId, gristApiToken);
        const recs = await client.getRecords(
          args.tableId,
          args.filter,
          args.limit,
        );
        context.logger.info("Fetched {count} records from {table}", {
          count: recs.length,
          table: args.tableId,
        });
        const handle = await context.writeResource(
          "records",
          `records-${args.tableId}`,
          {
            tableId: args.tableId,
            records: recs,
            count: recs.length,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    /** Insert one or more records into a Grist table. */
    addRecords: {
      description:
        "Insert records into a Grist table. Use dryRun=true to preview without writing.",
      arguments: AddRecordsArgs,
      execute: async (
        args: z.infer<typeof AddRecordsArgs>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { gristBaseUrl, gristDocId, gristApiToken } = context.globalArgs;
        const client = makeClient(gristBaseUrl, gristDocId, gristApiToken);
        let rowIds: number[] = [];
        if (!args.dryRun) {
          rowIds = await client.addRecords(args.tableId, args.records);
          context.logger.info("Inserted {count} records into {table}", {
            count: rowIds.length,
            table: args.tableId,
          });
        }
        const handle = await context.writeResource(
          "addResult",
          `add-result-${args.tableId}`,
          {
            tableId: args.tableId,
            rowIds,
            count: args.records.length,
            dryRun: args.dryRun,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    /** Update existing records in a Grist table by row id. */
    updateRecords: {
      description:
        "Update records in a Grist table by row id. Use dryRun=true to preview.",
      arguments: UpdateRecordsArgs,
      execute: async (
        args: z.infer<typeof UpdateRecordsArgs>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { gristBaseUrl, gristDocId, gristApiToken } = context.globalArgs;
        const client = makeClient(gristBaseUrl, gristDocId, gristApiToken);
        if (!args.dryRun) {
          await client.updateRecords(args.tableId, args.records);
          context.logger.info("Updated {count} records in {table}", {
            count: args.records.length,
            table: args.tableId,
          });
        }
        const handle = await context.writeResource(
          "updateResult",
          `update-result-${args.tableId}`,
          {
            tableId: args.tableId,
            rowIds: args.records.map((r) => r.id),
            count: args.records.length,
            dryRun: args.dryRun,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    /** Create a new table in the Grist document with specified columns. */
    createTable: {
      description:
        "Create a new Grist table with specified columns. Use dryRun=true to preview.",
      arguments: CreateTableArgs,
      execute: async (
        args: z.infer<typeof CreateTableArgs>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { gristBaseUrl, gristDocId, gristApiToken } = context.globalArgs;
        const client = makeClient(gristBaseUrl, gristDocId, gristApiToken);
        if (!args.dryRun) {
          await client.createTable(args.tableId, args.columns);
          context.logger.info("Created table {table}", {
            table: args.tableId,
          });
        }
        const handle = await context.writeResource(
          "tableCreate",
          `table-create-${args.tableId}`,
          {
            tableId: args.tableId,
            dryRun: args.dryRun,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    /** Add columns to an existing Grist table. */
    addColumns: {
      description:
        "Add columns to an existing Grist table. Use dryRun=true to preview.",
      arguments: AddColumnsArgs,
      execute: async (
        args: z.infer<typeof AddColumnsArgs>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { gristBaseUrl, gristDocId, gristApiToken } = context.globalArgs;
        const client = makeClient(gristBaseUrl, gristDocId, gristApiToken);
        if (!args.dryRun) {
          await client.addColumns(args.tableId, args.columns);
          context.logger.info("Added {count} columns to {table}", {
            count: args.columns.length,
            table: args.tableId,
          });
        }
        const handle = await context.writeResource(
          "columnAdd",
          `column-add-${args.tableId}`,
          {
            tableId: args.tableId,
            columnsAdded: args.columns.map((c) => c.id),
            dryRun: args.dryRun,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
