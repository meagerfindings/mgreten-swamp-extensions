import {
  PostReleaseMeasurementPlan,
  validatePostReleaseMeasurementPlan,
} from "./_lib/post_release_measurement_contracts.ts";
import { model, planForPersistence } from "./post_release_measurement.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

const hash = (character: string) => character.repeat(64);
const source = {
  schemaVersion: "1.0",
  sourceId: "synthetic-metrics-query",
  source: {
    system: "analytics",
    resourceType: "saved-query",
    resourceId: "activation",
  },
  provenance: {
    collector: "release-manager",
    collectorVersion: "1",
    method: "declared",
    collectedAt: "2026-08-23T11:30:00Z",
  },
  observedAt: "2026-08-23T11:00:00Z",
  freshness: {
    asOf: "2026-08-23T11:30:00Z",
    expiresAt: "2026-09-30T00:00:00Z",
  },
  sensitivity: "internal" as const,
};
const plan = {
  schemaVersion: "2.0",
  planId: "synthetic-plan",
  releasedArtifact: { id: "release-7", version: 7, sha256: hash("a") },
  workOrder: { id: "work-order-3", version: 3, sha256: hash("b") },
  releasedAt: "2026-08-23T12:00:00Z",
  declaredAt: "2026-08-23T11:45:00Z",
  expectedOutcome: {
    statement: "Activation improves.",
    successCondition: "Rate is at least 0.50.",
    failureCondition: "Rate is below 0.40.",
    ambiguityCondition: "Rate is otherwise inconclusive.",
  },
  measurementSource: source,
  observationWindow: {
    startsAt: "2026-08-24T00:00:00Z",
    endsAt: "2026-08-31T00:00:00Z",
  },
  nextDecisions: {
    success: {
      decision: "Recommend retaining release.",
      rationale: "Target met.",
    },
    failure: {
      decision: "Recommend human rollback review.",
      rationale: "Failure bound met.",
    },
    ambiguity: {
      decision: "Recommend more observation.",
      rationale: "Evidence is inconclusive.",
    },
  },
  authority: {
    disposition: "recommendation-only",
    humanDecisionRequired: true,
    mayExecute: false,
    productionEffects: "none",
  },
};

Deno.test("accepts a complete synthetic plan and exposes the public model contract", () => {
  assert(PostReleaseMeasurementPlan.safeParse(plan).success);
  assert(model.type === "@mgreten/post-release-measurement");
  assert(model.version === "2026.08.23.1");
  assert(
    JSON.stringify(Object.keys(model.methods)) === JSON.stringify(["record"]),
  );
  assert(!("files" in model));
});

Deno.test("rejects authority escalation and temporal boundary violations", () => {
  for (
    const invalid of [
      { ...plan, authority: { ...plan.authority, mayExecute: true } },
      { ...plan, declaredAt: "2026-08-23T12:00:01Z" },
      {
        ...plan,
        observationWindow: {
          startsAt: "2026-08-23T11:59:59Z",
          endsAt: "2026-08-31T00:00:00Z",
        },
      },
      {
        ...plan,
        observationWindow: {
          startsAt: "2026-08-24T00:00:00Z",
          endsAt: "2026-08-24T00:00:00Z",
        },
      },
      {
        ...plan,
        measurementSource: {
          ...source,
          freshness: { ...source.freshness, expiresAt: "2026-08-30T23:59:59Z" },
        },
      },
    ]
  ) assert(!PostReleaseMeasurementPlan.safeParse(invalid).success);
});

Deno.test("returns stable diagnostics for malformed plans", () => {
  const result = validatePostReleaseMeasurementPlan({
    ...plan,
    releasedArtifact: { ...plan.releasedArtifact, sha256: "bad" },
  });
  assert(!result.valid);
  assert(result.diagnostics[0].path === "releasedArtifact.sha256");
  try {
    planForPersistence({});
    throw new Error("expected persistence validation to throw");
  } catch (error) {
    assert(error instanceof TypeError);
  }
});

Deno.test("record persists exactly one validated plan under a safe identifier", async () => {
  const writes: unknown[][] = [];
  const result = await model.methods.record.execute({
    recordId: "synthetic-plan",
    plan,
  }, {
    readResource: () => Promise.resolve(null),
    writeResource: (...args: unknown[]) => {
      writes.push(args);
      return Promise.resolve({ name: args[1] });
    },
    logger: { info: () => undefined },
  });
  assert(writes.length === 1);
  assert(
    JSON.stringify(writes[0].slice(0, 2)) ===
      JSON.stringify(["plan", "plan-synthetic-plan"]),
  );
  assert(
    JSON.stringify(result) ===
      JSON.stringify({ dataHandles: [{ name: "plan-synthetic-plan" }] }),
  );
  assert(
    !model.methods.record.arguments.safeParse({ recordId: "unsafe id", plan })
      .success,
  );
});

Deno.test("record is replay-idempotent and rejects conflicting or malformed stored data", async () => {
  let writes = 0;
  const context = {
    readResource: () => Promise.resolve(plan),
    writeResource: () => {
      writes++;
      return Promise.resolve({});
    },
    logger: { info: () => undefined },
  };
  const replay = await model.methods.record.execute(
    { recordId: "synthetic-plan", plan },
    context,
  );
  assert(writes === 0);
  assert(JSON.stringify(replay) === JSON.stringify({ dataHandles: [] }));

  for (
    const existing of [{ ...plan, declaredAt: "tampered" }, {
      ...plan,
      expectedOutcome: { ...plan.expectedOutcome, statement: "Changed." },
    }]
  ) {
    try {
      await model.methods.record.execute(
        { recordId: "synthetic-plan", plan },
        { ...context, readResource: () => Promise.resolve(existing) },
      );
      throw new Error("expected conflicting stored data to throw");
    } catch (error) {
      assert(error instanceof TypeError);
    }
  }
  assert(writes === 0);
});

Deno.test("rejects identifier mismatch, unknown fields, and oversized text", () => {
  assert(
    !PostReleaseMeasurementPlan.safeParse({ ...plan, unexpected: true })
      .success,
  );
  assert(
    !PostReleaseMeasurementPlan.safeParse({
      ...plan,
      expectedOutcome: {
        ...plan.expectedOutcome,
        statement: "x".repeat(2_001),
      },
    }).success,
  );
});
