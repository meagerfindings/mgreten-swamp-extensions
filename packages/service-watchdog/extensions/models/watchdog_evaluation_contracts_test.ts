import {
  validateWatchdogEvaluation,
  watchdogEvaluationSchema,
} from "./watchdog_evaluation_contracts.ts";

const assert = (value: unknown, message = "assertion failed") => {
  if (!value) throw new Error(message);
};
const measured = {
  schemaVersion: "1.0",
  evaluationId: "synthetic-evaluation",
  watchdogKey: "synthetic-watchdog",
  observationWindow: {
    startsAt: "2026-08-01T00:00:00Z",
    endsAt: "2026-08-02T00:00:00Z",
  },
  recordedAt: "2026-08-02T01:00:00Z",
  confusion: {
    status: "measured",
    usefulEscalations: 8,
    falsePositives: 2,
    missedSignals: 2,
    correctlyIgnored: 8,
    denominators: {
      evaluatedSignals: 20,
      escalations: 10,
      actionableSignals: 10,
    },
  },
  duplicateGrouping: {
    status: "measured",
    duplicateAlerts: 6,
    correctlyGroupedDuplicates: 4,
    incorrectlyGroupedDistinctSignals: 1,
    denominators: { alertsReviewed: 20, groupingDecisions: 5 },
  },
  timeToTriage: {
    status: "measured",
    totalTimeToTriage: { value: 30, unit: "minutes" },
    denominators: { triagedEscalations: 10 },
  },
  cost: {
    status: "observed",
    amount: 12.5,
    currency: "USD",
    provenance: {
      sourceKey: "synthetic",
      collectedAt: "2026-08-02T00:00:00Z",
      observedAt: "2026-08-01T23:00:00Z",
    },
  },
  humanAttention: {
    status: "measured",
    duration: { value: 2, unit: "hours" },
    interactionCount: 12,
    denominators: { escalationsRequiringAttention: 4 },
  },
};

Deno.test("calculates deterministic generic watchdog evaluation metrics", () => {
  const value = watchdogEvaluationSchema.parse(measured);
  assert(value.derived.escalationPrecision.value === 0.8);
  assert(value.derived.averageTriageMilliseconds.value === 180_000);
  assert(value.derived.averageAttentionMilliseconds.value === 1_800_000);
});

Deno.test("rejects incoherent denominators with sorted diagnostics", () => {
  const result = validateWatchdogEvaluation({
    ...measured,
    confusion: {
      ...measured.confusion,
      denominators: { ...measured.confusion.denominators, escalations: 9 },
    },
  });
  assert(!result.success && result.diagnostics.length === 2);
  if (!result.success) {
    const sorted = [...result.diagnostics].sort((a, b) =>
      a.path.localeCompare(b.path) || a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message)
    );
    assert(JSON.stringify(result.diagnostics) === JSON.stringify(sorted));
  }
});
