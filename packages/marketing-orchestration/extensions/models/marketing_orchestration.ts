/** Approval-gated, digest-bound marketing release orchestration. @module */
import { z } from "npm:zod@4";

/** Package CalVer shared with the manifest. */
export const MARKETING_ORCHESTRATION_VERSION = "2026.08.28.2" as const;
/** Stable model type used by the coupled report. */
export const MARKETING_ORCHESTRATION_TYPE =
  "@mgreten/marketing-orchestration" as const;

const MAX_IDEAS = 100;

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const Timestamp = z.iso.datetime({ offset: true });
const TimeZone = z.union([
  z.literal("UTC"),
  z.string().regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/),
]);
const State = z.string().trim().min(1).max(80);
const Approval = z.strictObject({
  approvalId: Id,
  approved: z.literal(true),
  principal: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(100),
  approvedAt: Timestamp,
  draftDigest: Digest,
  publicationRequestsDigest: Digest,
});
const Binding = z.strictObject({
  channel: Id,
  model: z.string().trim().min(1).max(200),
  method: z.string().trim().min(1).max(100),
  intendedState: State,
  successfulObservedStates: z.array(State).min(1).max(10),
});
const GlobalArgs = z.strictObject({
  approvalPrincipals: z.array(z.strictObject({
    principal: z.string().trim().min(1).max(200),
    role: z.string().trim().min(1).max(100),
  })).min(1).max(20),
  ideationPolicy: z.strictObject({
    minIdeas: z.number().int().min(1).max(MAX_IDEAS).default(20),
    maxIdeas: z.number().int().min(1).max(MAX_IDEAS).default(60),
    minGroups: z.number().int().min(1).max(MAX_IDEAS).default(4),
  }).default({ minIdeas: 20, maxIdeas: 60, minGroups: 4 }),
  dispatchBindings: z.array(Binding).min(1).max(30),
  states: z.strictObject({
    initialObserved: State.default("not_sent"),
    queuedObserved: State.default("queued"),
    failedObserved: State.default("failed"),
    canceledObserved: State.default("canceled"),
  }).default({
    initialObserved: "not_sent",
    queuedObserved: "queued",
    failedObserved: "failed",
    canceledObserved: "canceled",
  }),
}).superRefine((value, ctx) => {
  if (value.ideationPolicy.minIdeas > value.ideationPolicy.maxIdeas) {
    ctx.addIssue({
      code: "custom",
      path: ["ideationPolicy", "minIdeas"],
      message: "minIdeas must not exceed maxIdeas",
    });
  }
  if (value.ideationPolicy.minGroups > value.ideationPolicy.minIdeas) {
    ctx.addIssue({
      code: "custom",
      path: ["ideationPolicy", "minGroups"],
      message: "minGroups must not exceed minIdeas",
    });
  }
  if (
    new Set(value.dispatchBindings.map((b) => b.channel)).size !==
      value.dispatchBindings.length
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["dispatchBindings"],
      message: "channels must be unique",
    });
  }
});
type Globals = z.infer<typeof GlobalArgs>;

const ideaSchema = z.strictObject({
  ideaId: Id,
  group: Id,
  title: z.string().trim().min(1).max(160),
  audience: z.string().trim().min(1).max(300),
  tension: z.string().trim().min(1).max(500),
  promise: z.string().trim().min(1).max(500),
  proofNeeded: z.string().trim().min(1).max(500),
  formatHypothesis: z.string().trim().min(1).max(500),
  whyItMightWork: z.string().trim().min(1).max(500),
});
const ideationFields = {
  schemaVersion: z.literal("1.0"),
  campaignId: Id,
  campaignName: z.string().trim().min(1).max(200),
  brief: z.string().trim().min(1).max(4000),
  capturedAt: Timestamp,
  ideas: z.array(ideaSchema).min(1).max(MAX_IDEAS),
};
const refineIdeas = (
  value: { ideas: z.infer<typeof ideaSchema>[] },
  ctx: z.RefinementCtx,
) => {
  if (new Set(value.ideas.map((i) => i.ideaId)).size !== value.ideas.length) {
    ctx.addIssue({
      code: "custom",
      path: ["ideas"],
      message: "ideaId values must be unique",
    });
  }
};
const captureIdeationArgumentsSchema = z.strictObject(ideationFields)
  .superRefine(
    refineIdeas,
  );
const ideationSchema = z.strictObject({
  ...ideationFields,
  digest: Digest,
}).superRefine(
  refineIdeas,
);
const directionSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  campaignId: Id,
  approvalId: Id,
  principal: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(100),
  approvedAt: Timestamp,
  ideationDigest: Digest,
  selectedIdeaIds: z.array(Id).min(1).max(10),
  thesis: z.string().trim().min(1).max(1500),
  supportingPoints: z.array(z.string().trim().min(1).max(500)).min(2).max(8),
  digest: Digest,
});
const draftItem = z.strictObject({
  itemId: Id,
  ideaId: Id,
  variantId: Id,
  label: z.string().trim().min(1).max(200),
  channel: Id,
  scheduledAt: Timestamp,
  timeZone: TimeZone,
  planningStatus: z.enum(["planned", "approval_pending"]),
  content: z.record(z.string(), z.unknown()),
});
const releaseDraftSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  campaignId: Id,
  releaseId: Id,
  directionApprovalId: Id,
  directionDigest: Digest,
  preparedAt: Timestamp,
  items: z.array(draftItem).min(1).max(100),
  digest: Digest,
});
const requestSchema = z.strictObject({
  itemId: Id,
  model: z.string().trim().min(1).max(200),
  method: z.string().trim().min(1).max(100),
  arguments: z.record(z.string(), z.unknown()),
});
const approvedItem = draftItem.omit({ planningStatus: true }).extend({
  dispatch: z.strictObject({
    model: z.string(),
    method: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  }),
  intendedPlatformState: State,
  successfulObservedStates: z.array(State).min(1).max(10),
});
const approvedReleaseSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  campaignId: Id,
  releaseId: Id,
  directionApprovalId: Id,
  directionDigest: Digest,
  draftDigest: Digest,
  exactApproval: Approval,
  items: z.array(approvedItem).min(1).max(100),
  digest: Digest,
});
const ScheduleStatus = z.enum([
  "planned",
  "approval_pending",
  "approved",
  "dispatching",
  "scheduled",
  "published",
  "failed",
  "canceled",
]);
const scheduleEntrySchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  campaignId: Id,
  releaseId: Id,
  itemId: Id,
  ideaId: Id,
  variantId: Id,
  label: z.string().min(1),
  channel: Id,
  scheduledAt: Timestamp,
  timeZone: TimeZone,
  status: ScheduleStatus,
  approvalState: z.enum(["not_ready", "pending", "approved"]),
  intendedPlatformState: State,
  observedPlatformState: State,
  successfulObservedStates: z.array(State).min(1).max(10),
  releaseDigest: Digest.nullable(),
  dispatchAttemptId: Id.nullable(),
  dispatchClaimId: Digest.nullable(),
  platformReference: z.string().min(1).nullable(),
  detail: z.string().max(1000).nullable(),
  updatedAt: Timestamp,
});
const dispatchSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  campaignId: Id,
  releaseId: Id,
  itemId: Id,
  attemptId: Id,
  channel: Id,
  scheduledAt: Timestamp,
  releaseDigest: Digest,
  claimId: Digest,
  claimStatus: z.enum(["prepared", "reconciled"]),
  model: z.string(),
  method: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  preparedAt: Timestamp,
  reconciledAt: Timestamp.nullable(),
  deliveryStatus: z.enum(["scheduled", "published", "failed", "canceled"])
    .nullable(),
});
/** Validated snapshot contract consumed by the calendar report. */
export const calendarSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  generatedAt: Timestamp,
  from: Timestamp.nullable(),
  until: Timestamp.nullable(),
  entries: z.array(scheduleEntrySchema),
});

type Context = {
  modelType: string;
  modelId: string;
  globalArgs: Globals;
  methodName?: string;
  logger?: {
    info(message: string, properties?: Record<string, unknown>): void;
  };
  readResource(name: string): Promise<Record<string, unknown> | null>;
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<unknown>;
  dataRepository: {
    findAllForModel(
      type: string,
      modelId: string,
    ): Promise<
      Array<
        {
          name: string;
          version: number;
          tags?: Record<string, string>;
          lifecycle?: string;
          createdAt?: string;
        }
      >
    >;
    getContent(
      type: string,
      modelId: string,
      name: string,
      version?: number,
    ): Promise<Uint8Array | null>;
  };
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b)
      ).map((
        [k, v],
      ) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")
    }}`;
  }
  return JSON.stringify(value);
}
/** Return a stable SHA-256 digest of JSON-compatible data. */
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  ).map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** Digest the exact ordered publication request packet presented for approval. */
export const digestPublicationRequests = (value: unknown) => digest(value);
function dispatchClaimDigest(
  campaignId: string,
  releaseId: string,
  itemId: string,
  attemptId: string,
  releaseDigest: string,
  dispatch: {
    model: string;
    method: string;
    arguments: Record<string, unknown>;
  },
): Promise<string> {
  return digest({
    campaignId,
    releaseId,
    itemId,
    attemptId,
    releaseDigest,
    dispatch,
  });
}
async function createOnce(
  context: Context,
  spec: string,
  name: string,
  value: Record<string, unknown>,
): Promise<unknown | null> {
  const existing = await context.readResource(name);
  if (existing) {
    if (canonical(existing) !== canonical(value)) {
      throw new TypeError(`${name} already exists with different content`);
    }
    return null;
  }
  return await context.writeResource(spec, name, value);
}
function logEntry(context: Context, operation: string, identifiers = {}) {
  context.logger?.info("Marketing orchestration method {operation} entered", {
    operation,
    ...identifiers,
  });
}
function logCompletion(
  context: Context,
  operation: string,
  handles: unknown[],
) {
  context.logger?.info(
    "Marketing orchestration method {operation} completed with {outputCount} outputs",
    {
      operation,
      outputCount: handles.length,
    },
  );
  return { dataHandles: handles };
}
const dispatchLocks = new Map<string, Promise<void>>();
// Swamp holds an exclusive per-model-instance lock for the full method run,
// including across workflow workers. This narrower lock also preserves the
// invariant when consumers invoke execute directly in one JavaScript process.
async function serializeDispatch<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = dispatchLocks.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  dispatchLocks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (dispatchLocks.get(key) === tail) dispatchLocks.delete(key);
  }
}
async function readParsed<T>(
  context: Context,
  name: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const raw = await context.readResource(name);
  if (!raw) throw new TypeError(`required resource ${name} is missing`);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new TypeError(
      `required resource ${name} is invalid: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}
function immutableScheduleMatches(
  existing: z.infer<typeof scheduleEntrySchema>,
  expected: z.infer<typeof scheduleEntrySchema>,
): boolean {
  const mutable = new Set([
    "status",
    "approvalState",
    "releaseDigest",
    "dispatchAttemptId",
    "dispatchClaimId",
    "observedPlatformState",
    "platformReference",
    "detail",
    "updatedAt",
  ]);
  return Object.entries(expected).every(([key, value]) =>
    mutable.has(key) ||
    canonical(existing[key as keyof typeof existing]) === canonical(value)
  );
}
async function ensureSchedule(
  context: Context,
  name: string,
  expected: z.infer<typeof scheduleEntrySchema>,
): Promise<unknown | null> {
  const raw = await context.readResource(name);
  if (!raw) return await context.writeResource("scheduleEntry", name, expected);
  const existing = scheduleEntrySchema.safeParse(raw);
  if (!existing.success) {
    throw new TypeError(
      `existing schedule ${name} is invalid: ${
        z.prettifyError(existing.error)
      }`,
    );
  }
  if (!immutableScheduleMatches(existing.data, expected)) {
    throw new TypeError(
      `${name} already exists with different immutable content`,
    );
  }
  if (
    expected.approvalState === "approved" &&
    existing.data.approvalState !== "approved"
  ) return await context.writeResource("scheduleEntry", name, expected);
  return null;
}
function authorized(
  globals: Globals,
  principal: string,
  role: string,
): boolean {
  return globals.approvalPrincipals.some((entry) =>
    entry.principal === principal && entry.role === role
  );
}
function binding(globals: Globals, channel: string): z.infer<typeof Binding> {
  const found = globals.dispatchBindings.find((entry) =>
    entry.channel === channel
  );
  if (!found) throw new TypeError(`no dispatch binding for channel ${channel}`);
  return found;
}

const approveDirectionArgumentsSchema = directionSchema.omit({
  digest: true,
});
const stageReleaseArgumentsSchema = releaseDraftSchema.omit({
  directionDigest: true,
  digest: true,
});
const approveReleaseArgumentsSchema = z.strictObject({
  campaignId: Id,
  releaseId: Id,
  expectedDraftDigest: Digest,
  exactApproval: Approval,
  publicationRequests: z.array(requestSchema).min(1).max(100),
});
const prepareDispatchArgumentsSchema = z.strictObject({
  campaignId: Id,
  releaseId: Id,
  itemId: Id,
  attemptId: Id,
  asOf: Timestamp,
});
const recordDeliveryArgumentsSchema = z.strictObject({
  campaignId: Id,
  releaseId: Id,
  itemId: Id,
  expectedReleaseDigest: Digest,
  dispatchClaimId: Digest,
  attemptId: Id,
  status: z.enum(["scheduled", "published", "failed", "canceled"]),
  observedPlatformState: State,
  observedAt: Timestamp,
  platformReference: z.string().trim().min(1).max(500).nullable(),
  detail: z.string().trim().min(1).max(1000).nullable(),
});
const calendarArgumentsSchema = z.strictObject({
  generatedAt: Timestamp,
  from: Timestamp.nullable().default(null),
  until: Timestamp.nullable().default(null),
  statuses: z.array(ScheduleStatus).default([]),
}).superRefine((value, ctx) => {
  if (
    value.from && value.until &&
    Date.parse(value.from) > Date.parse(value.until)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["from"],
      message: "from must be before or equal to until",
    });
  }
});

/** Swamp model definition. */
export const model = {
  type: "@mgreten/marketing-orchestration",
  version: "2026.08.28.2",
  globalArguments: GlobalArgs,
  upgrades: [
    {
      toVersion: "2026.08.28.2",
      description: "Expose the model type in registry metadata",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  checks: {
    "valid-orchestration-configuration": {
      description:
        "Validate approval identities and publisher routes before mutation",
      labels: ["policy", "dependency"],
      execute: async (context: { globalArgs: unknown }) => {
        await Promise.resolve();
        const result = GlobalArgs.safeParse(context.globalArgs);
        return result.success ? { pass: true } : {
          pass: false,
          errors: [
            `Marketing orchestration configuration is invalid: ${
              z.prettifyError(result.error)
            }`,
          ],
        };
      },
    },
  },
  resources: {
    ideation: {
      description: "Bounded campaign ideation board",
      schema: ideationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    directionApproval: {
      description: "Immutable approval of one campaign direction",
      schema: directionSchema,
      lifetime: "infinite" as const,
      garbageCollection: 1,
    },
    releaseDraft: {
      description: "Release candidate awaiting exact approval",
      schema: releaseDraftSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    approvedRelease: {
      description: "Immutable exact-approved release packet",
      schema: approvedReleaseSchema,
      lifetime: "infinite" as const,
      garbageCollection: 1,
    },
    scheduleEntry: {
      description: "Intended and observed delivery state",
      schema: scheduleEntrySchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
    dispatch: {
      description: "Exact deterministic handoff to a configured publisher",
      schema: dispatchSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    calendar: {
      description: "Point-in-time content calendar",
      schema: calendarSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    captureIdeation: {
      description: "Persist bounded, diverse campaign ideation.",
      arguments: captureIdeationArgumentsSchema,
      execute: async (
        args: z.infer<typeof captureIdeationArgumentsSchema>,
        context: Context,
      ) => {
        logEntry(context, "captureIdeation", { campaignId: args.campaignId });
        const policy = context.globalArgs.ideationPolicy;
        if (
          args.ideas.length < policy.minIdeas ||
          args.ideas.length > policy.maxIdeas
        ) {
          throw new TypeError(
            `ideation requires ${policy.minIdeas}-${policy.maxIdeas} ideas`,
          );
        }
        if (
          new Set(args.ideas.map((idea) => idea.group)).size < policy.minGroups
        ) {
          throw new TypeError(
            `ideation requires at least ${policy.minGroups} groups`,
          );
        }
        if (await context.readResource(`direction-${args.campaignId}`)) {
          throw new TypeError(
            "approved campaign ideation is frozen",
          );
        }
        const value = ideationSchema.parse({
          ...args,
          digest: await digest(args),
        });
        return logCompletion(context, "captureIdeation", [
          await context.writeResource(
            "ideation",
            `ideation-${args.campaignId}`,
            value,
          ),
        ]);
      },
    },
    approveDirection: {
      description:
        "Bind an authorized principal's direction approval to exact ideation.",
      arguments: approveDirectionArgumentsSchema,
      execute: async (
        args: z.infer<typeof approveDirectionArgumentsSchema>,
        context: Context,
      ) => {
        logEntry(context, "approveDirection", { campaignId: args.campaignId });
        if (!authorized(context.globalArgs, args.principal, args.role)) {
          throw new TypeError("approval principal is not authorized");
        }
        const ideation = await readParsed(
          context,
          `ideation-${args.campaignId}`,
          ideationSchema,
        );
        if (args.ideationDigest !== ideation.digest) {
          throw new TypeError("ideation digest mismatch");
        }
        const known = new Set(ideation.ideas.map((idea) => idea.ideaId));
        if (args.selectedIdeaIds.some((id) => !known.has(id))) {
          throw new TypeError("direction references an unknown idea");
        }
        const value = directionSchema.parse({
          ...args,
          digest: await digest(args),
        });
        const handle = await createOnce(
          context,
          "directionApproval",
          `direction-${args.campaignId}`,
          value,
        );
        return logCompletion(
          context,
          "approveDirection",
          handle ? [handle] : [],
        );
      },
    },
    stageRelease: {
      description:
        "Stage channel variants and schedule slots before exact release approval.",
      arguments: stageReleaseArgumentsSchema,
      execute: async (
        args: z.infer<typeof stageReleaseArgumentsSchema>,
        context: Context,
      ) => {
        logEntry(context, "stageRelease", {
          campaignId: args.campaignId,
          releaseId: args.releaseId,
        });
        const direction = await readParsed(
          context,
          `direction-${args.campaignId}`,
          directionSchema,
        );
        if (args.directionApprovalId !== direction.approvalId) {
          throw new TypeError("direction approval mismatch");
        }
        const selected = new Set(direction.selectedIdeaIds);
        if (args.items.some((item) => !selected.has(item.ideaId))) {
          throw new TypeError("release item is outside the approved direction");
        }
        if (
          new Set(args.items.map((item) => item.itemId)).size !==
            args.items.length
        ) {
          throw new TypeError("itemId values must be unique");
        }
        for (const item of args.items) {
          binding(context.globalArgs, item.channel);
        }
        const base = { ...args, directionDigest: direction.digest };
        const value = releaseDraftSchema.parse({
          ...base,
          digest: await digest(base),
        });
        const handles: unknown[] = [];
        const draftHandle = await createOnce(
          context,
          "releaseDraft",
          `release-draft-${args.campaignId}-${args.releaseId}`,
          value,
        );
        if (draftHandle) handles.push(draftHandle);
        for (const item of value.items) {
          const route = binding(context.globalArgs, item.channel);
          const scheduleHandle = await ensureSchedule(
            context,
            `schedule-${args.campaignId}-${args.releaseId}-${item.itemId}`,
            scheduleEntrySchema.parse({
              schemaVersion: "1.0",
              campaignId: args.campaignId,
              releaseId: args.releaseId,
              itemId: item.itemId,
              ideaId: item.ideaId,
              variantId: item.variantId,
              label: item.label,
              channel: item.channel,
              scheduledAt: item.scheduledAt,
              timeZone: item.timeZone,
              status: item.planningStatus,
              approvalState: item.planningStatus === "planned"
                ? "not_ready"
                : "pending",
              intendedPlatformState: route.intendedState,
              observedPlatformState: context.globalArgs.states.initialObserved,
              successfulObservedStates: route.successfulObservedStates,
              releaseDigest: null,
              dispatchAttemptId: null,
              dispatchClaimId: null,
              platformReference: null,
              detail: null,
              updatedAt: args.preparedAt,
            }),
          );
          if (scheduleHandle) handles.push(scheduleHandle);
        }
        return logCompletion(context, "stageRelease", handles);
      },
    },
    approveRelease: {
      description:
        "Create an immutable digest-bound release using configured dispatch bindings.",
      arguments: approveReleaseArgumentsSchema,
      execute: async (
        args: z.infer<typeof approveReleaseArgumentsSchema>,
        context: Context,
      ) => {
        logEntry(context, "approveRelease", {
          campaignId: args.campaignId,
          releaseId: args.releaseId,
        });
        const draft = await readParsed(
          context,
          `release-draft-${args.campaignId}-${args.releaseId}`,
          releaseDraftSchema,
        );
        if (
          draft.digest !== args.expectedDraftDigest ||
          args.exactApproval.draftDigest !== draft.digest
        ) throw new TypeError("release draft digest mismatch");
        if (
          !authorized(
            context.globalArgs,
            args.exactApproval.principal,
            args.exactApproval.role,
          )
        ) throw new TypeError("approval principal is not authorized");
        const publicationRequestsDigest = await digest(
          args.publicationRequests,
        );
        if (
          args.exactApproval.publicationRequestsDigest !==
            publicationRequestsDigest
        ) {
          throw new TypeError(
            "exact approval publication request digest mismatch",
          );
        }
        if (
          draft.items.some((item) => item.planningStatus !== "approval_pending")
        ) {
          throw new TypeError("planned items are not ready for exact approval");
        }
        const requests = new Map(
          args.publicationRequests.map((request) => [request.itemId, request]),
        );
        if (requests.size !== draft.items.length) {
          throw new TypeError(
            "exactly one publication request per item is required",
          );
        }
        const items = draft.items.map(
          ({ planningStatus: _planningStatus, ...item }) => {
            const request = requests.get(item.itemId);
            if (!request) {
              throw new TypeError(
                `publication request missing for ${item.itemId}`,
              );
            }
            const route = binding(context.globalArgs, item.channel);
            if (
              request.model !== route.model || request.method !== route.method
            ) {
              throw new TypeError(
                `publication request route mismatch for ${item.itemId}`,
              );
            }
            return {
              ...item,
              dispatch: {
                model: request.model,
                method: request.method,
                arguments: request.arguments,
              },
              intendedPlatformState: route.intendedState,
              successfulObservedStates: route.successfulObservedStates,
            };
          },
        );
        const base = {
          schemaVersion: "1.0" as const,
          campaignId: draft.campaignId,
          releaseId: draft.releaseId,
          directionApprovalId: draft.directionApprovalId,
          directionDigest: draft.directionDigest,
          draftDigest: draft.digest,
          exactApproval: args.exactApproval,
          items,
        };
        const value = approvedReleaseSchema.parse({
          ...base,
          digest: await digest(base),
        });
        const releaseHandle = await createOnce(
          context,
          "approvedRelease",
          `release-approved-${args.campaignId}-${args.releaseId}`,
          value,
        );
        const handles: unknown[] = releaseHandle ? [releaseHandle] : [];
        for (const item of value.items) {
          const scheduleHandle = await ensureSchedule(
            context,
            `schedule-${args.campaignId}-${args.releaseId}-${item.itemId}`,
            scheduleEntrySchema.parse({
              schemaVersion: "1.0",
              campaignId: args.campaignId,
              releaseId: args.releaseId,
              itemId: item.itemId,
              ideaId: item.ideaId,
              variantId: item.variantId,
              label: item.label,
              channel: item.channel,
              scheduledAt: item.scheduledAt,
              timeZone: item.timeZone,
              status: "approved",
              approvalState: "approved",
              intendedPlatformState: item.intendedPlatformState,
              observedPlatformState: context.globalArgs.states.initialObserved,
              successfulObservedStates: item.successfulObservedStates,
              releaseDigest: value.digest,
              dispatchAttemptId: null,
              dispatchClaimId: null,
              platformReference: null,
              detail: null,
              updatedAt: args.exactApproval.approvedAt,
            }),
          );
          if (scheduleHandle) handles.push(scheduleHandle);
        }
        return logCompletion(context, "approveRelease", handles);
      },
    },
    prepareDispatch: {
      description:
        "Fail closed unless an exact approved item is due and dispatchable.",
      arguments: prepareDispatchArgumentsSchema,
      execute: async (
        args: z.infer<typeof prepareDispatchArgumentsSchema>,
        context: Context,
      ) => {
        logEntry(context, "prepareDispatch", {
          campaignId: args.campaignId,
          releaseId: args.releaseId,
          itemId: args.itemId,
          attemptId: args.attemptId,
        });
        const dispatchKey =
          `${context.modelType}:${context.modelId}:${args.campaignId}:${args.releaseId}:${args.itemId}`;
        return await serializeDispatch(dispatchKey, async () => {
          const release = await readParsed(
            context,
            `release-approved-${args.campaignId}-${args.releaseId}`,
            approvedReleaseSchema,
          );
          const item = release.items.find((candidate) =>
            candidate.itemId === args.itemId
          );
          if (!item) throw new TypeError("approved release item not found");
          const claimName =
            `dispatch-${args.campaignId}-${args.releaseId}-${args.itemId}-${args.attemptId}`;
          const claimId = await dispatchClaimDigest(
            args.campaignId,
            args.releaseId,
            args.itemId,
            args.attemptId,
            release.digest,
            item.dispatch,
          );
          const scheduleName =
            `schedule-${args.campaignId}-${args.releaseId}-${args.itemId}`;
          const schedule = await readParsed(
            context,
            scheduleName,
            scheduleEntrySchema,
          );
          if (schedule.releaseDigest !== release.digest) {
            throw new TypeError("release item is not dispatchable");
          }
          if (Date.parse(args.asOf) < Date.parse(item.scheduledAt)) {
            throw new TypeError("release item is not due");
          }
          const sameBinding = schedule.dispatchAttemptId === args.attemptId &&
            schedule.dispatchClaimId === claimId;
          if (schedule.status === "dispatching" && !sameBinding) {
            throw new TypeError(
              "another dispatch attempt is already in progress",
            );
          }
          if (schedule.status === "failed" && sameBinding) {
            throw new TypeError("failed dispatch attempt cannot be re-emitted");
          }
          if (
            schedule.status !== "dispatching" &&
            !["approved", "failed"].includes(schedule.status)
          ) throw new TypeError("release item is not dispatchable");
          if (
            schedule.status === "failed" &&
            schedule.dispatchAttemptId === args.attemptId
          ) {
            throw new TypeError("failed dispatch attempt cannot be re-emitted");
          }
          const value = dispatchSchema.parse({
            schemaVersion: "1.0",
            campaignId: args.campaignId,
            releaseId: args.releaseId,
            itemId: item.itemId,
            attemptId: args.attemptId,
            channel: item.channel,
            scheduledAt: item.scheduledAt,
            releaseDigest: release.digest,
            claimId,
            claimStatus: "prepared",
            ...item.dispatch,
            preparedAt: schedule.status === "dispatching"
              ? schedule.updatedAt
              : args.asOf,
            reconciledAt: null,
            deliveryStatus: null,
          });
          if (schedule.status !== "dispatching") {
            const latestSchedule = await readParsed(
              context,
              scheduleName,
              scheduleEntrySchema,
            );
            if (
              latestSchedule.status === "dispatching" &&
              (latestSchedule.dispatchAttemptId !== args.attemptId ||
                latestSchedule.dispatchClaimId !== claimId)
            ) {
              throw new TypeError(
                "another dispatch attempt is already in progress",
              );
            }
            if (canonical(latestSchedule) !== canonical(schedule)) {
              throw new TypeError("schedule changed while preparing dispatch");
            }
            await context.writeResource(
              "scheduleEntry",
              scheduleName,
              scheduleEntrySchema.parse({
                ...schedule,
                status: "dispatching",
                dispatchAttemptId: args.attemptId,
                dispatchClaimId: claimId,
                updatedAt: args.asOf,
              }),
            );
          }
          const existingClaim = await context.readResource(claimName);
          if (existingClaim) {
            const parsed = dispatchSchema.safeParse(existingClaim);
            if (
              !parsed.success || canonical(parsed.data) !== canonical(value)
            ) {
              throw new TypeError(
                `${claimName} already exists with a mismatched attempt binding`,
              );
            }
            return logCompletion(context, "prepareDispatch", []);
          }
          const handle = await createOnce(
            context,
            "dispatch",
            claimName,
            value,
          );
          return logCompletion(
            context,
            "prepareDispatch",
            handle ? [handle] : [],
          );
        });
      },
    },
    recordDelivery: {
      description:
        "Record a validated delivery-state transition without changing approved content.",
      arguments: recordDeliveryArgumentsSchema,
      execute: async (
        args: z.infer<typeof recordDeliveryArgumentsSchema>,
        context: Context,
      ) => {
        logEntry(context, "recordDelivery", {
          campaignId: args.campaignId,
          releaseId: args.releaseId,
          itemId: args.itemId,
        });
        const release = await readParsed(
          context,
          `release-approved-${args.campaignId}-${args.releaseId}`,
          approvedReleaseSchema,
        );
        const item = release.items.find((candidate) =>
          candidate.itemId === args.itemId
        );
        if (!item) throw new TypeError("approved release item not found");
        if (release.digest !== args.expectedReleaseDigest) {
          throw new TypeError("release digest mismatch");
        }
        const expectedClaimId = await dispatchClaimDigest(
          args.campaignId,
          args.releaseId,
          args.itemId,
          args.attemptId,
          release.digest,
          item.dispatch,
        );
        const name =
          `schedule-${args.campaignId}-${args.releaseId}-${args.itemId}`;
        const current = await readParsed(
          context,
          name,
          scheduleEntrySchema,
        );
        if (current.releaseDigest !== args.expectedReleaseDigest) {
          throw new TypeError("release digest mismatch");
        }
        if (
          current.dispatchAttemptId !== args.attemptId ||
          current.dispatchClaimId !== expectedClaimId ||
          args.dispatchClaimId !== expectedClaimId
        ) throw new TypeError("schedule dispatch binding mismatch");
        const claimName =
          `dispatch-${args.campaignId}-${args.releaseId}-${args.itemId}-${args.attemptId}`;
        const claim = await readParsed(context, claimName, dispatchSchema);
        if (
          claim.claimId !== expectedClaimId ||
          args.dispatchClaimId !== expectedClaimId ||
          claim.attemptId !== args.attemptId ||
          claim.campaignId !== args.campaignId ||
          claim.releaseId !== args.releaseId ||
          claim.itemId !== args.itemId ||
          claim.releaseDigest !== release.digest ||
          claim.model !== item.dispatch.model ||
          claim.method !== item.dispatch.method ||
          canonical(claim.arguments) !== canonical(item.dispatch.arguments)
        ) throw new TypeError("dispatch claim mismatch");
        if (Date.parse(args.observedAt) < Date.parse(current.updatedAt)) {
          throw new TypeError(
            "delivery observation predates current schedule state",
          );
        }
        const exactScheduleReplay = current.status === args.status &&
          current.observedPlatformState === args.observedPlatformState &&
          current.updatedAt === args.observedAt &&
          current.platformReference === args.platformReference &&
          current.detail === args.detail;
        const allowed: Record<string, string[]> = {
          dispatching: ["scheduled", "published", "failed", "canceled"],
          scheduled: ["published", "failed", "canceled"],
          published: [],
          failed: [],
          canceled: [],
        };
        if (
          !exactScheduleReplay &&
          !(allowed[current.status] ?? []).includes(args.status)
        ) {
          throw new TypeError(
            `invalid schedule transition ${current.status} -> ${args.status}`,
          );
        }
        if (
          args.status === "scheduled" &&
          args.observedPlatformState !==
            context.globalArgs.states.queuedObserved
        ) {
          throw new TypeError(
            "scheduled delivery requires configured queued state",
          );
        }
        if (
          args.status === "published" &&
          (!args.platformReference ||
            !current.successfulObservedStates.includes(
              args.observedPlatformState,
            ))
        ) {
          throw new TypeError(
            "published delivery requires a platform reference and configured successful state",
          );
        }
        if (
          args.status === "failed" &&
          args.observedPlatformState !==
            context.globalArgs.states.failedObserved
        ) {
          throw new TypeError(
            "failed delivery requires configured failed state",
          );
        }
        if (
          args.status === "canceled" &&
          args.observedPlatformState !==
            context.globalArgs.states.canceledObserved
        ) {
          throw new TypeError(
            "canceled delivery requires configured canceled state",
          );
        }
        const reconciledClaim = dispatchSchema.parse({
          ...claim,
          claimStatus: "reconciled",
          reconciledAt: args.observedAt,
          deliveryStatus: args.status,
        });
        if (claim.claimStatus === "reconciled") {
          if (canonical(claim) === canonical(reconciledClaim)) {
            if (!exactScheduleReplay) {
              throw new TypeError("dispatch claim and schedule state disagree");
            }
            return logCompletion(context, "recordDelivery", []);
          }
          if (
            exactScheduleReplay &&
            !(allowed[claim.deliveryStatus ?? ""] ?? []).includes(args.status)
          ) {
            throw new TypeError("dispatch claim is reconciled differently");
          }
          if (!exactScheduleReplay && claim.deliveryStatus !== current.status) {
            throw new TypeError("dispatch claim and schedule state disagree");
          }
        }
        if (exactScheduleReplay) {
          return logCompletion(context, "recordDelivery", [
            await context.writeResource("dispatch", claimName, reconciledClaim),
          ]);
        }
        const next = scheduleEntrySchema.parse({
          ...current,
          status: args.status,
          observedPlatformState: args.observedPlatformState,
          platformReference: args.platformReference,
          detail: args.detail,
          updatedAt: args.observedAt,
        });
        const handles = [
          await context.writeResource("scheduleEntry", name, next),
          await context.writeResource("dispatch", claimName, reconciledClaim),
        ];
        return logCompletion(context, "recordDelivery", handles);
      },
    },
    calendar: {
      description:
        "Build the latest bounded schedule snapshot for report rendering.",
      arguments: calendarArgumentsSchema,
      execute: async (
        args: z.infer<typeof calendarArgumentsSchema>,
        context: Context,
      ) => {
        logEntry(context, "calendar", { generatedAt: args.generatedAt });
        if (
          args.from && args.until &&
          Date.parse(args.from) > Date.parse(args.until)
        ) {
          throw new TypeError(
            "calendar window is invalid: from must be before or equal to until",
          );
        }
        const all = await context.dataRepository.findAllForModel(
          context.modelType,
          context.modelId,
        );
        const latest = new Map<
          string,
          { name: string; version: number; lifecycle?: string }
        >();
        for (const item of all) {
          if (
            item.tags?.specName === "scheduleEntry" &&
            typeof item.createdAt === "string" &&
            Number.isFinite(Date.parse(item.createdAt)) &&
            Date.parse(item.createdAt) <= Date.parse(args.generatedAt) &&
            (!latest.has(item.name) ||
              item.version > latest.get(item.name)!.version)
          ) latest.set(item.name, item);
        }
        const entries: z.infer<typeof scheduleEntrySchema>[] = [];
        for (const item of latest.values()) {
          if (item.lifecycle === "deleted") continue;
          const raw = await context.dataRepository.getContent(
            context.modelType,
            context.modelId,
            item.name,
            item.version,
          );
          if (!raw) {
            throw new TypeError(
              `schedule ${item.name} version ${item.version} content is unavailable`,
            );
          }
          let json: unknown;
          try {
            json = JSON.parse(new TextDecoder().decode(raw));
          } catch (error) {
            throw new TypeError(
              `schedule ${item.name} version ${item.version} contains invalid JSON: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          const parsed = scheduleEntrySchema.safeParse(json);
          if (!parsed.success) {
            throw new TypeError(
              `schedule ${item.name} version ${item.version} is invalid: ${
                z.prettifyError(parsed.error)
              }`,
            );
          }
          const entry = parsed.data;
          if (
            args.from && Date.parse(entry.scheduledAt) < Date.parse(args.from)
          ) continue;
          if (
            args.until &&
            Date.parse(entry.scheduledAt) >= Date.parse(args.until)
          ) continue;
          if (args.statuses.length && !args.statuses.includes(entry.status)) {
            continue;
          }
          entries.push(entry);
        }
        entries.sort((a, b) =>
          a.scheduledAt.localeCompare(b.scheduledAt) ||
          a.channel.localeCompare(b.channel) ||
          a.itemId.localeCompare(b.itemId)
        );
        const value = calendarSchema.parse({
          schemaVersion: "1.0",
          generatedAt: args.generatedAt,
          from: args.from,
          until: args.until,
          entries,
        });
        return logCompletion(context, "calendar", [
          await context.writeResource("calendar", "calendar-current", value),
        ]);
      },
    },
  },
};
