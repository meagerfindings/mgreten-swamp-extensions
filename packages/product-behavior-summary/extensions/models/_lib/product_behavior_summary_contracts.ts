/** Generic, aggregate-only product behavior summary schemas and evaluation. @module */
import { z } from "npm:zod@4";

/** Current persisted summary schema version. */
export const PRODUCT_BEHAVIOR_SUMMARY_SCHEMA_VERSION = "1.0" as const;

const text = z.string().trim().min(1).max(500);
const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();

/** Consumer-owned catalog that supplies the application-specific outcome names. */
export const expectedOutcomesSchema = z.array(text.max(100)).min(1).max(100)
  .superRefine(
    (outcomes, context) => {
      outcomes.forEach((outcome, index) => {
        if (outcomes.indexOf(outcome) !== index) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "outcome names must be unique",
          });
        }
      });
    },
  );

const windowSchema = z.strictObject({ startsAt: timestamp, endsAt: timestamp });
/** Aggregate cohort facets accepted as segment dimensions. */
export const PRODUCT_BEHAVIOR_AGGREGATE_DIMENSIONS = [
  "campaign",
  "channel",
  "cohort",
  "country",
  "deviceType",
  "experiment",
  "language",
  "platform",
  "region",
  "subscriptionTier",
  "timeBucket",
  "variant",
] as const;
const aggregateDimensionKeys = new Set<string>(
  PRODUCT_BEHAVIOR_AGGREGATE_DIMENSIONS,
);
const dimensionsSchema = z.record(
  z.string().regex(/^[a-z][A-Za-z]{0,31}$/),
  text.max(100),
).superRefine((dimensions, context) => {
  if (Object.keys(dimensions).length > 12) {
    context.addIssue({
      code: "custom",
      message: "at most 12 aggregate dimensions are allowed",
    });
  }
  Object.keys(dimensions).forEach((key) => {
    if (!aggregateDimensionKeys.has(key)) {
      context.addIssue({
        code: "custom",
        path: [key],
        message: "dimension key is not an allowed aggregate facet",
      });
    }
  });
});
const segmentSchema = z.strictObject({
  name: text,
  dimensions: dimensionsSchema,
});
const sourceSchema = z.strictObject({
  sourceId: text,
  aggregateLevel: z.literal("cohort"),
  containsUserLevelData: z.literal(false),
  method: text,
});
const freshnessSchema = z.strictObject({
  asOf: timestamp,
  expiresAt: timestamp,
});
const privacySchema = z.strictObject({
  minimumCohortSize: z.number().int().positive(),
});
const common = {
  outcome: text,
  numeratorDefinition: text,
  denominatorDefinition: text,
  window: windowSchema,
  segment: segmentSchema,
  source: sourceSchema,
  freshness: freshnessSchema,
  privacy: privacySchema,
  claim: z.strictObject({
    kind: z.literal("descriptive_association"),
    causalClaim: z.literal("none"),
  }),
};

const measuredSchema = z.strictObject({
  status: z.literal("measured"),
  ...common,
  numerator: count,
  denominator: count,
});
const unavailableSchema = z.strictObject({
  status: z.enum(["missing", "unmeasured"]),
  ...common,
  numerator: z.null(),
  denominator: z.null(),
  reason: text,
});
const suppressedSchema = z.strictObject({
  status: z.literal("privacy_suppressed"),
  ...common,
  numerator: z.null(),
  denominator: z.null(),
  reason: text,
});

/** Input schema for one aggregate metric. */
export const productBehaviorMetricSchema = z.discriminatedUnion("status", [
  measuredSchema,
  unavailableSchema,
  suppressedSchema,
])
  .superRefine((value, context) => {
    if (Date.parse(value.window.startsAt) >= Date.parse(value.window.endsAt)) {
      context.addIssue({
        code: "custom",
        path: ["window", "endsAt"],
        message: "endsAt must be after startsAt",
      });
    }
    if (Date.parse(value.freshness.asOf) < Date.parse(value.window.endsAt)) {
      context.addIssue({
        code: "custom",
        path: ["freshness", "asOf"],
        message: "asOf must be at or after the window end",
      });
    }
    if (
      Date.parse(value.freshness.expiresAt) <= Date.parse(value.freshness.asOf)
    ) {
      context.addIssue({
        code: "custom",
        path: ["freshness", "expiresAt"],
        message: "expiresAt must be after asOf",
      });
    }
    if (value.status === "measured") {
      if (value.numerator > value.denominator) {
        context.addIssue({
          code: "custom",
          path: ["numerator"],
          message: "numerator cannot exceed denominator",
        });
      }
      if (value.denominator < value.privacy.minimumCohortSize) {
        context.addIssue({
          code: "custom",
          path: ["denominator"],
          message: "cohorts below minimumCohortSize must be privacy_suppressed",
        });
      }
    }
  });

const summaryShape = z.strictObject({
  schemaVersion: z.literal(PRODUCT_BEHAVIOR_SUMMARY_SCHEMA_VERSION),
  summaryId: text,
  generatedAt: timestamp,
  inputPolicy: z.strictObject({
    aggregateOnly: z.literal(true),
    userLevelIdentifiersAllowed: z.literal(false),
  }),
  sideEffectAuthority: z.literal("none"),
  metrics: z.array(productBehaviorMetricSchema).min(1).max(100),
});

/** Validate a summary against a consumer-owned outcome catalog and calculate deterministic rates. */
export function createProductBehaviorSummarySchema(
  expectedOutcomes: readonly string[],
) {
  const catalog = expectedOutcomesSchema.parse(expectedOutcomes);
  return summaryShape.superRefine((value, context) => {
    const outcomes = value.metrics.map((metric) => metric.outcome);
    catalog.forEach((outcome) => {
      if (outcomes.filter((candidate) => candidate === outcome).length !== 1) {
        context.addIssue({
          code: "custom",
          path: ["metrics"],
          message: `exactly one ${outcome} metric is required`,
        });
      }
    });
    value.metrics.forEach((metric, index) => {
      if (!catalog.includes(metric.outcome)) {
        context.addIssue({
          code: "custom",
          path: ["metrics", index, "outcome"],
          message: "outcome is absent from expectedOutcomes",
        });
      }
      if (Date.parse(value.generatedAt) < Date.parse(metric.freshness.asOf)) {
        context.addIssue({
          code: "custom",
          path: ["metrics", index, "freshness", "asOf"],
          message: "asOf cannot be after generatedAt",
        });
      }
    });
  }).transform((value) => ({
    ...value,
    metrics: catalog.map((outcome) => {
      const metric = value.metrics.find((candidate) =>
        candidate.outcome === outcome
      )!;
      return {
        ...metric,
        result: metric.status === "measured"
          ? metric.denominator === 0
            ? { status: "insufficient_denominator" as const, rate: null }
            : {
              status: "calculated" as const,
              rate: metric.numerator / metric.denominator,
            }
          : { status: metric.status, rate: null },
      };
    }),
  }));
}

const calculatedResultSchema = z.strictObject({
  status: z.literal("calculated"),
  rate: z.number().finite().min(0).max(1),
});
const insufficientResultSchema = z.strictObject({
  status: z.literal("insufficient_denominator"),
  rate: z.null(),
});
const nullResultSchema = (
  status: "missing" | "unmeasured" | "privacy_suppressed",
) => z.strictObject({ status: z.literal(status), rate: z.null() });
const persistedMetricSchema = z.discriminatedUnion("status", [
  measuredSchema.extend({
    result: z.union([calculatedResultSchema, insufficientResultSchema]),
  }),
  z.strictObject({
    status: z.literal("missing"),
    ...common,
    numerator: z.null(),
    denominator: z.null(),
    reason: text,
    result: nullResultSchema("missing"),
  }),
  z.strictObject({
    status: z.literal("unmeasured"),
    ...common,
    numerator: z.null(),
    denominator: z.null(),
    reason: text,
    result: nullResultSchema("unmeasured"),
  }),
  suppressedSchema.extend({ result: nullResultSchema("privacy_suppressed") }),
]);

/** Strict static resource schema; catalog membership is validated at method execution. */
export const productBehaviorSummaryOutputSchema = z.strictObject({
  schemaVersion: z.literal(PRODUCT_BEHAVIOR_SUMMARY_SCHEMA_VERSION),
  summaryId: text,
  generatedAt: timestamp,
  inputPolicy: z.strictObject({
    aggregateOnly: z.literal(true),
    userLevelIdentifiersAllowed: z.literal(false),
  }),
  sideEffectAuthority: z.literal("none"),
  metrics: z.array(persistedMetricSchema).min(1).max(100),
}).superRefine((summary, context) => {
  const input = {
    ...summary,
    metrics: summary.metrics.map(({ result: _result, ...metric }) => metric),
  };
  const expected = summaryShape.safeParse(input);
  if (!expected.success) {
    expected.error.issues.forEach((issue) =>
      context.addIssue({
        code: "custom",
        path: issue.path,
        message: issue.message,
      })
    );
    return;
  }
  summary.metrics.forEach((metric, index) => {
    const result = metric.status === "measured"
      ? metric.denominator === 0
        ? { status: "insufficient_denominator", rate: null }
        : { status: "calculated", rate: metric.numerator / metric.denominator }
      : { status: metric.status, rate: null };
    if (JSON.stringify(metric.result) !== JSON.stringify(result)) {
      context.addIssue({
        code: "custom",
        path: ["metrics", index, "result"],
        message: "persisted result must equal deterministic evaluation",
      });
    }
  });
});

/** Type of a successfully evaluated summary. */
export type ProductBehaviorSummary = z.output<
  ReturnType<typeof createProductBehaviorSummarySchema>
>;
/** Type of one input metric. */
export type ProductBehaviorMetric = z.input<typeof productBehaviorMetricSchema>;

/** Structured validation diagnostic. */
export interface ProductBehaviorDiagnostic {
  path: string;
  code: string;
  message: string;
}
/** Result of deterministic summary validation. */
export type ProductBehaviorValidation =
  | { success: true; value: ProductBehaviorSummary; diagnostics: [] }
  | { success: false; diagnostics: ProductBehaviorDiagnostic[] };

/** Validate input and return sorted diagnostics without throwing. */
export function evaluateProductBehaviorSummary(
  input: unknown,
  expectedOutcomes: readonly string[],
): ProductBehaviorValidation {
  const result = createProductBehaviorSummarySchema(expectedOutcomes).safeParse(
    input,
  );
  if (result.success) {
    return { success: true, value: result.data, diagnostics: [] };
  }
  const diagnostics = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
    message: issue.message,
  })).sort((a, b) =>
    a.path.localeCompare(b.path) || a.code.localeCompare(b.code) ||
    a.message.localeCompare(b.message)
  );
  return { success: false, diagnostics };
}
