import { evaluateCampaignOutcomeEvidence } from "./_lib/campaign_outcome_contracts.ts";
import { model } from "./campaign_outcome.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

const hash = (letter: string) => letter.repeat(64);
const source = (sourceId: string) => ({
  sourceId,
  system: "synthetic-warehouse",
  resourceType: "aggregate",
  resourceId: sourceId,
  resourceVersion: "v1",
  contentHash: hash("a"),
  provenance: {
    collector: "synthetic-test",
    method: "declared-fixture",
    collectedAt: "2026-08-17T10:00:00Z",
  },
  freshness: {
    asOf: "2026-08-17T10:00:00Z",
    expiresAt: "2026-08-18T00:00:00Z",
  },
});
const measure = (
  status: "observed" | "unavailable" | "hypothetical",
  name: string,
) => ({
  status,
  ...(status === "unavailable"
    ? { reason: "Synthetic source has no aggregate" }
    : { value: 2 }),
  ...(status === "hypothetical"
    ? { assumption: "Synthetic scenario only" }
    : {}),
  denominator: { name: "eligible_sessions", count: 10, unit: "sessions" },
  window: { startsAt: "2026-08-10T00:00:00Z", endsAt: "2026-08-17T00:00:00Z" },
  source: source(name),
  evidenceIds: ["ev-1"],
  uncertaintyIds: ["u-1"],
});
const fixture = () => ({
  schemaVersion: "1.0",
  outcomeId: "outcome-1",
  evaluatedAt: "2026-08-17T12:00:00Z",
  campaign: { id: "campaign-1", version: "v2", sha256: hash("b") },
  creative: { id: "creative-1", version: "v3", sha256: hash("c") },
  message: { id: "message-1", version: "v4", sha256: hash("d") },
  landing: { id: "landing-1", version: "v5", sha256: hash("e"), path: "/test" },
  spend: {
    ...measure("observed", "spend-source"),
    currency: "TST",
    unit: "currency_minor",
    spendDenominator: "campaign_total",
  },
  outcomes: ["paid", "checkout", "retention", "activation", "acquisition"].map((
    stage,
    index,
  ) => ({
    stage,
    metric: `${stage}_aggregate`,
    measurement: measure(
      index === 2 ? "unavailable" : index === 1 ? "hypothetical" : "observed",
      `${stage}-source`,
    ),
  })),
  evidence: [{
    evidenceId: "ev-1",
    claim: "Synthetic aggregate fixture",
    source: source("evidence-source"),
  }],
  uncertainties: [{
    uncertaintyId: "u-1",
    statement: "Synthetic attribution uncertainty",
    impact: "medium",
  }],
  recommendation: {
    type: "no_action",
    rationale: "Human review is required",
    evidenceIds: ["ev-1"],
    uncertaintyIds: ["u-1"],
    authority: "human_decision_required",
    actionTaken: false,
  },
  privacy: {
    aggregation: "aggregate_only",
    containsUserLevelData: false,
    containsUserStories: false,
  },
});

Deno.test("accepts aggregate evidence and canonicalizes every ordered collection", () => {
  const value = fixture();
  value.spend.evidenceIds = ["ev-1"];
  const result = evaluateCampaignOutcomeEvidence(value);
  assert(result.success);
  assert(
    result.value.outcomes.map((item) => item.stage).join(",") ===
      "acquisition,activation,retention,checkout,paid",
  );
});

Deno.test("rejects boundary chronology, duplicated stages, and unrecognized references", () => {
  const invalid: unknown[] = [];
  const zeroWindow = fixture();
  zeroWindow.spend.window.endsAt = zeroWindow.spend.window.startsAt;
  invalid.push(zeroWindow);
  const duplicateStage = fixture();
  duplicateStage.outcomes[0].stage = "acquisition";
  invalid.push(duplicateStage);
  const duplicateReference = fixture();
  duplicateReference.spend.evidenceIds = ["ev-1", "ev-1"];
  invalid.push(duplicateReference);
  const unknownUncertainty = fixture();
  unknownUncertainty.recommendation.uncertaintyIds = ["missing"];
  invalid.push(unknownUncertainty);
  for (const value of invalid) {
    assert(!evaluateCampaignOutcomeEvidence(value).success);
  }
});

Deno.test("rejects evidence expiring exactly at evaluatedAt", () => {
  const value = fixture();
  value.evidence[0].source.freshness.expiresAt = value.evaluatedAt;
  assert(!evaluateCampaignOutcomeEvidence(value).success);
});

Deno.test("rejects strict-object leaks and does not persist invalid evidence", async () => {
  const value = fixture() as Record<string, unknown>;
  value.unexpected = "leak";
  const writes: unknown[][] = [];
  await model.methods.record.execute({
    recordId: "valid-id",
    evidence: fixture(),
  }, {
    writeResource: (...args: unknown[]) => {
      writes.push(args);
      return Promise.resolve({ name: args[1] });
    },
  });
  assert(writes.length === 1 && writes[0][1] === "evidence-valid-id");
  await (async () => {
    try {
      await model.methods.record.execute({
        recordId: "valid-id",
        evidence: value,
      }, {
        writeResource: (...args: unknown[]) =>
          Promise.resolve(writes.push(args)),
      });
      throw new Error("expected invalid evidence to throw");
    } catch (error) {
      assert(error instanceof TypeError);
    }
  })();
  assert(writes.length === 1);
});
