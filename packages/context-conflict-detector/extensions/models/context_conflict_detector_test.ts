import { detectConflicts, model } from "./context_conflict_detector.ts";

const assert: (value: unknown) => asserts value = (value) => {
  if (!value) throw new Error("assertion failed");
};
const record = (recordId: string, value: string) => ({
  recordId,
  version: 1,
  sha256: "a".repeat(64),
  authority: {
    authorityId: `authority-${recordId}`,
    actorId: "human-1",
    role: "owner",
    humanAuthority: true,
    source: "fixture",
  },
  provenance: {
    sourceId: `source-${recordId}`,
    collector: "fixture",
    collectorVersion: "1",
    method: "synthetic",
    collectedAt: "2026-08-16T00:00:00Z",
  },
  freshness: {
    asOf: "2026-08-16T00:00:00Z",
    expiresAt: "2026-08-20T00:00:00Z",
  },
  reviewAt: "2026-08-18T00:00:00Z",
  claims: [{ conflictKey: "delivery.status", value }],
});
const fixture = () => ({
  schemaVersion: "1.0",
  evaluationId: "evaluation-1",
  evaluatedAt: "2026-08-17T00:00:00Z",
  references: [record("reference-1", "active")],
  decisions: [record("decision-b", "stopped"), record("decision-a", "active")],
  plans: [],
  proposals: [],
  availability: ["reference", "decision", "plan", "proposal"].map((
    category,
  ) => ({ category, status: "available", reason: null })),
  conflictRules: [{
    ruleId: "delivery-rule",
    conflictKey: "delivery.status",
    appliesTo: ["reference", "decision"],
    contradictoryValuePairs: [["active", "stopped"]],
    severity: "escalation",
    recommendation: "Human owner must resolve this.",
  }],
  stalePolicy: {
    reviewDue: "report",
    freshnessExpired: "report",
    futureAsOf: "escalate",
  },
  ordering: "severity_desc_code_asc_conflict_key_asc_record_ids_asc",
});

Deno.test("synthetic conflicts are deterministic and blocked without authority", () => {
  const first = detectConflicts(fixture());
  const second = detectConflicts(fixture());
  assert(JSON.stringify(first) === JSON.stringify(second));
  assert(first.verdict === "blocked");
  assert(first.diagnostics.some((d) => d.code === "contradictory_decision"));
  assert(
    !first.authority.mayResolveConflicts && !first.authority.mayExecute &&
      !first.authority.networkCalls,
  );
});
Deno.test("ordering and malformed input are deterministic failures", () => {
  const output = detectConflicts(fixture());
  assert(output.diagnostics[0].severity === "escalation");
  const input: any = fixture();
  input.references[0].authority.humanAuthority = false;
  let failed = false;
  try {
    detectConflicts(input);
  } catch {
    failed = true;
  }
  assert(failed);
});
Deno.test("diagnostics are sorted before a truthful 500-item cap", () => {
  const input: any = fixture();
  input.references = Array.from(
    { length: 100 },
    (_, i) => record(`reference-${String(i).padStart(3, "0")}`, "active"),
  );
  input.decisions = Array.from(
    { length: 100 },
    (_, i) => record(`decision-${String(i).padStart(3, "0")}`, "active"),
  );
  input.plans = Array.from(
    { length: 100 },
    (_, i) => record(`plan-${String(i).padStart(3, "0")}`, "active"),
  );
  input.proposals = Array.from(
    { length: 100 },
    (_, i) => record(`proposal-${String(i).padStart(3, "0")}`, "active"),
  );
  input.evaluatedAt = "2026-08-23T00:00:00Z";
  input.stalePolicy.reviewDue = "escalate";
  input.stalePolicy.freshnessExpired = "escalate";
  input.stalePolicy.futureAsOf = "report";

  const output = detectConflicts(input);
  assert(output.diagnostics.length === 500);
  assert(output.truncated === true);
  // The complete set has 800 escalations, so blockers omitted beyond the cap
  // must still keep the verdict blocked.
  assert(output.verdict === "blocked");
  assert(
    output.diagnostics.every((diagnostic) =>
      diagnostic.severity === "escalation"
    ),
  );
  assert(
    output.diagnostics.every((diagnostic, index, diagnostics) =>
      index === 0 ||
      diagnostics[index - 1].code.localeCompare(diagnostic.code) <= 0
    ),
  );
});
Deno.test("truncated is false when no diagnostics are omitted", () => {
  const output = detectConflicts(fixture());
  assert(output.diagnostics.length < 500);
  assert(output.truncated === false);
});
Deno.test("freshness expiring exactly at evaluation is stale", () => {
  const input: any = fixture();
  input.references[0].freshness.expiresAt = input.evaluatedAt;
  const output = detectConflicts(input);
  assert(output.diagnostics.some((item) => item.code === "expired_freshness"));
});
Deno.test("duplicate recordId and version pairs are rejected across categories", () => {
  const input: any = fixture();
  input.proposals = [record("reference-1", "active")];
  let failed = false;
  try {
    detectConflicts(input);
  } catch {
    failed = true;
  }
  assert(failed);

  input.proposals[0].version = 2;
  detectConflicts(input);
});
Deno.test("model persists exactly one evaluation", async () => {
  const writes: unknown[][] = [];
  await model.methods.evaluate.execute({
    requestId: "request-1",
    input: fixture(),
  }, {
    writeResource: async (...args: unknown[]) => {
      writes.push(args);
      return { name: args[1] };
    },
  });
  assert(writes.length === 1 && writes[0][0] === "evaluation");
});
