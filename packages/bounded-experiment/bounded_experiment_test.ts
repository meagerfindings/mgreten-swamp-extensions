import { evaluateBoundedExperiment } from "./_lib/bounded_experiment_contracts.ts";
import { model, validateBoundedExperiment } from "./bounded_experiment.ts";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260823.31";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

const money = (amountMinor: number) => ({
  amountMinor,
  currency: "TST",
  unit: "currency_minor" as const,
  denominator: "synthetic_population",
});
const measure = (value: number) => ({
  value,
  unit: "percent",
  denominator: "synthetic_population",
  currency: null,
});
const evidence = (
  evidenceId: string,
  evidenceKind: "product_metric" | "unit_economics",
) => ({
  evidenceId,
  evidenceKind,
  provenance: {
    artifactId: `artifact:${evidenceId}`,
    artifactVersion: "v1",
    contentHash: (evidenceKind === "product_metric" ? "a" : "b").repeat(64),
    producer: "synthetic-test",
    sourceSystem: "fixture",
    sourceUri: `https://example.invalid/${evidenceId}`,
    observedAt: "2026-08-20T10:00:00Z",
    generatedAt: "2026-08-20T11:00:00Z",
    expiresAt: "2026-08-25T00:00:00Z",
  },
  metricName: evidenceId,
  observedValue: measure(10),
  populationDenominator: "100 synthetic users",
  caveat: "Synthetic evidence only.",
});

const fixture = () => ({
  schemaVersion: "1.0" as const,
  proposalId: "synthetic-proposal",
  evaluatedAt: "2026-08-23T12:00:00Z",
  experimentKind: "pricing" as const,
  title: "Synthetic bounded test",
  hypothesis: "A hypothetical price may improve synthetic economics.",
  evidence: [
    evidence("metric", "product_metric"),
    evidence("economics", "unit_economics"),
  ],
  observedClaims: [{
    claimId: "observed",
    statement: "Synthetic conversion was observed.",
    evidenceIds: ["metric"],
  }],
  hypotheticalClaims: [{
    claimId: "hypothesis",
    statement: "Conversion might remain stable.",
    assumption: "Synthetic behavior continues.",
  }],
  policy: {
    policyId: "caller-policy",
    policyVersion: "v1",
    policyHash: "c".repeat(64),
    maximumPopulation: 1_000,
    maximumDurationDays: 30,
    maximumSpend: money(10_000),
    maximumRevenueDownside: money(20_000),
    maximumUserDownsideCount: 50,
  },
  bounds: {
    population: 100,
    durationDays: 14,
    maxSpend: money(5_000),
    maxRevenueDownside: money(10_000),
    maxUserDownsideCount: 10,
  },
  guardrails: [{
    guardrailId: "complaints",
    metric: "complaint_rate",
    limit: measure(5),
    response: "stop_and_review" as const,
  }],
  stopConditions: [{
    conditionId: "conversion",
    signal: "conversion_rate",
    comparator: "lt" as const,
    threshold: measure(5),
    action: "stop_and_review" as const,
  }],
  decisions: {
    success: {
      decision: "recommend_consider_expansion" as const,
      criteria: [{
        criterionId: "success",
        metricName: "conversion_rate",
        comparator: "gte" as const,
        threshold: measure(10),
        minimumSampleSize: 100,
      }],
    },
    failure: {
      decision: "recommend_stop" as const,
      criteria: [{
        criterionId: "failure",
        metricName: "conversion_rate",
        comparator: "lt" as const,
        threshold: measure(5),
        minimumSampleSize: 100,
      }],
    },
    ambiguity: {
      decision: "recommend_no_change_and_review" as const,
      rule:
        "Mixed, underpowered, missing, or contradictory results require review.",
    },
  },
  publishingInvolved: true,
  approvals: ["pricing", "spend", "publishing", "launch"].map((
    approvalKind,
  ) => ({
    approvalKind,
    applicable: true,
    required: true,
    status: "not_requested" as const,
    approverRole: `synthetic-${approvalKind}-owner`,
  })),
  sourceDataGap: "Synthetic fixture: no operational recommendation.",
});

Deno.test("is deterministic, normalized, and persistence-only", async () => {
  const input = fixture();
  input.evidence.reverse();
  const first = evaluateBoundedExperiment(input);
  const second = evaluateBoundedExperiment(input);
  assert(first.success && second.success);
  assert(JSON.stringify(first.value) === JSON.stringify(second.value));
  assert(first.value.evidence[0].evidenceId === "economics");
  assert(first.value.authority.mode === "recommendation_only");
  assert(first.value.authority.prohibitedEffects.includes("launch"));
  const { context, getWrittenResources, getLogs } = createModelTestContext({
    methodName: "propose",
  });
  const result = await model.methods.propose.execute({
    requestId: "request-1",
    input,
  }, {
    ...context,
    globalArgs: {},
    now: () => new Date("2026-08-23T12:01:00Z"),
  });
  assert(getWrittenResources().length === 1);
  assert(result.dataHandles.length === 1);
  assert(
    (result.dataHandles[0] as { name: string }).name === "proposal-request-1",
  );
  assert(Object.keys(model.methods).join(",") === "propose");
  assert(!("files" in model));
  assert(getLogs().length === 2);
});

Deno.test("replays identically and rejects request-id tampering", async () => {
  const proposal = validateBoundedExperiment(
    fixture(),
    new Date("2026-08-23T12:01:00Z"),
  );
  const { context, getWrittenResources } = createModelTestContext({
    methodName: "propose",
    storedResources: { "proposal-request-1": proposal },
  });
  const replay = await model.methods.propose.execute({
    requestId: "request-1",
    input: fixture(),
  }, {
    ...context,
    globalArgs: {},
    now: () => new Date("2026-08-23T12:01:00Z"),
  });
  assert(replay.dataHandles.length === 0);
  assert(getWrittenResources().length === 0);

  const tampered = fixture();
  tampered.title = "Changed after the request was persisted";
  let rejected = false;
  try {
    await model.methods.propose.execute({
      requestId: "request-1",
      input: tampered,
    }, {
      ...context,
      globalArgs: {},
      now: () => new Date("2026-08-23T12:01:00Z"),
    });
  } catch (error) {
    rejected = String(error).includes("already used for a different proposal");
  }
  assert(rejected);
});

Deno.test("fails closed for runtime stale and future proposal clocks", () => {
  let stale = false;
  try {
    validateBoundedExperiment(fixture(), new Date("2026-08-25T00:00:00Z"));
  } catch (error) {
    stale = String(error).includes("Stale evidence");
  }
  assert(stale);
  let future = false;
  try {
    validateBoundedExperiment(fixture(), new Date("2026-08-23T11:59:59Z"));
  } catch (error) {
    future = String(error).includes("Future evaluatedAt");
  }
  assert(future);
});

Deno.test("rejects cross-reference, freshness, downside, unit, and approval attacks", () => {
  const input = fixture();
  input.evidence[0].provenance.expiresAt = "2026-08-23T12:00:00Z";
  input.evidence[1].provenance.observedAt = "2026-08-21T12:00:00Z";
  input.observedClaims[0].evidenceIds = ["missing"];
  input.bounds.population = 1_001;
  input.bounds.maxUserDownsideCount = 101;
  input.bounds.maxSpend.currency = "USD";
  input.approvals[0].required = false;
  input.approvals[3] = { ...input.approvals[0] };
  const result = evaluateBoundedExperiment(input);
  assert(!result.success);
  const codes = result.diagnostics.map((item) => item.code);
  for (
    const code of [
      "stale_evidence",
      "invalid_time_order",
      "unknown_evidence",
      "policy_exceeded",
      "unit_mismatch",
      "approval_cardinality",
    ]
  ) assert(codes.includes(code), `missing ${code}`);
  assert(
    JSON.stringify(result.diagnostics) ===
      JSON.stringify(
        [...result.diagnostics].sort((a, b) =>
          a.path.localeCompare(b.path) || a.code.localeCompare(b.code) ||
          a.message.localeCompare(b.message)
        ),
      ),
  );
});

Deno.test("requires evidence kinds and correct approval applicability without granting approval", () => {
  const input = { ...fixture(), experimentKind: "positioning" as const };
  input.evidence = [
    evidence("metric-one", "product_metric"),
    evidence("metric-two", "product_metric"),
  ];
  input.bounds.maxSpend.amountMinor = 0;
  input.publishingInvolved = false;
  input.approvals = input.approvals.map((approval) => ({
    ...approval,
    applicable: true,
    required: true,
  }));
  const result = evaluateBoundedExperiment(input);
  assert(!result.success);
  assert(
    result.diagnostics.some((item) => item.code === "missing_evidence_kind"),
  );
  assert(
    result.diagnostics.filter((item) => item.code === "approval_mismatch")
      .length >= 3,
  );
});

Deno.test("rejects malformed fields, excessive evidence age, and unreachable criteria", () => {
  const malformed = { ...fixture(), unexpected: true };
  const strict = evaluateBoundedExperiment(malformed);
  assert(!strict.success);
  assert(strict.diagnostics.some((item) => item.code === "unrecognized_keys"));

  const input = fixture();
  input.evidence[0].provenance.generatedAt = "2026-07-01T00:00:00Z";
  input.evidence[0].provenance.observedAt = "2026-07-01T00:00:00Z";
  input.evidence[0].provenance.expiresAt = "2026-09-01T00:00:00Z";
  input.decisions.success.criteria[0].minimumSampleSize = 101;
  const result = evaluateBoundedExperiment(input);
  assert(!result.success);
  for (
    const code of [
      "evidence_too_old",
      "expiry_too_distant",
      "unreachable_criterion",
    ]
  ) {
    assert(
      result.diagnostics.some((item) => item.code === code),
      `missing ${code}`,
    );
  }
});
