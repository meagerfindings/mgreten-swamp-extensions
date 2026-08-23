import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  compileDecisionContext,
  type DecisionContextInput,
} from "./decision_context_contracts.ts";
import { model } from "./decision_context.ts";

const hash = (letter: string) => letter.repeat(64);
const kinds = [
  "policy",
  "operating_context",
  "decision_brief",
  "action_brief",
] as const;
const fixture = (): DecisionContextInput => ({
  schemaVersion: "1.0",
  packetId: "packet-1",
  evaluatedAt: "2026-08-23T12:00:00Z",
  bindings: kinds.map((kind, index) => ({
    kind,
    artifactId: `${kind}-1`,
    version: "v1",
    contentHash: hash(String.fromCharCode(97 + index)),
    observedAt: "2026-08-22T00:00:00Z",
    expiresAt: "2026-08-24T00:00:00Z",
    approved: true,
  })),
  safeClaims: [{
    claimId: "claim-1",
    statement: "Synthetic evidence-backed claim",
    evidenceIds: ["e-1"],
  }],
  outcomes: ["entry", "activation", "retention", "completion", "adoption"].map((
    outcome,
  ) => ({
    domain: "initiative" as const,
    outcome,
    status: "observed" as const,
    dimensions: {
      initiativeId: "initiative-1",
      subjectId: "subject-1",
      window: {
        startsAt: "2026-08-01T00:00:00Z",
        endsAt: "2026-08-22T00:00:00Z",
      },
    },
    value: 10,
    unit: "units",
    sourceBinding: {
      artifactId: "outcome-1",
      version: "v1",
      contentHash: hash("f"),
    },
  })),
  evidence: [
    {
      evidenceId: "e-1",
      sourceType: "first_party_aggregate",
      classification: "private",
      rightsStatus: "cleared",
      termsStatus: "compliant",
      contentHash: hash("a"),
      observedAt: "2026-08-22T00:00:00Z",
      expiresAt: "2026-08-24T00:00:00Z",
      sampleSize: 20,
    },
    {
      evidenceId: "e-2",
      sourceType: "public_reference",
      classification: "public",
      rightsStatus: "cleared",
      termsStatus: "compliant",
      contentHash: hash("b"),
      observedAt: "2026-08-22T00:00:00Z",
      expiresAt: "2026-08-24T00:00:00Z",
      sampleSize: 10,
    },
  ],
  requestedRecommendation: "none",
});

Deno.test("canonicalizes equivalent synthetic evidence without authority", () => {
  const first = compileDecisionContext(fixture());
  const reordered = fixture();
  reordered.bindings.reverse();
  reordered.evidence.reverse();
  reordered.outcomes.reverse();
  assertEquals(first, compileDecisionContext(reordered));
  assertEquals(first.diagnostics, []);
  assertEquals(first.authority, {
    disposition: "recommendation_and_persistence_only",
    providerInvocation: false,
    network: false,
    publish: false,
    externalCommunication: false,
    spend: false,
    policyChange: false,
    productionMutation: false,
  });
});

Deno.test("incomplete evidence cannot produce a positive recommendation", () => {
  const input = fixture();
  input.outcomes = input.outcomes.slice(0, 1);
  input.requestedRecommendation = "continue";
  const packet = compileDecisionContext(input);
  assertEquals(packet.recommendation, "collect_more_evidence");
  assert(
    packet.diagnostics.some((item) =>
      item.code === "missing_downstream_outcomes"
    ),
  );
  assert(
    packet.diagnostics.some((item) =>
      item.code === "insufficient_evidence_cannot_recommend"
    ),
  );
});

Deno.test("model writes exactly one packet and exposes no effect methods", async () => {
  const writes: unknown[][] = [];
  const logs: unknown[][] = [];
  const result = await model.methods.compile.execute(fixture(), {
    readResource: () => Promise.resolve(null),
    writeResource: (...args: unknown[]) => {
      writes.push(args);
      return Promise.resolve({ name: args[1] });
    },
    logger: { info: (...args: unknown[]) => logs.push(args) },
  });
  assertEquals(Object.keys(model.methods), ["compile"]);
  assert(!("files" in model));
  assertEquals(writes.length, 1);
  assertEquals(logs.length, 2);
  assertEquals(result, { dataHandles: [{ name: "packet-1" }] });
});

Deno.test("same packet ID is immutable and replay-safe", async () => {
  const packet = compileDecisionContext(fixture());
  const writes: unknown[] = [];
  const context = {
    readResource: () => Promise.resolve(packet),
    writeResource: (...args: unknown[]) => {
      writes.push(args);
      return Promise.resolve({});
    },
    logger: {
      info: (_message: string, _properties: Record<string, unknown>) => {},
    },
  };
  assertEquals(await model.methods.compile.execute(fixture(), context), {
    dataHandles: [],
  });
  const changed = fixture();
  changed.safeClaims[0].statement = "Changed claim";
  let rejected = false;
  try {
    await model.methods.compile.execute(changed, context);
  } catch (error) {
    rejected = String(error).includes("Conflicting replay");
  }
  assert(rejected);
  assertEquals(writes.length, 0);
});

Deno.test("rejects malformed, future, and duplicate provenance input", () => {
  const malformed = fixture();
  const malformedEvidence = { ...malformed.evidence[0], unexpected: true };
  const cases: unknown[] = [
    { ...malformed, evidence: [malformedEvidence, malformed.evidence[1]] },
  ];
  const future = fixture();
  future.evidence[0].observedAt = "2026-08-24T00:00:00Z";
  cases.push(future);
  const duplicate = fixture();
  duplicate.safeClaims[0].evidenceIds.push("e-1");
  cases.push(duplicate);
  const tampered = fixture();
  tampered.bindings[0].contentHash = "tampered";
  cases.push(tampered);

  for (const input of cases) {
    let rejected = false;
    try {
      compileDecisionContext(input);
    } catch {
      rejected = true;
    }
    assert(rejected);
  }
});
