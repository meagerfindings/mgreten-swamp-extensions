import { watchFactory } from "./_lib/factory_watcher_contracts.ts";
import { model } from "./factory_watcher.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

function rejects(fn: () => unknown, text: string) {
  try {
    fn();
  } catch (error) {
    assert(String(error).includes(text), String(error));
    return;
  }
  throw new Error(`expected ${text}`);
}

const categories = [
  "repeated_cycle",
  "context_gap",
  "permission_friction",
  "rejected_plan",
  "recurring_finding",
  "wasteful_model_routing",
  "factory_improvement",
] as const;
const source = (id: string) => ({
  schemaVersion: "1.0" as const,
  sourceId: id,
  source: { system: "synthetic", resourceType: "transition", resourceId: id },
  provenance: {
    collector: "test",
    collectorVersion: "1",
    method: "fixture",
    collectedAt: "2026-08-23T11:00:00Z",
  },
  observedAt: "2026-08-23T10:00:00Z",
  freshness: {
    asOf: "2026-08-23T11:00:00Z",
    expiresAt: "2026-08-24T00:00:00Z",
  },
  sensitivity: "internal" as const,
});
const fixture = () => ({
  schemaVersion: "1.0" as const,
  watchId: "watch-1",
  evaluatedAt: "2026-08-23T12:00:00Z",
  policy: {
    thresholds: categories.map((category, index) => ({
      category,
      minimumOccurrences: 2,
      lookbackHours: 24,
      priority: index === 0 ? 50 : 10,
      recommendation: `Review ${category}`,
    })),
    tieBreak: "priority_desc_category_asc_signal_key_asc" as const,
    maximumRecommendations: 10,
  },
  availability: categories.map((category) => ({
    category,
    status: category === "permission_friction"
      ? "unavailable" as const
      : "available" as const,
    unavailableReason: category === "permission_friction"
      ? "Permission telemetry was not supplied"
      : null,
  })),
  evidence: ["e-1", "e-2"].map((evidenceId) => ({
    evidenceId,
    evidenceLink: `https://example.test/${evidenceId}`,
    summary: `Evidence ${evidenceId}`,
    sourceReference: source(evidenceId),
  })),
  observations: ["b", "a"].flatMap((signalKey) =>
    [1, 2].map((number) => ({
      observationId: `${signalKey}-${number}`,
      category: "repeated_cycle" as const,
      signalKey,
      occurredAt: `2026-08-23T0${number}:00:00Z`,
      evidenceIds: [`e-${number}`],
    }))
  ),
});

Deno.test("synthetic transitions produce deterministic, ordered recommendations", () => {
  const input = fixture();
  const first = watchFactory(input);
  assert(JSON.stringify(first) === JSON.stringify(watchFactory(input)));
  assert(
    first.recommendations.map((item) => item.signalKey).join(",") === "a,b",
  );
  assert(JSON.stringify(first.evidence) === JSON.stringify(input.evidence));
  assert(first.unavailableData[0].category === "permission_friction");
  assert(first.truncated === false);
});

Deno.test("recommendation cap reports omitted sorted candidates", () => {
  const input = fixture();
  input.policy.maximumRecommendations = 1;
  const result = watchFactory(input);
  assert(result.recommendations.length === 1);
  assert(result.recommendations[0].signalKey === "a");
  assert(result.truncated === true);
});

Deno.test("stale evidence and incomplete availability declarations fail closed", () => {
  const stale = fixture();
  stale.evidence[0].sourceReference.freshness.expiresAt =
    "2026-08-23T11:59:59Z";
  rejects(() => watchFactory(stale), "fresh at evaluatedAt");
  rejects(
    () =>
      watchFactory({
        ...fixture(),
        availability: fixture().availability.slice(1),
      }),
    "availability",
  );
});

Deno.test("evidence collected after evaluation and malformed input fail closed", () => {
  const futureCollection = fixture();
  futureCollection.evidence[0].sourceReference.provenance.collectedAt =
    "2026-08-23T12:00:01Z";
  rejects(() => watchFactory(futureCollection), "collected by evaluatedAt");

  rejects(
    () => watchFactory({ ...fixture(), unexpected: true }),
    "Unrecognized key",
  );
  rejects(
    () =>
      watchFactory({
        ...fixture(),
        observations: [{
          ...fixture().observations[0],
          evidenceIds: ["missing"],
        }],
      }),
    "unknown evidenceId",
  );
});

Deno.test("recommendation provenance is chronologically ordered across offsets", () => {
  const input = fixture();
  input.observations = [
    {
      ...input.observations[0],
      observationId: "later",
      signalKey: "offset",
      occurredAt: "2026-08-23T03:00:00+01:00",
    },
    {
      ...input.observations[1],
      observationId: "earlier",
      signalKey: "offset",
      occurredAt: "2026-08-23T01:30:00Z",
    },
  ];
  const result = watchFactory(input);
  assert(
    result.recommendations[0].observationIds.join(",") === "earlier,later",
  );
});

Deno.test("model persists one recommendation-only result with no authority to act", async () => {
  const writes: unknown[][] = [];
  const logs: string[] = [];
  const result = await model.methods.watch.execute({
    requestId: "watch-1",
    input: fixture(),
  }, {
    logger: {
      info: (message: string) => logs.push(message),
    },
    writeResource: async (...args: unknown[]) => {
      writes.push(args);
      return { name: args[1] };
    },
  });
  assert(writes.length === 1 && writes[0][0] === "watch");
  assert(logs.length === 2);
  assert(
    JSON.stringify(result) ===
      JSON.stringify({ dataHandles: [{ name: "watch-watch-1" }] }),
  );
  const output = writes[0][2] as { authority: Record<string, unknown> };
  assert(
    output.authority.factoryMutation === false &&
      output.authority.providerCalls === false &&
      output.authority.networkCalls === false,
  );
  assert(
    JSON.stringify(Object.keys(model.methods)) === JSON.stringify(["watch"]),
  );
  assert(!("files" in model));
});

Deno.test("requestId is bound to input watchId", async () => {
  let rejected = false;
  try {
    await model.methods.watch.execute({ requestId: "other", input: fixture() }, {
      logger: { info: () => {} },
      writeResource: () => Promise.resolve({}),
    });
  } catch (error) { rejected = String(error).includes("exactly match"); }
  assert(rejected);
});
