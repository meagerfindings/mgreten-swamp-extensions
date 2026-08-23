import { prepareReadOnlyInvestigation } from "./_lib/read_only_investigation_contracts.ts";
import { model } from "./read_only_investigation.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function rejects(fn: () => unknown, text: string): void {
  try {
    fn();
  } catch (error) {
    assert(String(error).includes(text), String(error));
    return;
  }
  throw new Error(`expected ${text}`);
}
function fixture(): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    authorizationId: "auth-1",
    planId: "plan-1",
    evaluatedAt: "2026-08-23T12:00:00Z",
    authorization: {
      issuedAt: "2026-08-23T10:00:00Z",
      expiresAt: "2026-08-23T13:00:00Z",
      minimumConfidence: 0.9,
      minimumSeverity: "high",
      maxAnomalies: 2,
      maxQueries: 3,
      maxRowsPerQuery: 100,
      maxBytesPerQuery: 10_000,
      maxWindowSeconds: 3_600,
      escalation: {
        humanRole: "reviewer",
        requiredAtSeverity: "critical",
        action: "request_human_review",
      },
    },
    sourceRegistrySnapshot: {
      registrySnapshotId: "registry-1",
      capturedAt: "2026-08-23T11:00:00Z",
      sources: [{
        sourceId: "source-1",
        snapshotId: "snapshot-1",
        approved: true,
        availability: "available",
        collectedAt: "2026-08-23T11:00:00Z",
        expiresAt: "2026-08-23T13:00:00Z",
        sensitivity: "private-project",
        allowedOperations: ["search", "aggregate"],
        allowedScopes: ["synthetic-errors"],
      }],
    },
    anomalies: [{
      anomalyId: "anomaly-1",
      confidence: 0.95,
      severity: "critical",
      summary: "Synthetic anomaly",
      queries: [{
        queryId: "query-1",
        sourceId: "source-1",
        sourceSnapshotId: "snapshot-1",
        operation: "aggregate",
        scope: "synthetic-errors",
        evidenceId: "evidence-1",
        purpose: "Count synthetic records",
        maxRows: 50,
        maxBytes: 5_000,
        windowSeconds: 1_800,
        providerRoute: "internal",
      }],
    }],
  };
}

Deno.test("creates deterministic synthetic plans with no execution authority", () => {
  const first = prepareReadOnlyInvestigation(fixture());
  const second = prepareReadOnlyInvestigation(fixture());
  assert(JSON.stringify(first) === JSON.stringify(second));
  assert(
    first.authority.execution === "none" &&
      first.authority.network === "none" &&
      first.authority.providerInvocation === "none" &&
      first.authority.productionMutation === "none",
  );
  assert(first.anomalies[0].escalation.required);
});
Deno.test("fails closed for expired authority, unavailable sources, and external private-data routes", () => {
  const expired = fixture() as any;
  expired.authorization.expiresAt = expired.evaluatedAt;
  rejects(() => prepareReadOnlyInvestigation(expired), "expired");
  const unavailable = fixture() as any;
  unavailable.sourceRegistrySnapshot.sources[0].availability = "unavailable";
  rejects(() => prepareReadOnlyInvestigation(unavailable), "unavailable");
  const external = fixture() as any;
  external.anomalies[0].queries[0].providerRoute = "external";
  rejects(() => prepareReadOnlyInvestigation(external), "private data");
});
Deno.test("persists exactly one plan and exposes no execution collaborator", async () => {
  const writes: unknown[][] = [];
  await model.methods.prepare.execute(
    { requestId: "demo-1", input: fixture() },
    {
      writeResource: async (...args: unknown[]) => {
        writes.push(args);
        return { name: args[1] };
      },
    },
  );
  assert(
    writes.length === 1 && writes[0][0] === "plan" &&
      writes[0][1] === "plan-demo-1",
  );
});
