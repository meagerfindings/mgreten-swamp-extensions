import { prepareReadOnlyInvestigation } from "./_lib/read_only_investigation_contracts.ts";
import { model } from "./read_only_investigation.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
async function rejects(fn: () => unknown, text: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert(String(error).includes(text), String(error));
    return;
  }
  throw new Error(`expected ${text}`);
}
function fixture() {
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
        destinationClass: "controlled",
      }],
    }],
  };
}

Deno.test("creates deterministic synthetic plans with no execution authority", async () => {
  const first = await prepareReadOnlyInvestigation(fixture());
  const second = await prepareReadOnlyInvestigation(fixture());
  assert(JSON.stringify(first) === JSON.stringify(second));
  assert(
    first.authority.grant === "none" &&
      first.authority.authorityBasis === "caller-supplied-unverified" &&
      first.authority.execution === "none" &&
      first.authority.network === "none" &&
      first.authority.providerInvocation === "none" &&
      first.authority.productionMutation === "none",
  );
  assert(first.anomalies[0].escalation.required);
});
Deno.test("fails closed for expired authority, unavailable sources, and external private-data routes", async () => {
  const expired = fixture();
  expired.authorization.expiresAt = expired.evaluatedAt;
  await rejects(() => prepareReadOnlyInvestigation(expired), "expired");
  const unavailable = fixture();
  unavailable.sourceRegistrySnapshot.sources[0].availability = "unavailable";
  await rejects(() => prepareReadOnlyInvestigation(unavailable), "unavailable");
  const external = fixture();
  external.anomalies[0].queries[0].destinationClass = "external";
  await rejects(() => prepareReadOnlyInvestigation(external), "private data");
});
Deno.test("rejects malformed and excess fields rather than granting implied authority", async () => {
  for (const malformed of [null, {}, [], "authority", 7]) {
    await rejects(
      () => prepareReadOnlyInvestigation(malformed),
      "Invalid input",
    );
  }
  const base = fixture();
  const excess = {
    ...base,
    authorization: { ...base.authorization, execute: true },
  };
  await rejects(() => prepareReadOnlyInvestigation(excess), "Unrecognized key");
});
Deno.test("binds changed replay content to a different digest", async () => {
  const original = await prepareReadOnlyInvestigation(fixture());
  const replay = await prepareReadOnlyInvestigation(fixture());
  const tampered = fixture();
  tampered.anomalies[0].queries[0].purpose = "Changed synthetic purpose";
  const changed = await prepareReadOnlyInvestigation(tampered);
  assert(original.requestDigest === replay.requestDigest);
  assert(original.requestDigest !== changed.requestDigest);
});
Deno.test("persists exactly one plan and exposes no execution collaborator", async () => {
  const writes: unknown[][] = [];
  await model.methods.prepare.execute(
    { requestId: "demo-1", input: fixture() },
    {
      writeResource: (...args: unknown[]) => {
        writes.push(args);
        return Promise.resolve({ name: args[1] });
      },
      logger: { info: () => undefined },
    },
  );
  assert(
    writes.length === 1 && writes[0][0] === "plan" &&
      String(writes[0][1]).startsWith("plan-demo-1-") &&
      String(writes[0][1]).endsWith(
        (writes[0][2] as { requestDigest: string }).requestDigest.slice(0, 16),
      ),
  );
});
