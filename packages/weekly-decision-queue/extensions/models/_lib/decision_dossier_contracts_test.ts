import {
  DECISION_DOSSIER_SCHEMA_VERSION,
  DecisionDossier,
  validateDecisionDossier,
} from "./decision_dossier_contracts.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function copy<T>(value: T): T {
  return structuredClone(value);
}

const source = {
  schemaVersion: "1.0",
  sourceId: "synthetic:source:1",
  source: { system: "synthetic", resourceType: "record", resourceId: "1" },
  provenance: {
    collector: "fixture",
    collectorVersion: "1",
    method: "generated",
    collectedAt: "2026-01-02T12:00:00Z",
  },
  observedAt: "2026-01-02T11:00:00Z",
  freshness: {
    asOf: "2026-01-02T12:00:00Z",
    expiresAt: "2026-02-02T12:00:00Z",
  },
  sensitivity: "internal" as const,
};
export const syntheticDossier = {
  schemaVersion: DECISION_DOSSIER_SCHEMA_VERSION,
  dossierId: "synthetic:dossier:1",
  subject: {
    kind: "proposal",
    id: "synthetic:proposal:1",
    version: 2,
    sha256: "a".repeat(64),
  },
  version: 1,
  createdAt: "2026-01-03T12:00:00Z",
  problem: {
    statement: "A synthetic process exceeds its target",
    scope: "One synthetic process",
    evidenceIds: ["e1"],
  },
  affectedSegment: {
    segmentId: "segment:synthetic-users",
    label: "Synthetic users",
    definition: "Users of the affected synthetic process",
    evidenceIds: ["e1"],
  },
  confidence: {
    level: "medium" as const,
    rationale: "One fresh direct observation supports the problem",
    evidenceIds: ["e1"],
  },
  strategicFit: {
    alignment: "aligned" as const,
    rationale: "Reducing duration supports the synthetic speed principle",
    principleIds: ["principle:synthetic-speed"],
    evidenceIds: ["e1"],
  },
  evidence: [{
    evidenceId: "e1",
    claim: "The synthetic duration is ten hours",
    sourceReference: source,
  }],
  options: [
    {
      optionId: "o0",
      kind: "do_nothing" as const,
      title: "Continue",
      description: "Leave the process unchanged",
      evidenceIds: ["e1"],
    },
    {
      optionId: "o1",
      kind: "action" as const,
      title: "Change sequence",
      description: "Change the synthetic sequence",
      evidenceIds: ["e1"],
    },
  ],
  recommendation: {
    optionId: "o1",
    rationale: "Best expected balance",
    evidenceIds: ["e1"],
  },
  effort: {
    size: "small" as const,
    status: "hypothetical" as const,
    estimate: 2,
    unit: "engineer_days",
    rationale: "One bounded sequence change",
    evidenceIds: ["e1"],
    assumptions: ["The existing interface remains stable"],
  },
  economics: {
    summary: "Expected benefit exceeds cost",
    estimates: [
      {
        estimateId: "x1",
        optionId: "o0",
        label: "Observed effort",
        direction: "cost" as const,
        status: "observed" as const,
        asOf: "2026-01-02T12:00:00Z",
        evidenceIds: ["e1"],
        assumptions: [],
        sourceReference: source,
        valueType: "quantity" as const,
        value: 10,
        unit: "hours",
      },
      {
        estimateId: "x2",
        optionId: "o1",
        label: "Expected cost",
        direction: "cost" as const,
        status: "hypothetical" as const,
        asOf: "2026-01-03T12:00:00Z",
        evidenceIds: ["e1"],
        assumptions: ["Synthetic rate remains fixed"],
        valueType: "monetary" as const,
        value: 500,
        currency: "USD",
        unit: "currency" as const,
      },
    ],
  },
  risks: [{
    riskId: "r1",
    description: "Sequence could take longer",
    likelihood: "low" as const,
    impact: "medium" as const,
    mitigation: "Stop after one window",
    ownerId: "actor:2",
    evidenceIds: ["e1"],
  }],
  authority: {
    decisionMaker: { id: "actor:1", role: "decision owner" },
    authorityBasis: "Owns the affected scope",
    decisionDueAt: "2026-01-04T12:00:00Z",
  },
  expectedOutcomes: [{
    outcomeId: "out1",
    statement: "Duration decreases",
    metricIds: ["m1"],
  }],
  measurementPlan: {
    metrics: [{
      metricId: "m1",
      name: "Duration",
      unit: "hours",
      desiredDirection: "decrease" as const,
      target: 8,
    }],
    windows: [{
      windowId: "w1",
      purpose: "Initial evaluation",
      window: {
        startsAt: "2026-01-05T12:00:00Z",
        endsAt: "2026-01-12T12:00:00Z",
      },
    }],
    ownerId: "actor:2",
    reviewAt: "2026-01-12T12:00:00Z",
  },
};

Deno.test("complete synthetic dossier parses with stable identity and reused contracts", () => {
  const parsed = DecisionDossier.parse(syntheticDossier);
  assert(parsed.dossierId === "synthetic:dossier:1");
  assert(parsed.subject.sha256.length === 64);
  assert(parsed.evidence[0].sourceReference.sourceId === "synthetic:source:1");
  assert(parsed.affectedSegment.segmentId === "segment:synthetic-users");
  assert(parsed.confidence.level === "medium");
  assert(parsed.strategicFit.principleIds.length === 1);
  assert(parsed.effort.size === "small");
});

Deno.test("all objects are strict and version is literal", () => {
  assert(
    !DecisionDossier.safeParse({ ...syntheticDossier, extra: true }).success,
  );
  assert(
    !DecisionDossier.safeParse({ ...syntheticDossier, schemaVersion: "2.0" })
      .success,
  );
  const nested = copy(syntheticDossier) as any;
  nested.measurementPlan.metrics[0].extra = true;
  assert(!DecisionDossier.safeParse(nested).success);
});

Deno.test("option, recommendation, evidence, and metric references are consistent", () => {
  const mutations = [
    (x: any) => x.options[0].kind = "action",
    (x: any) => x.options[1].optionId = "o0",
    (x: any) => x.recommendation.optionId = "missing",
    (x: any) => x.problem.evidenceIds = ["missing"],
    (x: any) => x.affectedSegment.evidenceIds = ["missing"],
    (x: any) => x.confidence.evidenceIds = ["missing"],
    (x: any) => x.strategicFit.evidenceIds = ["missing"],
    (x: any) => x.effort.evidenceIds = ["missing"],
    (x: any) => x.economics.estimates[0].optionId = "missing",
    (x: any) => x.expectedOutcomes[0].metricIds = ["missing"],
  ];
  for (const mutate of mutations) {
    const value = copy(syntheticDossier);
    mutate(value);
    assert(!validateDecisionDossier(value).success);
  }

  const duplicate = copy(syntheticDossier);
  duplicate.options[1].optionId = "o0";
  const result = validateDecisionDossier(duplicate);
  assert(!result.success);
  assert(
    result.diagnostics.some((diagnostic) =>
      diagnostic.path === "options.1" &&
      diagnostic.message.startsWith("duplicate optionId")
    ),
  );
});

Deno.test("affected segment, confidence, strategic fit, and effort are required and typed", () => {
  for (
    const key of [
      "affectedSegment",
      "confidence",
      "strategicFit",
      "effort",
    ] as const
  ) {
    const value: any = copy(syntheticDossier);
    delete value[key];
    assert(!validateDecisionDossier(value).success);
  }

  const noEffortAssumption = copy(syntheticDossier);
  noEffortAssumption.effort.assumptions = [];
  assert(!validateDecisionDossier(noEffortAssumption).success);

  const duplicatePrinciple = copy(syntheticDossier);
  duplicatePrinciple.strategicFit.principleIds = ["same", "same"];
  assert(!validateDecisionDossier(duplicatePrinciple).success);
});

Deno.test("economics status, typing, provenance, currency, and assumptions are enforced", () => {
  const values = [
    (() => {
      const x: any = copy(syntheticDossier);
      delete x.economics.estimates[0].sourceReference;
      return x;
    })(),
    (() => {
      const x: any = copy(syntheticDossier);
      x.economics.estimates[1].assumptions = [];
      return x;
    })(),
    (() => {
      const x: any = copy(syntheticDossier);
      x.economics.estimates[1].currency = "usd";
      return x;
    })(),
    (() => {
      const x: any = copy(syntheticDossier);
      x.economics.estimates[1].unit = "hours";
      return x;
    })(),
  ];
  values.forEach((value) => assert(!validateDecisionDossier(value).success));
});

Deno.test("authority, freshness, and measurement windows are ordered", () => {
  const mutations = [
    (x: any) => x.authority.decisionDueAt = "2026-01-01T12:00:00Z",
    (x: any) => x.measurementPlan.reviewAt = "2026-01-01T12:00:00Z",
    (x: any) =>
      x.measurementPlan.windows[0].window.endsAt =
        x.measurementPlan.windows[0].window.startsAt,
    (x: any) =>
      x.evidence[0].sourceReference.freshness.asOf = "2026-01-01T00:00:00Z",
  ];
  for (const mutate of mutations) {
    const value = copy(syntheticDossier);
    mutate(value);
    assert(!validateDecisionDossier(value).success);
  }
});

Deno.test("validation diagnostics are deterministic and sorted", () => {
  const invalid = {
    ...syntheticDossier,
    dossierId: "",
    schemaVersion: "bad",
    extra: true,
  };
  const first = validateDecisionDossier(invalid);
  const second = validateDecisionDossier(copy(invalid));
  assert(JSON.stringify(first) === JSON.stringify(second));
  assert(!first.success);
  const sorted = [...first.diagnostics].sort((a, b) =>
    a.path.localeCompare(b.path) || a.code.localeCompare(b.code) ||
    a.message.localeCompare(b.message)
  );
  assert(JSON.stringify(first.diagnostics) === JSON.stringify(sorted));
});
