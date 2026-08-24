import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  model,
  observe,
  prepareInvocation,
  recordOutcome,
  validateAndRecordInvocation,
} from "./incident_dispatcher.ts";

Deno.test("upgrades retained Moment Savor 2026.08.19.4 globals", () => {
  const upgraded = model.upgrades[0].upgradeAttributes({
    agentCwd: "/tmp/moment-savor-incident-investigations",
    maxPromptBytes: 12000,
  });
  assertEquals(upgraded, {
    allowedProviders: ["amp"],
    modelPattern: "^amp-default$",
    workspaceRoot: "/tmp/moment-savor-incident-investigations",
    maxPromptBytes: 12000,
    sameCauseFailureLimit: 3,
  });
  assert(model.globalArguments.safeParse(upgraded).success);
});

const incident = {
  incidentId: "api-1",
  status: "open",
  openedAt: "2026-08-23T10:00:00Z",
  observedAt: "2026-08-23T10:00:00Z",
  evidenceRefs: ["evidence-1"],
} as const;
const input = (overrides: Record<string, unknown> = {}) => ({
  observedAt: "2026-08-23T10:00:00Z",
  trigger: "new",
  materialEvidenceFingerprint: null,
  incident,
  incidentRef: { modelName: "monitor", resourceName: "api-1" },
  contextRef: { modelName: "context", resourceName: "current" },
  ...overrides,
});
const memory = () => {
  const records = new Map<string, Record<string, unknown>>();
  let failWrite: number | null = null;
  let writeCount = 0;
  return {
    records,
    failOnWrite: (number: number | null) => {
      failWrite = number;
      writeCount = 0;
    },
    context: {
      globalArgs: {
        allowedProviders: ["provider"],
        modelPattern: "^model-[0-9]+$",
        workspaceRoot: "/tmp/dispatcher-test",
        maxPromptBytes: 12000,
        sameCauseFailureLimit: 3,
      },
      ensureWorkspace: (path: string) => Promise.resolve(path),
      readResource: (name: string) =>
        Promise.resolve(records.get(name) ?? null),
      writeResource: async (
        _spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        await Promise.resolve();
        writeCount++;
        if (writeCount === failWrite) throw new Error("injected write failure");
        records.set(name, structuredClone(data));
        return { name };
      },
    },
  };
};

Deno.test("gates duplicate and active observations to one claim", async () => {
  const store = memory();
  const first = await observe(input(), store.context);
  const replay = await observe(
    input({ observedAt: "2026-08-23T10:01:00Z" }),
    store.context,
  );
  assert(first.value.eligibility.eligible);
  assertEquals(replay.value.eligibility.reason, "active");
  assertEquals(replay.value.attempts.length, 1);
});
Deno.test("ineligible observations retain authoritative metadata and lifecycle ordering", async () => {
  const store = memory();
  const first = (await observe(input(), store.context)).value;
  const duplicate = (await observe(
    input({
      observedAt: "2026-08-23T10:05:00Z",
      incident: {
        ...incident,
        observedAt: "2026-08-23T10:05:00Z",
        evidenceRefs: ["other"],
      },
      incidentRef: { modelName: "untrusted", resourceName: "other" },
      contextRef: { modelName: "untrusted", resourceName: "other" },
    }),
    store.context,
  )).value;
  assertEquals(duplicate.incident, first.incident);
  assertEquals(duplicate.incidentRef, first.incidentRef);
  assertEquals(duplicate.contextRef, first.contextRef);
  await prepareInvocation({
    incidentId: incident.incidentId,
    preparedAt: "2026-08-23T10:06:00Z",
  }, store.context);
  const running = store.records.get("lifecycle-api-1");
  assertEquals(running?.incident, first.incident);
  await recordOutcome({
    incidentId: incident.incidentId,
    invocationId: first.invocationId,
    recordedAt: "2026-08-23T10:07:00Z",
    outcome: "failed",
    failureCause: "timeout",
  }, store.context);
  assertEquals(store.records.get("lifecycle-api-1")?.incident, first.incident);
});
Deno.test("stops at repeated same-cause failure limit", async () => {
  const store = memory();
  let life = (await observe(input(), store.context)).value;
  for (let n = 0; n < 3; n++) {
    life = (await recordOutcome({
      incidentId: incident.incidentId,
      invocationId: life.invocationId,
      recordedAt: `2026-08-23T10:0${n}:00Z`,
      outcome: "failed",
      failureCause: "timeout",
    }, store.context)).value;
    if (n < 2) {
      life = (await observe(input({ trigger: "retry" }), store.context)).value;
    }
  }
  assertEquals(life.status, "stopped");
  assertEquals(life.sameCauseFailures, 3);
});
Deno.test("prepares a minimized policy-bound request", async () => {
  const store = memory();
  await observe(input(), store.context);
  const request = (await prepareInvocation({
    incidentId: incident.incidentId,
    preparedAt: "2026-08-23T10:01:00Z",
  }, store.context)).value;
  assertEquals(request.requiredExecutionPolicy, {
    tools: "deny-all",
    sandbox: "required",
    sideEffects: "none",
  });
  assertEquals(request.handling.rawEvidenceIncluded, false);
  assert(request.prompt.includes("Use no tools"));
});
Deno.test("prepare resumes after either request-stage write fails", async () => {
  for (const failedWrite of [1, 2]) {
    const store = memory();
    await observe(input(), store.context);
    store.failOnWrite(failedWrite);
    await assertRejects(() =>
      prepareInvocation({
        incidentId: incident.incidentId,
        preparedAt: "2026-08-23T10:01:00Z",
      }, store.context)
    );
    store.failOnWrite(null);
    const resumed = await prepareInvocation({
      incidentId: incident.incidentId,
      preparedAt: "2026-08-23T10:01:00Z",
    }, store.context);
    assert(resumed.value.invocationId.startsWith("inv-api-1-"));
    assertEquals(store.records.get("lifecycle-api-1")?.status, "running");
    assert(store.records.has(`request-${resumed.value.invocationId}`));
  }
});
Deno.test("records only a provider/model-bound typed result", async () => {
  const store = memory();
  await observe(input(), store.context);
  const request = (await prepareInvocation({
    incidentId: incident.incidentId,
    preparedAt: "2026-08-23T10:01:00Z",
  }, store.context)).value;
  const result = await validateAndRecordInvocation({
    incidentId: incident.incidentId,
    invocationId: request.invocationId,
    validatedAt: "2026-08-23T10:02:00Z",
    request,
    agentOutput: {
      schemaVersion: "1.0",
      incidentId: incident.incidentId,
      invocationId: request.invocationId,
      generatedAt: "2026-08-23T10:02:00Z",
      verdict: "inconclusive",
      summary: "Evidence is insufficient for a conclusion.",
      confidence: "low",
      findingCodes: ["insufficient-evidence"],
      evidenceRefs: ["evidence-1"],
      nextAction: "review",
    },
    audit: {
      auditId: "audit-1",
      enforcementAuthority: "trusted-platform",
      invocationId: request.invocationId,
      provider: "provider",
      model: "model-1",
      promptHash: request.promptHash,
      workspace: request.workspace,
      success: true,
      tools: "deny-all",
      sandbox: "required",
      sideEffects: "none",
      durationMs: 1,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    },
  }, store.context);
  assertEquals(result.value.rawOutputIncluded, false);
  assertEquals(store.records.get("lifecycle-api-1")?.status, "completed");
});
Deno.test("result is durable before completion and validation resumes after either write fails", async () => {
  for (const failedWrite of [1, 2]) {
    const store = memory();
    await observe(input(), store.context);
    const request = (await prepareInvocation({
      incidentId: incident.incidentId,
      preparedAt: "2026-08-23T10:01:00Z",
    }, store.context)).value;
    const args = {
      incidentId: incident.incidentId,
      invocationId: request.invocationId,
      validatedAt: "2026-08-23T10:02:00Z",
      request,
      agentOutput: {
        schemaVersion: "1.0",
        incidentId: incident.incidentId,
        invocationId: request.invocationId,
        generatedAt: "2026-08-23T10:02:00Z",
        verdict: "inconclusive",
        summary: "Evidence is insufficient.",
        confidence: "low",
        findingCodes: ["insufficient-evidence"],
        evidenceRefs: ["evidence-1"],
        nextAction: "review",
      },
      audit: {
        auditId: "audit-1",
        enforcementAuthority: "trusted-platform",
        invocationId: request.invocationId,
        provider: "provider",
        model: "model-1",
        promptHash: request.promptHash,
        workspace: request.workspace,
        success: true,
        tools: "deny-all",
        sandbox: "required",
        sideEffects: "none",
        durationMs: 1,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      },
    } as const;
    store.failOnWrite(failedWrite);
    await assertRejects(() => validateAndRecordInvocation(args, store.context));
    if (failedWrite === 1) {
      assertEquals(store.records.get("lifecycle-api-1")?.status, "running");
    } else {
      assert(store.records.has(`result-${request.invocationId}`));
      assertEquals(store.records.get("lifecycle-api-1")?.status, "running");
    }
    store.failOnWrite(null);
    await validateAndRecordInvocation(args, store.context);
    assert(store.records.has(`result-${request.invocationId}`));
    assertEquals(store.records.get("lifecycle-api-1")?.status, "completed");
    const replay = await validateAndRecordInvocation(args, store.context);
    assertEquals(replay.handles.length, 0);
  }
});
Deno.test("rejects policy-violating audit and unclaimed evidence", async () => {
  const store = memory();
  await observe(input(), store.context);
  const request = (await prepareInvocation({
    incidentId: incident.incidentId,
    preparedAt: "2026-08-23T10:01:00Z",
  }, store.context)).value;
  await assertRejects(() =>
    validateAndRecordInvocation({
      incidentId: incident.incidentId,
      invocationId: request.invocationId,
      validatedAt: "2026-08-23T10:02:00Z",
      request,
      agentOutput: {
        schemaVersion: "1.0",
        incidentId: incident.incidentId,
        invocationId: request.invocationId,
        generatedAt: "2026-08-23T10:02:00Z",
        verdict: "inconclusive",
        summary: "Evidence is insufficient.",
        confidence: "low",
        findingCodes: ["insufficient-evidence"],
        evidenceRefs: ["other"],
        nextAction: "review",
      },
      audit: {
        auditId: "audit-1",
        enforcementAuthority: "trusted-platform",
        invocationId: request.invocationId,
        provider: "bad",
        model: "nope",
        promptHash: request.promptHash,
        workspace: request.workspace,
        success: true,
        tools: "deny-all",
        sandbox: "required",
        sideEffects: "none",
        durationMs: 1,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      },
    }, store.context)
  );
});

Deno.test("rejects malformed policy and non-canonical workspace claims", async () => {
  for (
    const globalArgs of [
      { ...memory().context.globalArgs, modelPattern: "[" },
      { ...memory().context.globalArgs, modelPattern: "model-.*" },
      {
        ...memory().context.globalArgs,
        workspaceRoot: "/tmp/dispatcher/../escape",
      },
      {
        ...memory().context.globalArgs,
        allowedProviders: ["provider", "provider"],
      },
    ]
  ) {
    const store = memory();
    store.context.globalArgs = globalArgs;
    await assertRejects(() => observe(input(), store.context));
  }

  const store = memory();
  await observe(input(), store.context);
  store.context.ensureWorkspace = () => Promise.resolve("/tmp/other");
  await assertRejects(() =>
    prepareInvocation({
      incidentId: incident.incidentId,
      preparedAt: "2026-08-23T10:01:00Z",
    }, store.context)
  );
  assertEquals(store.records.get("lifecycle-api-1")?.status, "queued");
});

Deno.test("does not accept unreferenced authority or unvalidated completion", async () => {
  const store = memory();
  await assertRejects(() =>
    observe(input({ trigger: "authorized-request" }), store.context)
  );
  assertEquals(store.records.size, 0);

  const life = (await observe(input(), store.context)).value;
  await assertRejects(() =>
    recordOutcome({
      incidentId: incident.incidentId,
      invocationId: life.invocationId,
      recordedAt: "2026-08-23T10:01:00Z",
      outcome: "completed",
    }, store.context)
  );
  assertEquals(store.records.get("lifecycle-api-1")?.status, "queued");
});
