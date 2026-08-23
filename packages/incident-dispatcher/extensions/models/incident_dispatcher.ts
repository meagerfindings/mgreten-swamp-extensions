import { z } from "npm:zod@4";

/** Version of the incident-dispatcher model contract. */
export const MODEL_VERSION = "2026.08.23.1" as const;
const Time = z.iso.datetime({ offset: true });
const Id = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Ref = z.strictObject({ modelName: Id, resourceName: Id });
const policySchema = z.strictObject({
  allowedProviders: z.array(Id).min(1).max(20),
  modelPattern: z.string().min(1).max(200).default(
    "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
  ),
  workspaceRoot: z.string().startsWith("/tmp/").max(240).default(
    "/tmp/incident-dispatcher",
  ),
  maxPromptBytes: z.number().int().min(1000).max(20000).default(12000),
  sameCauseFailureLimit: z.number().int().min(1).max(12).default(3),
});
type Policy = z.infer<typeof policySchema>;
const summary = z.string().trim().min(1).max(280).superRefine((value, ctx) => {
  if (
    /[\r\n]|https?:\/\/|\b(?:api[_ -]?key|password|secret|bearer|token)\s*[:=]/i
      .test(value)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "summary contains prohibited raw content",
    });
  }
});
const incidentSchema = z.strictObject({
  incidentId: Id,
  status: z.enum(["open", "resolved"]),
  openedAt: Time,
  observedAt: Time,
  evidenceRefs: z.array(Id).min(1).max(40),
});
const observeArgs = z.strictObject({
  observedAt: Time,
  trigger: z.enum(["new", "material-change", "retry", "authorized-request"])
    .default("new"),
  materialEvidenceFingerprint: Hash.nullable().default(null),
  incident: incidentSchema,
  incidentRef: Ref,
  contextRef: Ref,
});
const attempt = z.strictObject({
  attempt: z.number().int().positive(),
  invocationId: Id,
  fingerprint: Hash,
  trigger: observeArgs.shape.trigger,
  queuedAt: Time,
});
/** Schema for the durable eligibility and attempt lifecycle of an incident. */
export const lifecycleSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  incidentId: Id,
  status: z.enum(["queued", "running", "completed", "failed", "stopped"]),
  eligibility: z.strictObject({
    eligible: z.boolean(),
    reason: z.enum([
      "new-incident",
      "material-change",
      "eligible-retry",
      "authorized-request",
      "duplicate",
      "active",
      "not-open",
      "failure-limit",
    ]),
  }),
  fingerprint: Hash,
  invocationId: Id.nullable(),
  attempts: z.array(attempt).max(12),
  sameCauseFailures: z.number().int().nonnegative(),
  failureCauseFingerprint: Hash.nullable(),
  incident: incidentSchema,
  incidentRef: Ref,
  contextRef: Ref,
  authority: z.strictObject({
    execution: z.literal("external-only"),
    network: z.literal("forbidden"),
    remediation: z.literal("forbidden"),
  }),
});
const prepareArgs = z.strictObject({ incidentId: Id, preparedAt: Time });
/** Schema for the minimized request handed to an external execution platform. */
export const requestSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  incidentId: Id,
  invocationId: Id,
  preparedAt: Time,
  workspace: z.string().startsWith("/tmp/"),
  prompt: z.string().min(1).max(20000),
  promptHash: Hash,
  incident: incidentSchema,
  incidentRef: Ref,
  contextRef: Ref,
  handling: z.strictObject({
    rawEvidenceIncluded: z.literal(false),
    credentialsIncluded: z.literal(false),
    sourceIncluded: z.literal(false),
  }),
  requiredExecutionPolicy: z.strictObject({
    tools: z.literal("deny-all"),
    sandbox: z.literal("required"),
    sideEffects: z.literal("none"),
  }),
});
const agentOutput = z.strictObject({
  schemaVersion: z.literal("1.0"),
  incidentId: Id,
  invocationId: Id,
  generatedAt: Time,
  verdict: z.enum([
    "no-action",
    "needs-review",
    "needs-investigation",
    "confirmed",
    "inconclusive",
  ]),
  summary,
  confidence: z.enum(["low", "medium", "high"]),
  findingCodes: z.array(Id).min(1).max(20),
  evidenceRefs: z.array(Id).min(1).max(40),
  nextAction: z.enum([
    "monitor",
    "review",
    "read-only-investigation",
    "escalate",
  ]),
});
const audit = z.strictObject({
  invocationId: Id,
  provider: Id,
  model: z.string().min(1).max(100),
  promptHash: Hash,
  workspace: z.string().startsWith("/tmp/"),
  success: z.literal(true),
  tools: z.literal("deny-all"),
  sandbox: z.literal("required"),
  sideEffects: z.literal("none"),
  durationMs: z.number().nonnegative(),
  usage: z.strictObject({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  }),
});
const validateArgs = z.strictObject({
  incidentId: Id,
  invocationId: Id,
  validatedAt: Time,
  request: requestSchema,
  agentOutput,
  audit,
});
/** Schema for a validated, sanitized external assessment result. */
export const resultSchema = agentOutput.extend({
  resultId: Id,
  lifecycleRef: Ref,
  provider: Id,
  model: z.string(),
  promptHash: Hash,
  usage: audit.shape.usage,
  rawOutputIncluded: z.literal(false),
  authority: z.strictObject({
    notification: z.literal("external-only"),
    remediation: z.literal("forbidden"),
  }),
});
const outcomeArgs = z.strictObject({
  incidentId: Id,
  invocationId: Id,
  recordedAt: Time,
  outcome: z.enum(["completed", "failed"]),
  failureCause: z.string().min(1).max(500).optional(),
});

type Context = {
  globalArgs?: Policy;
  readResource(name: string): Promise<Record<string, unknown> | null>;
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<unknown>;
  ensureWorkspace?: (path: string) => Promise<string>;
};
const canon = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canon).join(",")}]`
    : v !== null && typeof v === "object"
    ? `{${
      Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b)
      ).map(([k, x]) => `${JSON.stringify(k)}:${canon(x)}`).join(",")
    }}`
    : JSON.stringify(v);
const hash = async (v: unknown) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(typeof v === "string" ? v : canon(v)),
      ),
    ),
  ].map((x) => x.toString(16).padStart(2, "0")).join("");
const policy = (ctx: Context) =>
  policySchema.parse(ctx.globalArgs ?? { allowedProviders: ["provider"] });
const lifeName = (id: string) => `lifecycle-${id}`;
const requestName = (id: string) => `request-${id}`;

/** Evaluates an observation and durably records its gated lifecycle state. */
export async function observe(raw: unknown, ctx: Context) {
  const a = observeArgs.parse(raw);
  const parsed = lifecycleSchema.safeParse(
    await ctx.readResource(lifeName(a.incident.incidentId)),
  );
  const prior = parsed.success ? parsed.data : null;
  const fingerprint = await hash({
    incident: a.incident,
    materialEvidenceFingerprint: a.materialEvidenceFingerprint,
  });
  let eligible = false;
  let reason: z.infer<typeof lifecycleSchema>["eligibility"]["reason"] =
    "duplicate";
  if (a.incident.status !== "open") reason = "not-open";
  else if (!prior) {
    eligible = true;
    reason = "new-incident";
  } else if (["queued", "running"].includes(prior.status)) reason = "active";
  else if (
    prior.status === "stopped" &&
    prior.sameCauseFailures >= policy(ctx).sameCauseFailureLimit
  ) reason = "failure-limit";
  else if (a.trigger === "authorized-request") {
    eligible = true;
    reason = "authorized-request";
  } else if (
    a.trigger === "material-change" && a.materialEvidenceFingerprint &&
    fingerprint !== prior.fingerprint
  ) {
    eligible = true;
    reason = "material-change";
  } else if (a.trigger === "retry" && prior.status === "failed") {
    eligible = true;
    reason = "eligible-retry";
  }
  const attempts = prior?.attempts ?? [];
  const invocationId = eligible
    ? `inv-${a.incident.incidentId}-${fingerprint.slice(0, 12)}-${
      attempts.length + 1
    }`
    : prior?.invocationId ?? null;
  const value = lifecycleSchema.parse({
    schemaVersion: "1.0",
    incidentId: a.incident.incidentId,
    status: eligible ? "queued" : prior?.status ?? "stopped",
    eligibility: { eligible, reason },
    fingerprint: eligible ? fingerprint : prior?.fingerprint ?? fingerprint,
    invocationId,
    attempts: eligible
      ? [...attempts, {
        attempt: attempts.length + 1,
        invocationId,
        fingerprint,
        trigger: a.trigger,
        queuedAt: a.observedAt,
      }]
      : attempts,
    sameCauseFailures: prior?.sameCauseFailures ?? 0,
    failureCauseFingerprint: prior?.failureCauseFingerprint ?? null,
    incident: eligible ? a.incident : prior?.incident ?? a.incident,
    incidentRef: eligible ? a.incidentRef : prior?.incidentRef ?? a.incidentRef,
    contextRef: eligible ? a.contextRef : prior?.contextRef ?? a.contextRef,
    authority: {
      execution: "external-only",
      network: "forbidden",
      remediation: "forbidden",
    },
  });
  return {
    value,
    handle: await ctx.writeResource(
      "lifecycle",
      lifeName(value.incidentId),
      value,
    ),
  };
}

/** Builds the bounded offline-assessment prompt for a prepared request. */
export function buildPrompt(
  request: Omit<z.infer<typeof requestSchema>, "prompt" | "promptHash">,
) {
  return [
    "Perform one offline, read-only incident assessment.",
    "Use no tools. Return only one JSON object matching OUTPUT_JSON_SCHEMA.",
    "Use only typed metadata and opaque evidence references. Do not infer unprovided facts, request raw evidence, contact anyone, remediate, or perform side effects.",
    `OUTPUT_JSON_SCHEMA=${JSON.stringify(z.toJSONSchema(agentOutput))}`,
    `INCIDENT_INPUT_JSON=${
      JSON.stringify({
        incidentId: request.incidentId,
        invocationId: request.invocationId,
        incident: request.incident,
        contextRef: request.contextRef,
        handling: request.handling,
        requiredExecutionPolicy: request.requiredExecutionPolicy,
      })
    }`,
  ].join("\n");
}

/** Persists and returns the request for one eligible external invocation. */
export async function prepareInvocation(raw: unknown, ctx: Context) {
  const a = prepareArgs.parse(raw);
  const life = lifecycleSchema.parse(
    await ctx.readResource(lifeName(a.incidentId)),
  );
  if (!["queued", "running"].includes(life.status) || !life.invocationId) {
    throw new TypeError("incident lacks a queued invocation");
  }
  const existing = requestSchema.safeParse(
    await ctx.readResource(requestName(life.invocationId)),
  );
  if (existing.success) {
    if (existing.data.incidentId !== life.incidentId) {
      throw new TypeError("stored request does not match queued invocation");
    }
    if (life.status === "running") {
      return { value: existing.data, handles: [] };
    }
    const running = lifecycleSchema.parse({ ...life, status: "running" });
    return {
      value: existing.data,
      handles: [
        await ctx.writeResource(
          "lifecycle",
          lifeName(life.incidentId),
          running,
        ),
      ],
    };
  }
  if (life.status === "running") {
    throw new TypeError("running invocation lacks its durable request");
  }
  const p = policy(ctx);
  const requested = `${p.workspaceRoot}/${life.invocationId}`;
  const workspace = ctx.ensureWorkspace
    ? await ctx.ensureWorkspace(requested)
    : requested;
  if (!workspace.startsWith("/tmp/")) {
    throw new TypeError("workspace must remain under /tmp");
  }
  const base = {
    schemaVersion: "1.0" as const,
    incidentId: life.incidentId,
    invocationId: life.invocationId,
    preparedAt: a.preparedAt,
    workspace,
    incident: life.incident,
    incidentRef: life.incidentRef,
    contextRef: life.contextRef,
    handling: {
      rawEvidenceIncluded: false as const,
      credentialsIncluded: false as const,
      sourceIncluded: false as const,
    },
    requiredExecutionPolicy: {
      tools: "deny-all" as const,
      sandbox: "required" as const,
      sideEffects: "none" as const,
    },
  };
  const prompt = buildPrompt(base);
  if (new TextEncoder().encode(prompt).byteLength > p.maxPromptBytes) {
    throw new TypeError("prompt exceeds policy limit");
  }
  const value = requestSchema.parse({
    ...base,
    prompt,
    promptHash: await hash(prompt),
  });
  const running = lifecycleSchema.parse({ ...life, status: "running" });
  return {
    value,
    handles: [
      await ctx.writeResource(
        "invocationRequest",
        requestName(value.invocationId),
        value,
      ),
      await ctx.writeResource("lifecycle", lifeName(value.incidentId), running),
    ],
  };
}

/** Records completion or failure for the lifecycle's active invocation. */
export async function recordOutcome(raw: unknown, ctx: Context) {
  const a = outcomeArgs.parse(raw);
  const prior = lifecycleSchema.parse(
    await ctx.readResource(lifeName(a.incidentId)),
  );
  if (
    prior.invocationId !== a.invocationId ||
    !["queued", "running"].includes(prior.status)
  ) throw new TypeError("outcome does not match active invocation");
  if (a.outcome === "failed" && !a.failureCause) {
    throw new TypeError("failed outcome requires failureCause");
  }
  const cause = a.failureCause
    ? await hash(a.failureCause.trim().toLowerCase())
    : null;
  const failures = a.outcome === "failed"
    ? cause === prior.failureCauseFingerprint ? prior.sameCauseFailures + 1 : 1
    : 0;
  const stopped = a.outcome === "failed" &&
    failures >= policy(ctx).sameCauseFailureLimit;
  const value = lifecycleSchema.parse({
    ...prior,
    status: stopped ? "stopped" : a.outcome,
    eligibility: {
      eligible: false,
      reason: stopped ? "failure-limit" : "duplicate",
    },
    sameCauseFailures: failures,
    failureCauseFingerprint: a.outcome === "failed" ? cause : null,
  });
  return {
    value,
    handle: await ctx.writeResource(
      "lifecycle",
      lifeName(value.incidentId),
      value,
    ),
  };
}

/** Validates request, audit, and output bindings before persisting a result. */
export async function validateAndRecordInvocation(raw: unknown, ctx: Context) {
  const a = validateArgs.parse(raw);
  const request = requestSchema.parse(
    await ctx.readResource(requestName(a.invocationId)),
  );
  const life = lifecycleSchema.parse(
    await ctx.readResource(lifeName(a.incidentId)),
  );
  const p = policy(ctx);
  if (
    canon(a.request) !== canon(request) ||
    !["running", "completed"].includes(life.status) ||
    life.invocationId !== a.invocationId ||
    a.agentOutput.incidentId !== a.incidentId ||
    a.agentOutput.invocationId !== a.invocationId ||
    a.audit.invocationId !== a.invocationId ||
    a.audit.promptHash !== request.promptHash ||
    a.audit.workspace !== request.workspace
  ) throw new TypeError("invocation identity or audit binding is invalid");
  if (
    !p.allowedProviders.includes(a.audit.provider) ||
    !(new RegExp(p.modelPattern).test(a.audit.model))
  ) throw new TypeError("provider or model violates policy");
  if (
    !a.agentOutput.evidenceRefs.every((ref) =>
      request.incident.evidenceRefs.includes(ref)
    )
  ) throw new TypeError("output cites unclaimed evidence");
  if (
    a.validatedAt !== a.agentOutput.generatedAt ||
    Date.parse(a.agentOutput.generatedAt) < Date.parse(request.preparedAt)
  ) throw new TypeError("output timestamp is invalid");
  const value = resultSchema.parse({
    ...a.agentOutput,
    resultId: a.invocationId,
    lifecycleRef: {
      modelName: "incident-dispatcher",
      resourceName: lifeName(a.incidentId),
    },
    provider: a.audit.provider,
    model: a.audit.model,
    promptHash: a.audit.promptHash,
    usage: a.audit.usage,
    rawOutputIncluded: false,
    authority: { notification: "external-only", remediation: "forbidden" },
  });
  const existing = resultSchema.safeParse(
    await ctx.readResource(`result-${value.resultId}`),
  );
  if (existing.success && canon(existing.data) !== canon(value)) {
    throw new TypeError("conflicting result replay");
  }
  if (life.status === "completed" && !existing.success) {
    throw new TypeError("completed invocation lacks its durable result");
  }
  const handles: unknown[] = [];
  if (!existing.success) {
    handles.push(
      await ctx.writeResource("result", `result-${value.resultId}`, value),
    );
  }
  if (life.status === "running") {
    const outcome = await recordOutcome({
      incidentId: a.incidentId,
      invocationId: a.invocationId,
      recordedAt: a.validatedAt,
      outcome: "completed",
    }, ctx);
    handles.push(outcome.handle);
  }
  return {
    value,
    handles,
  };
}

/** Swamp model definition for the gated incident-dispatch lifecycle. */
export const model = {
  type: "@mgreten/incident-dispatcher",
  version: MODEL_VERSION,
  globalArguments: policySchema,
  resources: {
    lifecycle: {
      description: "Durable gated incident lifecycle",
      schema: lifecycleSchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
    invocationRequest: {
      description: "Minimized typed request; execution is external",
      schema: requestSchema,
      lifetime: "30d" as const,
      garbageCollection: 100,
    },
    result: {
      description: "Validated sanitized typed result",
      schema: resultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
  },
  methods: {
    observe: {
      description:
        "Gate duplicate, active, retry, and validation lifecycle transitions",
      arguments: observeArgs,
      execute: async (args: unknown, ctx: Context) => ({
        dataHandles: [(await observe(args, ctx)).handle],
      }),
    },
    prepareInvocation: {
      description:
        "Prepare a minimized policy-bound external invocation request",
      arguments: prepareArgs,
      execute: async (args: unknown, ctx: Context) => ({
        dataHandles: (await prepareInvocation(args, ctx)).handles,
      }),
    },
    validateAndRecordInvocation: {
      description:
        "Validate external audit and typed result before completing lifecycle",
      arguments: validateArgs,
      execute: async (args: unknown, ctx: Context) => ({
        dataHandles: (await validateAndRecordInvocation(args, ctx)).handles,
      }),
    },
    recordOutcome: {
      description:
        "Record a claimed failure or completion without executing it",
      arguments: outcomeArgs,
      execute: async (args: unknown, ctx: Context) => ({
        dataHandles: [(await recordOutcome(args, ctx)).handle],
      }),
    },
  },
};
