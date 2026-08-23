import {
  DecisionDossier,
  validateDecisionDossier,
} from "./decision_dossier_contracts.ts";
import { syntheticDossier } from "./fixture.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function copy<T>(value: T): T {
  return structuredClone(value);
}

function object(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

Deno.test("accepts a complete generic dossier and its generic provenance", () => {
  const parsed = DecisionDossier.parse(syntheticDossier);
  assert(parsed.dossierId === "example:dossier:1");
  assert(parsed.subject.sha256.length === 64);
  assert(parsed.evidence[0].sourceReference.source.system === "example");
});

Deno.test("rejects unknown fields, unsupported schema versions, and invalid provenance chronology", () => {
  assert(
    !validateDecisionDossier({ ...syntheticDossier, extra: true }).success,
  );
  assert(
    !validateDecisionDossier({ ...syntheticDossier, schemaVersion: "2.0" })
      .success,
  );
  const invalid = copy(syntheticDossier);
  invalid.evidence[0].sourceReference.freshness.asOf = "2026-01-02T10:00:00Z";
  assert(!validateDecisionDossier(invalid).success);
});

Deno.test("enforces graph references, unique identifiers, and exactly one do-nothing option", () => {
  const mutations = [
    (value: unknown) =>
      object((object(value).options as unknown[])[0]).kind = "action",
    (value: unknown) =>
      object((object(value).options as unknown[])[1]).optionId = "o0",
    (value: unknown) =>
      object(object(value).recommendation).optionId = "missing",
    (value: unknown) => object(object(value).problem).evidenceIds = ["missing"],
    (value: unknown) =>
      object((object(object(value).economics).estimates as unknown[])[0])
        .optionId = "missing",
    (value: unknown) =>
      object((object(value).expectedOutcomes as unknown[])[0]).metricIds = [
        "missing",
      ],
  ];
  mutations.forEach((mutate) => {
    const value = copy(syntheticDossier);
    mutate(value);
    assert(!validateDecisionDossier(value).success);
  });
});

Deno.test("requires provenance for observations and assumptions for hypotheses", () => {
  const observed = copy(syntheticDossier);
  delete object(observed.economics.estimates[0]).sourceReference;
  assert(!validateDecisionDossier(observed).success);
  const hypothetical = copy(syntheticDossier);
  hypothetical.effort.assumptions = [];
  hypothetical.economics.estimates[1].assumptions = [];
  assert(!validateDecisionDossier(hypothetical).success);
});

Deno.test("validates temporal boundaries and emits stable sorted diagnostics", () => {
  const invalid = copy(syntheticDossier);
  invalid.authority.decisionDueAt = "2026-01-01T12:00:00Z";
  invalid.measurementPlan.windows[0].window.endsAt =
    invalid.measurementPlan.windows[0].window.startsAt;
  const first = validateDecisionDossier(invalid);
  const second = validateDecisionDossier(copy(invalid));
  assert(!first.success && !second.success);
  assert(JSON.stringify(first) === JSON.stringify(second));
  assert(
    JSON.stringify(first.diagnostics) ===
      JSON.stringify(
        [...first.diagnostics].sort((a, b) =>
          a.path.localeCompare(b.path) || a.code.localeCompare(b.code) ||
          a.message.localeCompare(b.message)
        ),
      ),
  );
});

Deno.test("bounds identifiers, text, and collections", () => {
  const longId = copy(syntheticDossier);
  longId.dossierId = "x".repeat(513);
  assert(!validateDecisionDossier(longId).success);
  const longText = copy(syntheticDossier);
  longText.problem.statement = "x".repeat(10_001);
  assert(!validateDecisionDossier(longText).success);
  const tooMany = copy(syntheticDossier);
  tooMany.problem.evidenceIds = Array.from(
    { length: 101 },
    (_, index) => `e${index}`,
  );
  assert(!validateDecisionDossier(tooMany).success);
});
