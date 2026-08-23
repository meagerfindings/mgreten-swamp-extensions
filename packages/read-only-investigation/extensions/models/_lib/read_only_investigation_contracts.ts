import { z } from "npm:zod@4";

/** Version for the stable investigation-plan wire schema. */
export const READ_ONLY_INVESTIGATION_SCHEMA_VERSION = "1.0" as const;

/** Hard upper bounds that callers cannot relax through authorization input. */
export const READ_ONLY_INVESTIGATION_LIMITS = {
  anomalies: 50,
  sources: 20,
  queries: 100,
  rows: 10_000,
  bytes: 10_000_000,
  windowSeconds: 604_800,
} as const;

const Id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/);
const Text = z.string().trim().min(1).max(1_000);
const Timestamp = z.iso.datetime({ offset: true });
const Sensitivity = z.enum([
  "public",
  "private-project",
  "company-internal",
  "customer-sensitive",
  "regulated",
]);
const Operation = z.enum(["lookup", "list", "search", "aggregate"]);
const Severity = z.enum(["low", "medium", "high", "critical"]);
const DestinationClass = z.enum(["none", "controlled", "external", "public"]);

const sourceSchema = z.strictObject({
  sourceId: Id,
  snapshotId: Id,
  approved: z.boolean(),
  availability: z.enum(["available", "unavailable"]),
  collectedAt: Timestamp,
  expiresAt: Timestamp,
  sensitivity: Sensitivity,
  allowedOperations: z.array(Operation).min(1).max(4),
  allowedScopes: z.array(Id).min(1).max(20),
});
const querySchema = z.strictObject({
  queryId: Id,
  sourceId: Id,
  sourceSnapshotId: Id,
  operation: Operation,
  scope: Id,
  evidenceId: Id,
  purpose: Text,
  maxRows: z.number().int().positive(),
  maxBytes: z.number().int().positive(),
  windowSeconds: z.number().int().positive(),
  destinationClass: DestinationClass,
});
const anomalySchema = z.strictObject({
  anomalyId: Id,
  confidence: z.number().finite().min(0).max(1),
  severity: Severity,
  summary: Text,
  queries: z.array(querySchema).min(1).max(
    READ_ONLY_INVESTIGATION_LIMITS.queries,
  ),
});

/** Strict input contract for constructing an investigation authorization plan. */
export const readOnlyInvestigationInputSchema = z.strictObject({
  schemaVersion: z.literal(READ_ONLY_INVESTIGATION_SCHEMA_VERSION),
  authorizationId: Id,
  planId: Id,
  evaluatedAt: Timestamp,
  authorization: z.strictObject({
    issuedAt: Timestamp,
    expiresAt: Timestamp,
    minimumConfidence: z.number().finite().min(0).max(1),
    minimumSeverity: Severity,
    maxAnomalies: z.number().int().positive().max(
      READ_ONLY_INVESTIGATION_LIMITS.anomalies,
    ),
    maxQueries: z.number().int().positive().max(
      READ_ONLY_INVESTIGATION_LIMITS.queries,
    ),
    maxRowsPerQuery: z.number().int().positive().max(
      READ_ONLY_INVESTIGATION_LIMITS.rows,
    ),
    maxBytesPerQuery: z.number().int().positive().max(
      READ_ONLY_INVESTIGATION_LIMITS.bytes,
    ),
    maxWindowSeconds: z.number().int().positive().max(
      READ_ONLY_INVESTIGATION_LIMITS.windowSeconds,
    ),
    escalation: z.strictObject({
      humanRole: Id,
      requiredAtSeverity: Severity,
      action: z.literal("request_human_review"),
    }),
  }),
  sourceRegistrySnapshot: z.strictObject({
    registrySnapshotId: Id,
    capturedAt: Timestamp,
    sources: z.array(sourceSchema).min(1).max(
      READ_ONLY_INVESTIGATION_LIMITS.sources,
    ),
  }),
  anomalies: z.array(anomalySchema).min(1).max(
    READ_ONLY_INVESTIGATION_LIMITS.anomalies,
  ),
});

const authoritySchema = z.strictObject({
  disposition: z.literal("unverified-plan-only"),
  authorityBasis: z.literal("caller-supplied-unverified"),
  grant: z.literal("none"),
  execution: z.literal("none"),
  network: z.literal("none"),
  providerInvocation: z.literal("none"),
  productionMutation: z.literal("none"),
  adapterApprovalRequired: z.literal(true),
});

/** Strict output contract for a zero-authority investigation plan. */
export const readOnlyInvestigationPlanSchema = z.strictObject({
  schemaVersion: z.literal(READ_ONLY_INVESTIGATION_SCHEMA_VERSION),
  authorizationId: Id,
  planId: Id,
  evaluatedAt: Timestamp,
  expiresAt: Timestamp,
  registrySnapshotId: Id,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  anomalies: z.array(z.strictObject({
    anomalyId: Id,
    confidence: z.number().min(0).max(1),
    severity: Severity,
    sourceIds: z.array(Id).min(1),
    evidenceIds: z.array(Id).min(1),
    queries: z.array(querySchema).min(1),
    escalation: z.strictObject({
      required: z.boolean(),
      humanRole: Id,
      action: z.literal("request_human_review"),
    }),
  })).min(1),
  authority: authoritySchema,
});

/** A validated, deterministic, and non-executable investigation plan. */
export type ReadOnlyInvestigationPlan = z.infer<
  typeof readOnlyInvestigationPlanSchema
>;

const severityRank = { low: 0, medium: 1, high: 2, critical: 3 } as const;

/**
 * Validate untrusted input and produce a bounded plan without performing I/O.
 *
 * The returned plan deliberately grants no execution or network authority.
 */
export async function prepareReadOnlyInvestigation(
  raw: unknown,
): Promise<ReadOnlyInvestigationPlan> {
  const input = readOnlyInvestigationInputSchema.parse(raw);
  function fail(message: string): never {
    throw new TypeError(message);
  }
  const now = Date.parse(input.evaluatedAt);
  if (
    Date.parse(input.authorization.issuedAt) > now ||
    Date.parse(input.authorization.expiresAt) <= now
  ) fail("authorization is unavailable or expired");
  if (Date.parse(input.sourceRegistrySnapshot.capturedAt) > now) {
    fail("source registry snapshot is not yet available");
  }
  if (
    new Set(
      input.sourceRegistrySnapshot.sources.map((source) => source.sourceId),
    ).size !== input.sourceRegistrySnapshot.sources.length
  ) fail("duplicate sourceId");
  if (
    new Set(input.anomalies.map((anomaly) => anomaly.anomalyId)).size !==
      input.anomalies.length
  ) fail("duplicate anomalyId");
  const eligible = input.anomalies.filter((anomaly) =>
    anomaly.confidence >= input.authorization.minimumConfidence &&
    severityRank[anomaly.severity] >=
      severityRank[input.authorization.minimumSeverity]
  );
  if (!eligible.length) fail("no anomaly meets authorization thresholds");
  if (eligible.length > input.authorization.maxAnomalies) {
    fail("anomaly limit exceeded");
  }
  const queryIds = new Set<string>();
  const evidenceIds = new Set<string>();
  let queryCount = 0;
  const anomalies = eligible.sort((left, right) =>
    left.anomalyId.localeCompare(right.anomalyId)
  ).map((anomaly) => {
    const queries = [...anomaly.queries].sort((left, right) =>
      left.queryId.localeCompare(right.queryId)
    );
    queryCount += queries.length;
    for (const query of queries) {
      if (queryIds.has(query.queryId) || evidenceIds.has(query.evidenceId)) {
        fail("query and evidence identifiers must be globally unique");
      }
      queryIds.add(query.queryId);
      evidenceIds.add(query.evidenceId);
      const source = input.sourceRegistrySnapshot.sources.find((candidate) =>
        candidate.sourceId === query.sourceId
      );
      if (!source) {
        fail("source is unavailable or unapproved");
      }
      if (!source.approved || source.availability !== "available") {
        fail("source is unavailable or unapproved");
      }
      if (source.snapshotId !== query.sourceSnapshotId) {
        fail("query source snapshot is not exact");
      }
      if (
        Date.parse(source.collectedAt) > now ||
        Date.parse(source.collectedAt) >
          Date.parse(input.sourceRegistrySnapshot.capturedAt) ||
        Date.parse(source.expiresAt) <= now
      ) fail("source snapshot is unavailable or stale");
      if (
        !source.allowedOperations.includes(query.operation) ||
        !source.allowedScopes.includes(query.scope)
      ) fail("query operation or scope is unapproved");
      if (
        query.maxRows > input.authorization.maxRowsPerQuery ||
        query.maxBytes > input.authorization.maxBytesPerQuery ||
        query.windowSeconds > input.authorization.maxWindowSeconds
      ) fail("query limit exceeded");
      if (
        source.sensitivity !== "public" &&
        (query.destinationClass === "external" ||
          query.destinationClass === "public")
      ) fail("private data cannot be routed to public or external providers");
    }
    return {
      anomalyId: anomaly.anomalyId,
      confidence: anomaly.confidence,
      severity: anomaly.severity,
      sourceIds: [...new Set(queries.map((query) => query.sourceId))].sort(),
      evidenceIds: queries.map((query) => query.evidenceId).sort(),
      queries,
      escalation: {
        required: severityRank[anomaly.severity] >=
          severityRank[input.authorization.escalation.requiredAtSeverity],
        humanRole: input.authorization.escalation.humanRole,
        action: "request_human_review" as const,
      },
    };
  });
  if (queryCount > input.authorization.maxQueries) fail("query limit exceeded");
  const requestDigest = await sha256(canonicalJson(input));
  return readOnlyInvestigationPlanSchema.parse({
    schemaVersion: READ_ONLY_INVESTIGATION_SCHEMA_VERSION,
    authorizationId: input.authorizationId,
    planId: input.planId,
    evaluatedAt: input.evaluatedAt,
    expiresAt: input.authorization.expiresAt,
    registrySnapshotId: input.sourceRegistrySnapshot.registrySnapshotId,
    requestDigest,
    anomalies,
    authority: {
      disposition: "unverified-plan-only",
      authorityBasis: "caller-supplied-unverified",
      grant: "none",
      execution: "none",
      network: "none",
      providerInvocation: "none",
      productionMutation: "none",
      adapterApprovalRequired: true,
    },
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
        .join(",")
    }}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
