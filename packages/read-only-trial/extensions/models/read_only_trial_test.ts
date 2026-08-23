import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import {
  evaluateReadOnlyTrial,
  readOnlyTrialInputSchema,
} from "./_lib/read_only_trial_contracts.ts";
import { model } from "./read_only_trial.ts";

const readiness = (source: string) => ({
  source,
  registered: true as const,
  approved: true as const,
  available: true as const,
  minimized: true as const,
  redacted: true as const,
  rawContentIncluded: false as const,
  restrictedContentIncluded: false as const,
  checkedAt: "2026-08-01T00:00:00Z",
  expiresAt: "2026-08-03T00:00:00Z",
  evidenceRefs: [`${source}-ready`],
});
const observation = (day: number, source: string) => ({
  day,
  observedAt: `2026-08-0${day}T12:00:00Z`,
  sourceCoverage: [{
    source,
    status: "covered" as const,
    recordsObserved: day,
    evidenceRefs: [`${source}-${day}`],
    unavailableReason: null,
  }],
  pulse: {
    status: "recorded" as const,
    pulseId: `pulse-${day}`,
    deliveredAt: `2026-08-0${day}T12:01:00Z`,
    evidenceRefs: [`pulse-${day}`],
    humanReviewed: true,
  },
});
const fixture = (
  durationDays = 2,
): z.input<typeof readOnlyTrialInputSchema> => ({
  schemaVersion: "1.0" as const,
  trialId: "synthetic-trial",
  durationDays,
  evaluatedAt: "2026-08-03T01:00:00Z",
  activation: {
    approvalId: "approval-1",
    actor: "human:owner",
    approvedAt: "2026-08-01T00:00:00Z",
    startsAt: "2026-08-01T00:00:00Z",
  },
  sourceReadiness: [readiness("synthetic-source")],
  observations: Array.from(
    { length: durationDays },
    (_, index) => observation(index + 1, "synthetic-source"),
  ),
  failures: [],
  prohibitedConditions: [],
  finalReview: null,
});

Deno.test("synthetic trial boundary requires observations inside the exact duration", () => {
  const input = fixture();
  input.observations[1].observedAt = "2026-08-03T00:00:00Z";
  assertThrows(
    () => evaluateReadOnlyTrial(input),
    Error,
    "observation must fall inside",
  );
});

Deno.test("pulse delivery cannot be later than evaluation and progresses at the boundary", () => {
  const future = fixture();
  assert(future.observations[1].pulse.status === "recorded");
  future.observations[1].pulse.deliveredAt = "2026-08-03T01:00:00.001Z";
  assertThrows(
    () => evaluateReadOnlyTrial(future),
    Error,
    "pulse delivery must be between observation and evaluation",
  );

  const boundary = fixture();
  assert(boundary.observations[1].pulse.status === "recorded");
  boundary.observations[1].pulse.deliveredAt = boundary.evaluatedAt;
  assertEquals(evaluateReadOnlyTrial(boundary).status, "awaiting_final_review");
});

Deno.test("synthetic freshness rejects readiness that expires at activation", () => {
  const input = fixture();
  input.sourceReadiness[0].expiresAt = "2026-08-01T00:00:00Z";
  assertThrows(() => evaluateReadOnlyTrial(input), Error, "remain fresh");
});

Deno.test("synthetic freshness covers the full declared duration", () => {
  const stale = fixture();
  stale.sourceReadiness[0].expiresAt = "2026-08-02T23:59:59.999Z";
  assertThrows(() => evaluateReadOnlyTrial(stale), Error, "trial end");

  const boundary = fixture();
  boundary.sourceReadiness[0].expiresAt = "2026-08-03T00:00:00Z";
  assertEquals(evaluateReadOnlyTrial(boundary).status, "awaiting_final_review");
});

Deno.test("synthetic repeated failure pauses without operational authority", () => {
  const input = fixture();
  input.failures = [1, 2, 3].map((sequence) => ({
    sequence,
    occurredAt: `2026-08-01T0${sequence}:00:00Z`,
    causeFingerprint: "synthetic-failure",
    evidenceRef: `failure-${sequence}`,
  }));
  const result = evaluateReadOnlyTrial(input);
  assertEquals(result.status, "paused");
  assertEquals(result.measurements.maximumConsecutiveSameCauseFailures, 3);
  assert(
    Object.entries(result.authority).every(([key, value]) =>
      key === "sideEffects" || key === "activationRequiresHumanApproval" ||
      value === false
    ),
  );
});

Deno.test("dormant synthetic trial has zero authority", () => {
  const input = fixture();
  input.activation = null;
  input.observations = [];
  const result = evaluateReadOnlyTrial(input);
  assertEquals(result.status, "not_activated");
  assertEquals(result.authority.operationalBindings, false);
});

Deno.test("model persists exactly one local evaluation and has no bindings", async () => {
  const writes: unknown[][] = [];
  const logs: unknown[][] = [];
  await model.methods.evaluate.execute({
    evaluationId: "synthetic-trial",
    input: fixture(),
  }, {
    logger: { info: (...args: unknown[]) => logs.push(args) },
    writeResource: async (...args: unknown[]) => {
      writes.push(args);
      return { name: args[1] };
    },
  });
  assertEquals(writes.length, 1);
  assertEquals(writes[0][0], "evaluation");
  assertEquals(logs.length, 2);
  assert(
    !/fetch\s*\(|Deno\.|invoke|vault|workflow|report/i.test(
      model.methods.evaluate.execute.toString(),
    ),
  );
});

Deno.test("strict contracts reject malformed IDs and cross-trial replay", async () => {
  const malformed = fixture();
  malformed.trialId = " synthetic-trial";
  assertThrows(() => evaluateReadOnlyTrial(malformed));

  let writes = 0;
  let completions = 0;
  await assertRejects(
    () =>
      model.methods.evaluate.execute({
        evaluationId: "different-trial",
        input: fixture(),
      }, {
        logger: {
          info: (message: string) => {
            if (message.startsWith("Evaluated")) completions++;
          },
        },
        writeResource: () => {
          writes++;
          return Promise.resolve({});
        },
      }),
    Error,
    "cross-trial replay",
  );
  assertEquals(writes, 0);
  assertEquals(completions, 0);
});

Deno.test("generic sources, duration, and evaluation are deterministic", () => {
  const input = fixture(1);
  input.sourceReadiness = [readiness("source.alpha"), readiness("source:beta")];
  input.sourceReadiness.forEach((source) => {
    source.expiresAt = "2026-08-02T00:00:00Z";
  });
  input.observations = [observation(1, "source.alpha")];
  input.observations[0].sourceCoverage.push({
    source: "source:beta",
    status: "covered",
    recordsObserved: 0,
    evidenceRefs: ["source:beta-1"],
    unavailableReason: null,
  });
  const first = evaluateReadOnlyTrial(input);
  const second = evaluateReadOnlyTrial(structuredClone(input));
  assertEquals(first, second);
  assertEquals(first.measurements.recordsObserved, 1);
});

Deno.test("strict nested schemas and failure threshold reject boundary abuse", () => {
  const extraField = fixture() as Record<string, unknown>;
  extraField.unexpected = true;
  assertThrows(() => evaluateReadOnlyTrial(extraField), Error, "Unrecognized key");

  const twoFailures = fixture();
  twoFailures.failures = [1, 2].map((sequence) => ({
    sequence,
    occurredAt: `2026-08-01T0${sequence}:00:00Z`,
    causeFingerprint: "same-cause",
    evidenceRef: `failure-${sequence}`,
  }));
  assertEquals(evaluateReadOnlyTrial(twoFailures).status, "awaiting_final_review");

  const outOfWindow = fixture();
  outOfWindow.failures = [{
    sequence: 1,
    occurredAt: "2026-08-03T00:00:00Z",
    causeFingerprint: "same-cause",
    evidenceRef: "failure-1",
  }];
  assertThrows(() => evaluateReadOnlyTrial(outOfWindow), Error, "inside");
});
