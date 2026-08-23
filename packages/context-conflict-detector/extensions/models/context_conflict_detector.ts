/** A generic, deterministic, persistence-only registry conflict detector. @module */
import { z } from "npm:zod@4";

/** Contract version for registry snapshots and evaluations. */
export const SCHEMA_VERSION = "1.0" as const;
const Id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
const Text = z.string().trim().min(1).max(2_000);
const Timestamp = z.iso.datetime({ offset: true });
const Category = z.enum(["reference", "decision", "plan", "proposal"]);
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
export const inputSchema = z.strictObject({
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
const Diagnostic = z.strictObject({
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
export const outputSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  evaluationId: Id,
  evaluatedAt: Timestamp,
  diagnostics: z.array(Diagnostic).max(500),
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
/** Deterministically reports declared conflicts and freshness conditions without resolving them. */
export function detectConflicts(raw: unknown): z.infer<typeof outputSchema> {
  const x = inputSchema.parse(raw);
  const items = [
    ...x.references.map((record) => ({ category: "reference", record })),
    ...x.decisions.map((record) => ({ category: "decision", record })),
    ...x.plans.map((record) => ({ category: "plan", record })),
    ...x.proposals.map((record) => ({ category: "proposal", record })),
  ] as { category: z.infer<typeof Category>; record: z.infer<typeof Record> }[];
  const diagnostics: z.infer<typeof Diagnostic>[] = [];
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
  return outputSchema.parse({
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
const argumentsSchema = z.strictObject({
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
  input: z.unknown(),
});
/** Swamp model that persists exactly one evaluation and has no side effects beyond persistence. */
export const model = {
  type: "@mgreten/context-conflict-detector",
  version: "2026.08.23.1",
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
