import { z } from "npm:zod@4";
import { normalizedSignalSchema } from "./signal_contracts.ts";

export const REPEATED_FRICTION_SCHEMA_VERSION = "1.0" as const;
export const REPEATED_FRICTION_LIMITS = {
  categories: 20,
  signals: 200,
  groups: 100,
} as const;

const Id = z.string().trim().min(1).max(200);
const Timestamp = z.iso.datetime({ offset: true });
const Sensitivity = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
]);
const compare = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;
const unique = (values: string[], context: z.RefinementCtx) => {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: "duplicate identity",
      });
    }
    seen.add(value);
  });
};

const categoryPolicySchema = z.strictObject({
  category: Id,
  minimumSignalCount: z.number().int().positive().max(
    REPEATED_FRICTION_LIMITS.signals,
  ),
  minimumAbandonmentCount: z.number().int().nonnegative().max(
    REPEATED_FRICTION_LIMITS.signals,
  ),
  minimumDistinctSourceIdentities: z.number().int().positive().max(
    REPEATED_FRICTION_LIMITS.signals,
  ),
  minimumSignalConfidence: z.number().finite().min(0).max(1),
});

const frictionSignalSchema = z.strictObject({
  experienceId: Id,
  sourceIdentity: z.strictObject({ sourceId: Id, sourceRecordId: Id }),
  groupKey: Id,
  abandonment: z.boolean(),
  signal: normalizedSignalSchema,
});

export const repeatedFrictionInputSchema = z.strictObject({
  schemaVersion: z.literal(REPEATED_FRICTION_SCHEMA_VERSION),
  evaluationId: Id,
  evaluatedAt: Timestamp,
  policy: z.strictObject({
    categories: z.array(categoryPolicySchema).min(1).max(
      REPEATED_FRICTION_LIMITS.categories,
    ),
    lookback: z.strictObject({ startsAt: Timestamp, endsAt: Timestamp }),
    freshness: z.strictObject({
      requireAvailableByEvaluation: z.boolean(),
      requireUnexpiredAtEvaluation: z.boolean(),
      allowedSensitivities: z.array(Sensitivity).min(1).max(4).superRefine(
        unique,
      ),
    }),
    ordering: z.literal("category_group_key_ascending"),
  }),
  signals: z.array(frictionSignalSchema).max(REPEATED_FRICTION_LIMITS.signals),
}).superRefine((input, context) => {
  const add = (path: PropertyKey[], message: string) =>
    context.addIssue({ code: "custom", path, message });
  if (
    Date.parse(input.policy.lookback.startsAt) >
      Date.parse(input.policy.lookback.endsAt)
  ) add(["policy", "lookback"], "startsAt must not follow endsAt");
  if (
    Date.parse(input.policy.lookback.endsAt) > Date.parse(input.evaluatedAt)
  ) {
    add(
      ["policy", "lookback", "endsAt"],
      "lookback cannot end after evaluatedAt",
    );
  }
  unique(input.policy.categories.map((item) => item.category), context);
  unique(input.signals.map((item) => item.experienceId), context);
  unique(input.signals.map((item) => item.signal.signalId), context);
  input.signals.forEach((item, index) => {
    if (
      !input.policy.categories.some((policy) =>
        policy.category === item.signal.category
      )
    ) {
      add(
        ["signals", index, "signal", "category"],
        "signal category requires an explicit category policy",
      );
    }
    if (item.sourceIdentity.sourceId !== item.signal.sourceReference.sourceId) {
      add(
        ["signals", index, "sourceIdentity", "sourceId"],
        "source identity must preserve signal sourceId",
      );
    }
    if (
      item.signal.sourceReference.observedAt !==
        item.signal.recurrence.lastObservedAt
    ) {
      add(
        ["signals", index, "signal", "recurrence", "lastObservedAt"],
        "lastObservedAt must match the preserved source observation",
      );
    }
    if (
      item.sourceIdentity.sourceRecordId !==
        item.signal.sourceReference.source.resourceId
    ) {
      add(
        ["signals", index, "sourceIdentity", "sourceRecordId"],
        "source identity must preserve the signal source resourceId",
      );
    }
  });
});

const preservedSignalSchema = frictionSignalSchema.extend({
  eligibility: z.strictObject({
    inLookback: z.boolean(),
    available: z.boolean(),
    fresh: z.boolean(),
    sensitivityAllowed: z.boolean(),
    confidenceMet: z.boolean(),
    eligible: z.boolean(),
  }),
});
const groupSchema = z.strictObject({
  category: Id,
  groupKey: Id,
  state: z.enum(["repeated", "insufficient_evidence"]),
  signalCount: z.number().int().nonnegative(),
  abandonmentCount: z.number().int().nonnegative(),
  distinctSourceIdentityCount: z.number().int().nonnegative(),
  experienceIds: z.array(Id).superRefine(unique),
  signalIds: z.array(Id).superRefine(unique),
  sourceIdentities: z.array(
    z.strictObject({ sourceId: Id, sourceRecordId: Id }),
  ),
  threshold: categoryPolicySchema,
  queueDisposition: z.enum(["recommend_for_evidence_queue", "do_not_queue"]),
});

export const repeatedFrictionOutputSchema = z.strictObject({
  schemaVersion: z.literal(REPEATED_FRICTION_SCHEMA_VERSION),
  evaluationId: Id,
  evaluatedAt: Timestamp,
  policy: repeatedFrictionInputSchema.shape.policy,
  preservedSignals: z.array(preservedSignalSchema).max(
    REPEATED_FRICTION_LIMITS.signals,
  ),
  categoryStates: z.array(
    z.strictObject({
      category: Id,
      state: z.enum([
        "evaluated",
        "unavailable_no_signals",
        "unavailable_no_eligible_signals",
      ]),
    }),
  ),
  groups: z.array(groupSchema).max(REPEATED_FRICTION_LIMITS.groups),
  authority: z.strictObject({
    disposition: z.literal("recommendation/evidence-queue-only"),
    sideEffects: z.literal("none"),
    mayCommunicate: z.literal(false),
    mayCloseSources: z.literal(false),
    mayMergeExperiences: z.literal(false),
    mayUseNetwork: z.literal(false),
    mayInvokeProviders: z.literal(false),
    mayAffectProduction: z.literal(false),
  }),
});
export type RepeatedFrictionOutput = z.infer<
  typeof repeatedFrictionOutputSchema
>;

export function detectRepeatedFriction(raw: unknown): RepeatedFrictionOutput {
  const input = repeatedFrictionInputSchema.parse(raw);
  const evaluatedAt = Date.parse(input.evaluatedAt);
  const start = Date.parse(input.policy.lookback.startsAt);
  const end = Date.parse(input.policy.lookback.endsAt);
  const preservedSignals = input.signals.map((item) => {
    const observed = Date.parse(item.signal.sourceReference.observedAt);
    const asOf = Date.parse(item.signal.sourceReference.freshness.asOf);
    const expires = Date.parse(item.signal.sourceReference.freshness.expiresAt);
    const threshold = input.policy.categories.find((policy) =>
      policy.category === item.signal.category
    )!;
    const eligibility = {
      inLookback: observed >= start && observed <= end,
      available: asOf <= evaluatedAt,
      fresh: expires >= evaluatedAt,
      sensitivityAllowed: input.policy.freshness.allowedSensitivities.includes(
        item.signal.sourceReference.sensitivity,
      ),
      confidenceMet:
        item.signal.confidence >= threshold.minimumSignalConfidence,
      eligible: false,
    };
    eligibility.eligible = eligibility.inLookback &&
      eligibility.confidenceMet &&
      eligibility.sensitivityAllowed &&
      (!input.policy.freshness.requireAvailableByEvaluation ||
        eligibility.available) &&
      (!input.policy.freshness.requireUnexpiredAtEvaluation ||
        eligibility.fresh);
    return { ...item, eligibility };
  }).sort((a, b) =>
    compare(a.signal.category, b.signal.category) ||
    compare(a.groupKey, b.groupKey) ||
    compare(a.experienceId, b.experienceId) ||
    compare(a.signal.signalId, b.signal.signalId)
  );
  const groups: RepeatedFrictionOutput["groups"] = [];
  for (
    const threshold of [...input.policy.categories].sort((a, b) =>
      compare(a.category, b.category)
    )
  ) {
    const keys = [
      ...new Set(
        preservedSignals.filter((item) =>
          item.signal.category === threshold.category
        ).map((item) => item.groupKey),
      ),
    ].sort();
    for (const groupKey of keys) {
      const items = preservedSignals.filter((item) =>
        item.signal.category === threshold.category &&
        item.groupKey === groupKey && item.eligibility.eligible
      );
      if (items.length === 0) continue;
      const sourceIdentities = [
        ...new Map(
          items.map((
            item,
          ) => [
            `${item.sourceIdentity.sourceId}\u0000${item.sourceIdentity.sourceRecordId}`,
            item.sourceIdentity,
          ]),
        ).values(),
      ].sort((a, b) =>
        compare(a.sourceId, b.sourceId) ||
        compare(a.sourceRecordId, b.sourceRecordId)
      );
      const repeated = items.length >= threshold.minimumSignalCount &&
        items.filter((item) => item.abandonment).length >=
          threshold.minimumAbandonmentCount &&
        sourceIdentities.length >= threshold.minimumDistinctSourceIdentities;
      groups.push({
        category: threshold.category,
        groupKey,
        state: repeated ? "repeated" : "insufficient_evidence",
        signalCount: items.length,
        abandonmentCount: items.filter((item) => item.abandonment).length,
        distinctSourceIdentityCount: sourceIdentities.length,
        experienceIds: items.map((item) => item.experienceId).sort(),
        signalIds: items.map((item) => item.signal.signalId).sort(),
        sourceIdentities,
        threshold,
        queueDisposition: repeated
          ? "recommend_for_evidence_queue"
          : "do_not_queue",
      });
    }
  }
  if (groups.length > REPEATED_FRICTION_LIMITS.groups) {
    throw new TypeError(
      `group output exceeds ${REPEATED_FRICTION_LIMITS.groups}`,
    );
  }
  const categoryStates = [...input.policy.categories].sort((a, b) =>
    compare(a.category, b.category)
  ).map(({ category }) => {
    const all = preservedSignals.filter((item) =>
      item.signal.category === category
    );
    return {
      category,
      state: all.length === 0
        ? "unavailable_no_signals" as const
        : all.some((item) => item.eligibility.eligible)
        ? "evaluated" as const
        : "unavailable_no_eligible_signals" as const,
    };
  });
  return repeatedFrictionOutputSchema.parse({
    schemaVersion: REPEATED_FRICTION_SCHEMA_VERSION,
    evaluationId: input.evaluationId,
    evaluatedAt: input.evaluatedAt,
    policy: input.policy,
    preservedSignals,
    categoryStates,
    groups,
    authority: {
      disposition: "recommendation/evidence-queue-only",
      sideEffects: "none",
      mayCommunicate: false,
      mayCloseSources: false,
      mayMergeExperiences: false,
      mayUseNetwork: false,
      mayInvokeProviders: false,
      mayAffectProduction: false,
    },
  });
}
