import { z } from "npm:zod@4";

export const SIGNAL_SCHEMA_VERSION = "1.0" as const;

const timestampSchema = z.iso.datetime({ offset: true });
const identifierSchema = z.string().trim().min(1);

export const sourceReferenceSchema = z.strictObject({
  schemaVersion: z.literal(SIGNAL_SCHEMA_VERSION),
  sourceId: identifierSchema,
  source: z.strictObject({
    system: identifierSchema,
    accountId: identifierSchema.optional(),
    resourceType: identifierSchema,
    resourceId: identifierSchema,
  }),
  provenance: z.strictObject({
    collector: identifierSchema,
    collectorVersion: identifierSchema,
    method: identifierSchema,
    collectedAt: timestampSchema,
  }),
  observedAt: timestampSchema,
  freshness: z.strictObject({
    asOf: timestampSchema,
    expiresAt: timestampSchema,
  }),
  sensitivity: z.enum(["public", "internal", "confidential", "restricted"]),
}).superRefine((reference, context) => {
  const observedAt = Date.parse(reference.observedAt);
  const asOf = Date.parse(reference.freshness.asOf);
  const expiresAt = Date.parse(reference.freshness.expiresAt);
  const collectedAt = Date.parse(reference.provenance.collectedAt);

  if (observedAt > asOf) {
    context.addIssue({
      code: "custom",
      path: ["freshness", "asOf"],
      message: "asOf must be at or after observedAt",
    });
  }
  if (asOf > expiresAt) {
    context.addIssue({
      code: "custom",
      path: ["freshness", "expiresAt"],
      message: "expiresAt must be at or after asOf",
    });
  }
  if (collectedAt < observedAt) {
    context.addIssue({
      code: "custom",
      path: ["provenance", "collectedAt"],
      message: "collectedAt must be at or after observedAt",
    });
  }
});

export type SourceReference = z.infer<typeof sourceReferenceSchema>;

export const normalizedSignalSchema = z.strictObject({
  schemaVersion: z.literal(SIGNAL_SCHEMA_VERSION),
  signalId: identifierSchema,
  sourceReference: sourceReferenceSchema,
  category: identifierSchema,
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  confidence: z.number().finite().min(0).max(1),
  recurrence: z.strictObject({
    kind: z.enum(["once", "intermittent", "recurring", "continuous"]),
    count: z.number().int().positive(),
    firstObservedAt: timestampSchema,
    lastObservedAt: timestampSchema,
  }),
  impact: z.strictObject({
    summary: identifierSchema,
    scope: z.enum(["none", "individual", "team", "organization", "external"]),
    affectedCount: z.number().int().nonnegative().optional(),
  }),
  evidenceLinks: z.array(z.url()).min(1).superRefine((links, context) => {
    const firstIndexes = new Map<string, number>();
    links.forEach((link, index) => {
      const firstIndex = firstIndexes.get(link);
      if (firstIndex === undefined) firstIndexes.set(link, index);
      else {context.addIssue({
          code: "custom",
          path: [index],
          message: `duplicate evidence link (first at index ${firstIndex})`,
        });}
    });
  }),
  recommendedEscalation: z.strictObject({
    action: z.enum(["none", "monitor", "investigate", "notify", "escalate"]),
    urgency: z.enum(["routine", "soon", "immediate"]),
    rationale: identifierSchema,
    target: identifierSchema.optional(),
  }),
}).superRefine((signal, context) => {
  const first = Date.parse(signal.recurrence.firstObservedAt);
  const last = Date.parse(signal.recurrence.lastObservedAt);
  const asOf = Date.parse(signal.sourceReference.freshness.asOf);

  if (first > last) {
    context.addIssue({
      code: "custom",
      path: ["recurrence", "lastObservedAt"],
      message: "lastObservedAt must be at or after firstObservedAt",
    });
  }
  if (last > asOf) {
    context.addIssue({
      code: "custom",
      path: ["recurrence", "lastObservedAt"],
      message: "lastObservedAt must be at or before source freshness asOf",
    });
  }

  const escalation = signal.recommendedEscalation;
  if (escalation.action === "none" && escalation.target !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["recommendedEscalation", "target"],
      message: "target is not allowed when action is none",
    });
  }
  if (
    (escalation.action === "notify" || escalation.action === "escalate") &&
    escalation.target === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["recommendedEscalation", "target"],
      message: `target is required when action is ${escalation.action}`,
    });
  }
});

export type NormalizedSignal = z.infer<typeof normalizedSignalSchema>;

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export type ValidationResult<T> =
  | { valid: true; value: T; issues: [] }
  | { valid: false; issues: ValidationIssue[] };

function validate<T>(
  schema: z.ZodType<T>,
  input: unknown,
): ValidationResult<T> {
  const result = schema.safeParse(input);
  if (result.success) return { valid: true, value: result.data, issues: [] };

  const issues = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
    message: issue.message,
  })).sort((left, right) =>
    left.path.localeCompare(right.path) ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  );
  return { valid: false, issues };
}

export function validateSourceReference(
  input: unknown,
): ValidationResult<SourceReference> {
  return validate(sourceReferenceSchema, input);
}

export function validateNormalizedSignal(
  input: unknown,
): ValidationResult<NormalizedSignal> {
  return validate(normalizedSignalSchema, input);
}
