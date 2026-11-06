import { z } from "npm:zod@4";
import {
  crossSourceEvidenceItemSchema,
  evaluateCrossSourceEvidence,
} from "./_lib/cross_source_evidence_contracts.ts";
import { sourceReferenceSchema } from "./_lib/source_reference_contracts.ts";
import {
  buildPrompt,
  globalArgumentsSchema,
  invocationClaimAuditSchema,
  model,
  prepareRequest,
  validateAgentResult,
} from "./cross_source_evidence.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
async function rejects(
  fn: () => Promise<unknown>,
  text: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert(String(error).includes(text), String(error));
    return;
  }
  throw new Error(`expected ${text}`);
}

const now = new Date("2026-08-23T12:00:00Z");
const source = (id: string): z.input<typeof sourceReferenceSchema> => ({
  schemaVersion: "1.0",
  sourceId: id,
  source: { system: "demo", resourceType: "aggregate", resourceId: id },
  provenance: {
    collector: "fixture",
    collectorVersion: "1",
    method: "synthetic",
    collectedAt: "2026-08-23T10:00:00Z",
  },
  observedAt: "2026-08-23T09:00:00Z",
  freshness: {
    asOf: "2026-08-23T10:00:00Z",
    expiresAt: "2026-08-24T10:00:00Z",
  },
  sensitivity: "internal",
});
// Privacy-safe fixture cap: exactly two short, synthetic aggregate observations.
const evidence = [{
  evidenceId: "metric-1",
  domain: "telemetry",
  sourceReference: source("demo:metric:1"),
  observation: "Aggregate metric changed.",
}, {
  evidenceId: "report-1",
  domain: "support",
  sourceReference: source("demo:report:1"),
  observation: "Aggregate report changed.",
}] satisfies z.input<typeof crossSourceEvidenceItemSchema>[];
const output = {
  schemaVersion: "1.0",
  clusterId: "cluster-1",
  evaluatedAt: now.toISOString(),
  hypothesis: "The aggregate observations may be related.",
  claimSemantics: "hypothesis_not_causation",
  evidence,
  relationships: [{
    relationshipId: "relation-1",
    evidenceIds: ["metric-1", "report-1"],
    type: "co_occurs",
    confidence: 0.7,
    rationale: "Synthetic timing overlaps.",
    semantics: "hypothesis_not_causation",
  }],
  missingDomains: [
    "feedback",
    "product_behavior",
    "economics",
    "factory_findings",
  ],
  recommendation: {
    action: "Investigate",
    rationale: "Test the hypothesis.",
    authority: "recommendation_only",
  },
  sideEffectAuthority: "none",
};
const globals = globalArgumentsSchema.parse({
  agentCwd: "/tmp/cse-test",
  maxPromptBytes: 120_000,
});

Deno.test("fixtures are capped and sanitized", () => {
  assert(evidence.length === 2);
  for (const item of evidence) {
    assert(item.observation.length <= 64);
    assert(!/[\n@]/.test(item.observation));
    assert(item.sourceReference.source.system === "demo");
  }
});
Deno.test("prepare is deterministic and rejects a single source domain", async () => {
  assert(buildPrompt(evidence) === buildPrompt(evidence));
  assert(buildPrompt(evidence).includes("untrusted quoted data"));
  const forward = await prepareRequest("review-1", evidence, globals, now);
  const reversed = await prepareRequest(
    "review-1",
    [...evidence].reverse(),
    globals,
    now,
  );
  assert(forward.promptHash === reversed.promptHash);
  assert(
    JSON.stringify(forward.evidence) === JSON.stringify(reversed.evidence),
  );
  await rejects(
    () =>
      prepareRequest(
        "review-1",
        [evidence[0], { ...evidence[1], domain: "telemetry" }],
        globals,
        now,
      ),
    "two source domains",
  );
});
Deno.test("validation retains provenance and enforces readonly recommendation-only authority", async () => {
  const request = await prepareRequest("review-1", evidence, globals, now);
  const audit = {
    invocationId: "review-1",
    provider: "amp",
    model: "fixture",
    promptHash: request.promptHash,
    cwd: request.agentCwd,
    success: true,
  };
  const claim = invocationClaimAuditSchema.parse({
    operation: "invokeAndParse",
    invocationId: "review-1",
    provider: "amp",
    model: "fixture",
    promptHash: request.promptHash,
    cwd: request.agentCwd,
    toolProfile: "readonly",
    sandbox: {
      mode: "auto",
      provider: "amp",
      credentialAccess: "isolated",
      network: "allow",
      profilePath: "",
      required: true,
    },
  });
  const result = await validateAgentResult(
    "review-1",
    request,
    output,
    audit,
    claim,
    now,
  );
  assert(result.authority.mayExecute === false);
  assert(
    result.cluster.evidence[0].sourceReference.sourceId === "demo:metric:1",
  );
  await rejects(
    () =>
      validateAgentResult("review-1", request, output, audit, {
        ...claim,
        toolProfile: "actor",
      }, now),
    "readonly",
  );
  await rejects(
    () =>
      validateAgentResult(
        "review-1",
        request,
        {
          ...output,
          evidence: [evidence[0], { ...evidence[1], observation: "Changed." }],
        },
        audit,
        claim,
        now,
      ),
    "preserve every",
  );
});
Deno.test("contracts reject causal claims, authority, stale data, and flattened sources", () => {
  for (
    const invalid of [{ ...output, claimSemantics: "causal" }, {
      ...output,
      sideEffectAuthority: "write",
    }, {
      ...output,
      recommendation: { ...output.recommendation, authority: "execute" },
    }, {
      ...output,
      evidence: [evidence[0], {
        ...evidence[1],
        sourceReference: source("demo:metric:1"),
      }],
    }, {
      ...output,
      evidence: [{
        ...evidence[0],
        sourceReference: {
          ...evidence[0].sourceReference,
          freshness: {
            ...evidence[0].sourceReference.freshness,
            expiresAt: "2026-08-23T11:00:00Z",
          },
        },
      }, evidence[1]],
    }]
  ) assert(!evaluateCrossSourceEvidence(invalid).success);
});
Deno.test("arguments are strict and freshness is enforced at preparation and validation", async () => {
  assert(
    !model.methods.prepare.arguments.safeParse({
      requestId: "review-1",
      evidence,
      extra: true,
    }).success,
  );
  const stale = structuredClone(evidence);
  stale[0].sourceReference.freshness.expiresAt = now.toISOString();
  await rejects(
    () => prepareRequest("review-1", stale, globals, now),
    "stale at preparation",
  );

  const request = await prepareRequest("review-1", evidence, globals, now);
  const audit = {
    invocationId: "review-1",
    provider: "amp",
    model: "fixture",
    promptHash: request.promptHash,
    cwd: request.agentCwd,
    success: true,
  };
  const claim = invocationClaimAuditSchema.parse({
    operation: "invokeAndParse",
    invocationId: "review-1",
    provider: "amp",
    model: "fixture",
    promptHash: request.promptHash,
    cwd: request.agentCwd,
    toolProfile: "readonly",
    sandbox: {
      mode: "auto",
      provider: "amp",
      credentialAccess: "isolated",
      network: "allow",
      profilePath: "",
      required: true,
    },
  });
  await rejects(
    () =>
      validateAgentResult(
        "review-1",
        request,
        { ...output, evaluatedAt: "2026-08-23T12:00:01Z" },
        audit,
        claim,
        now,
      ),
    "future",
  );
  await rejects(
    () =>
      validateAgentResult(
        "review-1",
        request,
        output,
        audit,
        claim,
        new Date("2026-08-24T10:00:00Z"),
      ),
    "stale at validation",
  );
});

Deno.test("bounded strict contracts reject malformed and oversized input", async () => {
  const malformed = { ...evidence[0], extra: true };
  await rejects(
    () => prepareRequest("review-1", [malformed, evidence[1]], globals, now),
    "unrecognized",
  );
  const oversized = {
    ...evidence[0],
    evidenceId: "metric-oversized",
    sourceReference: source("demo:metric:oversized"),
    observation: "x".repeat(4_001),
  };
  await rejects(
    () => prepareRequest("review-1", [oversized, evidence[1]], globals, now),
    "Too big",
  );
  assert(
    !evaluateCrossSourceEvidence({
      ...output,
      relationships: Array(201).fill(output.relationships[0]),
    }).success,
  );
});

Deno.test("tampered binding fails while exact replay is deterministic and side-effect free", async () => {
  const request = await prepareRequest("review-1", evidence, globals, now);
  const audit = {
    invocationId: "review-1",
    provider: "amp",
    model: "fixture",
    promptHash: request.promptHash,
    cwd: request.agentCwd,
    success: true,
  };
  const claim = invocationClaimAuditSchema.parse({
    operation: "invokeAndParse",
    invocationId: "review-1",
    provider: "amp",
    model: "fixture",
    promptHash: request.promptHash,
    cwd: request.agentCwd,
    toolProfile: "readonly",
    sandbox: {
      mode: "auto",
      provider: "amp",
      credentialAccess: "isolated",
      network: "allow",
      profilePath: "",
      required: true,
    },
  });
  const first = await validateAgentResult(
    "review-1",
    request,
    output,
    audit,
    claim,
    now,
  );
  const replay = await validateAgentResult(
    "review-1",
    request,
    output,
    audit,
    claim,
    now,
  );
  assert(JSON.stringify(first) === JSON.stringify(replay));
  assert(first.authority.sideEffects === "none");
  await rejects(
    () =>
      validateAgentResult(
        "review-1",
        {
          ...request,
          createdAt: "2026-08-23T11:59:59Z",
          prompt: `${request.prompt}tampered`,
        },
        output,
        audit,
        claim,
        now,
      ),
    "binding is invalid",
  );
  await rejects(
    () =>
      validateAgentResult(
        "review-1",
        request,
        output,
        { ...audit, promptHash: "0".repeat(64) },
        claim,
        now,
      ),
    "binding is invalid",
  );
});

Deno.test("model methods write schema-conformant resources and log boundaries", async () => {
  const writes: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  const logs: string[] = [];
  const context = {
    globalArgs: globals,
    now: () => now,
    logger: { info: (message: string) => logs.push(message) },
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ spec, name, data });
      return Promise.resolve(`${spec}:${name}`);
    },
  };
  await model.methods.prepare.execute(
    { requestId: "review-1", evidence },
    context,
  );
  assert(writes[0].spec === "request");
  assert(writes[0].name === "request-review-1");
  assert(model.resources.request.schema.safeParse(writes[0].data).success);
  assert(logs.length === 2);

  const request = writes[0].data;
  const promptHash = String(request.promptHash);
  const cwd = String(request.agentCwd);
  await model.methods.validate.execute({
    requestId: "review-1",
    request: model.resources.request.schema.parse(request),
    agentOutput: output,
    invocation: {
      invocationId: "review-1",
      provider: "amp",
      model: "fixture",
      promptHash,
      cwd,
      success: true,
    },
    invocationClaim: {
      operation: "invokeAndParse",
      invocationId: "review-1",
      provider: "amp",
      model: "fixture",
      promptHash,
      cwd,
      toolProfile: "readonly",
      sandbox: {
        mode: "auto",
        provider: "amp",
        credentialAccess: "isolated",
        network: "allow",
        profilePath: "",
        required: true,
      },
    },
  }, context);
  assert(writes[1].spec === "validatedCluster");
  assert(writes[1].name === "cluster-review-1");
  assert(
    model.resources.validatedCluster.schema.safeParse(writes[1].data).success,
  );
  assert(Number(logs.length) === 4);
});
