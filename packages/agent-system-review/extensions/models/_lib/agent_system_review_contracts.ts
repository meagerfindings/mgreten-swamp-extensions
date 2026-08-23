import { z } from "npm:zod@4";
import { sourceReferenceSchema } from "./source_reference_contracts.ts";

export const AGENT_SYSTEM_REVIEW_SCHEMA_VERSION = "1.0" as const;
export const REVIEW_METRICS = [
  "context_failure_rate",
  "permission_denial_rate",
  "workflow_retry_rate",
  "median_completion_milliseconds",
] as const;
export const CHANGE_TARGETS = [
  "context",
  "permission",
  "workflow",
  "policy",
] as const;

const Id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
const Text = z.string().trim().min(1).max(2_000);
const Timestamp = z.iso.datetime({ offset: true });
const Hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const MetricName = z.enum(REVIEW_METRICS);
const TargetType = z.enum(CHANGE_TARGETS);
const Evidence = z.strictObject({
  evidenceId: Id,
  summary: Text,
  sourceReference: sourceReferenceSchema,
});
const Measurement = z.strictObject({
  metric: MetricName,
  status: z.enum(["available", "unavailable"]),
  value: z.number().finite().nonnegative().nullable(),
  sampleSize: z.number().int().nonnegative().nullable(),
  unavailableReason: Text.nullable(),
  evidenceIds: z.array(Id).min(1).max(20),
});
const Threshold = z.strictObject({
  metric: MetricName,
  maximum: z.number().finite().nonnegative(),
  minimumSampleSize: z.number().int().positive().max(1_000_000),
  weight: z.number().int().positive().max(100),
  target: z.strictObject({
    type: TargetType,
    id: Id,
    currentVersion: Id,
    currentHash: Hash,
  }),
  proposedChange: Text,
  expectedBenefit: Text,
  expectedRisk: Text,
});

export const agentSystemReviewInputSchema = z.strictObject({
  schemaVersion: z.literal(AGENT_SYSTEM_REVIEW_SCHEMA_VERSION),
  reviewId: Id,
  evaluatedAt: Timestamp,
  policy: z.strictObject({
    policyId: Id,
    policyVersion: Id,
    policyHash: Hash,
    thresholds: z.array(Threshold).length(REVIEW_METRICS.length),
    maximumProposals: z.number().int().positive().max(REVIEW_METRICS.length),
    scoring: z.literal("excess_basis_points_times_weight"),
    tieBreak: z.literal("score_desc_metric_asc_target_type_asc_target_id_asc"),
  }),
  evidence: z.array(Evidence).min(1).max(200),
  measurements: z.array(Measurement).length(REVIEW_METRICS.length),
}).superRefine((input, context) => {
  const issue = (path: PropertyKey[], message: string) =>
    context.addIssue({ code: "custom", path, message });
  for (const metric of REVIEW_METRICS) {
    if (
      input.policy.thresholds.filter((x) => x.metric === metric).length !== 1
    ) {
      issue(
        ["policy", "thresholds"],
        `exactly one ${metric} threshold is required`,
      );
    }
    if (input.measurements.filter((x) => x.metric === metric).length !== 1) {
      issue(["measurements"], `exactly one ${metric} measurement is required`);
    }
  }
  const evidenceIds = new Set<string>();
  const sourceIds = new Set<string>();
  input.evidence.forEach((evidence, index) => {
    if (evidenceIds.has(evidence.evidenceId)) {
      issue(["evidence", index, "evidenceId"], "duplicate evidenceId");
    }
    evidenceIds.add(evidence.evidenceId);
    if (sourceIds.has(evidence.sourceReference.sourceId)) {
      issue(
        ["evidence", index, "sourceReference", "sourceId"],
        "duplicate sourceId",
      );
    }
    sourceIds.add(evidence.sourceReference.sourceId);
    const freshness = evidence.sourceReference.freshness;
    if (Date.parse(freshness.asOf) > Date.parse(input.evaluatedAt)) {
      issue(["evidence", index], "evidence is not yet available");
    }
    if (Date.parse(freshness.expiresAt) < Date.parse(input.evaluatedAt)) {
      issue(["evidence", index], "evidence is stale");
    }
  });
  input.measurements.forEach((measurement, index) => {
    const available = measurement.status === "available";
    if (
      available &&
      (measurement.value === null || measurement.sampleSize === null ||
        measurement.unavailableReason !== null)
    ) {
      issue(
        ["measurements", index],
        "available metric requires value and sampleSize and no unavailableReason",
      );
    }
    if (
      !available &&
      (measurement.value !== null || measurement.sampleSize !== null ||
        measurement.unavailableReason === null)
    ) {
      issue(
        ["measurements", index],
        "unavailable metric requires only unavailableReason",
      );
    }
    const seen = new Set<string>();
    measurement.evidenceIds.forEach((id, evidenceIndex) => {
      if (seen.has(id)) {
        issue(
          ["measurements", index, "evidenceIds", evidenceIndex],
          "duplicate evidence reference",
        );
      }
      seen.add(id);
      if (!evidenceIds.has(id)) {
        issue(
          ["measurements", index, "evidenceIds", evidenceIndex],
          "unknown evidenceId",
        );
      }
    });
  });
});

const Proposal = z.strictObject({
  proposalId: Id,
  metric: MetricName,
  score: z.number().int().nonnegative(),
  measuredValue: z.number().nonnegative(),
  thresholdMaximum: z.number().nonnegative(),
  sampleSize: z.number().int().nonnegative(),
  target: Threshold.shape.target,
  proposedChange: Text,
  evidenceIds: z.array(Id),
  expectedBenefit: Text,
  expectedRisk: Text,
  approval: z.strictObject({
    requirement: z.literal("separate_human_approval_for_this_change"),
    approvalId: Id,
    status: z.literal("required"),
    approved: z.literal(false),
  }),
});

export const agentSystemReviewOutputSchema = z.strictObject({
  schemaVersion: z.literal(AGENT_SYSTEM_REVIEW_SCHEMA_VERSION),
  reviewId: Id,
  evaluatedAt: Timestamp,
  policy: agentSystemReviewInputSchema.shape.policy,
  evidence: agentSystemReviewInputSchema.shape.evidence,
  measurements: agentSystemReviewInputSchema.shape.measurements,
  proposals: z.array(Proposal).max(REVIEW_METRICS.length),
  truncated: z.boolean(),
  unavailableMetrics: z.array(z.strictObject({
    metric: MetricName,
    reason: Text,
    evidenceIds: z.array(Id),
  })),
  authority: z.strictObject({
    disposition: z.literal("proposal_only"),
    selfModification: z.literal(false),
    sideEffects: z.literal("persistence_only"),
    providerCalls: z.literal(false),
    networkCalls: z.literal(false),
    factoryCalls: z.literal(false),
    todoistCalls: z.literal(false),
    productionChanges: z.literal(false),
  }),
});
export type AgentSystemReviewOutput = z.infer<
  typeof agentSystemReviewOutputSchema
>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function reviewAgentSystem(raw: unknown): AgentSystemReviewOutput {
  const input = agentSystemReviewInputSchema.parse(raw);
  const candidates = input.measurements.flatMap((measurement) => {
    if (measurement.status !== "available") return [];
    const threshold = input.policy.thresholds.find((x) =>
      x.metric === measurement.metric
    )!;
    if (
      measurement.sampleSize! < threshold.minimumSampleSize ||
      measurement.value! <= threshold.maximum
    ) return [];
    const excessBasisPoints = threshold.maximum === 0 ? 1_000_000 : Math.round(
      ((measurement.value! - threshold.maximum) / threshold.maximum) * 10_000,
    );
    return [{
      proposalId: `${input.reviewId}:${measurement.metric}`,
      metric: measurement.metric,
      score: Math.min(100_000_000, excessBasisPoints * threshold.weight),
      measuredValue: measurement.value!,
      thresholdMaximum: threshold.maximum,
      sampleSize: measurement.sampleSize!,
      target: threshold.target,
      proposedChange: threshold.proposedChange,
      evidenceIds: [...measurement.evidenceIds].sort(),
      expectedBenefit: threshold.expectedBenefit,
      expectedRisk: threshold.expectedRisk,
      approval: {
        requirement: "separate_human_approval_for_this_change" as const,
        approvalId: `${input.reviewId}:${measurement.metric}:approval`,
        status: "required" as const,
        approved: false as const,
      },
    }];
  }).sort((a, b) =>
    b.score - a.score || compareText(a.metric, b.metric) ||
    compareText(a.target.type, b.target.type) ||
    compareText(a.target.id, b.target.id)
  );
  const proposals = candidates.slice(0, input.policy.maximumProposals);
  return agentSystemReviewOutputSchema.parse({
    ...input,
    proposals,
    truncated: candidates.length > proposals.length,
    unavailableMetrics: input.measurements.filter((x) =>
      x.status === "unavailable"
    ).map((x) => ({
      metric: x.metric,
      reason: x.unavailableReason!,
      evidenceIds: [...x.evidenceIds].sort(),
    })).sort((a, b) => compareText(a.metric, b.metric)),
    authority: {
      disposition: "proposal_only",
      selfModification: false,
      sideEffects: "persistence_only",
      providerCalls: false,
      networkCalls: false,
      factoryCalls: false,
      todoistCalls: false,
      productionChanges: false,
    },
  });
}
