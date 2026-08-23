import {
  buildPrompt,
  globalArgumentsSchema,
  invocationClaimAuditSchema,
  model,
  prepareRequest,
  validateAgentResult,
} from "./feature_idea_gate.ts";
import {
  evaluateFeatureIdeas,
  FEATURE_IDEA_GATE_CRITERIA,
  type FeatureIdeaGateAgentOutput,
  type FeatureIdeaGateInput,
} from "./_lib/feature_idea_gate_contracts.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
const rejects = async (fn: () => unknown | Promise<unknown>, message: string) => {
  try {
    await fn();
  } catch (error) {
    assert(String(error).includes(message), String(error));
    return;
  }
  throw new Error(`expected rejection: ${message}`);
};
const now = new Date("2026-08-23T12:00:00Z");
const criteriaEvidence: Record<string, string[]> = {
  userEvidence: ["signal-a", "signal-b"],
  activeBottleneckAlignment: ["bottleneck"],
  strategicFit: ["strategy"],
  trustPrivacySafety: ["trust"],
  implementationCost: ["cost"],
  reversibility: ["cost"],
};
const reference = (id: string) => ({
  sourceId: `synthetic-${id}`,
  source: { system: "synthetic-fixture", resourceType: "evidence", resourceId: id },
  provenance: {
    collector: "fixture",
    method: "synthetic",
    collectedAt: "2026-08-23T10:00:00Z",
  },
  observedAt: "2026-08-23T09:00:00Z",
  freshness: { asOf: "2026-08-23T10:00:00Z", expiresAt: "2026-08-24T10:00:00Z" },
  sensitivity: "internal" as const,
});
const evidenceFixture: Array<[string, string, string | null]> = [
  ["signal-a", "user-signal", "source-a"],
  ["signal-b", "user-signal", "source-b"],
  ["bottleneck", "active-bottleneck", null],
  ["strategy", "strategy", null],
  ["trust", "trust-privacy", null],
  ["cost", "implementation-assessment", null],
];
const input = (): FeatureIdeaGateInput => ({
  schemaVersion: "1.0",
  gateId: "generic-gate",
  evaluatedAt: "2026-08-23T11:00:00Z",
  period: { startAt: "2026-08-01T00:00:00Z", endAt: "2026-08-23T11:00:00Z" },
  activeBottleneck: {
    title: "Synthetic activation bottleneck",
    evidenceIds: ["bottleneck"],
  },
  policy: {
    scales: FEATURE_IDEA_GATE_CRITERIA.map((criterion) => ({
      criterion,
      minimum: 0,
      maximum: 10,
      preferredDirection: criterion === "implementationCost"
        ? "lower" as const
        : "higher" as const,
      normalization: "linear_min_max" as const,
      weight: 1,
    })),
    requiredEvidenceTypes: {
      userEvidence: ["user-signal"],
      activeBottleneckAlignment: ["active-bottleneck"],
      strategicFit: ["strategy"],
      trustPrivacySafety: ["trust-privacy"],
      implementationCost: ["implementation-assessment"],
      reversibility: ["implementation-assessment"],
    },
    requiredCandidateLabels: ["candidate", "bounded"],
    missingData: "ineligible",
    minimumScore: 0.6,
    minimumIndependentUserSignals: 2,
    promotionLimit: 1,
    tieBreak: "candidate_id_ascending",
  },
  evidence: evidenceFixture.map(([evidenceId, evidenceType, independenceKey]) => ({
    evidenceId,
    evidenceLink: `https://example.test/evidence/${evidenceId}`,
    evidenceType,
    claim: `Synthetic evidence ${evidenceId}`,
    independenceKey,
    sourceReference: reference(evidenceId),
  })),
  candidates: ["beta", "alpha"].map((candidateId) => ({
    candidateId,
    title: `Candidate ${candidateId}`,
    description: "Synthetic bounded candidate.",
    taskUrl: `https://example.test/candidates/${candidateId}`,
    labels: ["candidate", "bounded"],
  })),
});
const output = (): FeatureIdeaGateAgentOutput => ({
  schemaVersion: "1.0",
  gateId: "generic-gate",
  generatedAt: "2026-08-23T11:30:00Z",
  assessments: ["beta", "alpha"].map((candidateId) => ({
    candidateId,
    conciseRationale: `${candidateId} is synthetic.`,
    ratings: FEATURE_IDEA_GATE_CRITERIA.map((criterion) => ({
      criterion,
      value: candidateId === "alpha" ? 8 : 6,
      evidenceIds: criteriaEvidence[criterion],
      missingReason: null,
    })),
    trustPrivacyBlocker: { blocked: false, reason: null, evidenceIds: [] },
    unknowns: [],
  })),
  authority: {
    disposition: "recommendation-only",
    sideEffects: "none",
    mayApprove: false,
    mayPlan: false,
    mayExecute: false,
  },
});

Deno.test("uses generic policy and deterministically recommends without authority", () => {
  const result = evaluateFeatureIdeas(input(), output());
  assert(result.ranking.map((item) => item.candidateId).join(",") === "alpha,beta");
  assert(result.recommendation.disposition === "promote_one");
  assert(
    result.authority.promotedAutomatically === false &&
      result.authority.plansCreated === false,
  );
});
Deno.test("fails closed for stale evidence, policy-label drift, and wrong rating provenance", async () => {
  const stale = input();
  stale.evidence[0].sourceReference.freshness.expiresAt = "2026-08-23T10:59:59Z";
  await rejects(() => evaluateFeatureIdeas(stale, output()), "fresh at evaluatedAt");
  const labels = input();
  labels.candidates[0].labels = ["candidate"];
  await rejects(() => evaluateFeatureIdeas(labels, output()), "policy label bounded");
  const wrongEvidence = output();
  wrongEvidence.assessments[0].ratings.find((rating) =>
    rating.criterion === "strategicFit"
  )!.evidenceIds = ["trust"];
  await rejects(
    () => evaluateFeatureIdeas(input(), wrongEvidence),
    "lacks required evidence type",
  );
});
Deno.test("missing data, blockers, tampering, and failed audited calls do not validate", async () => {
  const missing = output();
  const rating = missing.assessments[0].ratings[0];
  rating.value = null;
  rating.evidenceIds = [];
  rating.missingReason = "Synthetic evidence unavailable";
  missing.assessments[1].trustPrivacyBlocker = {
    blocked: true,
    reason: "Synthetic trust risk",
    evidenceIds: ["trust"],
  };
  const result = evaluateFeatureIdeas(input(), missing);
  assert(result.recommendation.disposition === "keep_all_parked");
  const globals = globalArgumentsSchema.parse({ agentCwd: "/tmp/generic-gate-test" });
  const request = await prepareRequest("generic-gate", input(), globals, now);
  const audit = {
    invocationId: "generic-gate",
    provider: "amp",
    model: "synthetic",
    promptHash: request.promptHash,
    cwd: request.agentCwd,
    success: true,
  };
  const claim = invocationClaimAuditSchema.parse({
    operation: "invokeAndParse",
    invocationId: "generic-gate",
    provider: "amp",
    model: "synthetic",
    cwd: request.agentCwd,
    promptHash: request.promptHash,
    toolProfile: "readonly",
    sandbox: {
      mode: "auto",
      provider: "amp",
      credentialAccess: "isolated",
      network: "allow",
      profilePath: "",
      required: true,
    },
  });
  const validated = await validateAgentResult(
    "generic-gate",
    request,
    output(),
    audit,
    claim,
    now,
  );
  assert(
    validated.authority.mayApprove === false &&
      validated.authority.mayInvokeTools === false,
  );
  await rejects(
    () =>
      validateAgentResult(
        "generic-gate",
        request,
        output(),
        { ...audit, success: false },
        claim,
        now,
      ),
    "not successful",
  );
  await rejects(
    () =>
      validateAgentResult(
        "generic-gate",
        { ...request, prompt: "tampered" },
        output(),
        audit,
        claim,
        now,
      ),
    "exactly match",
  );
  assert(
    buildPrompt(input()).includes("Use no tools") &&
      !buildPrompt(input()).includes(["Moment", "Savor"].join(" ")),
  );
});

Deno.test("public methods reject unknown arguments and preparation creates no workspace", async () => {
  assert(!model.methods.prepare.arguments.safeParse({ gateId: "generic-gate", input: input(), extra: true }).success);
  assert(!model.methods.validate.arguments.safeParse({ extra: true }).success);
  let workspaceCreated = false;
  await model.methods.prepare.execute({ gateId: "generic-gate", input: input() }, {
    globalArgs: globalArgumentsSchema.parse({ agentCwd: "/tmp/generic-gate-test" }),
    now: () => now,
    writeResource: () => Promise.resolve({ name: "request-generic-gate" }),
    ensureWorkspace: () => { workspaceCreated = true; return Promise.resolve("/tmp/unexpected"); },
  } as Parameters<typeof model.methods.prepare.execute>[1]);
  assert(!workspaceCreated);
});
