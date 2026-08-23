/** Contracts and pure scoring algorithm for deterministic bottleneck ranking. */
import { z } from "npm:zod@4";
import { sourceReferenceSchema } from "./source_reference.ts";

/** Version of the ranking input and output contracts. */
export const BOTTLENECK_RANKING_SCHEMA_VERSION = "1.0" as const;
/** Criteria every ranking must score exactly once per candidate. */
export const BOTTLENECK_CRITERIA = [
  "customerValue",
  "confidence",
  "strategicFit",
  "economicValue",
  "risk",
  "effort",
] as const;

const Text = z.string().trim().min(1).max(2_000);
const Id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const Criterion = z.enum(BOTTLENECK_CRITERIA);
const Evidence = z.strictObject({
  evidenceId: Id,
  evidenceLink: z.url().max(2_000),
  observation: Text,
  sourceReference: sourceReferenceSchema,
});
const Scale = z.strictObject({
  criterion: Criterion,
  minimum: z.number().finite(),
  maximum: z.number().finite(),
  preferredDirection: z.enum(["higher", "lower"]),
  normalization: z.literal("linear_min_max"),
  weight: z.number().finite().nonnegative(),
});
const Rating = z.strictObject({
  criterion: Criterion,
  value: z.number().finite().nullable(),
  evidenceIds: z.array(Id).max(100),
  missingReason: Text.nullable(),
});

/** Strict caller-supplied input contract for a ranking operation. */
export const bottleneckRankingInputSchema = z.strictObject({
  schemaVersion: z.literal(BOTTLENECK_RANKING_SCHEMA_VERSION),
  rankingId: Id,
  evaluatedAt: z.iso.datetime({ offset: true }),
  policy: z.strictObject({
    scales: z.array(Scale).length(BOTTLENECK_CRITERIA.length),
    missingData: z.enum(["exclude_and_reweight", "score_as_zero"]),
    tieBreak: z.literal("candidate_id_ascending"),
  }),
  evidence: z.array(Evidence).max(500),
  candidates: z.array(
    z.strictObject({
      candidateId: Id,
      title: Text,
      ratings: z.array(Rating).length(BOTTLENECK_CRITERIA.length),
    }),
  ).min(1).max(200),
}).superRefine((input, context) => {
  const add = (path: PropertyKey[], message: string): void =>
    context.addIssue({ code: "custom", path, message });
  const evidenceIds = new Set<string>();
  input.evidence.forEach((evidence, index) => {
    if (evidenceIds.has(evidence.evidenceId)) {
      add(["evidence", index, "evidenceId"], "duplicate evidenceId");
    }
    evidenceIds.add(evidence.evidenceId);
    if (
      Date.parse(evidence.sourceReference.freshness.asOf) >
        Date.parse(input.evaluatedAt)
    ) {
      add(
        ["evidence", index, "sourceReference", "freshness", "asOf"],
        "evidence must be available by evaluatedAt",
      );
    }
    if (
      Date.parse(evidence.sourceReference.freshness.expiresAt) <
        Date.parse(input.evaluatedAt)
    ) {
      add(
        ["evidence", index, "sourceReference", "freshness", "expiresAt"],
        "evidence must be fresh at evaluatedAt",
      );
    }
  });
  for (const criterion of BOTTLENECK_CRITERIA) {
    if (
      input.policy.scales.filter((scale) => scale.criterion === criterion)
        .length !== 1
    ) add(["policy", "scales"], `exactly one ${criterion} scale is required`);
  }
  input.policy.scales.forEach((scale, index) => {
    if (scale.maximum <= scale.minimum) {
      add(
        ["policy", "scales", index, "maximum"],
        "maximum must exceed minimum",
      );
    }
  });
  if (input.policy.scales.every((scale) => scale.weight === 0)) {
    add(["policy", "scales"], "at least one weight must be positive");
  }
  const candidateIds = new Set<string>();
  input.candidates.forEach((candidate, candidateIndex) => {
    if (candidateIds.has(candidate.candidateId)) {
      add(
        ["candidates", candidateIndex, "candidateId"],
        "duplicate candidateId",
      );
    }
    candidateIds.add(candidate.candidateId);
    for (const criterion of BOTTLENECK_CRITERIA) {
      if (
        candidate.ratings.filter((rating) => rating.criterion === criterion)
          .length !== 1
      ) {
        add(
          ["candidates", candidateIndex, "ratings"],
          `exactly one ${criterion} rating is required`,
        );
      }
    }
    candidate.ratings.forEach((rating, ratingIndex) => {
      const path = ["candidates", candidateIndex, "ratings", ratingIndex];
      const scale = input.policy.scales.find((item) =>
        item.criterion === rating.criterion
      );
      if (rating.value === null && rating.missingReason === null) {
        add([...path, "missingReason"], "missing values require disclosure");
      }
      if (rating.value !== null && rating.missingReason !== null) {
        add(
          [...path, "missingReason"],
          "present values cannot have a missing reason",
        );
      }
      if (rating.value !== null && rating.evidenceIds.length === 0) {
        add([...path, "evidenceIds"], "present ratings require evidence");
      }
      if (rating.value === null && rating.evidenceIds.length > 0) {
        add(
          [...path, "evidenceIds"],
          "missing ratings cannot claim supporting evidence",
        );
      }
      if (
        rating.value !== null && scale &&
        (rating.value < scale.minimum || rating.value > scale.maximum)
      ) add([...path, "value"], "value must be within the explicit scale");
      rating.evidenceIds.forEach((id, evidenceIndex) => {
        if (!evidenceIds.has(id)) {
          add(
            [...path, "evidenceIds", evidenceIndex],
            "evidenceId must reference preserved evidence",
          );
        }
      });
    });
  });
});

const scoredCriterionSchema = z.strictObject({
  criterion: Criterion,
  rawValue: z.number().finite().nullable(),
  normalizedValue: z.number().min(0).max(1).nullable(),
  effectiveWeight: z.number().finite().nonnegative(),
  contribution: z.number().finite(),
  evidenceIds: z.array(Id).max(100),
  missingReason: Text.nullable(),
});
/** Strict output contract, including per-criterion contributions and disclosure. */
export const bottleneckRankingOutputSchema = z.strictObject({
  schemaVersion: z.literal(BOTTLENECK_RANKING_SCHEMA_VERSION),
  rankingId: Id,
  evaluatedAt: z.iso.datetime({ offset: true }),
  policy: bottleneckRankingInputSchema.shape.policy,
  evidence: z.array(Evidence).max(500),
  ranking: z.array(
    z.strictObject({
      rank: z.number().int().positive(),
      candidateId: Id,
      title: Text,
      score: z.number().finite(),
      criteria: z.array(scoredCriterionSchema),
    }),
  ),
  missingDataDisclosure: z.array(
    z.strictObject({ candidateId: Text, criterion: Criterion, reason: Text }),
  ),
  authority: z.strictObject({
    disposition: z.literal("recommendation_only"),
    replacesJudgment: z.literal(false),
    sideEffects: z.literal("none"),
  }),
});

/** A validated ranking result. */
export type BottleneckRanking = z.infer<typeof bottleneckRankingOutputSchema>;

/** Validate, normalize, score, and deterministically order caller-supplied candidates. */
export function rankBottlenecks(raw: unknown): BottleneckRanking {
  const input = bottleneckRankingInputSchema.parse(raw);
  const scales = new Map(
    input.policy.scales.map((scale) => [scale.criterion, scale]),
  );
  const totalWeight = input.policy.scales.reduce(
    (sum, scale) => sum + scale.weight,
    0,
  );
  const missingDataDisclosure: BottleneckRanking["missingDataDisclosure"] = [];
  const scored = input.candidates.map((candidate) => {
    const availableWeight = candidate.ratings.reduce(
      (sum, rating) =>
        sum +
        (rating.value === null ? 0 : scales.get(rating.criterion)!.weight),
      0,
    );
    const criteria = candidate.ratings.map((rating) => {
      const scale = scales.get(rating.criterion)!;
      if (rating.value === null) {
        missingDataDisclosure.push({
          candidateId: candidate.candidateId,
          criterion: rating.criterion,
          reason: rating.missingReason!,
        });
        return {
          criterion: rating.criterion,
          rawValue: null,
          normalizedValue: null,
          effectiveWeight: input.policy.missingData === "score_as_zero"
            ? scale.weight / totalWeight
            : 0,
          contribution: 0,
          evidenceIds: [...rating.evidenceIds].sort(),
          missingReason: rating.missingReason,
        };
      }
      const ascending = (rating.value - scale.minimum) /
        (scale.maximum - scale.minimum);
      const normalizedValue = scale.preferredDirection === "higher"
        ? ascending
        : 1 - ascending;
      const effectiveWeight =
        input.policy.missingData === "exclude_and_reweight"
          ? (availableWeight === 0 ? 0 : scale.weight / availableWeight)
          : scale.weight / totalWeight;
      return {
        criterion: rating.criterion,
        rawValue: rating.value,
        normalizedValue,
        effectiveWeight,
        contribution: normalizedValue * effectiveWeight,
        evidenceIds: [...rating.evidenceIds].sort(),
        missingReason: null,
      };
    }).sort((a, b) =>
      BOTTLENECK_CRITERIA.indexOf(a.criterion) -
      BOTTLENECK_CRITERIA.indexOf(b.criterion)
    );
    return {
      candidateId: candidate.candidateId,
      title: candidate.title,
      score: criteria.reduce((sum, item) => sum + item.contribution, 0),
      criteria,
    };
  }).sort((a, b) =>
    b.score - a.score || a.candidateId.localeCompare(b.candidateId)
  );
  const { candidates: _candidates, ...rankingMetadata } = input;
  return bottleneckRankingOutputSchema.parse({
    ...rankingMetadata,
    ranking: scored.map((candidate, index) => ({
      rank: index + 1,
      ...candidate,
    })),
    missingDataDisclosure: missingDataDisclosure.sort((a, b) =>
      a.candidateId.localeCompare(b.candidateId) ||
      a.criterion.localeCompare(b.criterion)
    ),
    authority: {
      disposition: "recommendation_only",
      replacesJudgment: false,
      sideEffects: "none",
    },
  });
}
