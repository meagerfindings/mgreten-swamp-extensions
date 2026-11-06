import { z } from "npm:zod@4";

export const CONTEXT_CONFLICT_DETECTOR_SCHEMA_VERSION = "1.0" as const;
export const CONTEXT_CONFLICT_LIMITS = {
  artifactsPerKind: 100,
  rules: 100,
  claimsPerArtifact: 50,
  diagnostics: 500,
} as const;

const Id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
const Text = z.string().trim().min(1).max(2_000);
const Timestamp = z.iso.datetime({ offset: true });
const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Kind = z.enum(["context", "decision", "work", "recommendation"]);
const Claim = z.strictObject({ conflictKey: Id, value: Text });
const Authority = z.strictObject({
  authorityId: Id,
  actorId: Id,
  role: Text,
  humanAuthority: z.boolean(),
  source: Text,
});
const Provenance = z.strictObject({
  sourceId: Id,
  collector: Id,
  collectorVersion: Text,
  method: Text,
  collectedAt: Timestamp,
});
const Freshness = z.strictObject({ asOf: Timestamp, expiresAt: Timestamp });
const Artifact = z.strictObject({
  artifactId: Id,
  version: z.number().int().positive().max(1_000_000),
  sha256: Hash,
  authority: Authority,
  provenance: Provenance,
  freshness: Freshness,
  reviewAt: Timestamp,
  claims: z.array(Claim).max(CONTEXT_CONFLICT_LIMITS.claimsPerArtifact),
});
const Availability = z.strictObject({
  kind: Kind,
  status: z.enum(["available", "unavailable"]),
  reason: Text.nullable(),
});
const Rule = z.strictObject({
  ruleId: Id,
  conflictKey: Id,
  appliesTo: z.array(Kind).min(2).max(4),
  contradictoryValuePairs: z.array(z.tuple([Text, Text])).min(1).max(50),
  severity: z.enum(["warning", "escalation"]),
  recommendation: Text,
});

export const contextConflictDetectorInputSchema = z.strictObject({
  schemaVersion: z.literal(CONTEXT_CONFLICT_DETECTOR_SCHEMA_VERSION),
  evaluationId: Id,
  evaluatedAt: Timestamp,
  context: z.array(Artifact).max(CONTEXT_CONFLICT_LIMITS.artifactsPerKind),
  decisions: z.array(Artifact).max(CONTEXT_CONFLICT_LIMITS.artifactsPerKind),
  work: z.array(Artifact).max(CONTEXT_CONFLICT_LIMITS.artifactsPerKind),
  recommendations: z.array(Artifact).max(
    CONTEXT_CONFLICT_LIMITS.artifactsPerKind,
  ),
  availability: z.array(Availability).length(4),
  conflictRules: z.array(Rule).min(1).max(CONTEXT_CONFLICT_LIMITS.rules),
  stalePolicy: z.strictObject({
    reviewDue: z.enum(["escalate", "report", "ignore"]),
    freshnessExpired: z.enum(["escalate", "report", "ignore"]),
    futureAsOf: z.enum(["escalate", "report"]),
  }),
  ordering: z.literal(
    "severity_desc_code_asc_conflict_key_asc_artifact_ids_asc",
  ),
}).superRefine((input, context) => {
  const issue = (path: PropertyKey[], message: string) =>
    context.addIssue({ code: "custom", path, message });
  const unique = (values: string[], path: PropertyKey[], message: string) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) issue([...path, index], message);
      seen.add(value);
    });
  };
  for (const kind of Kind.options) {
    if (input.availability.filter((x) => x.kind === kind).length !== 1) {
      issue(
        ["availability"],
        `exactly one ${kind} availability entry is required`,
      );
    }
  }
  input.availability.forEach((entry, index) => {
    if ((entry.status === "unavailable") !== (entry.reason !== null)) {
      issue(
        ["availability", index, "reason"],
        "reason is required only for unavailable data",
      );
    }
  });
  unique(
    input.conflictRules.map((x) => x.ruleId),
    ["conflictRules"],
    "duplicate ruleId",
  );
  input.conflictRules.forEach((rule, index) => {
    unique(
      rule.appliesTo,
      ["conflictRules", index, "appliesTo"],
      "duplicate kind",
    );
    rule.contradictoryValuePairs.forEach(([left, right], pairIndex) => {
      if (left === right) {
        issue(
          ["conflictRules", index, "contradictoryValuePairs", pairIndex],
          "contradictory values must differ",
        );
      }
    });
  });
  const groups = {
    context: input.context,
    decision: input.decisions,
    work: input.work,
    recommendation: input.recommendations,
  };
  for (const [kind, artifacts] of Object.entries(groups)) {
    const available = input.availability.find((x) =>
      x.kind === kind
    )?.status === "available";
    if (!available && artifacts.length) {
      issue(
        [kind === "decision" ? "decisions" : kind],
        "unavailable data must not include artifacts",
      );
    }
    unique(
      artifacts.map((x) => `${x.artifactId}@${x.version}`),
      [kind],
      "duplicate artifact identity and version",
    );
    artifacts.forEach((artifact, index) => {
      if (
        (kind === "context" || kind === "decision") &&
        !artifact.authority.humanAuthority
      ) {
        issue(
          [kind, index, "authority", "humanAuthority"],
          `${kind} artifacts must carry explicit human authority`,
        );
      }
      unique(
        artifact.claims.map((x) => x.conflictKey),
        [kind, index, "claims"],
        "duplicate conflictKey",
      );
      if (
        Date.parse(artifact.provenance.collectedAt) >
          Date.parse(input.evaluatedAt)
      ) {
        issue(
          [kind, index, "provenance", "collectedAt"],
          "artifact cannot be collected after evaluatedAt",
        );
      }
      if (
        Date.parse(artifact.freshness.asOf) >
          Date.parse(artifact.freshness.expiresAt)
      ) issue([kind, index, "freshness"], "asOf must not follow expiresAt");
      if (
        Date.parse(artifact.provenance.collectedAt) >
          Date.parse(artifact.freshness.asOf)
      ) {
        issue(
          [kind, index, "freshness", "asOf"],
          "freshness cannot predate provenance collection",
        );
      }
    });
  }
});

const Diagnostic = z.strictObject({
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
export const contextConflictDetectorOutputSchema = z.strictObject({
  schemaVersion: z.literal(CONTEXT_CONFLICT_DETECTOR_SCHEMA_VERSION),
  evaluationId: Id,
  evaluatedAt: Timestamp,
  diagnostics: z.array(Diagnostic).max(CONTEXT_CONFLICT_LIMITS.diagnostics),
  unavailableData: z.array(z.strictObject({ kind: Kind, reason: Text })).max(4),
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
export type ContextConflictDetectorOutput = z.infer<
  typeof contextConflictDetectorOutputSchema
>;

export function detectContextConflicts(
  raw: unknown,
): ContextConflictDetectorOutput {
  const input = contextConflictDetectorInputSchema.parse(raw);
  type Item = {
    kind: z.infer<typeof Kind>;
    artifact: z.infer<typeof Artifact>;
  };
  const items: Item[] = [
    ...input.context.map((artifact) => ({
      kind: "context" as const,
      artifact,
    })),
    ...input.decisions.map((artifact) => ({
      kind: "decision" as const,
      artifact,
    })),
    ...input.work.map((artifact) => ({ kind: "work" as const, artifact })),
    ...input.recommendations.map((artifact) => ({
      kind: "recommendation" as const,
      artifact,
    })),
  ];
  const diagnostics: z.infer<typeof Diagnostic>[] = [];
  const addStale = (
    item: Item,
    code: "stale_goal" | "expired_freshness" | "future_as_of",
    policy: "escalate" | "report",
  ) =>
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
  for (const item of items) {
    if (
      Date.parse(item.artifact.reviewAt) <= Date.parse(input.evaluatedAt) &&
      input.stalePolicy.reviewDue !== "ignore"
    ) addStale(item, "stale_goal", input.stalePolicy.reviewDue);
    if (
      Date.parse(item.artifact.freshness.expiresAt) <
        Date.parse(input.evaluatedAt) &&
      input.stalePolicy.freshnessExpired !== "ignore"
    ) addStale(item, "expired_freshness", input.stalePolicy.freshnessExpired);
    if (
      Date.parse(item.artifact.freshness.asOf) > Date.parse(input.evaluatedAt)
    ) addStale(item, "future_as_of", input.stalePolicy.futureAsOf);
  }
  for (const rule of input.conflictRules) {
    const candidates = items.filter((x) => rule.appliesTo.includes(x.kind))
      .flatMap((x) =>
        x.artifact.claims.filter((claim) =>
          claim.conflictKey === rule.conflictKey
        ).map((claim) => ({ ...x, claim }))
      );
    for (let left = 0; left < candidates.length; left++) {
      for (let right = left + 1; right < candidates.length; right++) {
        const a = candidates[left], b = candidates[right];
        const conflicts = rule.contradictoryValuePairs.some(([x, y]) =>
          (a.claim.value === x && b.claim.value === y) ||
          (a.claim.value === y && b.claim.value === x)
        );
        if (!conflicts) {
          continue;
        }
        diagnostics.push({
          severity: rule.severity,
          code: a.kind === "decision" && b.kind === "decision"
            ? "contradictory_decision"
            : "conflict",
          conflictKey: rule.conflictKey,
          artifactIds: [a.artifact.artifactId, b.artifact.artifactId].sort(),
          ruleId: rule.ruleId,
          message: `Conflicting caller-declared values for ${rule.conflictKey}`,
          recommendation: rule.recommendation,
          requiresHumanResolution: true,
        });
      }
    }
  }
  input.availability.filter((x) => x.status === "unavailable").forEach((x) =>
    diagnostics.push({
      severity: "information",
      code: "unavailable_data",
      conflictKey: null,
      artifactIds: [],
      ruleId: null,
      message: `${x.kind} data unavailable: ${x.reason}`,
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
  const truncated = diagnostics.length > CONTEXT_CONFLICT_LIMITS.diagnostics;
  const blocked = diagnostics.some((diagnostic) =>
    diagnostic.severity === "escalation" ||
    diagnostic.code === "conflict" ||
    diagnostic.code === "contradictory_decision"
  );
  return contextConflictDetectorOutputSchema.parse({
    schemaVersion: input.schemaVersion,
    evaluationId: input.evaluationId,
    evaluatedAt: input.evaluatedAt,
    diagnostics: diagnostics.slice(0, CONTEXT_CONFLICT_LIMITS.diagnostics),
    unavailableData: input.availability.filter((x) =>
      x.status === "unavailable"
    ).map((x) => ({ kind: x.kind, reason: x.reason! })).sort((a, b) =>
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
