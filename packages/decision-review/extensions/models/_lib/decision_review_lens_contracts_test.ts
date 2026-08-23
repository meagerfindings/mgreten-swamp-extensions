import {
  DECISION_REVIEW_LENS_SCHEMA_VERSION,
  validateDecisionReviewLensContract,
} from "./decision_review_lens_contracts.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

const evidence = (evidenceId: string) => ({
  evidenceId,
  claim: `Synthetic claim ${evidenceId}`,
  provenance: {
    sourceId: `source-${evidenceId}`,
    sourceType: "experiment",
    collectedBy: "synthetic fixture",
    collectedAt: "2026-08-23T10:00:00Z",
    method: "synthetic test",
  },
});
const finding = (category: string) => ({
  category,
  assessment: `Synthetic ${category}`,
  evidenceIds: ["e1"],
  confidence: 0.7,
});
const fixture = {
  schemaVersion: DECISION_REVIEW_LENS_SCHEMA_VERSION,
  input: {
    reviewId: "review-1",
    decisionArtifactId: "decision-1",
    decisionArtifactVersion: 1,
    targetFamily: "synthetic audience",
    question: "Should the synthetic test proceed?",
    constraints: ["stay private"],
    requiredGates: ["owner approval"],
    evidence: [evidence("e1")],
  },
  output: {
    reviewId: "review-1",
    generatedAt: "2026-08-23T10:01:00Z",
    authority: {
      disposition: "recommendation-only",
      sideEffects: "none",
      mayExecute: false,
      mayApprove: false,
      mayBypassGates: false,
    },
    lenses: {
      customerAdvocate: {
        lens: "customer-advocate",
        findings: [
          "target-family-capture",
          "preservation",
          "trust",
          "habit",
          "retention",
        ].map(finding),
        recommendation: "Test",
        confidence: 0.7,
      },
      skeptic: {
        lens: "skeptic",
        findings: [
          "weak-evidence",
          "selection-bias",
          "loud-request-bias",
          "confounding",
          "unnecessary-implementation",
          "causal-claim",
        ].map(finding),
        recommendation: "Caution",
        confidence: 0.7,
      },
      dreamer: {
        lens: "dreamer",
        findings: [{
          alternativeId: "alternative-1",
          proposal: "Try a smaller test",
          leverage: "10x",
          evidenceIds: ["e1"],
          assumptions: ["synthetic behavior transfers"],
          constraintsHonored: ["stay private"],
          gatesRequired: ["owner approval"],
          authorityRequired: "owner approval",
          confidence: 0.5,
        }],
        recommendation: "Prototype",
        confidence: 0.5,
      },
    },
  },
};
const copy = <T>(value: T): T => structuredClone(value);

Deno.test("accepts a complete recommendation-only three-lens review", () => {
  assert(validateDecisionReviewLensContract(fixture).success);
});

Deno.test("rejects synthetic evidence, authority, and gate edge cases", () => {
  const mutations = [
    (value: typeof fixture) =>
      value.input.evidence.push(structuredClone(value.input.evidence[0])),
    (value: typeof fixture) => value.output.authority.mayExecute = true,
    (value: typeof fixture) =>
      value.output.lenses.dreamer.findings[0].gatesRequired = [],
    (value: typeof fixture) =>
      value.output.lenses.skeptic.findings[0].evidenceIds = ["missing"],
  ];
  for (const mutate of mutations) {
    const invalid = copy(fixture);
    mutate(invalid);
    assert(!validateDecisionReviewLensContract(invalid).success);
  }
});
