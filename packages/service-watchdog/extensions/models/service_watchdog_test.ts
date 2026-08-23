import {
  evaluateInspection,
  model,
  prepareInspection,
  type ServiceWatchdogPolicy,
} from "./service_watchdog.ts";

const assert = (value: unknown, message = "assertion failed") => {
  if (!value) throw new Error(message);
};
const policy: ServiceWatchdogPolicy = {
  topology: { subjects: [{ key: "api" }] },
  sourceAdapters: [
    { adapterKey: "synthetic", healthyStatuses: ["up"], required: true },
  ],
  freshness: { maxSnapshotAgeSeconds: 120, maxObservationAgeSeconds: 120 },
  retry: { intervalSeconds: 60 },
  alert: {
    sustainedForSeconds: 120,
    openUrgency: "high",
    resolveUrgency: "default",
  },
};
const harness = () => {
  const stored: Record<string, Record<string, unknown>> = {};
  const writes: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  let now = "2026-08-23T12:00:30.000Z";
  return {
    stored,
    writes,
    setNow: (value: string) => now = value,
    context: {
      globalArgs: policy,
      now: () => new Date(now),
      readResource: async (name: string) => stored[name] ?? null,
      writeResource: async (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ spec, name, data });
        stored[name] = data;
        return { name };
      },
    },
  };
};
const source = (plan: Record<string, unknown>, state: string) => ({
  adapterKey: "synthetic",
  collectedAt: plan.capturedAt,
  windowStartedAt: plan.windowStartedAt,
  windowEndedAt: plan.windowEndedAt,
  truncated: false,
  observations: [{
    subjectKey: "api",
    status: state,
    observedAt: plan.capturedAt,
  }],
});

Deno.test("two-phase transition-only watchdog opens and resolves exactly once", async () => {
  const h = harness();
  for (const minute of [0, 1, 2]) {
    h.setNow(`2026-08-23T12:0${minute}:30.000Z`);
    const plan = (await prepareInspection(h.context)).value;
    await evaluateInspection(
      { sourceSnapshots: [source(plan, "down")] },
      h.context,
    );
  }
  assert(
    h.writes.filter((write) => write.spec === "alertIntent").length === 1,
    "opens after the sustained policy threshold",
  );
  const openedIntentIndex = h.writes.findIndex((write) =>
    write.spec === "alertIntent" && write.data.event === "opened"
  );
  const transitionIndex = h.writes.findIndex((write, index) =>
    index > openedIntentIndex && write.spec === "subjectState" &&
    write.data.lastInspectionId ===
      h.writes[openedIntentIndex].data.inspectionRef
  );
  assert(
    openedIntentIndex >= 0 && transitionIndex > openedIntentIndex,
    "persists incident outputs before the transition replay marker",
  );
  const duplicatePlan = (await prepareInspection(h.context)).value;
  const writesBeforeReplay = h.writes.length;
  await evaluateInspection({
    sourceSnapshots: [source(duplicatePlan, "down")],
  }, h.context);
  assert(
    h.writes.length === writesBeforeReplay,
    "unchanged inspection replay produces no writes",
  );
  assert(
    h.writes.filter((write) => write.spec === "alertIntent").length === 1,
    "retry does not re-deliver an intent",
  );
  h.setNow("2026-08-23T12:03:30.000Z");
  const recovered = (await prepareInspection(h.context)).value;
  await evaluateInspection({
    sourceSnapshots: [source(recovered, "up")],
  }, h.context);
  assert(
    h.writes.filter((write) => write.spec === "alertIntent").length === 2,
    "resolves once",
  );
  assert(
    !`${prepareInspection}${evaluateInspection}`.match(
      /fetch\(|Deno\.Command|notification|deliveryClient|deleteResource/,
    ),
    "core has no delivery or provider access",
  );
});

Deno.test("missing, stale, and truncated source evidence cannot change a healthy state", async () => {
  const h = harness();
  const plan = (await prepareInspection(h.context)).value;
  await evaluateInspection({ sourceSnapshots: [] }, h.context);
  assert(h.writes.filter((write) => write.spec === "alertIntent").length === 0);
});

Deno.test("future-collected snapshots are stale and cannot influence state", async () => {
  const h = harness();
  const plan = (await prepareInspection(h.context)).value;
  const future = source(plan, "down");
  future.collectedAt = new Date(Date.parse(plan.capturedAt) + 1).toISOString();
  await evaluateInspection({ sourceSnapshots: [future] }, h.context);
  const inspection = h.writes.find((write) => write.spec === "inspection");
  assert(
    (inspection?.data.sources as Array<{ state: string }>)[0].state === "stale",
  );
  assert(h.writes.filter((write) => write.spec === "alertIntent").length === 0);
});

Deno.test("prepare returns the persisted handle and reuses the pure plan", async () => {
  const h = harness();
  const first = await prepareInspection(h.context);
  assert(
    first.handles[0] &&
      (first.handles[0] as { name: string }).name === "plan-current",
  );
  const replay = await prepareInspection(h.context);
  assert(replay.value.inspectionId === first.value.inspectionId);
  assert(replay.handles.length === 0);
});

Deno.test("rejects malformed and duplicate snapshots before any evaluation write", async () => {
  const h = harness();
  const plan = (await prepareInspection(h.context)).value;
  const writesBefore = h.writes.length;
  const duplicateObservation = source(plan, "up");
  duplicateObservation.observations.push(duplicateObservation.observations[0]);
  const unknownAdapter = { ...source(plan, "up"), adapterKey: "unknown" };
  for (
    const snapshots of [
      [{}],
      [source(plan, "up"), source(plan, "up")],
      [duplicateObservation],
      [unknownAdapter],
    ]
  ) {
    let rejected = false;
    try {
      await evaluateInspection({ sourceSnapshots: snapshots }, h.context);
    } catch {
      rejected = true;
    }
    assert(rejected);
    assert(h.writes.length === writesBefore, "validation must precede writes");
  }
});

Deno.test("one stale required observation makes all subject evidence unknown", async () => {
  const h = harness();
  h.context.globalArgs = {
    ...policy,
    sourceAdapters: [
      ...policy.sourceAdapters,
      { adapterKey: "secondary", healthyStatuses: ["up"], required: true },
    ],
  };
  const plan = (await prepareInspection(h.context)).value;
  const primary = source(plan, "down");
  const secondary = {
    ...source(plan, "down"),
    adapterKey: "secondary",
    observations: [{
      subjectKey: "api",
      status: "down",
      observedAt: "2026-08-23T11:00:00.000Z",
    }],
  };
  await evaluateInspection({ sourceSnapshots: [primary, secondary] }, h.context);
  const state = h.writes.find((write) => write.spec === "subjectState");
  assert(state?.data.state === "unknown");
  assert(h.writes.every((write) => write.spec !== "alertIntent"));
});

Deno.test("reads and validates every output before the first evaluation write", async () => {
  const h = harness();
  h.stored["subject-api"] = {
    schemaVersion: "1.0",
    subjectKey: "api",
    state: "unhealthy",
    incidentState: "open",
    unhealthySince: "2026-08-23T11:58:00.000Z",
    lastObservedAt: "2026-08-23T11:59:00.000Z",
    lastInspectionId: "prior",
    incidentId: "incident-api-1",
  };
  const plan = (await prepareInspection(h.context)).value;
  const writesBefore = h.writes.length;
  const context = {
    ...h.context,
    readResource: async (name: string) => {
      if (name === "incident-incident-api-1") {
        throw new Error("injected read failure");
      }
      return h.stored[name] ?? null;
    },
  };
  let rejected = false;
  try {
    await evaluateInspection(
      { sourceSnapshots: [source(plan, "up")] },
      context,
    );
  } catch {
    rejected = true;
  }
  assert(rejected);
  assert(h.writes.length === writesBefore);
});

Deno.test("malformed persisted subject state fails before evaluation writes", async () => {
  const h = harness();
  const plan = (await prepareInspection(h.context)).value;
  h.stored["subject-api"] = { state: "invented" };
  const writesBefore = h.writes.length;
  let rejected = false;
  try {
    await evaluateInspection(
      { sourceSnapshots: [source(plan, "down")] },
      h.context,
    );
  } catch {
    rejected = true;
  }
  assert(rejected);
  assert(h.writes.length === writesBefore);
});

Deno.test("evaluation rejects caller plans and stale persisted policy", async () => {
  const h = harness();
  const plan = (await prepareInspection(h.context)).value;
  let rejected = false;
  try {
    await evaluateInspection({ plan, sourceSnapshots: [] }, h.context);
  } catch {
    rejected = true;
  }
  assert(rejected, "caller-supplied plans are not public arguments");

  h.context.globalArgs = {
    ...policy,
    retry: { intervalSeconds: 30 },
  };
  rejected = false;
  try {
    await evaluateInspection({ sourceSnapshots: [] }, h.context);
  } catch (error) {
    rejected = String(error).includes("current global policy");
  }
  assert(rejected, "persisted plans must bind the current global policy");
});

Deno.test("prepareInspection ignores evaluator-injected global arguments", () => {
  assert(
    Object.keys(
      model.methods.prepareInspection.arguments.parse({ bypass: true }),
    ).length === 0,
  );
});
