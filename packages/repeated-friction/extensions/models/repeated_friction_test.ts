import { detectRepeatedFriction } from "./_lib/repeated_friction_contracts.ts";
import { model } from "./repeated_friction.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function rejects(fn: () => unknown, text: string) {
  try {
    fn();
  } catch (error) {
    assert(String(error).includes(text), String(error));
    return;
  }
  throw new Error(`expected ${text}`);
}
const signal = (
  id: string,
  sourceId: string,
  category = "onboarding",
  confidence = 0.9,
  observedAt = "2026-08-16T09:00:00Z",
) => ({
  schemaVersion: "1.0",
  signalId: id,
  sourceReference: {
    schemaVersion: "1.0",
    sourceId,
    source: { system: "synthetic", resourceType: "feedback", resourceId: id },
    provenance: {
      collector: "fixture",
      collectorVersion: "1",
      method: "synthetic",
      collectedAt: "2026-08-16T10:00:00Z",
    },
    observedAt,
    freshness: {
      asOf: "2026-08-16T10:00:00Z",
      expiresAt: "2026-08-20T00:00:00Z",
    },
    sensitivity: "internal",
  },
  category,
  severity: "medium",
  confidence,
  recurrence: {
    kind: "once",
    count: 1,
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
  },
  impact: { summary: "Synthetic confusion", scope: "individual" },
  evidenceLinks: [`https://example.test/${id}`],
  recommendedEscalation: {
    action: "investigate",
    urgency: "routine",
    rationale: "Synthetic",
  },
});
const fixture = () => ({
  schemaVersion: "1.0",
  evaluationId: "eval-1",
  evaluatedAt: "2026-08-17T12:00:00Z",
  policy: {
    categories: [
      {
        category: "onboarding",
        minimumSignalCount: 2,
        minimumAbandonmentCount: 1,
        minimumDistinctSourceIdentities: 2,
        minimumSignalConfidence: 0.8,
      },
      {
        category: "pricing",
        minimumSignalCount: 2,
        minimumAbandonmentCount: 0,
        minimumDistinctSourceIdentities: 2,
        minimumSignalConfidence: 0.8,
      },
    ],
    lookback: {
      startsAt: "2026-08-10T00:00:00Z",
      endsAt: "2026-08-17T12:00:00Z",
    },
    freshness: {
      requireAvailableByEvaluation: true,
      requireUnexpiredAtEvaluation: true,
    },
    ordering: "category_group_key_ascending",
  },
  signals: [
    {
      experienceId: "experience-2",
      sourceIdentity: { sourceId: "source-2", sourceRecordId: "signal-2" },
      groupKey: "setup",
      abandonment: true,
      signal: signal("signal-2", "source-2"),
    },
    {
      experienceId: "experience-1",
      sourceIdentity: { sourceId: "source-1", sourceRecordId: "signal-1" },
      groupKey: "setup",
      abandonment: false,
      signal: signal("signal-1", "source-1"),
    },
  ],
});

Deno.test("detects repeated friction deterministically while preserving separate identities and provenance", () => {
  const input = fixture();
  const first = detectRepeatedFriction(input);
  const second = detectRepeatedFriction(input);
  assert(JSON.stringify(first) === JSON.stringify(second));
  assert(first.groups[0].queueDisposition === "recommend_for_evidence_queue");
  assert(
    first.groups[0].experienceIds.join(",") === "experience-1,experience-2",
  );
  assert(
    first.preservedSignals[0].signal.sourceReference.provenance.collector ===
      "fixture",
  );
  assert(
    first.authority.mayMergeExperiences === false &&
      first.authority.mayUseNetwork === false,
  );
  assert(
    first.categoryStates.find((item) => item.category === "pricing")?.state ===
      "unavailable_no_signals",
  );
});

Deno.test("explicit confidence, freshness, lookback, abandonment, and distinct-source thresholds govern eligibility", () => {
  const low = fixture();
  low.signals[0].signal.confidence = 0.1;
  const result = detectRepeatedFriction(low);
  assert(
    result.groups[0].state === "insufficient_evidence" &&
      result.groups[0].distinctSourceIdentityCount === 1,
  );
  const unavailable = fixture();
  unavailable.signals.forEach((item) =>
    item.signal.sourceReference.freshness.expiresAt = "2026-08-17T11:00:00Z"
  );
  assert(
    detectRepeatedFriction(unavailable).categoryStates[0].state ===
      "unavailable_no_eligible_signals",
  );
});

Deno.test("strict bounds, identities, category policy, and chronology fail closed", () => {
  const missingPolicy = fixture();
  missingPolicy.signals[0].signal.category = "trust";
  rejects(
    () => detectRepeatedFriction(missingPolicy),
    "explicit category policy",
  );
  const merged = fixture();
  merged.signals[1].experienceId = "experience-2";
  rejects(() => detectRepeatedFriction(merged), "duplicate identity");
  const mismatched = fixture();
  mismatched.signals[0].sourceIdentity.sourceId = "other";
  rejects(
    () => detectRepeatedFriction(mismatched),
    "must preserve signal sourceId",
  );
  const mismatchedRecord = fixture();
  mismatchedRecord.signals[0].sourceIdentity.sourceRecordId = "other";
  rejects(
    () => detectRepeatedFriction(mismatchedRecord),
    "must preserve the signal source resourceId",
  );
  const implicit = fixture();
  delete (implicit.policy.categories[0] as Record<string, unknown>)
    .minimumSignalConfidence;
  rejects(() => detectRepeatedFriction(implicit), "minimumSignalConfidence");
});

Deno.test("persistence-only model writes one bounded evaluation and performs no other effect", async () => {
  const writes: unknown[][] = [];
  await model.methods.evaluate.execute({ requestId: "r1", input: fixture() }, {
    writeResource: (...args: unknown[]) => {
      writes.push(args);
      return Promise.resolve({ name: args[1] });
    },
  });
  assert(
    writes.length === 1 && writes[0][0] === "evaluation" &&
      writes[0][1] === "evaluation-r1",
  );
  assert(
    !model.methods.evaluate.arguments.safeParse({
      requestId: "r1",
      input: fixture(),
      unexpected: true,
    }).success,
  );
});

Deno.test("lookback boundaries are inclusive and optional freshness gates do not discard evidence", () => {
  const input = fixture();
  input.signals.forEach((item) => {
    item.signal.sourceReference.observedAt = "2026-08-10T00:00:00Z";
    item.signal.sourceReference.provenance.collectedAt = "2026-08-16T10:00:00Z";
    item.signal.recurrence.firstObservedAt = "2026-08-10T00:00:00Z";
    item.signal.recurrence.lastObservedAt = "2026-08-10T00:00:00Z";
    item.signal.sourceReference.freshness.asOf = "2026-08-18T00:00:00Z";
    item.signal.sourceReference.freshness.expiresAt = "2026-08-19T00:00:00Z";
  });
  input.policy.freshness.requireAvailableByEvaluation = false;
  input.policy.freshness.requireUnexpiredAtEvaluation = false;

  const result = detectRepeatedFriction(input);
  assert(result.groups[0].state === "repeated");
  assert(result.preservedSignals.every((item) => item.eligibility.inLookback));
  assert(result.preservedSignals.every((item) => item.eligibility.eligible));
});

Deno.test("fails before returning an output when more than one hundred eligible groups exist", () => {
  const input = fixture();
  input.policy.categories = [{
    category: "onboarding",
    minimumSignalCount: 1,
    minimumAbandonmentCount: 0,
    minimumDistinctSourceIdentities: 1,
    minimumSignalConfidence: 0,
  }];
  input.signals = Array.from({ length: 101 }, (_, index) => {
    const id = `signal-${index}`;
    return {
      experienceId: `experience-${index}`,
      sourceIdentity: { sourceId: `source-${index}`, sourceRecordId: id },
      groupKey: `group-${index}`,
      abandonment: false,
      signal: signal(id, `source-${index}`),
    };
  });

  rejects(() => detectRepeatedFriction(input), "group output exceeds 100");
});
