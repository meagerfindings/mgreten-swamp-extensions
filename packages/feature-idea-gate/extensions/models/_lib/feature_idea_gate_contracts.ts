import { z } from "npm:zod@4";

export const FEATURE_IDEA_GATE_SCHEMA_VERSION = "1.0" as const;
export const FEATURE_IDEA_GATE_CRITERIA = [
  "userEvidence",
  "activeBottleneckAlignment",
  "strategicFit",
  "trustPrivacySafety",
  "implementationCost",
  "reversibility",
] as const;

const Id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
const Text = z.string().trim().min(1);
const Timestamp = z.iso.datetime({ offset: true });
const Criterion = z.enum(FEATURE_IDEA_GATE_CRITERIA);
const EvidenceType = z.string().trim().min(1).max(100);

export const sourceReferenceSchema = z.strictObject({
  sourceId: Id,
  source: z.strictObject({
    system: Text.max(100),
    resourceType: Text.max(100),
    resourceId: Id,
  }),
  provenance: z.strictObject({
    collector: Text.max(100),
    method: Text.max(100),
    collectedAt: Timestamp,
  }),
  observedAt: Timestamp,
  freshness: z.strictObject({ asOf: Timestamp, expiresAt: Timestamp }),
  sensitivity: z.enum(["public", "internal", "confidential", "restricted"]),
}).superRefine((value, context) => {
  const observed = Date.parse(value.observedAt);
  const asOf = Date.parse(value.freshness.asOf);
  const expires = Date.parse(value.freshness.expiresAt);
  const collected = Date.parse(value.provenance.collectedAt);
  if (observed > asOf) {
    context.addIssue({
      code: "custom",
      path: ["freshness", "asOf"],
      message: "asOf must be at or after observedAt",
    });
  }
  if (asOf > expires) {
    context.addIssue({
      code: "custom",
      path: ["freshness", "expiresAt"],
      message: "expiresAt must be at or after asOf",
    });
  }
  if (collected < observed) {
    context.addIssue({
      code: "custom",
      path: ["provenance", "collectedAt"],
      message: "collectedAt must be at or after observedAt",
    });
  }
});

const evidenceSchema = z.strictObject({
  evidenceId: Id,
  evidenceLink: z.url(),
  evidenceType: EvidenceType,
  claim: Text.max(1_000),
  independenceKey: Id.nullable(),
  sourceReference: sourceReferenceSchema,
});
const scaleSchema = z.strictObject({
  criterion: Criterion,
  minimum: z.number().finite(),
  maximum: z.number().finite(),
  preferredDirection: z.enum(["higher", "lower"]),
  normalization: z.literal("linear_min_max"),
  weight: z.number().finite().nonnegative(),
});
const candidateSchema = z.strictObject({
  candidateId: Id,
  title: Text.max(300),
  description: z.string().max(5_000),
  taskUrl: z.url(),
  labels: z.array(Text).min(1),
});

const requiredEvidenceTypesSchema = z.object(
  Object.fromEntries(
    FEATURE_IDEA_GATE_CRITERIA.map((
      criterion,
    ) => [criterion, z.array(EvidenceType).min(1)]),
  ) as Record<
    typeof FEATURE_IDEA_GATE_CRITERIA[number],
    z.ZodArray<typeof EvidenceType>
  >,
).strict();

export const featureIdeaGateInputSchema = z.strictObject({
  schemaVersion: z.literal(FEATURE_IDEA_GATE_SCHEMA_VERSION),
  gateId: Id,
  evaluatedAt: Timestamp,
  period: z.strictObject({ startAt: Timestamp, endAt: Timestamp }),
  activeBottleneck: z.strictObject({
    title: Text.max(300),
    evidenceIds: z.array(Id).min(1),
  }),
  policy: z.strictObject({
    scales: z.array(scaleSchema).length(FEATURE_IDEA_GATE_CRITERIA.length),
    requiredEvidenceTypes: requiredEvidenceTypesSchema,
    requiredCandidateLabels: z.array(Text.max(100)).min(1).max(20),
    missingData: z.literal("ineligible"),
    minimumScore: z.number().finite().min(0).max(1),
    minimumIndependentUserSignals: z.number().int().positive(),
    promotionLimit: z.literal(1),
    tieBreak: z.literal("candidate_id_ascending"),
  }),
  evidence: z.array(evidenceSchema).min(1).max(200),
  candidates: z.array(candidateSchema).min(1).max(50),
}).superRefine((input, context) => {
  const add = (path: PropertyKey[], message: string) =>
    context.addIssue({ code: "custom", path, message });
  if (Date.parse(input.period.endAt) < Date.parse(input.period.startAt)) {
    add(["period", "endAt"], "period endAt must be at or after startAt");
  }
  if (Date.parse(input.period.endAt) > Date.parse(input.evaluatedAt)) {
    add(["period", "endAt"], "period cannot end after evaluatedAt");
  }
  const evidence = new Map<string, z.infer<typeof evidenceSchema>>();
  input.evidence.forEach((item, index) => {
    if (evidence.has(item.evidenceId)) {
      add(["evidence", index, "evidenceId"], "duplicate evidenceId");
    }
    evidence.set(item.evidenceId, item);
    if (item.evidenceType === "user-signal" && item.independenceKey === null) {
      add(
        ["evidence", index, "independenceKey"],
        "user signals require an independenceKey",
      );
    }
    if (item.evidenceType !== "user-signal" && item.independenceKey !== null) {
      add(
        ["evidence", index, "independenceKey"],
        "only user signals may declare an independenceKey",
      );
    }
    if (
      Date.parse(item.sourceReference.freshness.asOf) >
        Date.parse(input.evaluatedAt)
    ) add(["evidence", index], "evidence must be available by evaluatedAt");
    if (
      Date.parse(item.sourceReference.provenance.collectedAt) >
        Date.parse(input.evaluatedAt)
    ) add(["evidence", index], "evidence must be collected by evaluatedAt");
    if (
      Date.parse(item.sourceReference.freshness.expiresAt) <
        Date.parse(input.evaluatedAt)
    ) add(["evidence", index], "evidence must be fresh at evaluatedAt");
  });
  input.activeBottleneck.evidenceIds.forEach((id, index) => {
    if (evidence.get(id)?.evidenceType !== "active-bottleneck") {
      add(
        ["activeBottleneck", "evidenceIds", index],
        "active bottleneck requires preserved active-bottleneck evidence",
      );
    }
  });
  FEATURE_IDEA_GATE_CRITERIA.forEach((criterion) => {
    if (
      input.policy.scales.filter((scale) => scale.criterion === criterion)
        .length !== 1
    ) add(["policy", "scales"], `exactly one ${criterion} scale is required`);
  });
  input.policy.scales.forEach((scale, index) => {
    if (scale.maximum <= scale.minimum) {
      add(["policy", "scales", index], "maximum must exceed minimum");
    }
  });
  if (input.policy.scales.every((scale) => scale.weight === 0)) {
    add(["policy", "scales"], "at least one weight must be positive");
  }
  const candidates = new Set<string>();
  input.candidates.forEach((candidate, index) => {
    if (candidates.has(candidate.candidateId)) {
      add(["candidates", index, "candidateId"], "duplicate candidateId");
    }
    candidates.add(candidate.candidateId);
    input.policy.requiredCandidateLabels.forEach((label) => {
      if (!candidate.labels.includes(label)) {
        add(
          ["candidates", index, "labels"],
          `candidate requires policy label ${label}`,
        );
      }
    });
  });
});

const ratingSchema = z.strictObject({
  criterion: Criterion,
  value: z.number().finite().nullable(),
  evidenceIds: z.array(Id),
  missingReason: Text.max(500).nullable(),
});
const assessmentSchema = z.strictObject({
  candidateId: Id,
  conciseRationale: Text.max(600),
  ratings: z.array(ratingSchema).length(FEATURE_IDEA_GATE_CRITERIA.length),
  trustPrivacyBlocker: z.strictObject({
    blocked: z.boolean(),
    reason: Text.max(500).nullable(),
    evidenceIds: z.array(Id),
  }),
  unknowns: z.array(Text.max(300)).max(10),
});
export const featureIdeaGateAgentOutputSchema = z.strictObject({
  schemaVersion: z.literal(FEATURE_IDEA_GATE_SCHEMA_VERSION),
  gateId: Id,
  generatedAt: Timestamp,
  assessments: z.array(assessmentSchema).min(1).max(50),
  authority: z.strictObject({
    disposition: z.literal("recommendation-only"),
    sideEffects: z.literal("none"),
    mayApprove: z.literal(false),
    mayPlan: z.literal(false),
    mayExecute: z.literal(false),
  }),
});
const criterionResultSchema = z.strictObject({
  criterion: Criterion,
  rawValue: z.number().finite().nullable(),
  normalizedValue: z.number().min(0).max(1).nullable(),
  effectiveWeight: z.number().finite().nonnegative(),
  contribution: z.number().finite(),
  evidenceIds: z.array(Id),
  missingReason: Text.nullable(),
});
export const featureIdeaGateEvaluationSchema = z.strictObject({
  schemaVersion: z.literal(FEATURE_IDEA_GATE_SCHEMA_VERSION),
  gateId: Id,
  evaluatedAt: Timestamp,
  ranking: z.array(z.strictObject({
    rank: z.number().int().positive(),
    candidateId: Id,
    title: Text,
    score: z.number().finite().min(0).max(1),
    eligible: z.boolean(),
    ineligibilityReasons: z.array(Text),
    conciseRationale: Text,
    criteria: z.array(criterionResultSchema),
    unknowns: z.array(Text),
  })),
  recommendation: z.discriminatedUnion("disposition", [
    z.strictObject({
      disposition: z.literal("promote_one"),
      candidateId: Id,
      rationale: Text,
      ownerChoices: z.tuple([
        z.literal("approve_promotion"),
        z.literal("reject_promotion"),
        z.literal("keep_all_parked"),
      ]),
    }),
    z.strictObject({
      disposition: z.literal("keep_all_parked"),
      candidateId: z.null(),
      rationale: Text,
      ownerChoices: z.tuple([z.literal("keep_all_parked")]),
    }),
  ]),
  authority: z.strictObject({
    disposition: z.literal("recommendation-only"),
    sideEffects: z.literal("none"),
    promotedAutomatically: z.literal(false),
    plansCreated: z.literal(false),
  }),
});
export type FeatureIdeaGateInput = z.infer<typeof featureIdeaGateInputSchema>;
export type FeatureIdeaGateAgentOutput = z.infer<
  typeof featureIdeaGateAgentOutputSchema
>;
export type FeatureIdeaGateEvaluation = z.infer<
  typeof featureIdeaGateEvaluationSchema
>;

export function evaluateFeatureIdeas(
  rawInput: unknown,
  rawOutput: unknown,
): FeatureIdeaGateEvaluation {
  const input = featureIdeaGateInputSchema.parse(rawInput);
  const output = featureIdeaGateAgentOutputSchema.parse(rawOutput);
  if (output.gateId !== input.gateId) {
    throw new TypeError("Agent output gateId must match input gateId");
  }
  if (Date.parse(output.generatedAt) < Date.parse(input.evaluatedAt)) {
    throw new TypeError("Agent output generatedAt cannot predate evaluatedAt");
  }
  const evidence = new Map(
    input.evidence.map((item) => [item.evidenceId, item]),
  );
  const candidates = new Map(
    input.candidates.map((item) => [item.candidateId, item]),
  );
  const assessments = new Map<string, z.infer<typeof assessmentSchema>>();
  output.assessments.forEach((assessment) => {
    if (!candidates.has(assessment.candidateId)) {
      throw new TypeError(
        `Assessment references unknown candidate: ${assessment.candidateId}`,
      );
    }
    if (assessments.has(assessment.candidateId)) {
      throw new TypeError(
        `Duplicate candidate assessment: ${assessment.candidateId}`,
      );
    }
    assessments.set(assessment.candidateId, assessment);
  });
  if (assessments.size !== candidates.size) {
    throw new TypeError(
      "Agent output must assess every candidate exactly once",
    );
  }
  const scales = new Map(
    input.policy.scales.map((scale) => [scale.criterion, scale]),
  );
  const totalWeight = input.policy.scales.reduce(
    (sum, scale) => sum + scale.weight,
    0,
  );
  const ranking = input.candidates.map((candidate) => {
    const assessment = assessments.get(candidate.candidateId)!;
    const ratings = new Map<string, z.infer<typeof ratingSchema>>();
    assessment.ratings.forEach((rating) => {
      if (ratings.has(rating.criterion)) {
        throw new TypeError(
          `Duplicate ${rating.criterion} rating for ${candidate.candidateId}`,
        );
      }
      ratings.set(rating.criterion, rating);
    });
    if (ratings.size !== FEATURE_IDEA_GATE_CRITERIA.length) {
      throw new TypeError(
        `Every criterion must be rated for ${candidate.candidateId}`,
      );
    }
    const reasons: string[] = [];
    const criteria = FEATURE_IDEA_GATE_CRITERIA.map((criterion) => {
      const rating = ratings.get(criterion)!;
      const scale = scales.get(criterion)!;
      if (rating.value === null) {
        if (rating.missingReason === null || rating.evidenceIds.length) {
          throw new TypeError(
            `Missing ${criterion} rating requires only a missingReason`,
          );
        }
        reasons.push(`Missing ${criterion}: ${rating.missingReason}`);
        return {
          criterion,
          rawValue: null,
          normalizedValue: null,
          effectiveWeight: scale.weight / totalWeight,
          contribution: 0,
          evidenceIds: [],
          missingReason: rating.missingReason,
        };
      }
      if (rating.missingReason !== null || !rating.evidenceIds.length) {
        throw new TypeError(
          `Present ${criterion} rating requires evidence and no missingReason`,
        );
      }
      if (rating.value < scale.minimum || rating.value > scale.maximum) {
        throw new TypeError(
          `${criterion} rating must be within the explicit scale`,
        );
      }
      const cited = rating.evidenceIds.map((id) => {
        const item = evidence.get(id);
        if (!item) {
          throw new TypeError(`Rating references unknown evidence: ${id}`);
        }
        return item;
      });
      if (
        !cited.some((item) =>
          input.policy.requiredEvidenceTypes[criterion].includes(
            item.evidenceType,
          )
        )
      ) throw new TypeError(`${criterion} rating lacks required evidence type`);
      const normalizedValue = scale.preferredDirection === "higher"
        ? (rating.value - scale.minimum) / (scale.maximum - scale.minimum)
        : 1 - (rating.value - scale.minimum) / (scale.maximum - scale.minimum);
      const effectiveWeight = scale.weight / totalWeight;
      return {
        criterion,
        rawValue: rating.value,
        normalizedValue,
        effectiveWeight,
        contribution: normalizedValue * effectiveWeight,
        evidenceIds: [...new Set(rating.evidenceIds)].sort(),
        missingReason: null,
      };
    });
    const blocker = assessment.trustPrivacyBlocker;
    if (blocker.blocked) {
      if (blocker.reason === null || !blocker.evidenceIds.length) {
        throw new TypeError(
          "A trust/privacy blocker requires a reason and evidence",
        );
      }
      blocker.evidenceIds.forEach((id) => {
        if (evidence.get(id)?.evidenceType !== "trust-privacy") {
          throw new TypeError(
            "Trust/privacy blocker must cite trust-privacy evidence",
          );
        }
      });
      reasons.push(`Trust/privacy blocker: ${blocker.reason}`);
    } else if (blocker.reason !== null || blocker.evidenceIds.length) {
      throw new TypeError(
        "An unblocked trust/privacy assessment cannot claim blocker details",
      );
    }
    const signals = new Set(
      ratings.get("userEvidence")!.evidenceIds.map((id) => evidence.get(id))
        .filter((
          item,
        ) => item?.evidenceType === "user-signal").map((item) =>
          item!.independenceKey!
        ),
    );
    if (signals.size < input.policy.minimumIndependentUserSignals) {
      reasons.push(
        `Only ${signals.size} independent user signal(s); ${input.policy.minimumIndependentUserSignals} required`,
      );
    }
    const score = criteria.reduce((sum, item) => sum + item.contribution, 0);
    if (score < input.policy.minimumScore) {
      reasons.push(
        `Score ${score.toFixed(4)} is below minimum ${
          input.policy.minimumScore.toFixed(4)
        }`,
      );
    }
    return {
      candidateId: candidate.candidateId,
      title: candidate.title,
      score,
      eligible: !reasons.length,
      ineligibilityReasons: reasons,
      conciseRationale: assessment.conciseRationale,
      criteria,
      unknowns: assessment.unknowns,
    };
  }).sort((left, right) =>
    Number(right.eligible) - Number(left.eligible) ||
    right.score - left.score ||
    left.candidateId.localeCompare(right.candidateId)
  ).map((candidate, index) => ({ rank: index + 1, ...candidate }));
  const winner = ranking.find((candidate) => candidate.eligible);
  return featureIdeaGateEvaluationSchema.parse({
    schemaVersion: FEATURE_IDEA_GATE_SCHEMA_VERSION,
    gateId: input.gateId,
    evaluatedAt: input.evaluatedAt,
    ranking,
    recommendation: winner
      ? {
        disposition: "promote_one",
        candidateId: winner.candidateId,
        rationale: winner.conciseRationale,
        ownerChoices: [
          "approve_promotion",
          "reject_promotion",
          "keep_all_parked",
        ],
      }
      : {
        disposition: "keep_all_parked",
        candidateId: null,
        rationale:
          "No candidate satisfied the evidence, trust/privacy, completeness, and score gates.",
        ownerChoices: ["keep_all_parked"],
      },
    authority: {
      disposition: "recommendation-only",
      sideEffects: "none",
      promotedAutomatically: false,
      plansCreated: false,
    },
  });
}
