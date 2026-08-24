import { z } from "npm:zod@4";

/** Version of the incident-dispatcher model contract. */
export const MODEL_VERSION = "2026.08.24.1" as const;
const Time = z.iso.datetime({ offset: true });
const Id = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Ref = z.strictObject({ modelName: Id, resourceName: Id });
const ModelPattern = z.string().min(1).max(200).superRefine((value, ctx) => {
  try {
    new RegExp(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "modelPattern is not valid" });
  }
  if (!value.startsWith("^") || !value.endsWith("$")) {
    ctx.addIssue({ code: "custom", message: "modelPattern must be anchored" });
  }
  if (/\(\?|\\[1-9]|(?:\*|\+|\})[+*{]/.test(value)) {
    ctx.addIssue({
      code: "custom",
      message: "modelPattern uses unsafe features",
    });
  }
});
const WorkspaceRoot = z.string().max(240).regex(
  /^\/tmp\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/,
  "workspaceRoot must be a canonical path below /tmp",
);
const policySchema = z.strictObject({
  allowedProviders: z.array(Id).min(1).max(20).refine(
    (providers) => new Set(providers).size === providers.length,
    "allowedProviders must be unique",
  ),
  modelPattern: ModelPattern.default(
    "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
  ),
  workspaceRoot: WorkspaceRoot.default(
    "/tmp/incident-dispatcher",
  ),
  maxPromptBytes: z.number().int().min(1000).max(20000).default(12000),
  sameCauseFailureLimit: z.number().int().min(1).max(12).default(3),
});
type Policy = z.infer<typeof policySchema>;
const summary = z.string().trim().min(1).max(280).superRefine((value, ctx) => {
  const prohibited = [
    /[\r\n]/,
    /https?:\/\//i,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    /(?:\+\d[\d\s().-]{6,}\d|(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4})/,
    /\b\d{2}-\d{7}\b/,
    /\b(?:api[_ -]?key|password|secret|bearer|access[_ -]?token)\s*[:=]/i,
    /\b[a-f0-9]{32,}\b/i,
    /(?:^|\s)\/(?:home|etc|var|run|tmp)\//,
  ];
  if (prohibited.some((pattern) => pattern.test(value))) {
    ctx.addIssue({
      code: "custom",
      message: "summary contains prohibited raw or identifying content",
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
const Trigger = z.enum([
  "new",
  "material-change",
  "retry",
  "authorized-request",
]);
const observeArgs = z.strictObject({
  observedAt: Time,
  trigger: Trigger.default("new"),
  materialEvidenceFingerprint: Hash.nullable().default(null),
  incident: incidentSchema,
  incidentRef: Ref,
  contextRef: Ref,
  authorizationRef: Id.nullable().default(null),
}).superRefine((value, ctx) => {
  if (value.trigger === "authorized-request" && !value.authorizationRef) {
    ctx.addIssue({
      code: "custom",
      path: ["authorizationRef"],
      message:
        "authorized-request requires an external authorization reference",
    });
  }
});
const attempt = z.strictObject({
  attempt: z.number().int().positive(),
  invocationId: Id,
  fingerprint: Hash,
  trigger: Trigger,
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
  auditId: Id,
  enforcementAuthority: Id,
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
  auditId: Id,
  enforcementAuthority: Id,
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
  outcome: z.literal("failed"),
  failureCause: z.string().min(1).max(500),
});

type Context = {
  globalArgs?: Policy;
  logger?: { info(message: string, values?: Record<string, unknown>): void };
  definition?: { name: string };
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
const runLogged = async <T>(
  name: string,
  ctx: Context,
  operation: () => Promise<T>,
) => {
  ctx.logger?.info("Starting {method}", { method: name });
  const result = await operation();
  ctx.logger?.info("Completed {method}", { method: name });
  return result;
};

/** Evaluates an observation and durably records its gated lifecycle state. */
export async function observe(raw: unknown, ctx: Context) {
  const a = observeArgs.parse(raw);
  const p = policy(ctx);
  const stored = await ctx.readResource(lifeName(a.incident.incidentId));
  const parsed = lifecycleSchema.safeParse(stored);
  if (stored !== null && !parsed.success) {
    throw new TypeError("stored incident lifecycle is invalid");
  }
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
    prior.sameCauseFailures >= p.sameCauseFailureLimit
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
    }`.slice(0, 100)
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
  const storedRequest = await ctx.readResource(requestName(life.invocationId));
  const existing = requestSchema.safeParse(storedRequest);
  if (storedRequest !== null && !existing.success) {
    throw new TypeError("stored invocation request is invalid");
  }
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
  if (workspace !== requested) {
    throw new TypeError(
      "workspace platform did not attest the exact requested path",
    );
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
  const cause = await hash(a.failureCause.trim().toLowerCase());
  const failures = cause === prior.failureCauseFingerprint
    ? prior.sameCauseFailures + 1
    : 1;
  const stopped = failures >= policy(ctx).sameCauseFailureLimit;
  const value = lifecycleSchema.parse({
    ...prior,
    status: stopped ? "stopped" : "failed",
    eligibility: {
      eligible: false,
      reason: stopped ? "failure-limit" : "duplicate",
    },
    sameCauseFailures: failures,
    failureCauseFingerprint: cause,
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
  const modelName = Id.parse(ctx.definition?.name);
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
    Date.parse(a.agentOutput.generatedAt) < Date.parse(request.preparedAt) ||
    Date.parse(a.agentOutput.generatedAt) >
      Date.parse(request.preparedAt) + 30 * 60 * 1000
  ) throw new TypeError("output timestamp is invalid");
  const value = resultSchema.parse({
    ...a.agentOutput,
    resultId: a.invocationId,
    lifecycleRef: {
      modelName,
      resourceName: lifeName(a.incidentId),
    },
    auditId: a.audit.auditId,
    enforcementAuthority: a.audit.enforcementAuthority,
    provider: a.audit.provider,
    model: a.audit.model,
    promptHash: a.audit.promptHash,
    usage: a.audit.usage,
    rawOutputIncluded: false,
    authority: { notification: "external-only", remediation: "forbidden" },
  });
  const storedResult = await ctx.readResource(`result-${value.resultId}`);
  const existing = resultSchema.safeParse(storedResult);
  if (storedResult !== null && !existing.success) {
    throw new TypeError("stored invocation result is invalid");
  }
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
    const completed = lifecycleSchema.parse({
      ...life,
      status: "completed",
      eligibility: { eligible: false, reason: "duplicate" },
      sameCauseFailures: 0,
      failureCauseFingerprint: null,
    });
    handles.push(
      await ctx.writeResource(
        "lifecycle",
        lifeName(a.incidentId),
        completed,
      ),
    );
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
  upgrades: [{
    toVersion: MODEL_VERSION,
    description:
      "Migrate the retained 2026.08.19.4 Moment Savor dispatcher globals to generic policy globals",
    upgradeAttributes: (old: Record<string, unknown>) => ({
      allowedProviders: ["amp"],
      modelPattern: "^amp-default$",
      workspaceRoot: old.agentCwd ?? "/tmp/incident-dispatcher",
      maxPromptBytes: old.maxPromptBytes ?? 12000,
      sameCauseFailureLimit: 3,
    }),
  }],
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
  checks: {
    "policy-valid": {
      description: "Verify incident dispatch policy before state transitions",
      labels: ["policy"],
      appliesTo: [
        "observe",
        "prepareInvocation",
        "validateAndRecordInvocation",
        "recordOutcome",
      ],
      execute: (ctx: Context) => {
        const parsed = policySchema.safeParse(ctx.globalArgs);
        return parsed.success ? { pass: true } : {
          pass: false,
          errors: parsed.error.issues.map((issue) => issue.message),
        };
      },
    },
  },
  methods: {
    observe: {
      description:
        "Gate duplicate, active, retry, and validation lifecycle transitions",
      arguments: observeArgs,
      execute: async (args: unknown, ctx: Context) =>
        await runLogged("observe", ctx, async () => ({
          dataHandles: [(await observe(args, ctx)).handle],
        })),
    },
    prepareInvocation: {
      description:
        "Prepare a minimized policy-bound external invocation request",
      arguments: prepareArgs,
      execute: async (args: unknown, ctx: Context) =>
        await runLogged("prepareInvocation", ctx, async () => ({
          dataHandles: (await prepareInvocation(args, ctx)).handles,
        })),
    },
    validateAndRecordInvocation: {
      description:
        "Validate external audit and typed result before completing lifecycle",
      arguments: validateArgs,
      execute: async (args: unknown, ctx: Context) =>
        await runLogged("validateAndRecordInvocation", ctx, async () => ({
          dataHandles: (await validateAndRecordInvocation(args, ctx)).handles,
        })),
    },
    recordOutcome: {
      description:
        "Record a claimed external invocation failure without executing it",
      arguments: outcomeArgs,
      execute: async (args: unknown, ctx: Context) =>
        await runLogged("recordOutcome", ctx, async () => ({
          dataHandles: [(await recordOutcome(args, ctx)).handle],
        })),
    },
  },
};
