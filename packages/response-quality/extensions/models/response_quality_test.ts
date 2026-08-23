import {
  evaluateResponseQuality,
  RESPONSE_QUALITY_DIMENSIONS,
  responseQualityInputSchema,
} from "./_lib/response_quality_contracts.ts";
import { model } from "./response_quality.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

const hash = (character: string): string => character.repeat(64);

function fixture(): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    evaluationId: "synthetic-evaluation",
    evaluatedAt: "2026-08-23T12:00:00Z",
    draft: { id: "draft", version: "1", sha256: hash("a") },
    source: { id: "source", version: "1", sha256: hash("b") },
    reviewer: { id: "reviewer", version: "1", sha256: hash("c") },
    policy: {
      policyId: "policy",
      version: "1",
      sha256: hash("d"),
      overallMinimumNormalizedScore: 0.6,
      optionalUnavailableTreatment: "exclude_and_reweight",
      scales: RESPONSE_QUALITY_DIMENSIONS.map((dimension) => ({
        dimension,
        minimum: 1,
        maximum: 5,
        preferredDirection: "higher",
        weight: 1,
        minimumNormalizedScore: 0.5,
        required: dimension !== "userFollowUp",
      })),
    },
    evidence: RESPONSE_QUALITY_DIMENSIONS.map((dimension, index) => ({
      evidenceId: `e-${index}`,
      dimension,
      observation: `Synthetic evidence for ${dimension}`,
      source: { id: `source-${index}`, version: "1", sha256: hash("e") },
      provenance: {
        sourceSystem: "synthetic",
        collector: "test",
        collectorVersion: "1",
        method: "synthetic observation",
        collectedAt: "2026-08-23T11:00:00Z",
      },
      freshness: {
        asOf: "2026-08-23T11:00:00Z",
        expiresAt: "2026-08-24T00:00:00Z",
      },
    })),
    scores: RESPONSE_QUALITY_DIMENSIONS.map((dimension, index) => ({
      dimension,
      status: "available",
      value: 4,
      evidenceIds: [`e-${index}`],
      unavailableReason: null,
    })),
  };
}

Deno.test("scores deterministically in contract order and preserves bindings", () => {
  const input = fixture();
  const first = evaluateResponseQuality(input);
  const second = evaluateResponseQuality(input);
  assert(JSON.stringify(first) === JSON.stringify(second));
  assert(first.result === "pass");
  assert(
    JSON.stringify(first.scores.map((score) => score.dimension)) ===
      JSON.stringify(RESPONSE_QUALITY_DIMENSIONS),
  );
  assert(
    first.draft.id === "draft" && first.source.id === "source" &&
      first.reviewer.id === "reviewer",
  );
});

Deno.test("requires review for a required unavailable dimension", () => {
  const input = fixture();
  const scores = input.scores as Array<Record<string, unknown>>;
  scores[3] = {
    dimension: "responseTime",
    status: "unavailable",
    value: null,
    evidenceIds: [],
    unavailableReason: "Synthetic absence",
  };
  const output = evaluateResponseQuality(input);
  assert(output.result === "review");
  assert(output.scores[3].normalizedValue === null);
  assert(
    output.reviewReasons.includes(
      "required dimension unavailable: responseTime",
    ),
  );
});

Deno.test("scores optional unavailable values as zero when policy requests it", () => {
  const input = fixture();
  const policy = input.policy as Record<string, unknown>;
  policy.optionalUnavailableTreatment = "score_as_zero";
  const scores = input.scores as Array<Record<string, unknown>>;
  scores[4] = {
    dimension: "userFollowUp",
    status: "unavailable",
    value: null,
    evidenceIds: [],
    unavailableReason: "Synthetic absence",
  };
  const output = evaluateResponseQuality(input);
  assert(output.scores[4].effectiveWeight > 0);
  assert(output.scores[4].contribution === 0);
});

Deno.test("rejects synthetic contract failures", () => {
  const invalidInputs: Array<Record<string, unknown>> = [];
  const duplicateEvidence = fixture();
  (duplicateEvidence.evidence as Array<Record<string, unknown>>)[1].evidenceId =
    "e-0";
  invalidInputs.push(duplicateEvidence);
  const mismatchedEvidence = fixture();
  (mismatchedEvidence.scores as Array<Record<string, unknown>>)[0].evidenceIds =
    ["e-1"];
  invalidInputs.push(mismatchedEvidence);
  const staleEvidence = fixture();
  ((staleEvidence.evidence as Array<Record<string, unknown>>)[0]
    .freshness as Record<string, unknown>).expiresAt = "2026-08-23T11:59:59Z";
  invalidInputs.push(staleEvidence);
  const outOfRange = fixture();
  (outOfRange.scores as Array<Record<string, unknown>>)[0].value = 6;
  invalidInputs.push(outOfRange);
  for (const input of invalidInputs) {
    assert(!responseQualityInputSchema.safeParse(input).success);
  }
});

Deno.test("persists exactly one evaluation and exposes no side-effect methods", async () => {
  const writes: unknown[][] = [];
  const result = await model.methods.evaluate.execute({
    recordId: "synthetic-1",
    input: fixture(),
  }, {
    writeResource: (...args: unknown[]): Promise<unknown> => {
      writes.push(args);
      return Promise.resolve({ name: args[1] });
    },
  });
  assert(
    JSON.stringify(result) ===
      JSON.stringify({
        dataHandles: [{ name: "response-quality-synthetic-1" }],
      }),
  );
  assert(writes.length === 1 && writes[0][0] === "evaluation");
  assert(
    JSON.stringify(Object.keys(model.methods)) === JSON.stringify(["evaluate"]),
  );
  assert(!("files" in model));
});
