import { z } from "npm:zod@4";

/** Current public version of the service watchdog model. */
export const MODEL_VERSION = "2026.08.24.1" as const;
const timestamp = z.iso.datetime({ offset: true });
const key = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/);
const status = z.string().trim().min(1).max(50).regex(/^[a-z0-9_.-]+$/);
const authority = z.strictObject({
  network: z.literal("forbidden"),
  delivery: z.literal("forbidden"),
  remediation: z.literal("forbidden"),
  productionMutation: z.literal("forbidden"),
});
const noAuthority = {
  network: "forbidden",
  delivery: "forbidden",
  remediation: "forbidden",
  productionMutation: "forbidden",
} as const;

const adapterSchema = z.strictObject({
  adapterKey: key,
  healthyStatuses: z.array(status).min(1).max(20),
  required: z.boolean().default(true),
});
const topologySchema = z.strictObject({
  subjects: z.array(z.strictObject({ key })).min(1).max(100),
});
const policySchema = z.strictObject({
  topology: topologySchema,
  sourceAdapters: z.array(adapterSchema).min(1).max(20),
  freshness: z.strictObject({
    maxSnapshotAgeSeconds: z.number().int().min(1).max(86_400),
    maxObservationAgeSeconds: z.number().int().min(1).max(86_400),
  }),
  retry: z.strictObject({
    intervalSeconds: z.number().int().min(1).max(86_400),
  }),
  alert: z.strictObject({
    sustainedForSeconds: z.number().int().min(0).max(604_800),
    openUrgency: z.enum(["high", "default"]).default("high"),
    resolveUrgency: z.enum(["high", "default"]).default("default"),
  }),
});
const parsePolicy = (value: unknown): z.infer<typeof policySchema> => {
  const parsed = policySchema.parse(value);
  for (
    const [field, values] of [[
      "topology.subjects",
      parsed.topology.subjects.map((item) => item.key),
    ], [
      "sourceAdapters",
      parsed.sourceAdapters.map((item) => item.adapterKey),
    ]] as const
  ) {
    if (new Set(values).size !== values.length) {
      throw new TypeError(`${field} keys must be unique`);
    }
  }
  return parsed;
};
/** Schema for the immutable plan captured before adapter reads begin. */
export const planSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  inspectionId: key,
  intervalId: key,
  capturedAt: timestamp,
  windowStartedAt: timestamp,
  windowEndedAt: timestamp,
  policy: policySchema,
  authority,
});
const observationSchema = z.strictObject({
  subjectKey: key,
  status,
  observedAt: timestamp,
});
const sourceSnapshotSchema = z.strictObject({
  adapterKey: key,
  collectedAt: timestamp,
  windowStartedAt: timestamp,
  windowEndedAt: timestamp,
  truncated: z.boolean(),
  observations: z.array(observationSchema).max(1_000),
}).superRefine((value, context) => {
  const subjectKeys = value.observations.map((item) => item.subjectKey);
  if (new Set(subjectKeys).size !== subjectKeys.length) {
    context.addIssue({
      code: "custom",
      path: ["observations"],
      message: "subject keys must be unique within an adapter snapshot",
    });
  }
});
/** Schema for a provider-neutral inspection result. */
export const inspectionSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  inspectionId: key,
  evaluatedAt: timestamp,
  sources: z.array(
    z.strictObject({
      adapterKey: key,
      state: z.enum(["available", "missing", "stale", "truncated"]),
      observationCount: z.number().int().nonnegative(),
    }),
  ),
  authority,
});
const subjectStateSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  subjectKey: key,
  state: z.enum(["unknown", "healthy", "unhealthy"]),
  incidentState: z.enum(["none", "open"]),
  unhealthySince: timestamp.nullable(),
  lastObservedAt: timestamp.nullable(),
  lastInspectionId: key.nullable(),
  incidentId: key.nullable(),
});
const incidentSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  incidentId: key,
  subjectKey: key,
  status: z.enum(["open", "resolved"]),
  openedAt: timestamp,
  resolvedAt: timestamp.nullable(),
  latestInspectionRef: key,
  authority,
});
/** Schema for a transition-only alert intent that another workflow may deliver. */
export const alertIntentSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  intentId: key,
  incidentId: key,
  subjectKey: key,
  event: z.enum(["opened", "resolved"]),
  urgency: z.enum(["high", "default"]),
  inspectionRef: key,
  authority,
});

/** Validated global policy accepted by the service watchdog model. */
export type ServiceWatchdogPolicy = z.infer<typeof policySchema>;
type Policy = ServiceWatchdogPolicy;
type Context = {
  globalArgs?: Policy;
  now?: () => Date;
  logger?: {
    info(message: string, properties?: Record<string, unknown>): void;
    warning(message: string, properties?: Record<string, unknown>): void;
  };
  readResource(name: string): Promise<Record<string, unknown> | null>;
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<unknown>;
};
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
const nameFor = (prefix: string, value: string) =>
  `${prefix}-${value.replace(/[^A-Za-z0-9_.:-]/g, "_")}`;

/** Capture or reuse the deterministic inspection plan for the current interval. */
export async function prepareInspection(context: Context) {
  context.logger?.info("Preparing service watchdog inspection");
  const captured = (context.now ?? (() => new Date()))();
  const policy = parsePolicy(context.globalArgs);
  const intervalMs = policy.retry.intervalSeconds * 1_000;
  const end = Math.floor(captured.getTime() / intervalMs) * intervalMs;
  const intervalId = `i-${end}`;
  const current = planSchema.safeParse(
    await context.readResource("plan-current"),
  );
  if (current.success && current.data.intervalId === intervalId) {
    context.logger?.info("Reusing inspection plan {inspectionId}", {
      inspectionId: current.data.inspectionId,
    });
    return { value: current.data, handles: [] };
  }
  const plan = planSchema.parse({
    schemaVersion: "1.0",
    inspectionId: intervalId,
    intervalId,
    capturedAt: captured.toISOString(),
    windowStartedAt: iso(end - intervalMs),
    windowEndedAt: iso(end),
    policy,
    authority: noAuthority,
  });
  const handle = await context.writeResource("plan", "plan-current", plan);
  context.logger?.info("Prepared inspection plan {inspectionId}", {
    inspectionId: plan.inspectionId,
  });
  return { value: plan, handles: [handle] };
}

const sourceState = (
  snapshot: unknown,
  adapter: z.infer<typeof adapterSchema>,
  plan: z.infer<typeof planSchema>,
) => {
  const parsed = sourceSnapshotSchema.safeParse(snapshot);
  if (!parsed.success || parsed.data.adapterKey !== adapter.adapterKey) {
    return {
      state: "missing" as const,
      observations: [] as z.infer<typeof observationSchema>[],
    };
  }
  const value = parsed.data;
  if (value.truncated) {
    return { state: "truncated" as const, observations: value.observations };
  }
  const collected = Date.parse(value.collectedAt);
  const captured = Date.parse(plan.capturedAt);
  if (
    value.windowStartedAt !== plan.windowStartedAt ||
    value.windowEndedAt !== plan.windowEndedAt ||
    collected <
      captured - plan.policy.freshness.maxSnapshotAgeSeconds * 1_000 ||
    collected > captured
  ) return { state: "stale" as const, observations: value.observations };
  return { state: "available" as const, observations: value.observations };
};

/** Evaluate supplied snapshots and persist only deterministic state transitions. */
export async function evaluateInspection(input: unknown, context: Context) {
  context.logger?.info("Evaluating service watchdog inspection");
  const args = z.strictObject({
    sourceSnapshots: z.array(z.unknown()).max(20).default([]),
  }).parse(input);
  const persistedPlan = planSchema.safeParse(
    await context.readResource("plan-current"),
  );
  if (!persistedPlan.success) {
    throw new TypeError("A valid persisted plan-current is required");
  }
  const plan = persistedPlan.data;
  const currentPolicy = parsePolicy(context.globalArgs);
  if (JSON.stringify(plan.policy) !== JSON.stringify(currentPolicy)) {
    throw new TypeError(
      "Persisted plan policy does not match current global policy",
    );
  }
  const snapshots = args.sourceSnapshots.map((value, index) => {
    const parsed = sourceSnapshotSchema.safeParse(value);
    if (!parsed.success) {
      throw new TypeError(`Malformed source snapshot at index ${index}`);
    }
    return parsed.data;
  });
  const byAdapter = new Map<string, z.infer<typeof sourceSnapshotSchema>>();
  const configuredAdapters = new Set(
    plan.policy.sourceAdapters.map((adapter) => adapter.adapterKey),
  );
  for (const snapshot of snapshots) {
    if (!configuredAdapters.has(snapshot.adapterKey)) {
      throw new TypeError(
        `Unknown source snapshot adapter ${snapshot.adapterKey}`,
      );
    }
    if (byAdapter.has(snapshot.adapterKey)) {
      throw new TypeError(
        `Duplicate source snapshot for adapter ${snapshot.adapterKey}`,
      );
    }
    byAdapter.set(snapshot.adapterKey, snapshot);
  }
  const sources = plan.policy.sourceAdapters.map((adapter) => ({
    adapter,
    ...sourceState(byAdapter.get(adapter.adapterKey), adapter, plan),
  }));
  const inspection = inspectionSchema.parse({
    schemaVersion: "1.0",
    inspectionId: plan.inspectionId,
    evaluatedAt: plan.capturedAt,
    sources: sources.map(({ adapter, state, observations }) => ({
      adapterKey: adapter.adapterKey,
      state,
      observationCount: observations.length,
    })),
    authority: noAuthority,
  });
  const subjects = await Promise.all(
    plan.policy.topology.subjects.map(async (subject) => {
      const stored = await context.readResource(
        nameFor("subject", subject.key),
      );
      if (stored === null) return { subject, previous: null };
      return { subject, previous: subjectStateSchema.parse(stored) };
    }),
  );
  if (
    subjects.every(({ previous }) =>
      previous?.lastInspectionId === inspection.inspectionId
    )
  ) {
    context.logger?.info("Suppressing replay of inspection {inspectionId}", {
      inspectionId: inspection.inspectionId,
    });
    return { dataHandles: [] };
  }
  const pending: Array<{
    spec: string;
    name: string;
    data: Record<string, unknown>;
  }> = [{
    spec: "inspection",
    name: nameFor("inspection", inspection.inspectionId),
    data: inspection,
  }];
  for (const { subject, previous } of subjects) {
    const applicable = sources.filter(({ adapter }) => adapter.required);
    const evidence = applicable.map(({ adapter, state, observations }) => ({
      adapter,
      state,
      observation: observations.find((item) => item.subjectKey === subject.key),
    }));
    const valid = evidence.every((item) =>
      item.state === "available" && item.observation
    );
    const observedAts = valid
      ? evidence.map((item) => item.observation!.observedAt)
      : [];
    const observedAt = observedAts.sort().at(-1) ?? null;
    const earliestFresh = Date.parse(plan.capturedAt) -
      plan.policy.freshness.maxObservationAgeSeconds * 1_000;
    const fresh = observedAts.length > 0 &&
      observedAts.every((value) =>
        Date.parse(value) >= earliestFresh &&
        Date.parse(value) <= Date.parse(plan.capturedAt)
      );
    const healthy = fresh &&
      evidence.every((item) =>
        item.adapter.healthyStatuses.includes(item.observation!.status)
      );
    const stateName = nameFor("subject", subject.key);
    if (
      previous?.lastInspectionId === inspection.inspectionId
    ) continue;
    const prior = previous ?? {
      schemaVersion: "1.0" as const,
      subjectKey: subject.key,
      state: "unknown" as const,
      incidentState: "none" as const,
      unhealthySince: null,
      lastObservedAt: null,
      lastInspectionId: null,
      incidentId: null,
    };
    let next = prior;
    let event: "opened" | "resolved" | null = null;
    let eventIncidentId: string | null = null;
    if (!fresh) {
      context.logger?.warning(
        "Inspection {inspectionId} has degraded evidence for {subjectKey}",
        { inspectionId: inspection.inspectionId, subjectKey: subject.key },
      );
      next = {
        ...prior,
        state: "unknown" as const,
        lastInspectionId: inspection.inspectionId,
      };
    } else if (healthy) {
      if (prior.incidentState === "open") {
        event = "resolved";
        eventIncidentId = prior.incidentId;
      }
      next = {
        ...prior,
        state: "healthy" as const,
        incidentState: "none" as const,
        unhealthySince: null,
        lastObservedAt: observedAt,
        lastInspectionId: inspection.inspectionId,
        incidentId: null,
      };
    } else {
      const continuous = prior.state === "unhealthy" &&
        prior.lastObservedAt !== null &&
        Date.parse(observedAt!) - Date.parse(prior.lastObservedAt) <=
          plan.policy.freshness.maxObservationAgeSeconds * 1_000;
      const unhealthySince = continuous ? prior.unhealthySince : observedAt;
      const breached = unhealthySince !== null &&
        Date.parse(observedAt!) - Date.parse(unhealthySince) >=
          plan.policy.alert.sustainedForSeconds * 1_000;
      const incidentId = prior.incidentId ??
        (breached
          ? nameFor("incident", `${subject.key}-${Date.parse(unhealthySince!)}`)
          : null);
      if (breached && prior.incidentState !== "open") {
        event = "opened";
        eventIncidentId = incidentId;
      }
      next = {
        ...prior,
        state: "unhealthy" as const,
        incidentState: breached ? "open" as const : prior.incidentState,
        unhealthySince,
        lastObservedAt: observedAt,
        lastInspectionId: inspection.inspectionId,
        incidentId,
      };
    }
    const state = subjectStateSchema.parse(next);
    if (event && eventIncidentId) {
      context.logger?.info(
        "Recorded {event} transition for {subjectKey}",
        { event, subjectKey: subject.key },
      );
      const incidentName = nameFor("incident", eventIncidentId);
      const storedIncident = await context.readResource(incidentName);
      const priorIncident = storedIncident === null
        ? null
        : incidentSchema.parse(storedIncident);
      const incident = incidentSchema.parse({
        schemaVersion: "1.0",
        incidentId: eventIncidentId,
        subjectKey: subject.key,
        status: event === "opened" ? "open" : "resolved",
        openedAt: event === "opened"
          ? plan.capturedAt
          : (priorIncident?.openedAt ?? plan.capturedAt),
        resolvedAt: event === "resolved" ? plan.capturedAt : null,
        latestInspectionRef: inspection.inspectionId,
        authority: noAuthority,
      });
      pending.push({ spec: "incident", name: incidentName, data: incident });
      const intent = alertIntentSchema.parse({
        schemaVersion: "1.0",
        intentId: nameFor(event, eventIncidentId),
        incidentId: eventIncidentId,
        subjectKey: subject.key,
        event,
        urgency: event === "opened"
          ? plan.policy.alert.openUrgency
          : plan.policy.alert.resolveUrgency,
        inspectionRef: inspection.inspectionId,
        authority: noAuthority,
      });
      pending.push({
        spec: "alertIntent",
        name: intent.intentId,
        data: intent,
      });
    }
    // Commit the transition marker last. If an earlier write fails, the next
    // evaluation retries the same incident/intent writes before advancing state.
    pending.push({ spec: "subjectState", name: stateName, data: state });
  }
  const handles: unknown[] = [];
  for (const output of pending) {
    handles.push(
      await context.writeResource(output.spec, output.name, output.data),
    );
  }
  context.logger?.info("Evaluated inspection {inspectionId}", {
    inspectionId: inspection.inspectionId,
  });
  return { dataHandles: handles };
}

/** Swamp model definition for provider-neutral transition-only watchdogs. */
export const model = {
  type: "@mgreten/service-watchdog",
  version: MODEL_VERSION,
  globalArguments: policySchema,
  resources: {
    plan: {
      description: "Deterministic inspection plan",
      schema: planSchema,
      lifetime: "7d" as const,
      garbageCollection: 2,
    },
    inspection: {
      description: "Provider-neutral inspection",
      schema: inspectionSchema,
      lifetime: "30d" as const,
      garbageCollection: 100,
    },
    subjectState: {
      description: "Transition state",
      schema: subjectStateSchema,
      lifetime: "90d" as const,
      garbageCollection: 100,
    },
    incident: {
      description: "Incident lifecycle",
      schema: incidentSchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
    alertIntent: {
      description: "Transition-only alert intent; never delivered here",
      schema: alertIntentSchema,
      lifetime: "30d" as const,
      garbageCollection: 100,
    },
  },
  methods: {
    prepareInspection: {
      description:
        "Persist a deterministic plan before adapters collect source snapshots",
      arguments: z.object({}),
      execute: async (_args: unknown, context: Context) => ({
        dataHandles: (await prepareInspection(context)).handles,
      }),
    },
    evaluateInspection: {
      description:
        "Evaluate supplied adapter snapshots without network, delivery, remediation, or mutation",
      arguments: z.object({
        sourceSnapshots: z.array(z.unknown()).max(20).default([]),
      }),
      execute: evaluateInspection,
    },
  },
};
