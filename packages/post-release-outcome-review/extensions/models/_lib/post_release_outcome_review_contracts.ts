import { z } from "npm:zod@4";
import { sourceReferenceSchema } from "./source_reference_contract.ts";

/** Version of the post-release outcome review resource schema. */
export const POST_RELEASE_OUTCOME_REVIEW_SCHEMA_VERSION = "2.0" as const;
/** Recommendations that a policy may assign to an aggregate outcome. */
export const RECOMMENDATIONS = [
  "keep",
  "iterate",
  "revert",
  "gather_evidence",
  "stop",
] as const;

const Id = z.string().trim().min(1).max(200);
const Text = z.string().trim().min(1).max(4000);
const Timestamp = z.iso.datetime({ offset: true });
const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const ExactReference = z.strictObject({
  id: Id,
  version: z.number().int().positive(),
  sha256: Hash,
});
const Comparator = z.enum(["gt", "gte", "lt", "lte", "eq"]);
const Recommendation = z.enum(RECOMMENDATIONS);
const Outcome = z.enum(["success", "failure", "ambiguity"]);

const MetricPolicy = z.strictObject({
  metricId: Id,
  unit: Id,
  denominatorUnit: Id,
  success: z.strictObject({ comparator: Comparator, threshold: z.number() }),
  failure: z.strictObject({ comparator: Comparator, threshold: z.number() }),
}).superRefine((policy, context) => {
  if (comparisonRangesOverlap(policy.success, policy.failure)) {
    issue(
      context,
      ["failure"],
      "success and failure thresholds must not overlap",
    );
  }
});

const ObservedMetric = z.strictObject({
  metricId: Id,
  value: z.number(),
  unit: Id,
  denominator: z.number().positive(),
  denominatorUnit: Id,
  measuredWindow: z.strictObject({ startsAt: Timestamp, endsAt: Timestamp }),
  evidence: sourceReferenceSchema,
});

const Comparison = z.strictObject({
  metricId: Id,
  value: z.number(),
  outcome: Outcome,
  appliedComparator: Comparator.nullable(),
  appliedThreshold: z.number().nullable(),
});

/** Strict deterministic contract for a recommendation-only outcome review. */
export const PostReleaseOutcomeReview = z.strictObject({
  schemaVersion: z.literal(POST_RELEASE_OUTCOME_REVIEW_SCHEMA_VERSION),
  reviewId: Id,
  reviewedAt: Timestamp,
  releasedArtifact: ExactReference,
  workOrder: ExactReference,
  measurementPlan: ExactReference,
  observationWindow: z.strictObject({ startsAt: Timestamp, endsAt: Timestamp }),
  policy: z.strictObject({
    policyId: Id,
    version: z.number().int().positive(),
    sha256: Hash,
    metrics: z.array(MetricPolicy).min(1).max(100),
    recommendationByOutcome: z.strictObject({
      success: Recommendation,
      failure: Recommendation,
      ambiguity: Recommendation,
    }),
  }),
  observedMetrics: z.array(ObservedMetric).min(1).max(100),
  comparisons: z.array(Comparison).min(1).max(100),
  aggregateOutcome: Outcome,
  recommendation: Recommendation,
  rationale: Text,
  evidence: z.array(Id).min(1).max(100),
  authority: z.strictObject({
    disposition: z.literal("recommendation-only"),
    humanDecisionRequired: z.literal(true),
    mayExecute: z.literal(false),
    productionEffects: z.literal("none"),
  }),
}).superRefine((review, context) => {
  const reviewedAt = Date.parse(review.reviewedAt);
  const startsAt = Date.parse(review.observationWindow.startsAt);
  const endsAt = Date.parse(review.observationWindow.endsAt);
  if (endsAt <= startsAt) {
    issue(
      context,
      ["observationWindow", "endsAt"],
      "endsAt must be after startsAt",
    );
  }
  if (reviewedAt < endsAt) {
    issue(
      context,
      ["reviewedAt"],
      "review is forbidden before the declared observation window ends",
    );
  }

  const policies = new Map(
    review.policy.metrics.map((metric) => [metric.metricId, metric]),
  );
  const observations = new Map(
    review.observedMetrics.map((metric) => [metric.metricId, metric]),
  );
  if (policies.size !== review.policy.metrics.length) {
    issue(context, ["policy", "metrics"], "metricId values must be unique");
  }
  if (observations.size !== review.observedMetrics.length) {
    issue(context, ["observedMetrics"], "metricId values must be unique");
  }
  if (
    policies.size !== observations.size ||
    [...policies.keys()].some((id) => !observations.has(id))
  ) {
    issue(
      context,
      ["observedMetrics"],
      "observations must exactly match policy metrics",
    );
  }

  review.observedMetrics.forEach((metric, index) => {
    const policy = policies.get(metric.metricId);
    if (
      policy &&
      (metric.unit !== policy.unit ||
        metric.denominatorUnit !== policy.denominatorUnit)
    ) {
      issue(
        context,
        ["observedMetrics", index],
        "units must exactly match the declared metric policy",
      );
    }
    if (
      metric.measuredWindow.startsAt !== review.observationWindow.startsAt ||
      metric.measuredWindow.endsAt !== review.observationWindow.endsAt
    ) {
      issue(
        context,
        ["observedMetrics", index, "measuredWindow"],
        "measured window must exactly bind the declared observation window",
      );
    }
    const evidence = metric.evidence;
    if (
      Date.parse(evidence.observedAt) < endsAt ||
      Date.parse(evidence.observedAt) > reviewedAt ||
      Date.parse(evidence.provenance.collectedAt) > reviewedAt ||
      Date.parse(evidence.freshness.asOf) < endsAt ||
      Date.parse(evidence.freshness.asOf) > reviewedAt ||
      Date.parse(evidence.freshness.expiresAt) < reviewedAt
    ) {
      issue(
        context,
        ["observedMetrics", index, "evidence"],
        "evidence must be post-window, available at review, and fresh through review",
      );
    }
  });

  const expected = derive(review.policy.metrics, observations);
  if (
    JSON.stringify(review.comparisons) !== JSON.stringify(expected.comparisons)
  ) {
    issue(
      context,
      ["comparisons"],
      "comparisons must equal deterministic policy evaluation in policy order",
    );
  }
  if (review.aggregateOutcome !== expected.aggregateOutcome) {
    issue(
      context,
      ["aggregateOutcome"],
      "aggregate outcome must equal deterministic policy evaluation",
    );
  }
  if (
    review.recommendation !==
      review.policy.recommendationByOutcome[expected.aggregateOutcome]
  ) {
    issue(
      context,
      ["recommendation"],
      "recommendation must use the explicit policy mapping",
    );
  }
  const evidenceIds = review.observedMetrics.map((metric) =>
    metric.evidence.sourceId
  );
  if (JSON.stringify(review.evidence) !== JSON.stringify(evidenceIds)) {
    issue(
      context,
      ["evidence"],
      "evidence must list every metric sourceId in observation order",
    );
  }
});

function issue(context: z.RefinementCtx, path: PropertyKey[], message: string) {
  context.addIssue({ code: "custom", path, message });
}

function comparisonRangesOverlap(
  first: z.infer<typeof MetricPolicy>["success"],
  second: z.infer<typeof MetricPolicy>["failure"],
) {
  const interval = (comparison: typeof first) => {
    const threshold = comparison.threshold;
    return comparison.comparator === "gt"
      ? {
        lower: threshold,
        lowerInclusive: false,
        upper: Infinity,
        upperInclusive: false,
      }
      : comparison.comparator === "gte"
      ? {
        lower: threshold,
        lowerInclusive: true,
        upper: Infinity,
        upperInclusive: false,
      }
      : comparison.comparator === "lt"
      ? {
        lower: -Infinity,
        lowerInclusive: false,
        upper: threshold,
        upperInclusive: false,
      }
      : comparison.comparator === "lte"
      ? {
        lower: -Infinity,
        lowerInclusive: false,
        upper: threshold,
        upperInclusive: true,
      }
      : {
        lower: threshold,
        lowerInclusive: true,
        upper: threshold,
        upperInclusive: true,
      };
  };
  const left = interval(first);
  const right = interval(second);
  const lower = Math.max(left.lower, right.lower);
  const upper = Math.min(left.upper, right.upper);
  if (lower < upper) return true;
  if (lower > upper) return false;
  const lowerIncluded = (left.lower !== lower || left.lowerInclusive) &&
    (right.lower !== lower || right.lowerInclusive);
  const upperIncluded = (left.upper !== upper || left.upperInclusive) &&
    (right.upper !== upper || right.upperInclusive);
  return lowerIncluded && upperIncluded;
}

function matches(
  value: number,
  comparator: z.infer<typeof Comparator>,
  threshold: number,
) {
  return comparator === "gt"
    ? value > threshold
    : comparator === "gte"
    ? value >= threshold
    : comparator === "lt"
    ? value < threshold
    : comparator === "lte"
    ? value <= threshold
    : value === threshold;
}

function derive(
  policies: z.infer<typeof MetricPolicy>[],
  observations: Map<string, z.infer<typeof ObservedMetric>>,
) {
  const comparisons = policies.map((policy) => {
    const value = observations.get(policy.metricId)?.value ?? Number.NaN;
    if (matches(value, policy.success.comparator, policy.success.threshold)) {
      return {
        metricId: policy.metricId,
        value,
        outcome: "success" as const,
        appliedComparator: policy.success.comparator,
        appliedThreshold: policy.success.threshold,
      };
    }
    if (matches(value, policy.failure.comparator, policy.failure.threshold)) {
      return {
        metricId: policy.metricId,
        value,
        outcome: "failure" as const,
        appliedComparator: policy.failure.comparator,
        appliedThreshold: policy.failure.threshold,
      };
    }
    return {
      metricId: policy.metricId,
      value,
      outcome: "ambiguity" as const,
      appliedComparator: null,
      appliedThreshold: null,
    };
  });
  const aggregateOutcome =
    comparisons.some((item) => item.outcome === "failure")
      ? "failure" as const
      : comparisons.every((item) => item.outcome === "success")
      ? "success" as const
      : "ambiguity" as const;
  return { comparisons, aggregateOutcome };
}

/** Inferred type for a validated post-release outcome review. */
export type PostReleaseOutcomeReview = z.infer<typeof PostReleaseOutcomeReview>;

/** Validates a review and returns stable, path-sorted diagnostics on failure. */
export function validatePostReleaseOutcomeReview(input: unknown) {
  const result = PostReleaseOutcomeReview.safeParse(input);
  if (result.success) {
    return { valid: true as const, value: result.data, diagnostics: [] };
  }
  return {
    valid: false as const,
    diagnostics: result.error.issues.map((item) => ({
      path: item.path.map(String).join("."),
      code: item.code,
      message: item.message,
    })).sort((a, b) =>
      a.path.localeCompare(b.path) || a.message.localeCompare(b.message)
    ),
  };
}
