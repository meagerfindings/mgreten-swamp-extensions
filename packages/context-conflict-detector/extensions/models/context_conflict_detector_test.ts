import {
  detectConflicts,
  genericOutputSchema,
  inputSchema,
  legacyOutputSchema,
  model,
} from "./context_conflict_detector.ts";

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
  plans: [] as ReturnType<typeof record>[],
  proposals: [] as ReturnType<typeof record>[],
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
type Fixture = ReturnType<typeof fixture>;
const legacyFixture = () => {
  const generic = fixture();
  const toArtifact = ({ recordId, ...rest }: ReturnType<typeof record>) => ({
    artifactId: recordId,
    ...rest,
  });
  return {
    schemaVersion: "1.0",
    evaluationId: generic.evaluationId,
    evaluatedAt: generic.evaluatedAt,
    context: generic.references.map(toArtifact),
    decisions: generic.decisions.map(toArtifact),
    work: generic.plans.map(toArtifact),
    recommendations: generic.proposals.map(toArtifact),
    availability: ["context", "decision", "work", "recommendation"].map(
      (kind) => ({ kind, status: "available", reason: null }),
    ),
    conflictRules: [{
      ...generic.conflictRules[0],
      appliesTo: ["context", "decision"],
    }],
    stalePolicy: generic.stalePolicy,
    ordering: "severity_desc_code_asc_conflict_key_asc_artifact_ids_asc",
  };
};

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
  const input = fixture();
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
  const input = fixture();
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
  const input = fixture();
  input.references[0].freshness.expiresAt = input.evaluatedAt;
  const output = detectConflicts(input);
  assert(output.diagnostics.some((item) => item.code === "expired_freshness"));
});
Deno.test("duplicate recordId and version pairs are rejected across categories", () => {
  const input = fixture();
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
Deno.test("strict schemas reject unknown fields and ambiguous declarations", () => {
  const unknown = { ...fixture(), injectedAuthority: true };
  assert(!inputSchema.safeParse(unknown).success);

  const duplicateClaim = fixture();
  duplicateClaim.references[0].claims.push({
    conflictKey: "delivery.status",
    value: "stopped",
  });
  assert(!inputSchema.safeParse(duplicateClaim).success);

  const duplicateRule = fixture();
  duplicateRule.conflictRules.push({ ...duplicateRule.conflictRules[0] });
  assert(!inputSchema.safeParse(duplicateRule).success);
});
Deno.test("diagnostic ordering is invariant to caller array ordering", () => {
  const original = fixture();
  const reordered: Fixture = {
    ...fixture(),
    decisions: fixture().decisions.reverse(),
    references: fixture().references.reverse(),
    availability: fixture().availability.reverse(),
  };
  assert(
    JSON.stringify(detectConflicts(original)) ===
      JSON.stringify(detectConflicts(reordered)),
  );
});
Deno.test("output binds replay evidence to caller-declared record digests", () => {
  const original = detectConflicts(fixture());
  const tampered = fixture();
  tampered.references[0].sha256 = "b".repeat(64);
  const replay = detectConflicts(tampered);
  assert(JSON.stringify(original) !== JSON.stringify(replay));
  assert("recordDigests" in replay);
  assert(
    replay.recordDigests.find((item) => item.recordId === "reference-1")
      ?.sha256 === "b".repeat(64),
  );
});
Deno.test("legacy context-compiler records receive the exact legacy output contract", () => {
  const legacy = legacyFixture();
  legacy.context[0].reviewAt = legacy.evaluatedAt;
  const output = detectConflicts(legacy);
  assert(legacyOutputSchema.safeParse(output).success);
  assert(!genericOutputSchema.safeParse(output).success);
  assert(!("recordDigests" in output));
  assert(output.diagnostics.every((item) => "artifactIds" in item));
  assert(output.diagnostics.some((item) => item.code === "stale_goal"));
  assert(
    output.diagnostics.find((item) => item.code === "stale_goal")
      ?.recommendation.endsWith("the artifact automatically."),
  );
  assert(model.resources.evaluation.schema.safeParse(output).success);
});

Deno.test("legacy freshness expiring exactly at evaluation remains current", () => {
  const legacy = legacyFixture();
  legacy.context[0].freshness.expiresAt = legacy.evaluatedAt;
  const output = detectConflicts(legacy);
  assert(!output.diagnostics.some((item) => item.code === "expired_freshness"));
});

Deno.test("legacy diagnostics are sorted before truthful truncation", () => {
  const legacy = legacyFixture();
  const artifact = legacy.context[0];
  legacy.context = Array.from({ length: 100 }, (_, i) => ({
    ...artifact,
    artifactId: `context-${String(i).padStart(3, "0")}`,
    reviewAt: "2026-08-16T00:00:00Z",
  }));
  legacy.decisions = Array.from({ length: 100 }, (_, i) => ({
    ...artifact,
    artifactId: `decision-${String(i).padStart(3, "0")}`,
    claims: [{ conflictKey: "delivery.status", value: "stopped" }],
    reviewAt: "2026-08-16T00:00:00Z",
  }));
  legacy.stalePolicy.reviewDue = "escalate";

  const output = detectConflicts(legacy);
  assert(output.diagnostics.length === 500);
  assert(output.truncated === true);
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

Deno.test("legacy artifact identity and version must be unique across kinds", () => {
  const legacy = legacyFixture();
  legacy.work = [{ ...legacy.context[0] }];
  assert(!inputSchema.safeParse(legacy).success);

  legacy.work[0].version = 2;
  detectConflicts(legacy);
});

Deno.test("malformed old/new hybrids fail closed", () => {
  const hybrids: unknown[] = [
    { ...fixture(), context: [] },
    {
      ...fixture(),
      references: fixture().references.map((item) => ({
        ...item,
        artifactId: item.recordId,
      })),
    },
    {
      ...fixture(),
      availability: fixture().availability.map(({ category, ...item }) => ({
        ...item,
        kind: category === "reference" ? "context" : category,
      })),
    },
  ];
  hybrids.forEach((hybrid) => {
    assert(!inputSchema.safeParse(hybrid).success);
    let failed = false;
    try {
      detectConflicts(hybrid);
    } catch {
      failed = true;
    }
    assert(failed);
  });
});

Deno.test("resource upgrades retain valid legacy and generic vocabulary verbatim", () => {
  const generic = detectConflicts(fixture());
  const legacy = detectConflicts(legacyFixture());
  assert("recordDigests" in generic);
  assert("artifactIds" in legacy.diagnostics[0]);
  const upgrade = model.upgrades[0].upgradeAttributes;
  assert(JSON.stringify(upgrade(generic)) === JSON.stringify(generic));
  assert(JSON.stringify(upgrade(legacy)) === JSON.stringify(legacy));
  const hybrid = { ...generic, artifactIds: [] };
  let failed = false;
  try {
    upgrade(hybrid);
  } catch {
    failed = true;
  }
  assert(failed);
});
Deno.test("model persists exactly one evaluation", async () => {
  const writes: unknown[][] = [];
  await model.methods.evaluate.execute({
    requestId: "request-1",
    input: fixture(),
  }, {
    writeResource: (...args: unknown[]) => {
      writes.push(args);
      return Promise.resolve({ name: args[1] });
    },
    logger: { info: () => undefined },
  });
  assert(writes.length === 1 && writes[0][0] === "evaluation");
});

Deno.test("model persists retained legacy output without translation", async () => {
  const writes: unknown[][] = [];
  await model.methods.evaluate.execute({
    requestId: "legacy-request",
    input: legacyFixture(),
  }, {
    writeResource: (...args: unknown[]) => {
      writes.push(args);
      return Promise.resolve({ name: args[1] });
    },
    logger: { info: () => undefined },
  });
  assert(writes.length === 1);
  assert(writes[0][1] === "context-conflict-legacy-request");
  assert(legacyOutputSchema.safeParse(writes[0][2]).success);
  assert(!genericOutputSchema.safeParse(writes[0][2]).success);
});

Deno.test("model logs entry and completion with structured outcome", async () => {
  const logs: unknown[][] = [];
  await model.methods.evaluate.execute({
    requestId: "logged-request",
    input: fixture(),
  }, {
    writeResource: () => Promise.resolve({ name: "evaluation" }),
    logger: { info: (...args: unknown[]) => logs.push(args) },
  });
  assert(logs.length === 2);
  assert(logs[0][0] === "Evaluating registry conflicts for {requestId}");
  assert((logs[0][1] as { requestId: string }).requestId === "logged-request");
  assert(
    logs[1][0] === "Persisted registry conflict evaluation {requestId}",
  );
  const completion = logs[1][1] as Record<string, unknown>;
  assert(completion.requestId === "logged-request");
  assert(completion.verdict === "blocked");
  assert(typeof completion.diagnosticCount === "number");
});

Deno.test("write failures propagate without a false completion log", async () => {
  const logs: unknown[][] = [];
  const failure = new Error("persistence unavailable");
  let caught: unknown;
  try {
    await model.methods.evaluate.execute({
      requestId: "failed-request",
      input: fixture(),
    }, {
      writeResource: () => Promise.reject(failure),
      logger: { info: (...args: unknown[]) => logs.push(args) },
    });
  } catch (error) {
    caught = error;
  }
  assert(caught === failure);
  assert(logs.length === 1);
  assert(logs[0][0] === "Evaluating registry conflicts for {requestId}");
});
