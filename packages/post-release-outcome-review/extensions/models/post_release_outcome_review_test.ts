import {
  PostReleaseOutcomeReview,
  type PostReleaseOutcomeReview as Review,
} from "./_lib/post_release_outcome_review_contracts.ts";
import type { SourceReference } from "./_lib/source_reference_contract.ts";
import { model } from "./post_release_outcome_review.ts";

const assert = (value: unknown, message = "assertion failed") => {
  if (!value) throw new Error(message);
};
const hash = (char: string) => char.repeat(64);
const evidence = (id: string): SourceReference => ({
  schemaVersion: "1.0",
  sourceId: id,
  source: { system: "warehouse", resourceType: "query", resourceId: id },
  provenance: {
    collector: "synthetic-test",
    collectorVersion: "1",
    method: "fixture",
    collectedAt: "2026-08-10T01:30:00Z",
  },
  observedAt: "2026-08-10T01:00:00Z",
  freshness: {
    asOf: "2026-08-10T01:00:00Z",
    expiresAt: "2026-08-11T00:00:00Z",
  },
  sensitivity: "internal" as const,
});
const review: Review = {
  schemaVersion: "2.0",
  reviewId: "review-1",
  reviewedAt: "2026-08-10T02:00:00Z",
  releasedArtifact: { id: "release-42", version: 3, sha256: hash("a") },
  workOrder: { id: "work-order-7", version: 2, sha256: hash("b") },
  measurementPlan: { id: "plan-1", version: 1, sha256: hash("c") },
  observationWindow: {
    startsAt: "2026-08-03T00:00:00Z",
    endsAt: "2026-08-10T00:00:00Z",
  },
  policy: {
    policyId: "policy-1",
    version: 1,
    sha256: hash("d"),
    metrics: [{
      metricId: "activation",
      unit: "ratio",
      denominatorUnit: "eligible_users",
      success: { comparator: "gte", threshold: 0.5 },
      failure: { comparator: "lt", threshold: 0.4 },
    }],
    recommendationByOutcome: {
      success: "keep",
      failure: "revert",
      ambiguity: "gather_evidence",
    },
  },
  observedMetrics: [{
    metricId: "activation",
    value: 0.45,
    unit: "ratio",
    denominator: 200,
    denominatorUnit: "eligible_users",
    measuredWindow: {
      startsAt: "2026-08-03T00:00:00Z",
      endsAt: "2026-08-10T00:00:00Z",
    },
    evidence: evidence("activation-query"),
  }],
  comparisons: [{
    metricId: "activation",
    value: 0.45,
    outcome: "ambiguity",
    appliedComparator: null,
    appliedThreshold: null,
  }],
  aggregateOutcome: "ambiguity",
  recommendation: "gather_evidence",
  rationale: "Declared thresholds leave the observed value ambiguous.",
  evidence: ["activation-query"],
  authority: {
    disposition: "recommendation-only",
    humanDecisionRequired: true,
    mayExecute: false,
    productionEffects: "none",
  },
};

Deno.test("accepts deterministic ambiguity and all five typed policy recommendations", () => {
  assert(PostReleaseOutcomeReview.safeParse(review).success);
  for (
    const recommendation of [
      "keep",
      "iterate",
      "revert",
      "gather_evidence",
      "stop",
    ]
  ) {
    assert(
      PostReleaseOutcomeReview.safeParse({
        ...review,
        policy: {
          ...review.policy,
          recommendationByOutcome: {
            ...review.policy.recommendationByOutcome,
            ambiguity: recommendation,
          },
        },
        recommendation,
      }).success,
    );
  }
});

Deno.test("fails closed on early review, binding, freshness, units, denominator, or invented result", () => {
  const cases = [
    { ...review, reviewedAt: "2026-08-09T23:59:59Z" },
    {
      ...review,
      measurementPlan: { ...review.measurementPlan, sha256: "bad" },
    },
    {
      ...review,
      observedMetrics: [{ ...review.observedMetrics[0], denominator: 0 }],
    },
    {
      ...review,
      observedMetrics: [{ ...review.observedMetrics[0], unit: "percent" }],
    },
    {
      ...review,
      policy: {
        ...review.policy,
        metrics: [{
          ...review.policy.metrics[0],
          success: { comparator: "gte", threshold: 0.5 },
          failure: { comparator: "lte", threshold: 0.6 },
        }],
      },
    },
    {
      ...review,
      observedMetrics: [{
        ...review.observedMetrics[0],
        evidence: {
          ...review.observedMetrics[0].evidence,
          freshness: {
            ...review.observedMetrics[0].evidence.freshness,
            expiresAt: "2026-08-10T01:00:00Z",
          },
        },
      }],
    },
    { ...review, aggregateOutcome: "success", recommendation: "keep" },
  ];
  cases.forEach((value) =>
    assert(!PostReleaseOutcomeReview.safeParse(value).success)
  );
});

Deno.test("record is persistence-only", async () => {
  const writes: unknown[][] = [];
  const result = await model.methods.record.execute({
    recordId: "synthetic-1",
    review,
  }, {
    writeResource: (...args: unknown[]) => {
      writes.push(args);
      return Promise.resolve({ name: args[1] });
    },
  });
  assert(writes.length === 1);
  assert(
    JSON.stringify(result) ===
      JSON.stringify({ dataHandles: [{ name: "review-synthetic-1" }] }),
  );
  assert(
    JSON.stringify(Object.keys(model.methods)) === JSON.stringify(["record"]),
  );
  assert(!("files" in model));
});
