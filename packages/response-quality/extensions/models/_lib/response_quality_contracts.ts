/** Deterministic validation and scoring contracts for response-quality evaluation. @module */
import { z } from "npm:zod@4";

/** The supported response-quality input and output schema version. */
export const RESPONSE_QUALITY_SCHEMA_VERSION = "1.0" as const;
/** The deterministic response-quality dimension order. */
export const RESPONSE_QUALITY_DIMENSIONS = [
  "factualAccuracy",
  "privacy",
  "empathy",
  "responseTime",
  "userFollowUp",
  "effortReduction",
] as const;
const Id = z.string().min(1).max(200);
const Text = z.string().min(1).max(2000);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Timestamp = z.iso.datetime({ offset: true });
const Dimension = z.enum(RESPONSE_QUALITY_DIMENSIONS);
const Binding = z.strictObject({ id: Id, version: Id, sha256: Hash });
const Provenance = z.strictObject({
  sourceSystem: Id,
  collector: Id,
  collectorVersion: Id,
  method: Text,
  collectedAt: Timestamp,
});
const Freshness = z.strictObject({ asOf: Timestamp, expiresAt: Timestamp });
const Evidence = z.strictObject({
  evidenceId: Id,
  dimension: Dimension,
  observation: Text,
  source: Binding,
  provenance: Provenance,
  freshness: Freshness,
});
const Scale = z.strictObject({
  dimension: Dimension,
  minimum: z.number().finite(),
  maximum: z.number().finite(),
  preferredDirection: z.enum(["higher", "lower"]),
  weight: z.number().finite().nonnegative(),
  minimumNormalizedScore: z.number().min(0).max(1),
  required: z.boolean(),
});
const Score = z.strictObject({
  dimension: Dimension,
  status: z.enum(["available", "unavailable"]),
  value: z.number().finite().nullable(),
  evidenceIds: z.array(Id).max(20),
  unavailableReason: Text.nullable(),
});

/** Validates caller-supplied inputs, evidence, chronology, and scoring invariants. */
export const responseQualityInputSchema = z.strictObject({
  schemaVersion: z.literal(RESPONSE_QUALITY_SCHEMA_VERSION),
  evaluationId: Id,
  evaluatedAt: Timestamp,
  draft: Binding,
  source: Binding,
  reviewer: Binding,
  policy: z.strictObject({
    policyId: Id,
    version: Id,
    sha256: Hash,
    scales: z.array(Scale).length(RESPONSE_QUALITY_DIMENSIONS.length),
    overallMinimumNormalizedScore: z.number().min(0).max(1),
    optionalUnavailableTreatment: z.enum([
      "exclude_and_reweight",
      "score_as_zero",
    ]),
  }),
  evidence: z.array(Evidence).max(120),
  scores: z.array(Score).length(RESPONSE_QUALITY_DIMENSIONS.length),
}).superRefine((input, context) => {
  const issue = (path: PropertyKey[], message: string): void =>
    context.addIssue({ code: "custom", path, message });
  const evidence = new Map<string, z.infer<typeof Evidence>>();
  input.evidence.forEach((item, index) => {
    if (evidence.has(item.evidenceId)) {
      issue(["evidence", index, "evidenceId"], "duplicate evidenceId");
    }
    evidence.set(item.evidenceId, item);
    if (Date.parse(item.freshness.asOf) > Date.parse(input.evaluatedAt)) {
      issue(
        ["evidence", index, "freshness", "asOf"],
        "evidence is from after evaluatedAt",
      );
    }
    if (Date.parse(item.freshness.expiresAt) < Date.parse(input.evaluatedAt)) {
      issue(
        ["evidence", index, "freshness", "expiresAt"],
        "evidence is stale at evaluatedAt",
      );
    }
    if (
      Date.parse(item.provenance.collectedAt) > Date.parse(input.evaluatedAt)
    ) {
      issue(
        ["evidence", index, "provenance", "collectedAt"],
        "evidence was collected after evaluatedAt",
      );
    }
    if (
      Date.parse(item.provenance.collectedAt) >
        Date.parse(item.freshness.asOf) ||
      Date.parse(item.freshness.asOf) > Date.parse(item.freshness.expiresAt)
    ) {
      issue(
        ["evidence", index, "freshness"],
        "evidence provenance and freshness must be chronological",
      );
    }
  });
  for (const dimension of RESPONSE_QUALITY_DIMENSIONS) {
    if (
      input.policy.scales.filter((x) => x.dimension === dimension).length !== 1
    ) issue(["policy", "scales"], `exactly one ${dimension} scale is required`);
    if (input.scores.filter((x) => x.dimension === dimension).length !== 1) {
      issue(["scores"], `exactly one ${dimension} score is required`);
    }
  }
  if (input.policy.scales.every((x) => x.weight === 0)) {
    issue(["policy", "scales"], "at least one weight must be positive");
  }
  input.policy.scales.forEach((scale, index) => {
    if (scale.maximum <= scale.minimum) {
      issue(
        ["policy", "scales", index, "maximum"],
        "maximum must exceed minimum",
      );
    }
  });
  input.scores.forEach((score, index) => {
    const path = ["scores", index];
    const scale = input.policy.scales.find((x) =>
      x.dimension === score.dimension
    );
    if (score.status === "available") {
      if (score.value === null) {
        issue([...path, "value"], "available score requires a value");
      }
      if (score.unavailableReason !== null) {
        issue(
          [...path, "unavailableReason"],
          "available score cannot have an unavailable reason",
        );
      }
      if (score.evidenceIds.length === 0) {
        issue(
          [...path, "evidenceIds"],
          "every available score requires evidence",
        );
      }
      if (
        score.value !== null && scale &&
        (score.value < scale.minimum || score.value > scale.maximum)
      ) issue([...path, "value"], "value is outside caller-supplied scale");
    } else if (
      score.value !== null || score.evidenceIds.length !== 0 ||
      score.unavailableReason === null
    ) issue(path, "unavailable score requires only an unavailable reason");
    score.evidenceIds.forEach((id, evidenceIndex) => {
      const item = evidence.get(id);
      if (!item) {
        issue([...path, "evidenceIds", evidenceIndex], "unknown evidenceId");
      } else if (item.dimension !== score.dimension) {
        issue(
          [...path, "evidenceIds", evidenceIndex],
          "evidence dimension must match score dimension",
        );
      }
    });
  });
});

const ResultScore = z.strictObject({
  dimension: Dimension,
  status: z.enum(["available", "unavailable"]),
  rawValue: z.number().finite().nullable(),
  normalizedValue: z.number().min(0).max(1).nullable(),
  effectiveWeight: z.number().min(0).max(1),
  contribution: z.number().min(0).max(1),
  thresholdMet: z.boolean().nullable(),
  evidenceIds: z.array(Id).max(20),
  unavailableReason: Text.nullable(),
});
/** Validates the immutable output shape produced by response-quality evaluation. */
export const responseQualityOutputSchema = z.strictObject({
  schemaVersion: z.literal(RESPONSE_QUALITY_SCHEMA_VERSION),
  evaluationId: Id,
  evaluatedAt: Timestamp,
  draft: Binding,
  source: Binding,
  reviewer: Binding,
  policy: responseQualityInputSchema.shape.policy,
  evidence: z.array(Evidence).max(120),
  scores: z.array(ResultScore).length(RESPONSE_QUALITY_DIMENSIONS.length),
  overallNormalizedScore: z.number().min(0).max(1),
  result: z.enum(["pass", "review"]),
  reviewReasons: z.array(Text).max(20),
  authority: z.strictObject({
    purpose: z.literal("evaluation_only"),
    sending: z.literal("forbidden"),
    sourceClosure: z.literal("forbidden"),
    userContact: z.literal("forbidden"),
    providerNetworkEffects: z.literal("none"),
    productionEffects: z.literal("none"),
    sideEffects: z.literal("persistence_only"),
  }),
});
/** The fully evaluated, persistence-only response-quality result. */
export type ResponseQualityEvaluation = z.infer<
  typeof responseQualityOutputSchema
>;
/** Validate, normalize, and deterministically evaluate caller-supplied response-quality evidence. */
export function evaluateResponseQuality(
  raw: unknown,
): ResponseQualityEvaluation {
  const input = responseQualityInputSchema.parse(raw);
  const scales = new Map(input.policy.scales.map((x) => [x.dimension, x]));
  const scores = new Map(input.scores.map((x) => [x.dimension, x]));
  const includedWeight = RESPONSE_QUALITY_DIMENSIONS.reduce(
    (sum, dimension) => {
      const score = scores.get(dimension)!;
      const scale = scales.get(dimension)!;
      return sum +
        (score.status === "available" ||
            input.policy.optionalUnavailableTreatment === "score_as_zero"
          ? scale.weight
          : 0);
    },
    0,
  );
  const resultScores = RESPONSE_QUALITY_DIMENSIONS.map((dimension) => {
    const score = scores.get(dimension)!;
    const scale = scales.get(dimension)!;
    const effectiveWeight = includedWeight === 0
      ? 0
      : scale.weight / includedWeight;
    if (score.status === "unavailable") {
      return {
        dimension,
        status: score.status,
        rawValue: null,
        normalizedValue: null,
        effectiveWeight:
          input.policy.optionalUnavailableTreatment === "score_as_zero"
            ? effectiveWeight
            : 0,
        contribution: 0,
        thresholdMet: null,
        evidenceIds: [],
        unavailableReason: score.unavailableReason,
      };
    }
    const ascending = (score.value! - scale.minimum) /
      (scale.maximum - scale.minimum);
    const normalizedValue = scale.preferredDirection === "higher"
      ? ascending
      : 1 - ascending;
    return {
      dimension,
      status: score.status,
      rawValue: score.value,
      normalizedValue,
      effectiveWeight,
      contribution: normalizedValue * effectiveWeight,
      thresholdMet: normalizedValue >= scale.minimumNormalizedScore,
      evidenceIds: [...score.evidenceIds].sort(),
      unavailableReason: null,
    };
  });
  const overallNormalizedScore = resultScores.reduce(
    (sum, score) => sum + score.contribution,
    0,
  );
  const reviewReasons = resultScores.flatMap((score) => {
    const scale = scales.get(score.dimension)!;
    if (score.status === "unavailable" && scale.required) {
      return [`required dimension unavailable: ${score.dimension}`];
    }
    if (score.thresholdMet === false) {
      return [`dimension below policy threshold: ${score.dimension}`];
    }
    return [];
  });
  if (overallNormalizedScore < input.policy.overallMinimumNormalizedScore) {
    reviewReasons.push("overall score below policy threshold");
  }
  return responseQualityOutputSchema.parse({
    ...input,
    scores: resultScores,
    overallNormalizedScore,
    result: reviewReasons.length === 0 ? "pass" as const : "review" as const,
    reviewReasons,
    authority: {
      purpose: "evaluation_only" as const,
      sending: "forbidden" as const,
      sourceClosure: "forbidden" as const,
      userContact: "forbidden" as const,
      providerNetworkEffects: "none" as const,
      productionEffects: "none" as const,
      sideEffects: "persistence_only" as const,
    },
  });
}
