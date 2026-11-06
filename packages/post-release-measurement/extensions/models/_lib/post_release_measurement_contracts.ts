import { z } from "npm:zod@4";
import { sourceReferenceSchema } from "./signal_contracts.ts";

export const POST_RELEASE_MEASUREMENT_SCHEMA_VERSION = "2.0" as const;

const Id = z.string().trim().min(1).max(200);
const Text = z.string().trim().min(1).max(2_000);
const Timestamp = z.iso.datetime({ offset: true });
const ExactArtifact = z.strictObject({
  id: Id,
  version: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const NextDecision = z.strictObject({
  decision: Text,
  rationale: Text,
});

/** Strict, human-controlled declaration for measuring a specific release. */
export const PostReleaseMeasurementPlan = z.strictObject({
  schemaVersion: z.literal(POST_RELEASE_MEASUREMENT_SCHEMA_VERSION),
  planId: Id,
  releasedArtifact: ExactArtifact,
  workOrder: ExactArtifact,
  releasedAt: Timestamp,
  declaredAt: Timestamp,
  expectedOutcome: z.strictObject({
    statement: Text,
    successCondition: Text,
    failureCondition: Text,
    ambiguityCondition: Text,
  }),
  measurementSource: sourceReferenceSchema,
  observationWindow: z.strictObject({
    startsAt: Timestamp,
    endsAt: Timestamp,
  }),
  nextDecisions: z.strictObject({
    success: NextDecision,
    failure: NextDecision,
    ambiguity: NextDecision,
  }),
  authority: z.strictObject({
    disposition: z.literal("recommendation-only"),
    humanDecisionRequired: z.literal(true),
    mayExecute: z.literal(false),
    productionEffects: z.literal("none"),
  }),
}).superRefine((plan, context) => {
  const releasedAt = Date.parse(plan.releasedAt);
  const declaredAt = Date.parse(plan.declaredAt);
  const startsAt = Date.parse(plan.observationWindow.startsAt);
  const endsAt = Date.parse(plan.observationWindow.endsAt);

  if (declaredAt > releasedAt) {
    context.addIssue({
      code: "custom",
      path: ["declaredAt"],
      message: "measurement plan must be declared no later than release",
    });
  }
  if (startsAt < releasedAt) {
    context.addIssue({
      code: "custom",
      path: ["observationWindow", "startsAt"],
      message: "observation window cannot begin before release",
    });
  }
  if (declaredAt > startsAt) {
    context.addIssue({
      code: "custom",
      path: ["declaredAt"],
      message: "plan must be declared no later than observation start",
    });
  }
  if (endsAt <= startsAt) {
    context.addIssue({
      code: "custom",
      path: ["observationWindow", "endsAt"],
      message: "endsAt must be after startsAt",
    });
  }
  if (Date.parse(plan.measurementSource.observedAt) > declaredAt) {
    context.addIssue({
      code: "custom",
      path: ["measurementSource", "observedAt"],
      message: "measurement source must be known when the plan is declared",
    });
  }
  if (Date.parse(plan.measurementSource.provenance.collectedAt) > declaredAt) {
    context.addIssue({
      code: "custom",
      path: ["measurementSource", "provenance", "collectedAt"],
      message: "measurement source must be collected when the plan is declared",
    });
  }
  if (Date.parse(plan.measurementSource.freshness.asOf) > declaredAt) {
    context.addIssue({
      code: "custom",
      path: ["measurementSource", "freshness", "asOf"],
      message: "measurement source must be available when the plan is declared",
    });
  }
  if (Date.parse(plan.measurementSource.freshness.expiresAt) < endsAt) {
    context.addIssue({
      code: "custom",
      path: ["measurementSource", "freshness", "expiresAt"],
      message: "measurement source freshness must cover the observation window",
    });
  }
});

export type PostReleaseMeasurementPlan = z.infer<
  typeof PostReleaseMeasurementPlan
>;

/** Parses a plan and returns deterministic, path-sorted diagnostics. */
export function validatePostReleaseMeasurementPlan(input: unknown) {
  const result = PostReleaseMeasurementPlan.safeParse(input);
  if (result.success) {
    return { valid: true as const, value: result.data, diagnostics: [] };
  }

  const diagnostics = result.error.issues.slice(0, 32).map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
    message: issue.message.slice(0, 500),
  })).sort((a, b) =>
    a.path.localeCompare(b.path) || a.code.localeCompare(b.code) ||
    a.message.localeCompare(b.message)
  );
  return { valid: false as const, diagnostics };
}
