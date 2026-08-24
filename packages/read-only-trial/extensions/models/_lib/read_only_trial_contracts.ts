import { z } from "npm:zod@4";

export const READ_ONLY_TRIAL_SCHEMA_VERSION = "1.0" as const;

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/);
const Timestamp = z.iso.datetime({ offset: true });
const EvidenceRefs = z.array(Id).min(1).max(100);
const Source = Id;

const readinessSchema = z.strictObject({
  source: Source,
  registered: z.literal(true),
  approved: z.literal(true),
  available: z.literal(true),
  minimized: z.literal(true),
  redacted: z.literal(true),
  rawContentIncluded: z.literal(false),
  restrictedContentIncluded: z.literal(false),
  checkedAt: Timestamp,
  expiresAt: Timestamp,
  evidenceRefs: EvidenceRefs,
});

const coverageSchema = z.discriminatedUnion("status", [
  z.strictObject({
    source: Source,
    status: z.literal("covered"),
    recordsObserved: z.number().int().nonnegative(),
    evidenceRefs: EvidenceRefs,
    unavailableReason: z.null(),
  }),
  z.strictObject({
    source: Source,
    status: z.literal("unavailable"),
    recordsObserved: z.literal(0),
    evidenceRefs: z.array(Id).max(100),
    unavailableReason: z.string().trim().min(1).max(1_000),
  }),
]);

const pulseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("recorded"),
    pulseId: Id,
    deliveredAt: Timestamp,
    evidenceRefs: EvidenceRefs,
    humanReviewed: z.boolean(),
  }),
  z.strictObject({
    status: z.literal("not_recorded"),
    reason: z.string().trim().min(1).max(1_000),
  }),
]);

const observationSchema = z.strictObject({
  day: z.number().int().positive(),
  observedAt: Timestamp,
  sourceCoverage: z.array(coverageSchema).min(1).max(20),
  pulse: pulseSchema,
});

const failureSchema = z.strictObject({
  sequence: z.number().int().positive(),
  occurredAt: Timestamp,
  causeFingerprint: Id,
  evidenceRef: Id,
});

const prohibitedConditionSchema = z.strictObject({
  conditionId: Id,
  occurredAt: Timestamp,
  kind: z.enum([
    "restricted_data_access",
    "restricted_data_dependency",
    "restricted_data_exposure",
    "raw_telemetry_access",
    "unapproved_telemetry_access",
    "untraceable_evidence",
    "new_spending_required",
    "new_spending_incurred",
  ]),
  evidenceRef: Id,
});

const activationSchema = z.strictObject({
  approvalId: Id,
  actor: z.string().regex(/^human:[A-Za-z0-9][A-Za-z0-9_-]*$/),
  approvedAt: Timestamp,
  startsAt: Timestamp,
});

const finalReviewSchema = z.strictObject({
  actor: z.string().regex(/^human:[A-Za-z0-9][A-Za-z0-9_-]*$/),
  reviewedAt: Timestamp,
  disposition: z.enum(["proceed", "revise", "stop"]),
  evidenceRefs: EvidenceRefs,
});

export const readOnlyTrialInputSchema = z.strictObject({
  schemaVersion: z.literal(READ_ONLY_TRIAL_SCHEMA_VERSION),
  trialId: Id,
  durationDays: z.number().int().min(1).max(365),
  evaluatedAt: Timestamp,
  activation: activationSchema.nullable(),
  sourceReadiness: z.array(readinessSchema).min(1).max(20),
  observations: z.array(observationSchema).max(365),
  failures: z.array(failureSchema).max(100),
  prohibitedConditions: z.array(prohibitedConditionSchema).max(100),
  finalReview: finalReviewSchema.nullable(),
}).superRefine((input, context) => {
  const issue = (path: PropertyKey[], message: string) =>
    context.addIssue({ code: "custom", path, message });
  const unique = (
    values: Array<string | number>,
    path: PropertyKey[],
    name: string,
  ) => {
    if (new Set(values).size !== values.length) {
      issue(path, `duplicate ${name}`);
    }
  };
  const sourceNames = input.sourceReadiness.map((source) => source.source)
    .sort();
  unique(sourceNames, ["sourceReadiness"], "source");
  unique(input.observations.map((observation) => observation.day), [
    "observations",
  ], "day");
  unique(
    input.failures.map((failure) => failure.sequence),
    ["failures"],
    "failure sequence",
  );
  unique(input.prohibitedConditions.map((condition) => condition.conditionId), [
    "prohibitedConditions",
  ], "conditionId");
  input.observations.forEach((observation, index) => {
    const coverageNames = observation.sourceCoverage.map((coverage) =>
      coverage.source
    ).sort();
    if (coverageNames.join(",") !== sourceNames.join(",")) {
      issue(
        ["observations", index, "sourceCoverage"],
        "coverage must contain each declared source exactly once",
      );
    }
    unique(
      coverageNames,
      ["observations", index, "sourceCoverage"],
      "coverage source",
    );
  });
  if (!input.activation) {
    if (
      input.observations.length || input.failures.length ||
      input.prohibitedConditions.length || input.finalReview
    ) {
      issue(
        ["activation"],
        "trial evidence requires explicit human activation approval",
      );
    }
    return;
  }
  const startsAt = Date.parse(input.activation.startsAt);
  const endsAt = startsAt + input.durationDays * 86_400_000;
  const evaluatedAt = Date.parse(input.evaluatedAt);
  if (Date.parse(input.activation.approvedAt) > startsAt) {
    issue(["activation", "startsAt"], "trial cannot start before approval");
  }
  if (Date.parse(input.activation.approvedAt) > evaluatedAt) {
    issue(
      ["activation", "approvedAt"],
      "activation approval cannot be later than evaluation",
    );
  }
  input.sourceReadiness.forEach((source, index) => {
    if (
      Date.parse(source.checkedAt) > startsAt ||
      Date.parse(source.checkedAt) > evaluatedAt ||
      Date.parse(source.expiresAt) < endsAt
    ) {
      issue(
        ["sourceReadiness", index],
        "source readiness must be checked by trial start and evaluation, and remain fresh through trial end",
      );
    }
  });
  input.observations.forEach((observation, index) => {
    const observedAt = Date.parse(observation.observedAt);
    if (
      observedAt < startsAt || observedAt >= endsAt ||
      observedAt > Date.parse(input.evaluatedAt)
    ) {
      issue(
        ["observations", index, "observedAt"],
        "observation must fall inside the evaluated trial window",
      );
    }
    if (
      observation.day !== Math.floor((observedAt - startsAt) / 86_400_000) + 1
    ) {
      issue(
        ["observations", index, "day"],
        "day does not match observedAt in the trial window",
      );
    }
    if (
      observation.pulse.status === "recorded" &&
      (Date.parse(observation.pulse.deliveredAt) < observedAt ||
        Date.parse(observation.pulse.deliveredAt) >= endsAt ||
        Date.parse(observation.pulse.deliveredAt) > evaluatedAt)
    ) {
      issue(
        ["observations", index, "pulse", "deliveredAt"],
        "pulse delivery must be between observation and trial end, and no later than evaluation",
      );
    }
  });
  input.failures.forEach((failure, index) => {
    const occurredAt = Date.parse(failure.occurredAt);
    if (failure.sequence !== index + 1) {
      issue(
        ["failures", index, "sequence"],
        "failure sequence must be contiguous",
      );
    }
    if (
      occurredAt < startsAt || occurredAt >= endsAt ||
      occurredAt > Date.parse(input.evaluatedAt)
    ) {
      issue(
        ["failures", index, "occurredAt"],
        "failure must occur inside the evaluated trial window",
      );
    }
    if (
      index > 0 &&
      Date.parse(input.failures[index - 1].occurredAt) >= occurredAt
    ) {
      issue(
        ["failures", index, "occurredAt"],
        "failures must be strictly chronological",
      );
    }
  });
  input.prohibitedConditions.forEach((condition, index) => {
    const occurredAt = Date.parse(condition.occurredAt);
    if (
      occurredAt < startsAt || occurredAt >= endsAt ||
      occurredAt > evaluatedAt
    ) {
      issue(
        ["prohibitedConditions", index, "occurredAt"],
        "prohibited condition must occur inside the evaluated trial window",
      );
    }
  });
  if (
    input.finalReview &&
    (Date.parse(input.finalReview.reviewedAt) < endsAt ||
      Date.parse(input.finalReview.reviewedAt) > Date.parse(input.evaluatedAt))
  ) {
    issue(
      ["finalReview", "reviewedAt"],
      "final review must be after the trial end and no later than evaluation",
    );
  }
});

const authoritySchema = z.strictObject({
  sourceRetrieval: z.literal(false),
  providerInvocation: z.literal(false),
  networkCalls: z.literal(false),
  sourceMutation: z.literal(false),
  productionMutation: z.literal(false),
  externalCommunication: z.literal(false),
  spending: z.literal(false),
  remediation: z.literal(false),
  operationalBindings: z.literal(false),
  sideEffects: z.literal("evaluation_record_persistence_only"),
  activationRequiresHumanApproval: z.literal(true),
});

export const readOnlyTrialEvaluationSchema = z.strictObject({
  schemaVersion: z.literal(READ_ONLY_TRIAL_SCHEMA_VERSION),
  trialId: Id,
  evaluatedAt: Timestamp,
  startsAt: Timestamp.nullable(),
  endsAt: Timestamp.nullable(),
  status: z.enum([
    "not_activated",
    "running",
    "paused",
    "unsuccessful",
    "awaiting_final_review",
    "eligible_to_proceed",
  ]),
  reasons: z.array(z.string().min(1)),
  measurements: z.strictObject({
    observationsRecorded: z.number().int().nonnegative(),
    completeObservations: z.number().int().nonnegative(),
    reviewedPulses: z.number().int().nonnegative(),
    recordsObserved: z.number().int().nonnegative(),
    prohibitedConditions: z.number().int().nonnegative(),
    maximumConsecutiveSameCauseFailures: z.number().int().nonnegative(),
  }),
  authority: authoritySchema,
});

export type ReadOnlyTrialEvaluation = z.infer<
  typeof readOnlyTrialEvaluationSchema
>;

function maximumConsecutiveFailures(
  failures: Array<z.infer<typeof failureSchema>>,
) {
  let maximum = 0, current = 0, prior = "";
  for (const failure of failures) {
    current = failure.causeFingerprint === prior ? current + 1 : 1;
    prior = failure.causeFingerprint;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

/** Evaluates supplied evidence only; it cannot retrieve, invoke, or mutate an external system. */
export function evaluateReadOnlyTrial(raw: unknown): ReadOnlyTrialEvaluation {
  const input = readOnlyTrialInputSchema.parse(raw);
  const authority = {
    sourceRetrieval: false as const,
    providerInvocation: false as const,
    networkCalls: false as const,
    sourceMutation: false as const,
    productionMutation: false as const,
    externalCommunication: false as const,
    spending: false as const,
    remediation: false as const,
    operationalBindings: false as const,
    sideEffects: "evaluation_record_persistence_only" as const,
    activationRequiresHumanApproval: true as const,
  };
  const maximumFailures = maximumConsecutiveFailures(input.failures);
  const completeObservations =
    input.observations.filter((observation) =>
      observation.sourceCoverage.every((coverage) =>
        coverage.status === "covered"
      ) && observation.pulse.status === "recorded"
    ).length;
  const measurements = {
    observationsRecorded: input.observations.length,
    completeObservations,
    reviewedPulses:
      input.observations.filter((observation) =>
        observation.pulse.status === "recorded" &&
        observation.pulse.humanReviewed
      ).length,
    recordsObserved: input.observations.flatMap((observation) =>
      observation.sourceCoverage
    ).reduce((total, coverage) => total + coverage.recordsObserved, 0),
    prohibitedConditions: input.prohibitedConditions.length,
    maximumConsecutiveSameCauseFailures: maximumFailures,
  };
  let status: ReadOnlyTrialEvaluation["status"] = "not_activated";
  const reasons: string[] = [];
  let startsAt: string | null = null, endsAt: string | null = null;
  if (
    !input.activation ||
    Date.parse(input.evaluatedAt) < Date.parse(input.activation.startsAt)
  ) {
    reasons.push(
      "Explicit human activation approval is absent or the approved start has not arrived.",
    );
  } else {
    startsAt = input.activation.startsAt;
    endsAt = new Date(Date.parse(startsAt) + input.durationDays * 86_400_000)
      .toISOString();
    const dependency = input.prohibitedConditions.some((condition) =>
      condition.kind === "restricted_data_dependency"
    );
    if (dependency) {
      status = "unsuccessful";
      reasons.push("The trial requires restricted-data access.");
    } else if (input.prohibitedConditions.length || maximumFailures >= 3) {
      status = "paused";
      reasons.push(
        input.prohibitedConditions.length
          ? "A prohibited condition requires revision."
          : "The trial reached three consecutive failures with the same cause.",
      );
    } else if (Date.parse(input.evaluatedAt) < Date.parse(endsAt)) {
      status = "running";
      reasons.push("The approved observation window is still open.");
    } else if (
      completeObservations !== input.durationDays ||
      measurements.reviewedPulses !== input.durationDays
    ) {
      status = "paused";
      reasons.push(
        "Every trial day requires complete coverage, a pulse, and human review.",
      );
    } else if (!input.finalReview) {
      status = "awaiting_final_review";
      reasons.push("The complete trial record requires final human review.");
    } else if (input.finalReview.disposition === "stop") {
      status = "unsuccessful";
      reasons.push("The human reviewer stopped the trial.");
    } else if (input.finalReview.disposition === "revise") {
      status = "paused";
      reasons.push("The human reviewer requested revision.");
    } else {
      status = "eligible_to_proceed";
      reasons.push(
        "The deterministic trial gate passed; any authority expansion requires separate approval.",
      );
    }
  }
  return readOnlyTrialEvaluationSchema.parse({
    schemaVersion: READ_ONLY_TRIAL_SCHEMA_VERSION,
    trialId: input.trialId,
    evaluatedAt: input.evaluatedAt,
    startsAt,
    endsAt,
    status,
    reasons,
    measurements,
    authority,
  });
}
