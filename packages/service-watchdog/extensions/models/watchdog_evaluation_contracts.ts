import { z } from "npm:zod@4";

export const WATCHDOG_EVALUATION_SCHEMA_VERSION = "1.0" as const;
const identifier = z.string().trim().min(1);
const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();
const duration = z.strictObject({
  value: z.number().finite().nonnegative(),
  unit: z.enum(["milliseconds", "seconds", "minutes", "hours"]),
});
const unmeasured = z.strictObject({
  status: z.literal("not_measured"),
  reason: identifier,
});
const sourceReference = z.strictObject({
  schemaVersion: z.literal("1.0"),
  sourceId: identifier,
  source: z.strictObject({
    system: identifier,
    accountId: identifier.optional(),
    resourceType: identifier,
    resourceId: identifier,
  }),
  provenance: z.strictObject({
    collector: identifier,
    collectorVersion: identifier,
    method: identifier,
    collectedAt: timestamp,
  }),
  observedAt: timestamp,
  freshness: z.strictObject({ asOf: timestamp, expiresAt: timestamp }),
  sensitivity: z.enum(["public", "internal", "confidential", "restricted"]),
}).superRefine((value, context) => {
  const observedAt = Date.parse(value.observedAt);
  const collectedAt = Date.parse(value.provenance.collectedAt);
  const asOf = Date.parse(value.freshness.asOf);
  const expiresAt = Date.parse(value.freshness.expiresAt);
  if (collectedAt < observedAt) {
    context.addIssue({
      code: "custom",
      path: ["provenance", "collectedAt"],
      message: "collectedAt must be at or after observedAt",
    });
  }
  if (asOf < observedAt) {
    context.addIssue({
      code: "custom",
      path: ["freshness", "asOf"],
      message: "asOf must be at or after observedAt",
    });
  }
  if (expiresAt < asOf) {
    context.addIssue({
      code: "custom",
      path: ["freshness", "expiresAt"],
      message: "expiresAt must be at or after asOf",
    });
  }
});

const evaluationInput = z.strictObject({
  schemaVersion: z.literal(WATCHDOG_EVALUATION_SCHEMA_VERSION),
  evaluationId: identifier,
  watchdogId: identifier,
  observationWindow: z.strictObject({ startsAt: timestamp, endsAt: timestamp }),
  recordedAt: timestamp,
  confusion: z.union([
    z.strictObject({
      status: z.literal("measured"),
      usefulEscalations: count,
      falsePositives: count,
      missedSignals: count,
      correctlyIgnored: count,
      denominators: z.strictObject({
        evaluatedSignals: count,
        escalations: count,
        actionableSignals: count,
      }),
    }),
    unmeasured,
  ]),
  duplicateGrouping: z.union([
    z.strictObject({
      status: z.literal("measured"),
      duplicateAlerts: count,
      correctlyGroupedDuplicates: count,
      incorrectlyGroupedDistinctSignals: count,
      denominators: z.strictObject({
        alertsReviewed: count,
        groupingDecisions: count,
      }),
    }),
    unmeasured,
  ]),
  timeToTriage: z.union([
    z.strictObject({
      status: z.literal("measured"),
      totalTimeToTriage: duration,
      denominators: z.strictObject({ triagedEscalations: count }),
    }),
    unmeasured,
  ]),
  cost: z.union([
    z.strictObject({
      status: z.literal("observed"),
      amount: z.number().finite().nonnegative(),
      currency: z.string().regex(/^[A-Z]{3}$/),
      provenance: sourceReference,
    }),
    unmeasured,
  ]),
  humanAttention: z.union([
    z.strictObject({
      status: z.literal("measured"),
      duration,
      interactionCount: count,
      denominators: z.strictObject({ escalationsRequiringAttention: count }),
    }),
    unmeasured,
  ]),
}).superRefine((value, context) => {
  if (
    Date.parse(value.observationWindow.startsAt) >=
      Date.parse(value.observationWindow.endsAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["observationWindow", "endsAt"],
      message: "endsAt must be after startsAt",
    });
  }
  if (
    Date.parse(value.recordedAt) < Date.parse(value.observationWindow.endsAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["recordedAt"],
      message: "recordedAt must be at or after endsAt",
    });
  }
  if (value.confusion.status === "measured") {
    const {
      usefulEscalations: useful,
      falsePositives: falsePositive,
      missedSignals: missed,
      correctlyIgnored: ignored,
      denominators,
    } = value.confusion;
    if (
      denominators.escalations !== useful + falsePositive ||
      denominators.actionableSignals !== useful + missed ||
      denominators.evaluatedSignals !==
        useful + falsePositive + missed + ignored
    ) {
      context.addIssue({
        code: "custom",
        path: ["confusion", "denominators"],
        message: "confusion denominators are inconsistent",
      });
    }
  }
  if (
    value.duplicateGrouping.status === "measured" &&
    (value.duplicateGrouping.correctlyGroupedDuplicates >
        value.duplicateGrouping.duplicateAlerts ||
      value.duplicateGrouping.duplicateAlerts >
        value.duplicateGrouping.denominators.alertsReviewed ||
      value.duplicateGrouping.denominators.groupingDecisions !==
        value.duplicateGrouping.correctlyGroupedDuplicates +
          value.duplicateGrouping.incorrectlyGroupedDistinctSignals)
  ) {
    context.addIssue({
      code: "custom",
      path: ["duplicateGrouping"],
      message: "duplicate grouping denominators are inconsistent",
    });
  }
  if (
    value.confusion.status === "measured" &&
    value.timeToTriage.status === "measured" &&
    value.timeToTriage.denominators.triagedEscalations >
      value.confusion.denominators.escalations
  ) {
    context.addIssue({
      code: "custom",
      path: ["timeToTriage"],
      message: "triagedEscalations cannot exceed escalations",
    });
  }
  if (
    value.timeToTriage.status === "measured" &&
    value.timeToTriage.denominators.triagedEscalations === 0 &&
    value.timeToTriage.totalTimeToTriage.value !== 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["timeToTriage"],
      message: "time must be zero without triaged escalations",
    });
  }
  if (
    value.confusion.status === "measured" &&
    value.humanAttention.status === "measured" &&
    value.humanAttention.denominators.escalationsRequiringAttention >
      value.confusion.denominators.escalations
  ) {
    context.addIssue({
      code: "custom",
      path: ["humanAttention", "denominators", "escalationsRequiringAttention"],
      message: "escalationsRequiringAttention cannot exceed escalations",
    });
  }
  if (
    value.humanAttention.status === "measured" &&
    value.humanAttention.denominators.escalationsRequiringAttention === 0 &&
    (value.humanAttention.duration.value !== 0 ||
      value.humanAttention.interactionCount !== 0)
  ) {
    context.addIssue({
      code: "custom",
      path: ["humanAttention"],
      message: "attention must be zero without attention-requiring escalations",
    });
  }
  if (
    value.humanAttention.status === "measured" &&
    value.humanAttention.interactionCount <
      value.humanAttention.denominators.escalationsRequiringAttention
  ) {
    context.addIssue({
      code: "custom",
      path: ["humanAttention", "interactionCount"],
      message:
        "interactionCount cannot be less than escalationsRequiringAttention",
    });
  }
});

type Rate = { status: "calculated"; value: number } | {
  status: "insufficient_denominator" | "not_measured";
  value: null;
};
const rate = (numerator: number, denominator: number): Rate =>
  denominator === 0
    ? { status: "insufficient_denominator", value: null }
    : { status: "calculated", value: numerator / denominator };
const milliseconds = (value: number, unit: z.infer<typeof duration>["unit"]) =>
  value *
  ({
    milliseconds: 1,
    seconds: 1_000,
    minutes: 60_000,
    hours: 3_600_000,
  } as const)[unit];

export const watchdogEvaluationSchema = evaluationInput.transform((value) => ({
  ...value,
  derived: {
    escalationPrecision: value.confusion.status === "measured"
      ? rate(
        value.confusion.usefulEscalations,
        value.confusion.denominators.escalations,
      )
      : { status: "not_measured" as const, value: null },
    signalRecall: value.confusion.status === "measured"
      ? rate(
        value.confusion.usefulEscalations,
        value.confusion.denominators.actionableSignals,
      )
      : { status: "not_measured" as const, value: null },
    duplicateGroupingPrecision: value.duplicateGrouping.status === "measured"
      ? rate(
        value.duplicateGrouping.correctlyGroupedDuplicates,
        value.duplicateGrouping.denominators.groupingDecisions,
      )
      : { status: "not_measured" as const, value: null },
    averageTriageMilliseconds: value.timeToTriage.status === "measured"
      ? rate(
        milliseconds(
          value.timeToTriage.totalTimeToTriage.value,
          value.timeToTriage.totalTimeToTriage.unit,
        ),
        value.timeToTriage.denominators.triagedEscalations,
      )
      : { status: "not_measured" as const, value: null },
    averageAttentionMilliseconds: value.humanAttention.status === "measured"
      ? rate(
        milliseconds(
          value.humanAttention.duration.value,
          value.humanAttention.duration.unit,
        ),
        value.humanAttention.denominators.escalationsRequiringAttention,
      )
      : { status: "not_measured" as const, value: null },
  },
}));

export type WatchdogEvaluation = z.output<typeof watchdogEvaluationSchema>;
export function validateWatchdogEvaluation(input: unknown) {
  const result = watchdogEvaluationSchema.safeParse(input);
  return result.success
    ? { success: true as const, value: result.data, diagnostics: [] as const }
    : {
      success: false as const,
      diagnostics: result.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        code: issue.code,
        message: issue.message,
      })).sort((a, b) =>
        a.path.localeCompare(b.path) || a.code.localeCompare(b.code) ||
        a.message.localeCompare(b.message)
      ),
    };
}
