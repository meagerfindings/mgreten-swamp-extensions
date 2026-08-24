/** A generic, deterministic, persistence-only registry conflict detector. @module */
import { z } from "npm:zod@4";

/** Contract version for registry snapshots and evaluations. */
export const SCHEMA_VERSION = "1.0" as const;
const Id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
const Text = z.string().trim().min(1).max(2_000);
const Timestamp = z.iso.datetime({ offset: true });
const Category = z.enum(["reference", "decision", "plan", "proposal"]);
const LegacyKind = z.enum(["context", "decision", "work", "recommendation"]);
const Record = z.strictObject({
  recordId: Id,
  version: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  authority: z.strictObject({
    authorityId: Id,
    actorId: Id,
    role: Text,
    humanAuthority: z.boolean(),
    source: Text,
  }),
  provenance: z.strictObject({
    sourceId: Id,
    collector: Id,
    collectorVersion: Text,
    method: Text,
    collectedAt: Timestamp,
  }),
  freshness: z.strictObject({ asOf: Timestamp, expiresAt: Timestamp }),
  reviewAt: Timestamp,
  claims: z.array(z.strictObject({ conflictKey: Id, value: Text })).max(50),
}).superRefine((record, ctx) => {
  const seen = new Set<string>();
  record.claims.forEach((claim, index) => {
    if (seen.has(claim.conflictKey)) {
      ctx.addIssue({
        code: "custom",
        path: ["claims", index, "conflictKey"],
        message: "a record may declare each conflict key only once",
      });
    }
    seen.add(claim.conflictKey);
  });
});
const Rule = z.strictObject({
  ruleId: Id,
  conflictKey: Id,
  appliesTo: z.array(Category).min(2).max(4),
  contradictoryValuePairs: z.array(z.tuple([Text, Text])).min(1),
  severity: z.enum(["warning", "escalation"]),
  recommendation: Text,
}).superRefine((rule, ctx) => {
  if (new Set(rule.appliesTo).size !== rule.appliesTo.length) {
    ctx.addIssue({
      code: "custom",
      path: ["appliesTo"],
      message: "appliesTo categories must be unique",
    });
  }
  const pairs = new Set<string>();
  rule.contradictoryValuePairs.forEach(([left, right], index) => {
    if (left === right) {
      ctx.addIssue({
        code: "custom",
        path: ["contradictoryValuePairs", index],
        message: "a value cannot contradict itself",
      });
    }
    const key = [left, right].sort().join("\0");
    if (pairs.has(key)) {
      ctx.addIssue({
        code: "custom",
        path: ["contradictoryValuePairs", index],
        message: "contradictory value pairs must be unique",
      });
    }
    pairs.add(key);
  });
});
/** Validates an explicit, generic registry snapshot. */
export const genericInputSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  evaluationId: Id,
  evaluatedAt: Timestamp,
  references: z.array(Record).max(100),
  decisions: z.array(Record).max(100),
  plans: z.array(Record).max(100),
  proposals: z.array(Record).max(100),
  availability: z.array(
    z.strictObject({
      category: Category,
      status: z.enum(["available", "unavailable"]),
      reason: Text.nullable(),
    }),
  ).length(4),
  conflictRules: z.array(Rule).min(1).max(100),
  stalePolicy: z.strictObject({
    reviewDue: z.enum(["escalate", "report", "ignore"]),
    freshnessExpired: z.enum(["escalate", "report", "ignore"]),
    futureAsOf: z.enum(["escalate", "report"]),
  }),
  ordering: z.literal("severity_desc_code_asc_conflict_key_asc_record_ids_asc"),
}).superRefine((x, ctx) => {
  const fail = (path: PropertyKey[], message: string): void =>
    ctx.addIssue({ code: "custom", path, message });
  for (const category of Category.options) {
    if (
      x.availability.filter((item) => item.category === category).length !== 1
    ) {
      fail(
        ["availability"],
        `exactly one ${category} availability entry is required`,
      );
    }
  }
  x.availability.forEach((item, i) => {
    if ((item.status === "unavailable") !== (item.reason !== null)) {
      fail(
        ["availability", i, "reason"],
        "reason is required only for unavailable data",
      );
    }
  });
  const groups = {
    reference: x.references,
    decision: x.decisions,
    plan: x.plans,
    proposal: x.proposals,
  };
  const recordVersions = new Map<string, { category: string; index: number }>();
  for (const [category, records] of Object.entries(groups)) {
    records.forEach((record, i) => {
      const key = `${record.recordId}\0${record.version}`;
      const previous = recordVersions.get(key);
      if (previous) {
        fail(
          [category, i],
          `${record.recordId}@${record.version} duplicates ${previous.category}[${previous.index}]`,
        );
      } else {
        recordVersions.set(key, { category, index: i });
      }
      if (
        (category === "reference" || category === "decision") &&
        !record.authority.humanAuthority
      ) {
        fail(
          [category, i, "authority"],
          "explicit human authority is required",
        );
      }
      if (
        Date.parse(record.provenance.collectedAt) > Date.parse(x.evaluatedAt) ||
        Date.parse(record.freshness.asOf) >
          Date.parse(record.freshness.expiresAt) ||
        Date.parse(record.provenance.collectedAt) >
          Date.parse(record.freshness.asOf)
      ) {
        fail([category, i], "invalid provenance or freshness ordering");
      }
    });
  }
  const ruleIds = new Set<string>();
  x.conflictRules.forEach((rule, index) => {
    if (ruleIds.has(rule.ruleId)) {
      fail(
        ["conflictRules", index, "ruleId"],
        "ruleId values must be unique",
      );
    }
    ruleIds.add(rule.ruleId);
  });
});
const GenericDiagnostic = z.strictObject({
  severity: z.enum(["escalation", "warning", "information"]),
  code: z.enum([
    "contradictory_decision",
    "conflict",
    "review_due",
    "expired_freshness",
    "future_as_of",
    "unavailable_data",
  ]),
  conflictKey: Id.nullable(),
  recordIds: z.array(Id),
  ruleId: Id.nullable(),
  message: Text,
  recommendation: Text,
  requiresHumanResolution: z.literal(true),
});
/** Immutable output contract with an explicit no-authority boundary. */
export const genericOutputSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  evaluationId: Id,
  evaluatedAt: Timestamp,
  diagnostics: z.array(GenericDiagnostic).max(500),
  recordDigests: z.array(z.strictObject({
    category: Category,
    recordId: Id,
    version: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })).max(400),
  unavailableData: z.array(
    z.strictObject({ category: Category, reason: Text }),
  ),
  truncated: z.boolean(),
  verdict: z.enum(["clean", "blocked"]),
  authority: z.strictObject({
    disposition: z.literal("recommendation_only"),
    humanResolutionRequired: z.literal(true),
    mayResolveConflicts: z.literal(false),
    mayExecute: z.literal(false),
    sideEffects: z.literal("persistence_only"),
    providerCalls: z.literal(false),
    networkCalls: z.literal(false),
  }),
});

// The legacy contract remains explicit rather than accepting aliases field by
// field. This makes mixed-vocabulary payloads invalid instead of guessing what
// the caller intended.
const LegacyRecord = z.strictObject({
  artifactId: Id,
  version: z.number().int().positive().max(1_000_000),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  authority: Record.shape.authority,
  provenance: Record.shape.provenance,
  freshness: Record.shape.freshness,
  reviewAt: Timestamp,
  claims: z.array(z.strictObject({ conflictKey: Id, value: Text })).max(50),
});
const LegacyRule = z.strictObject({
  ruleId: Id,
  conflictKey: Id,
  appliesTo: z.array(LegacyKind).min(2).max(4),
  contradictoryValuePairs: z.array(z.tuple([Text, Text])).min(1).max(50),
  severity: z.enum(["warning", "escalation"]),
  recommendation: Text,
});
/** Exact pre-extraction input contract; no generic aliases are accepted. */
export const legacyInputSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  evaluationId: Id,
  evaluatedAt: Timestamp,
  context: z.array(LegacyRecord).max(100),
  decisions: z.array(LegacyRecord).max(100),
  work: z.array(LegacyRecord).max(100),
  recommendations: z.array(LegacyRecord).max(100),
  availability: z.array(z.strictObject({
    kind: LegacyKind,
    status: z.enum(["available", "unavailable"]),
    reason: Text.nullable(),
  })).length(4),
  conflictRules: z.array(LegacyRule).min(1).max(100),
  stalePolicy: z.strictObject({
    reviewDue: z.enum(["escalate", "report", "ignore"]),
    freshnessExpired: z.enum(["escalate", "report", "ignore"]),
    futureAsOf: z.enum(["escalate", "report"]),
  }),
  ordering: z.literal(
    "severity_desc_code_asc_conflict_key_asc_artifact_ids_asc",
  ),
}).superRefine((x, ctx) => {
  const fail = (path: PropertyKey[], message: string): void =>
    ctx.addIssue({ code: "custom", path, message });
  const unique = (
    values: string[],
    path: PropertyKey[],
    message: string,
  ): void => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) fail([...path, index], message);
      seen.add(value);
    });
  };
  for (const kind of LegacyKind.options) {
    if (x.availability.filter((item) => item.kind === kind).length !== 1) {
      fail(
        ["availability"],
        `exactly one ${kind} availability entry is required`,
      );
    }
  }
  x.availability.forEach((item, index) => {
    if ((item.status === "unavailable") !== (item.reason !== null)) {
      fail(
        ["availability", index, "reason"],
        "reason is required only for unavailable data",
      );
    }
  });
  unique(
    x.conflictRules.map((rule) => rule.ruleId),
    ["conflictRules"],
    "duplicate ruleId",
  );
  x.conflictRules.forEach((rule, index) => {
    unique(
      rule.appliesTo,
      ["conflictRules", index, "appliesTo"],
      "duplicate kind",
    );
    rule.contradictoryValuePairs.forEach(([left, right], pairIndex) => {
      if (left === right) {
        fail(
          ["conflictRules", index, "contradictoryValuePairs", pairIndex],
          "contradictory values must differ",
        );
      }
    });
  });
  const groups = {
    context: x.context,
    decision: x.decisions,
    work: x.work,
    recommendation: x.recommendations,
  };
  const artifactVersions = new Map<
    string,
    { kind: string; index: number }
  >();
  for (const [kind, artifacts] of Object.entries(groups)) {
    const available = x.availability.find((item) =>
      item.kind === kind
    )?.status === "available";
    if (!available && artifacts.length) {
      fail(
        [kind === "decision" ? "decisions" : kind],
        "unavailable data must not include artifacts",
      );
    }
    artifacts.forEach((artifact, index) => {
      const identity = `${artifact.artifactId}@${artifact.version}`;
      const previous = artifactVersions.get(identity);
      if (previous) {
        fail(
          [kind, index],
          `${identity} duplicates ${previous.kind}[${previous.index}]`,
        );
      } else {
        artifactVersions.set(identity, { kind, index });
      }
      if (
        (kind === "context" || kind === "decision") &&
        !artifact.authority.humanAuthority
      ) {
        fail(
          [kind, index, "authority", "humanAuthority"],
          `${kind} artifacts must carry explicit human authority`,
        );
      }
      unique(
        artifact.claims.map((claim) => claim.conflictKey),
        [kind, index, "claims"],
        "duplicate conflictKey",
      );
      if (
        Date.parse(artifact.provenance.collectedAt) > Date.parse(x.evaluatedAt)
      ) {
        fail(
          [kind, index, "provenance", "collectedAt"],
          "artifact cannot be collected after evaluatedAt",
        );
      }
      if (
        Date.parse(artifact.freshness.asOf) >
          Date.parse(artifact.freshness.expiresAt)
      ) {
        fail(
          [kind, index, "freshness"],
          "asOf must not follow expiresAt",
        );
      }
      if (
        Date.parse(artifact.provenance.collectedAt) >
          Date.parse(artifact.freshness.asOf)
      ) {
        fail(
          [kind, index, "freshness", "asOf"],
          "freshness cannot predate provenance collection",
        );
      }
    });
  }
});
const LegacyDiagnostic = z.strictObject({
  severity: z.enum(["escalation", "warning", "information"]),
  code: z.enum([
    "contradictory_decision",
    "conflict",
    "stale_goal",
    "expired_freshness",
    "future_as_of",
    "unavailable_data",
  ]),
  conflictKey: Id.nullable(),
  artifactIds: z.array(Id).max(8),
  ruleId: Id.nullable(),
  message: Text,
  recommendation: Text,
  requiresHumanResolution: z.literal(true),
});
/** Exact output contract consumed by the pre-extraction context compiler. */
export const legacyOutputSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  evaluationId: Id,
  evaluatedAt: Timestamp,
  diagnostics: z.array(LegacyDiagnostic).max(500),
  unavailableData: z.array(z.strictObject({ kind: LegacyKind, reason: Text }))
    .max(4),
  truncated: z.boolean(),
  verdict: z.enum(["clean", "blocked"]),
  authority: genericOutputSchema.shape.authority,
});
/** Closed union of complete generic and legacy input contracts. */
export const inputSchema = z.union([genericInputSchema, legacyInputSchema]);
/** Resource union retaining both generic and legacy evaluation records. */
export const outputSchema = z.union([genericOutputSchema, legacyOutputSchema]);

/** Deterministically reports declared conflicts and freshness conditions without resolving them. */
function detectGenericConflicts(
  raw: unknown,
): z.infer<typeof genericOutputSchema> {
  const x = genericInputSchema.parse(raw);
  const items = [
    ...x.references.map((record) => ({ category: "reference", record })),
    ...x.decisions.map((record) => ({ category: "decision", record })),
    ...x.plans.map((record) => ({ category: "plan", record })),
    ...x.proposals.map((record) => ({ category: "proposal", record })),
  ] as { category: z.infer<typeof Category>; record: z.infer<typeof Record> }[];
  const diagnostics: z.infer<typeof GenericDiagnostic>[] = [];
  for (const item of items) {
    const add = (
      code: "review_due" | "expired_freshness" | "future_as_of",
      policy: "escalate" | "report",
    ): void => {
      diagnostics.push({
        severity: policy === "escalate" ? "escalation" : "warning",
        code,
        conflictKey: null,
        recordIds: [item.record.recordId],
        ruleId: null,
        message:
          `${item.category} ${item.record.recordId}@${item.record.version} requires review`,
        recommendation:
          "Escalate to the named human authority; do not update or supersede the record automatically.",
        requiresHumanResolution: true,
      });
    };
    if (
      Date.parse(item.record.reviewAt) <= Date.parse(x.evaluatedAt) &&
      x.stalePolicy.reviewDue !== "ignore"
    ) add("review_due", x.stalePolicy.reviewDue);
    if (
      Date.parse(item.record.freshness.expiresAt) <=
        Date.parse(x.evaluatedAt) &&
      x.stalePolicy.freshnessExpired !== "ignore"
    ) add("expired_freshness", x.stalePolicy.freshnessExpired);
    if (Date.parse(item.record.freshness.asOf) > Date.parse(x.evaluatedAt)) {
      add("future_as_of", x.stalePolicy.futureAsOf);
    }
  }
  for (const rule of x.conflictRules) {
    const candidates = items.filter((item) =>
      rule.appliesTo.includes(item.category)
    ).flatMap((item) =>
      item.record.claims.filter((claim) =>
        claim.conflictKey === rule.conflictKey
      ).map((claim) => ({ ...item, claim }))
    );
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i], b = candidates[j];
        if (
          rule.contradictoryValuePairs.some(([left, right]) =>
            (a.claim.value === left && b.claim.value === right) ||
            (a.claim.value === right && b.claim.value === left)
          )
        ) {
          diagnostics.push({
            severity: rule.severity,
            code: a.category === "decision" && b.category === "decision"
              ? "contradictory_decision"
              : "conflict",
            conflictKey: rule.conflictKey,
            recordIds: [a.record.recordId, b.record.recordId].sort(),
            ruleId: rule.ruleId,
            message:
              `Conflicting caller-declared values for ${rule.conflictKey}`,
            recommendation: rule.recommendation,
            requiresHumanResolution: true,
          });
        }
      }
    }
  }
  x.availability.filter((item) => item.status === "unavailable").forEach((
    item,
  ) =>
    diagnostics.push({
      severity: "information",
      code: "unavailable_data",
      conflictKey: null,
      recordIds: [],
      ruleId: null,
      message: `${item.category} data unavailable: ${item.reason}`,
      recommendation:
        "Supply the unavailable data before treating this evaluation as complete.",
      requiresHumanResolution: true,
    })
  );
  const rank = { escalation: 0, warning: 1, information: 2 };
  diagnostics.sort((a, b) =>
    rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code) ||
    (a.conflictKey ?? "").localeCompare(b.conflictKey ?? "") ||
    a.recordIds.join("\0").localeCompare(b.recordIds.join("\0")) ||
    (a.ruleId ?? "").localeCompare(b.ruleId ?? "") ||
    a.message.localeCompare(b.message) ||
    a.recommendation.localeCompare(b.recommendation)
  );
  const blocked = diagnostics.some((d) =>
    d.severity === "escalation" || d.code === "conflict" ||
    d.code === "contradictory_decision"
  );
  const truncated = diagnostics.length > 500;
  const returnedDiagnostics = diagnostics.slice(0, 500);
  return genericOutputSchema.parse({
    schemaVersion: x.schemaVersion,
    evaluationId: x.evaluationId,
    evaluatedAt: x.evaluatedAt,
    diagnostics: returnedDiagnostics,
    recordDigests: items.map(({ category, record }) => ({
      category,
      recordId: record.recordId,
      version: record.version,
      sha256: record.sha256,
    })).sort((a, b) =>
      a.category.localeCompare(b.category) ||
      a.recordId.localeCompare(b.recordId) || a.version - b.version
    ),
    unavailableData: x.availability.filter((item) =>
      item.status === "unavailable"
    ).map((item) => ({ category: item.category, reason: item.reason! })).sort((
      a,
      b,
    ) => a.category.localeCompare(b.category)),
    truncated,
    verdict: blocked ? "blocked" : "clean",
    authority: {
      disposition: "recommendation_only",
      humanResolutionRequired: true,
      mayResolveConflicts: false,
      mayExecute: false,
      sideEffects: "persistence_only",
      providerCalls: false,
      networkCalls: false,
    },
  });
}

/** Preserves the pre-extraction detector's output and expiry-boundary behavior. */
function detectLegacyConflicts(
  raw: unknown,
): z.infer<typeof legacyOutputSchema> {
  const x = legacyInputSchema.parse(raw);
  const items = [
    ...x.context.map((artifact) => ({ kind: "context", artifact })),
    ...x.decisions.map((artifact) => ({ kind: "decision", artifact })),
    ...x.work.map((artifact) => ({ kind: "work", artifact })),
    ...x.recommendations.map((artifact) => ({
      kind: "recommendation",
      artifact,
    })),
  ] as {
    kind: z.infer<typeof LegacyKind>;
    artifact: z.infer<typeof LegacyRecord>;
  }[];
  const diagnostics: z.infer<typeof LegacyDiagnostic>[] = [];
  const addStale = (
    item: (typeof items)[number],
    code: "stale_goal" | "expired_freshness" | "future_as_of",
    policy: "escalate" | "report",
  ): void => {
    diagnostics.push({
      severity: policy === "escalate" ? "escalation" : "warning",
      code,
      conflictKey: null,
      artifactIds: [item.artifact.artifactId],
      ruleId: null,
      message:
        `${item.kind} ${item.artifact.artifactId}@${item.artifact.version} requires review`,
      recommendation:
        "Escalate to the named human authority; do not update or supersede the artifact automatically.",
      requiresHumanResolution: true,
    });
  };
  for (const item of items) {
    if (
      Date.parse(item.artifact.reviewAt) <= Date.parse(x.evaluatedAt) &&
      x.stalePolicy.reviewDue !== "ignore"
    ) addStale(item, "stale_goal", x.stalePolicy.reviewDue);
    // Legacy freshness is strict-before; generic freshness is inclusive.
    if (
      Date.parse(item.artifact.freshness.expiresAt) <
        Date.parse(x.evaluatedAt) &&
      x.stalePolicy.freshnessExpired !== "ignore"
    ) addStale(item, "expired_freshness", x.stalePolicy.freshnessExpired);
    if (Date.parse(item.artifact.freshness.asOf) > Date.parse(x.evaluatedAt)) {
      addStale(item, "future_as_of", x.stalePolicy.futureAsOf);
    }
  }
  for (const rule of x.conflictRules) {
    const candidates = items.filter((item) =>
      rule.appliesTo.includes(item.kind)
    )
      .flatMap((item) =>
        item.artifact.claims.filter((claim) =>
          claim.conflictKey === rule.conflictKey
        ).map((claim) => ({ ...item, claim }))
      );
    for (let left = 0; left < candidates.length; left++) {
      for (let right = left + 1; right < candidates.length; right++) {
        const a = candidates[left], b = candidates[right];
        if (
          rule.contradictoryValuePairs.some(([first, second]) =>
            (a.claim.value === first && b.claim.value === second) ||
            (a.claim.value === second && b.claim.value === first)
          )
        ) {
          diagnostics.push({
            severity: rule.severity,
            code: a.kind === "decision" && b.kind === "decision"
              ? "contradictory_decision"
              : "conflict",
            conflictKey: rule.conflictKey,
            artifactIds: [a.artifact.artifactId, b.artifact.artifactId].sort(),
            ruleId: rule.ruleId,
            message:
              `Conflicting caller-declared values for ${rule.conflictKey}`,
            recommendation: rule.recommendation,
            requiresHumanResolution: true,
          });
        }
      }
    }
  }
  x.availability.filter((item) => item.status === "unavailable").forEach((
    item,
  ) =>
    diagnostics.push({
      severity: "information",
      code: "unavailable_data",
      conflictKey: null,
      artifactIds: [],
      ruleId: null,
      message: `${item.kind} data unavailable: ${item.reason}`,
      recommendation:
        "Supply the unavailable data before treating this evaluation as complete.",
      requiresHumanResolution: true,
    })
  );
  const rank = { escalation: 0, warning: 1, information: 2 };
  diagnostics.sort((a, b) =>
    rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code) ||
    (a.conflictKey ?? "").localeCompare(b.conflictKey ?? "") ||
    a.artifactIds.join("\0").localeCompare(b.artifactIds.join("\0")) ||
    (a.ruleId ?? "").localeCompare(b.ruleId ?? "")
  );
  const truncated = diagnostics.length > 500;
  const blocked = diagnostics.some((diagnostic) =>
    diagnostic.severity === "escalation" || diagnostic.code === "conflict" ||
    diagnostic.code === "contradictory_decision"
  );
  return legacyOutputSchema.parse({
    schemaVersion: x.schemaVersion,
    evaluationId: x.evaluationId,
    evaluatedAt: x.evaluatedAt,
    diagnostics: diagnostics.slice(0, 500),
    unavailableData: x.availability.filter((item) =>
      item.status === "unavailable"
    ).map((item) => ({ kind: item.kind, reason: item.reason! })).sort((a, b) =>
      a.kind.localeCompare(b.kind)
    ),
    truncated,
    verdict: blocked ? "blocked" : "clean",
    authority: {
      disposition: "recommendation_only",
      humanResolutionRequired: true,
      mayResolveConflicts: false,
      mayExecute: false,
      sideEffects: "persistence_only",
      providerCalls: false,
      networkCalls: false,
    },
  });
}

/** Selects one complete contract without merging their behavior. */
export function detectConflicts(raw: unknown): z.infer<typeof outputSchema> {
  const generic = genericInputSchema.safeParse(raw);
  if (generic.success) return detectGenericConflicts(generic.data);
  return detectLegacyConflicts(raw);
}
const argumentsSchema = z.strictObject({
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
  input: z.unknown(),
});
/** Swamp model that persists exactly one evaluation and has no side effects beyond persistence. */
export const model = {
  type: "@mgreten/context-conflict-detector",
  version: "2026.08.23.1",
  upgrades: [{
    toVersion: "2026.08.23.1",
    description:
      "Retain strict legacy evaluation resources alongside generic evaluations without rewriting their vocabulary.",
    upgradeAttributes: (attributes: Record<string, unknown>) =>
      outputSchema.parse(attributes),
  }],
  globalArguments: z.strictObject({}),
  resources: {
    evaluation: {
      description: "Immutable recommendation-only registry conflict evaluation",
      schema: outputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    evaluate: {
      description:
        "Evaluate records and persist diagnostics only; no resolution, execution, providers, or network.",
      arguments: argumentsSchema,
      execute: async (
        args: z.infer<typeof argumentsSchema>,
        context: {
          writeResource(
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ): Promise<unknown>;
          logger: {
            info(message: string, properties: Record<string, unknown>): void;
          };
        },
      ): Promise<{ dataHandles: unknown[] }> => {
        context.logger.info("Evaluating registry conflicts for {requestId}", {
          requestId: args.requestId,
        });
        const evaluation = detectConflicts(args.input);
        const handle = await context.writeResource(
          "evaluation",
          `context-conflict-${args.requestId}`,
          evaluation,
        );
        context.logger.info(
          "Persisted registry conflict evaluation {requestId}",
          {
            requestId: args.requestId,
            verdict: evaluation.verdict,
            diagnosticCount: evaluation.diagnostics.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
