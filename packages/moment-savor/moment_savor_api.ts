/**
 * Moment Savor V1 API extension for swamp.
 *
 * Manages memories, API tokens, and family membership via the Moment Savor
 * REST API. Authenticate with a Bearer token obtained from
 * https://momentsavor.app/api_tokens.
 *
 * Syncs to resources for downstream CEL queries; mutation methods (create,
 * update, delete) act immediately without updating stored snapshots — call
 * `sync` after mutations to refresh.
 *
 * @module
 */

// Controllers covered by this extension (update when new endpoints are added):
//   app/controllers/api/v1/memories_controller.rb
//   app/controllers/api/v1/tokens_controller.rb
//   app/controllers/api/v1/family_members_controller.rb
//   app/controllers/api/v1/family_invitations_controller.rb

import { z } from "npm:zod@4";

// ── schemas ───────────────────────────────────────────────────────────────────

const GlobalArgsSchema = z.object({
  apiToken: z
    .string()
    .describe("Bearer token obtained from https://momentsavor.app/api_tokens"),
  baseUrl: z
    .string()
    .url()
    .default("https://momentsavor.app")
    .describe("Base URL of the Moment Savor app (override for local dev)"),
});

/** Shape of a memory as returned by the V1 API. */
const MemorySchema = z.object({
  id: z.string().uuid(),
  family_id: z.string().uuid(),
  created_by_user_id: z.string().uuid().nullable(),
  title: z.string().nullable(),
  transcript: z.string().nullable(),
  notes: z.string().nullable(),
  recorded_at: z.string(),
  location_name: z.string().nullable(),
  tags: z.array(z.string()),
  visibility: z.string(),
  transcription_status: z.string(),
  transcription_completed_at: z.string().nullable(),
  ai_data: z.record(z.string(), z.unknown()),
  ai_extraction_status: z.string(),
  ai_extraction_completed_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  first_memory: z.boolean(),
});

/** Shape of an API token as returned by the V1 API. */
const ApiTokenSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  scope: z.enum(["read", "read_write"]),
  family_id: z.string().uuid(),
  last_used_at: z.string().nullable(),
  created_at: z.string(),
});

/** Shape of a family membership as returned by the V1 API. */
const FamilyMemberSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  name: z.string(),
  email: z.string(),
  role: z.string(),
  joined_at: z.string().nullable(),
});

const MemoriesSnapshotSchema = z.object({
  memories: z.array(MemorySchema),
  total_count: z.number(),
  fetched_at: z.string(),
  query: z.string().optional(),
});

const TokensSnapshotSchema = z.object({
  tokens: z.array(ApiTokenSchema),
  fetched_at: z.string(),
});

const FamilyMembersSnapshotSchema = z.object({
  members: z.array(FamilyMemberSchema),
  fetched_at: z.string(),
});

/**
 * Stores a newly issued token value. Only `create` and `rotate` operations
 * expose the raw token — write it here so it is accessible via CEL after the
 * method completes.
 */
const IssuedTokenSchema = z.object({
  token: ApiTokenSchema,
  raw_token: z.string(),
  issued_at: z.string(),
});

// ── internal types ────────────────────────────────────────────────────────────

/** Loose shape of a V1 API response envelope for structured error extraction. */
type ApiEnvelope = {
  data?: unknown;
  meta?: { next_cursor?: string | null };
  error?: { code?: string; message?: string };
  errors?: unknown;
};

/** API response for token create / rotate — includes a one-time raw token. */
type TokenIssuance = z.infer<typeof ApiTokenSchema> & { token: string };

/**
 * Swamp execute-method context. Typed against GlobalArgsSchema; the full
 * swamp context type is not exported, so we declare the subset we use.
 */
interface ExecuteContext {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: { info: (msg: string) => void };
  writeResource: (
    name: string,
    instance: string,
    data: unknown,
  ) => Promise<unknown>;
}

// ── http helpers ──────────────────────────────────────────────────────────────

async function apiRequest(
  method: string,
  url: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch { /* 204 No Content or non-JSON body */ }
  return { status: response.status, json };
}

function apiGet(baseUrl: string, token: string, path: string) {
  return apiRequest("GET", `${baseUrl}${path}`, token);
}

function apiPost(
  baseUrl: string,
  token: string,
  path: string,
  body: Record<string, unknown>,
) {
  return apiRequest("POST", `${baseUrl}${path}`, token, body);
}

function apiPatch(
  baseUrl: string,
  token: string,
  path: string,
  body: Record<string, unknown>,
) {
  return apiRequest("PATCH", `${baseUrl}${path}`, token, body);
}

function apiDelete(baseUrl: string, token: string, path: string) {
  return apiRequest("DELETE", `${baseUrl}${path}`, token);
}

/** Cast unknown JSON to the loose envelope type for structured field access. */
function envelope(json: unknown): ApiEnvelope {
  return json as ApiEnvelope;
}

/**
 * Throws if the response status does not match the expected value(s), with the
 * API error message included in the thrown Error.
 */
function assertSuccess(
  status: number,
  json: unknown,
  expected: number | number[],
): void {
  const ok = Array.isArray(expected)
    ? expected.includes(status)
    : status === expected;
  if (!ok) {
    const env = envelope(json);
    const msg = env?.error?.message ?? JSON.stringify(env?.errors ?? json);
    throw new Error(`API error ${status}: ${msg}`);
  }
}

/** Fetches all pages of memories, following cursor pagination. */
async function fetchAllMemories(
  baseUrl: string,
  token: string,
  query?: string,
): Promise<Array<z.infer<typeof MemorySchema>>> {
  const memories: Array<z.infer<typeof MemorySchema>> = [];
  let cursor: string | null = null;

  for (let page = 0; page < 100; page++) {
    let path = `/api/v1/memories?per_page=100`;
    if (query) path += `&q=${encodeURIComponent(query)}`;
    if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;

    const { status, json } = await apiGet(baseUrl, token, path);
    assertSuccess(status, json, 200);

    const env = envelope(json);
    const data = (env.data as unknown[]) ?? [];
    memories.push(...data.map((m) => MemorySchema.parse(m)));

    cursor = env.meta?.next_cursor ?? null;
    if (!cursor) break;
  }

  return memories;
}

// ── model ─────────────────────────────────────────────────────────────────────

/**
 * Swamp model for the Moment Savor V1 REST API.
 *
 * Configure with an `apiToken` from https://momentsavor.app/api_tokens and
 * an optional `baseUrl` override for local development. Call `sync` to
 * populate resources, then use CEL expressions to query the snapshots.
 */
export const model = {
  type: "@mgreten/moment-savor",
  version: "2026.06.06.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    "memories": {
      description:
        "Snapshot of all memories for the authenticated family, optionally filtered by search query",
      schema: MemoriesSnapshotSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "tokens": {
      description:
        "Snapshot of active API tokens visible to the authenticated user",
      schema: TokensSnapshotSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "family-members": {
      description: "Snapshot of current family membership",
      schema: FamilyMembersSnapshotSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "issued-token": {
      description:
        "The most recently created or rotated API token, including the raw token value",
      schema: IssuedTokenSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    sync: {
      description:
        "Fetch current memories, tokens, and family members from the API and store as resources for CEL queries",
      arguments: z.object({
        query: z
          .string()
          .optional()
          .describe(
            "Optional full-text search query to filter the memories snapshot",
          ),
      }),
      execute: async (
        args: { query?: string },
        context: ExecuteContext,
      ) => {
        const { apiToken, baseUrl } = context.globalArgs;
        const fetched_at = new Date().toISOString();
        const handles = [];

        context.logger.info("Fetching memories…");
        const memories = await fetchAllMemories(baseUrl, apiToken, args.query);
        handles.push(
          await context.writeResource("memories", "current", {
            memories,
            total_count: memories.length,
            fetched_at,
            ...(args.query ? { query: args.query } : {}),
          }),
        );

        context.logger.info("Fetching tokens…");
        const { status: ts, json: tj } = await apiGet(
          baseUrl,
          apiToken,
          "/api/v1/tokens",
        );
        assertSuccess(ts, tj, 200);
        const tokenData = ((envelope(tj).data as unknown[]) ?? []).map((t) =>
          ApiTokenSchema.parse(t)
        );
        handles.push(
          await context.writeResource("tokens", "current", {
            tokens: tokenData,
            fetched_at,
          }),
        );

        context.logger.info("Fetching family members…");
        const { status: ms, json: mj } = await apiGet(
          baseUrl,
          apiToken,
          "/api/v1/family/members",
        );
        assertSuccess(ms, mj, 200);
        const members = ((envelope(mj).data as unknown[]) ?? []).map((m) =>
          FamilyMemberSchema.parse(m)
        );
        handles.push(
          await context.writeResource("family-members", "current", {
            members,
            fetched_at,
          }),
        );

        context.logger.info(
          `Synced ${memories.length} memories, ${tokenData.length} tokens, ${members.length} members`,
        );
        return { dataHandles: handles };
      },
    },

    createMemory: {
      description: "Create a new memory",
      arguments: z.object({
        recorded_at: z
          .string()
          .describe("ISO 8601 datetime when the memory occurred"),
        title: z.string().optional().describe("Title of the memory"),
        notes: z.string().optional().describe("Free-form notes or description"),
        transcript: z.string().optional().describe("Text transcript"),
        location_name: z.string().optional().describe("Location name"),
        visibility: z
          .enum(["visible", "private"])
          .optional()
          .describe("Visibility setting"),
        pinned: z.boolean().optional().describe("Whether to pin this memory"),
        tags: z.array(z.string()).optional().describe("Tags for the memory"),
      }),
      execute: async (
        args: Record<string, unknown>,
        context: ExecuteContext,
      ) => {
        const { apiToken, baseUrl } = context.globalArgs;
        const { status, json } = await apiPost(
          baseUrl,
          apiToken,
          "/api/v1/memories",
          { memory: args },
        );
        assertSuccess(status, json, 201);
        const memory = MemorySchema.parse(envelope(json).data);
        context.logger.info(
          `Created memory ${memory.id}: ${memory.title ?? "(untitled)"}`,
        );
        return { dataHandles: [] };
      },
    },

    updateMemory: {
      description:
        "Update an existing memory's title, notes, visibility, pinned state, tags, or recorded_at",
      arguments: z.object({
        id: z.string().uuid().describe("Memory UUID"),
        title: z.string().optional(),
        notes: z.string().optional(),
        recorded_at: z.string().optional().describe("ISO 8601 datetime"),
        visibility: z.enum(["visible", "private"]).optional(),
        pinned: z.boolean().optional(),
        tags: z.array(z.string()).optional(),
      }),
      execute: async (
        args: Record<string, unknown>,
        context: ExecuteContext,
      ) => {
        const { apiToken, baseUrl } = context.globalArgs;
        const { id, ...rest } = args as
          & { id: string }
          & Record<
            string,
            unknown
          >;
        const { status, json } = await apiPatch(
          baseUrl,
          apiToken,
          `/api/v1/memories/${id}`,
          { memory: rest },
        );
        assertSuccess(status, json, 200);
        context.logger.info(`Updated memory ${id}`);
        return { dataHandles: [] };
      },
    },

    deleteMemory: {
      description: "Permanently delete a memory",
      arguments: z.object({
        id: z.string().uuid().describe("Memory UUID to delete"),
      }),
      execute: async (args: { id: string }, context: ExecuteContext) => {
        const { apiToken, baseUrl } = context.globalArgs;
        const { status, json } = await apiDelete(
          baseUrl,
          apiToken,
          `/api/v1/memories/${args.id}`,
        );
        assertSuccess(status, json, 204);
        context.logger.info(`Deleted memory ${args.id}`);
        return { dataHandles: [] };
      },
    },

    createToken: {
      description:
        "Create a new API token. The raw token value is stored in the issued-token resource — read it immediately as it cannot be recovered later.",
      arguments: z.object({
        name: z.string().describe("Display name for the token"),
        scope: z
          .enum(["read", "read_write"])
          .describe("Token scope: read-only or read+write"),
      }),
      execute: async (
        args: { name: string; scope: string },
        context: ExecuteContext,
      ) => {
        const { apiToken, baseUrl } = context.globalArgs;
        const { status, json } = await apiPost(
          baseUrl,
          apiToken,
          "/api/v1/tokens",
          { token: { name: args.name, scope: args.scope } },
        );
        assertSuccess(status, json, 201);
        const data = envelope(json).data as TokenIssuance;
        const handle = await context.writeResource("issued-token", "latest", {
          token: ApiTokenSchema.parse(data),
          raw_token: data.token,
          issued_at: new Date().toISOString(),
        });
        context.logger.info(`Created token "${args.name}" (id: ${data.id})`);
        return { dataHandles: [handle] };
      },
    },

    revokeToken: {
      description: "Permanently revoke an API token by ID",
      arguments: z.object({
        id: z.string().uuid().describe("API token UUID to revoke"),
      }),
      execute: async (args: { id: string }, context: ExecuteContext) => {
        const { apiToken, baseUrl } = context.globalArgs;
        const { status, json } = await apiDelete(
          baseUrl,
          apiToken,
          `/api/v1/tokens/${args.id}`,
        );
        assertSuccess(status, json, 204);
        context.logger.info(`Revoked token ${args.id}`);
        return { dataHandles: [] };
      },
    },

    rotateToken: {
      description:
        "Rotate an existing API token, generating a new secret. The new raw token value is stored in the issued-token resource.",
      arguments: z.object({
        id: z.string().uuid().describe("API token UUID to rotate"),
      }),
      execute: async (args: { id: string }, context: ExecuteContext) => {
        const { apiToken, baseUrl } = context.globalArgs;
        const { status, json } = await apiPost(
          baseUrl,
          apiToken,
          `/api/v1/tokens/${args.id}/rotate`,
          {},
        );
        assertSuccess(status, json, 200);
        const data = envelope(json).data as TokenIssuance;
        const handle = await context.writeResource("issued-token", "latest", {
          token: ApiTokenSchema.parse(data),
          raw_token: data.token,
          issued_at: new Date().toISOString(),
        });
        context.logger.info(`Rotated token ${args.id}`);
        return { dataHandles: [handle] };
      },
    },

    updateMemberRole: {
      description:
        "Update a family member's role. Requires an owner or admin token. Only owners can assign the owner role.",
      arguments: z.object({
        id: z.string().uuid().describe("Family membership UUID"),
        role: z
          .string()
          .describe("New role: member, admin, or owner"),
      }),
      execute: async (
        args: { id: string; role: string },
        context: ExecuteContext,
      ) => {
        const { apiToken, baseUrl } = context.globalArgs;
        const { status, json } = await apiPatch(
          baseUrl,
          apiToken,
          `/api/v1/family/members/${args.id}`,
          { role: args.role },
        );
        assertSuccess(status, json, 200);
        context.logger.info(`Updated member ${args.id} role to ${args.role}`);
        return { dataHandles: [] };
      },
    },

    removeMember: {
      description:
        "Remove a family member. Requires an owner or admin token. Cannot remove yourself.",
      arguments: z.object({
        id: z.string().uuid().describe("Family membership UUID to remove"),
      }),
      execute: async (args: { id: string }, context: ExecuteContext) => {
        const { apiToken, baseUrl } = context.globalArgs;
        const { status, json } = await apiDelete(
          baseUrl,
          apiToken,
          `/api/v1/family/members/${args.id}`,
        );
        assertSuccess(status, json, 204);
        context.logger.info(`Removed member ${args.id}`);
        return { dataHandles: [] };
      },
    },

    sendInvitation: {
      description:
        "Send a family invitation email. Requires a read_write token. Only owners can invite with the owner role.",
      arguments: z.object({
        email: z.string().email().describe("Email address to invite"),
        role: z
          .string()
          .default("member")
          .describe("Role to assign: member, admin, or owner"),
      }),
      execute: async (
        args: { email: string; role: string },
        context: ExecuteContext,
      ) => {
        const { apiToken, baseUrl } = context.globalArgs;
        const { status, json } = await apiPost(
          baseUrl,
          apiToken,
          "/api/v1/family/invitations",
          { invitation: { email: args.email, role: args.role } },
        );
        assertSuccess(status, json, 201);
        context.logger.info(`Sent invitation to ${args.email} (${args.role})`);
        return { dataHandles: [] };
      },
    },
  },
};
