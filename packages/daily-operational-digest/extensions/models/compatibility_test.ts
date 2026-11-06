import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import {
  buildFromBetterStackTriage,
  buildPhaseOnePulse,
  model,
  phaseOnePulseSchema,
} from "./operational_digest.ts";

const equal = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
};
const reference = () => ({
  schemaVersion: "1.0" as const,
  sourceId: "monitor-source",
  source: { system: "synthetic", resourceType: "monitor", resourceId: "m1" },
  provenance: {
    collector: "fixture",
    collectorVersion: "1",
    method: "fixture",
    collectedAt: "2026-08-23T11:00:00Z",
  },
  observedAt: "2026-08-23T10:00:00Z",
  freshness: {
    asOf: "2026-08-23T11:00:00Z",
    expiresAt: "2026-08-24T11:00:00Z",
  },
  sensitivity: "internal" as const,
});
const snapshot = () => ({
  schemaVersion: "1.0" as const,
  snapshotId: "snapshot-1",
  generatedAt: "2026-08-23T12:00:00Z",
  records: [{
    kind: "monitor" as const,
    recordId: "monitor-1",
    sourceReference: reference(),
    status: "confirmed_failure" as const,
    summary: "Synthetic monitor failure",
    evidenceIds: ["evidence-1"],
    monitor: { checkState: "down" as const, responseTimeMs: null },
  }],
  filtering: {
    policy: "exact-resource-identity-allowlist" as const,
    includedCount: 1,
    excludedCount: 0,
    excludedByReason: { identityNotAllowed: 0, missingIdentity: 0 },
  },
  limits: {
    maxRows: 100,
    maxBytes: 100_000,
    maxWindowSeconds: 86_400,
    rowsRead: 1,
    bytesRead: 100,
    windowStartedAt: "2026-08-23T11:00:00Z",
    windowEndedAt: "2026-08-23T12:00:00Z",
    truncated: false,
  },
  redaction: {
    method: "deterministic-secret-and-identifier-redaction" as const,
    methodVersion: "1",
    applied: true as const,
    rawLogsRetained: false as const,
    replacementCount: 0,
  },
  authority: {
    mode: "read-only" as const,
    sideEffects: "none" as const,
    remediation: "prohibited" as const,
    mayAcknowledgeIncidents: false as const,
    mayModifyMonitors: false as const,
  },
  escalation: {
    disposition: "recommend_review" as const,
    evidenceIds: ["evidence-1"],
    rationale: "Human review is warranted.",
  },
});
const railway = {
  scope: {
    projectId: "75e35651-c395-4918-a38b-d9fb4fb745d8",
    environmentId: "2f75ce5f-15b2-4267-b320-b594f51791d1",
    services: [{
      id: "e4a019af-3e2b-4099-bba9-9105b81e37d0",
      name: "web",
    }],
    maxSnapshotAgeSeconds: 420,
  },
  asOf: "2026-08-23T12:00:00Z",
  snapshot: { unavailable: true },
};
const railwayFailure = {
  ...railway,
  asOf: "2026-08-23T12:00:30Z",
  snapshot: {
    schemaVersion: "1.0",
    collectedAt: "2026-08-23T12:00:00Z",
    projectId: railway.scope.projectId,
    environmentId: railway.scope.environmentId,
    services: [{
      ...railway.scope.services[0],
      deployments: [{
        id: "deployment-1",
        status: "FAILED",
        createdAt: "2026-08-23T11:59:00Z",
        url: null,
        staticUrl: null,
        source: {
          repository: "example/example",
          branch: "main",
          commitSha: "a".repeat(40),
          commitMessage: "Synthetic failed deployment",
        },
      }],
      truncated: false,
    }],
    truncated: false,
    authority: {
      mode: "read-only",
      sideEffects: "none",
      mutationsExposed: false,
    },
  },
};
const emptyFeedbackBatch = {
  schemaVersion: "1.0" as const,
  collectedAt: "2026-08-23T12:00:00Z",
  window: {
    startedAt: "2026-08-23T11:00:00Z",
    endedAt: "2026-08-23T12:00:00Z",
    endExclusive: true as const,
    maximumHours: 24 as const,
  },
  artifacts: [],
  counts: { returned: 0, maximum: 50 as const },
  minimization: {
    selectedColumns: ["id", "category", "message", "created_at"] as const,
    rawContentIncluded: false as const,
    privateFamilyContentIncluded: false as const,
    userDataIncluded: false as const,
    memoryDataIncluded: false as const,
    emailIncluded: false as const,
    pageUrlIncluded: false as const,
    userAgentIncluded: false as const,
    metadataIncluded: false as const,
  },
  authority: {
    mode: "read-only" as const,
    sideEffects: "none" as const,
    mayMutate: false as const,
    agentInvoked: false as const,
    toolsInvoked: false as const,
  },
};

Deno.test("legacy Better Stack method maps strict evidence and persists", async () => {
  const args = { digestId: "legacy-digest", snapshot: snapshot() };
  const digest = buildFromBetterStackTriage(args);
  equal(digest.sections[0].items[0].itemId, "monitor-1");
  const { context, getLogs, getWrittenResources } = createModelTestContext({
    methodName: "buildFromBetterStackTriage",
  });
  await model.methods.buildFromBetterStackTriage.execute(args, context);
  equal(getWrittenResources()[0].specName, "digest");
  equal(getLogs().map((log) => log.message), [
    "Better Stack compatibility build started",
    "Better Stack compatibility build completed",
  ]);
});

Deno.test("Phase 1 pulse export validates output and method persists it", async () => {
  const args = {
    pulseId: "pulse-1",
    generatedAt: "2026-08-23T12:00:00Z",
    betterStack: { status: "available" as const, snapshot: snapshot() },
    feedback: { status: "zero-records" as const, reason: "No feedback." },
    railway,
  };
  const pulse = buildPhaseOnePulse(args);
  phaseOnePulseSchema.parse(pulse);
  equal(pulse.sources.length, 3);
  const { context, getLogs, getWrittenResources } = createModelTestContext({
    methodName: "buildPhaseOnePulse",
  });
  await model.methods.buildPhaseOnePulse.execute(args, context);
  equal(getWrittenResources()[0].specName, "pulse");
  equal(getLogs().map((log) => log.message), [
    "Phase 1 pulse build started",
    "Phase 1 pulse build completed",
  ]);
});

Deno.test("Phase 1 pulse rejects sensitive Better Stack evidence", () => {
  const unsafe = snapshot();
  unsafe.records[0].summary = "Email family@example.test";
  let rejected = false;
  try {
    buildPhaseOnePulse({
      pulseId: "unsafe-pulse",
      generatedAt: "2026-08-23T12:00:00Z",
      betterStack: { status: "available", snapshot: unsafe },
      feedback: { status: "unavailable", reason: "Unavailable." },
      railway,
    });
  } catch (error) {
    rejected = String(error).includes("unsafe Better Stack evidence");
  }
  equal(rejected, true);
});

Deno.test("Better Stack compatibility digest rejects sensitive evidence", () => {
  const unsafe = snapshot();
  unsafe.records[0].summary = "Credential api_key=synthetic-secret";
  let rejected = false;
  try {
    buildFromBetterStackTriage({ digestId: "unsafe-digest", snapshot: unsafe });
  } catch (error) {
    rejected = String(error).includes("unsafe Better Stack evidence");
  }
  equal(rejected, true);
});

Deno.test("active feedback-batch envelope and failing Railway evidence produce a cited pulse", () => {
  const pulse = buildPhaseOnePulse({
    pulseId: "active-envelope",
    generatedAt: "2026-08-23T12:00:00Z",
    betterStack: { status: "available", snapshot: snapshot() },
    feedback: { status: "available", feedbackBatch: emptyFeedbackBatch },
    railway: railwayFailure,
  });
  equal(pulse.sources.map((source) => [source.source, source.status]), [
    ["better-stack", "available"],
    ["feedback-batch", "zero-records"],
    ["railway", "available"],
  ]);
  const finding = pulse.findings.find((candidate) =>
    candidate.findingId ===
      `railway:${railway.scope.services[0].id}:deployment-1`
  );
  equal(finding?.severity, "critical");
  equal(finding?.evidenceReferences, [{
    source: "railway",
    recordId: railway.scope.services[0].id,
    evidenceId: "deployment-1",
  }]);
});
