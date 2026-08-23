import {
  REVIEW_METRICS,
  reviewAgentSystem,
} from "./_lib/agent_system_review_contracts.ts";
import { model } from "./agent_system_review.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function rejects(fn: () => unknown, text: string) {
  try {
    fn();
  } catch (error) {
    assert(String(error).includes(text), String(error));
    return;
  }
  throw new Error(`expected ${text}`);
}
const source = (id: string) => ({
  schemaVersion: "1.0",
  sourceId: id,
  source: {
    system: "synthetic",
    resourceType: "review-metric",
    resourceId: id,
  },
  provenance: {
    collector: "fixture",
    collectorVersion: "1",
    method: "snapshot",
    collectedAt: "2026-08-23T10:00:00Z",
  },
  observedAt: "2026-08-23T09:00:00Z",
  freshness: {
    asOf: "2026-08-23T10:00:00Z",
    expiresAt: "2026-08-24T00:00:00Z",
  },
  sensitivity: "internal" as const,
});
const fixture = () => ({
  schemaVersion: "1.0",
  reviewId: "review-1",
  evaluatedAt: "2026-08-23T12:00:00Z",
  policy: {
    policyId: "policy-1",
    policyVersion: "3",
    policyHash: `sha256:${"a".repeat(64)}`,
    maximumProposals: 4,
    scoring: "excess_basis_points_times_weight",
    tieBreak: "score_desc_metric_asc_target_type_asc_target_id_asc",
    thresholds: REVIEW_METRICS.map((metric, index) => ({
      metric,
      maximum: 10,
      minimumSampleSize: 10,
      weight: index + 1,
      target: {
        type: (["context", "permission", "workflow", "policy"] as const)[index],
        id: `target-${index}`,
        currentVersion: "v1",
        currentHash: `sha256:${String(index).repeat(64)}`,
      },
      proposedChange: `Change ${metric}`,
      expectedBenefit: `Reduce ${metric}`,
      expectedRisk: `Regression risk for ${metric}`,
    })),
  },
  evidence: REVIEW_METRICS.map((metric) => ({
    evidenceId: `e-${metric}`,
    summary: `Synthetic ${metric}`,
    sourceReference: source(metric),
  })),
  measurements: REVIEW_METRICS.map((metric, index) => ({
    metric,
    status: index === 1 ? "unavailable" as const : "available" as const,
    value: index === 1 ? null : 20,
    sampleSize: index === 1 ? null : 20,
    unavailableReason: index === 1
      ? "Permission telemetry was not collected"
      : null,
    evidenceIds: [`e-${metric}`],
  })),
});

Deno.test("review is deterministic, ordered, bounded, versioned, and separately approval gated", () => {
  const first = reviewAgentSystem(fixture());
  assert(
    JSON.stringify(first) === JSON.stringify(reviewAgentSystem(fixture())),
  );
  assert(
    first.proposals.map((x) => x.metric).join(",") ===
      "median_completion_milliseconds,workflow_retry_rate,context_failure_rate",
  );
  assert(
    first.proposals.every((x) =>
      x.approval.approved === false && x.approval.approvalId.includes(x.metric)
    ),
  );
  assert(first.unavailableMetrics[0].metric === "permission_denial_rate");
  assert(first.truncated === false);
  assert(
    !first.authority.selfModification && !first.authority.networkCalls &&
      !first.authority.factoryCalls && !first.authority.productionChanges,
  );
});

Deno.test("strict contract rejects bounded-evidence edge cases", () => {
  const missing = fixture();
  missing.policy.thresholds = missing.policy.thresholds.slice(1);
  rejects(() => reviewAgentSystem(missing), "thresholds");
  const stale = fixture();
  stale.evidence[0].sourceReference.freshness.expiresAt =
    "2026-08-23T11:00:00Z";
  rejects(() => reviewAgentSystem(stale), "stale");
  const unknown = fixture();
  unknown.measurements[0].evidenceIds = ["missing"];
  rejects(() => reviewAgentSystem(unknown), "unknown evidenceId");
  const duplicate = fixture();
  duplicate.measurements[0].evidenceIds = [
    duplicate.measurements[0].evidenceIds[0],
    duplicate.measurements[0].evidenceIds[0],
  ];
  rejects(() => reviewAgentSystem(duplicate), "duplicate evidence reference");
  const ambiguous = fixture();
  ambiguous.measurements[1].value = 1;
  rejects(
    () => reviewAgentSystem(ambiguous),
    "unavailable metric requires only unavailableReason",
  );
});

Deno.test("minimum samples and maximum proposals are enforced deterministically", () => {
  const input = fixture();
  input.measurements[0].sampleSize = 1;
  input.policy.maximumProposals = 1;
  const result = reviewAgentSystem(input);
  assert(
    result.proposals.length === 1 &&
      result.proposals[0].metric === "median_completion_milliseconds",
  );
  assert(result.truncated === true);
});

Deno.test("model exposes one persistence-only write", async () => {
  const writes: unknown[][] = [];
  const result = await model.methods.review.execute({
    requestId: "synthetic-1",
    input: fixture(),
  }, {
    writeResource: async (...args: unknown[]) => {
      writes.push(args);
      return { name: args[1] };
    },
  });
  assert(writes.length === 1 && writes[0][0] === "review");
  assert(
    JSON.stringify(result) ===
      JSON.stringify({ dataHandles: [{ name: "review-synthetic-1" }] }),
  );
  assert(
    JSON.stringify(Object.keys(model.methods)) === JSON.stringify(["review"]) &&
      !("files" in model),
  );
});
