import {
  BOTTLENECK_CRITERIA,
  rankBottlenecks,
} from "./_lib/bottleneck_ranking_contracts.ts";
import { model } from "./bottleneck_ranking.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function rejects(fn: () => unknown, text: string): void {
  try {
    fn();
  } catch (error) {
    assert(String(error).includes(text), `expected ${text}, got ${error}`);
    return;
  }
  throw new Error(`expected failure containing ${text}`);
}

function fixture(): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    rankingId: "synthetic-ranking",
    evaluatedAt: "2026-08-23T12:00:00Z",
    policy: {
      scales: BOTTLENECK_CRITERIA.map((criterion) => ({
        criterion,
        minimum: 0,
        maximum: 10,
        preferredDirection: criterion === "risk" || criterion === "effort"
          ? "lower"
          : "higher",
        normalization: "linear_min_max",
        weight: 1,
      })),
      missingData: "exclude_and_reweight",
      tieBreak: "candidate_id_ascending",
    },
    evidence: [{
      evidenceId: "synthetic-evidence",
      evidenceLink: "https://example.test/evidence",
      observation: "Synthetic test observation",
      sourceReference: {
        schemaVersion: "1.0",
        sourceId: "synthetic-source",
        source: { system: "test", resourceType: "fixture", resourceId: "one" },
        provenance: {
          collector: "test",
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
      },
    }],
    candidates: ["b", "a"].map((candidateId) => ({
      candidateId,
      title: `Candidate ${candidateId}`,
      ratings: BOTTLENECK_CRITERIA.map((criterion) => ({
        criterion,
        value: 5,
        evidenceIds: ["synthetic-evidence"],
        missingReason: null,
      })),
    })),
  };
}

Deno.test("ties, criteria order, evidence ordering, and repeated calculations are deterministic", () => {
  const input = fixture();
  const first = rankBottlenecks(input);
  const second = rankBottlenecks(input);
  assert(JSON.stringify(first) === JSON.stringify(second));
  assert(first.ranking.map((item) => item.candidateId).join(",") === "a,b");
  assert(
    first.ranking[0].criteria.map((item) => item.criterion).join(",") ===
      BOTTLENECK_CRITERIA.join(","),
  );
  assert(
    first.authority.replacesJudgment === false &&
      first.authority.sideEffects === "none",
  );
});

Deno.test("linear normalization, lower-is-better direction, and supplied weights determine the score", () => {
  const input = fixture() as {
    policy: { scales: Array<{ criterion: string; weight: number }> };
    candidates: Array<
      { ratings: Array<{ criterion: string; value: number | null }> }
    >;
  };
  input.policy.scales.find((scale) => scale.criterion === "customerValue")!
    .weight = 10;
  input.candidates[0].ratings.find((rating) =>
    rating.criterion === "customerValue"
  )!.value = 10;
  input.candidates[0].ratings.find((rating) => rating.criterion === "effort")!
    .value = 0;
  const result = rankBottlenecks(input);
  assert(result.ranking[0].candidateId === "b");
  assert(result.ranking[0].score > result.ranking[1].score);
  assert(
    result.ranking[0].criteria.find((item) => item.criterion === "effort")!
      .normalizedValue === 1,
  );
});

Deno.test("missing-data policies either reweight available criteria or retain zero contribution", () => {
  const excluded = fixture() as {
    candidates: Array<
      {
        ratings: Array<
          {
            criterion: string;
            value: number | null;
            evidenceIds: string[];
            missingReason: string | null;
          }
        >;
      }
    >;
    policy: { missingData: string };
  };
  const missing = excluded.candidates[0].ratings.find((rating) =>
    rating.criterion === "effort"
  )!;
  missing.value = null;
  missing.evidenceIds = [];
  missing.missingReason = "No estimate collected";
  const reweighted = rankBottlenecks(excluded);
  assert(
    reweighted.missingDataDisclosure[0].reason === "No estimate collected",
  );
  assert(
    reweighted.ranking.find((item) => item.candidateId === "b")!.criteria.find((
      item,
    ) => item.criterion === "effort")!.effectiveWeight === 0,
  );

  excluded.policy.missingData = "score_as_zero";
  const zeroed = rankBottlenecks(excluded);
  assert(
    zeroed.ranking.find((item) => item.candidateId === "b")!.criteria.find((
      item,
    ) => item.criterion === "effort")!.effectiveWeight === 1 / 6,
  );
});

Deno.test("invalid scales, policy, evidence, rating ranges, and candidate structure fail closed", () => {
  const badMaximum = fixture() as {
    policy: { scales: Array<{ maximum: number }> };
  };
  badMaximum.policy.scales[0].maximum = 0;
  rejects(() => rankBottlenecks(badMaximum), "maximum must exceed minimum");

  const zeroWeights = fixture() as {
    policy: { scales: Array<{ weight: number }> };
  };
  zeroWeights.policy.scales.forEach((scale) => scale.weight = 0);
  rejects(
    () => rankBottlenecks(zeroWeights),
    "at least one weight must be positive",
  );

  const outOfRange = fixture() as {
    candidates: Array<{ ratings: Array<{ value: number }> }>;
  };
  outOfRange.candidates[0].ratings[0].value = 11;
  rejects(() => rankBottlenecks(outOfRange), "within the explicit scale");

  const missingPolicy = fixture() as { policy: { missingData?: string } };
  delete missingPolicy.policy.missingData;
  rejects(() => rankBottlenecks(missingPolicy), "missingData");

  const missingEvidence = fixture() as {
    candidates: Array<{ ratings: Array<{ evidenceIds: string[] }> }>;
  };
  missingEvidence.candidates[0].ratings[0].evidenceIds = ["unknown"];
  rejects(
    () => rankBottlenecks(missingEvidence),
    "reference preserved evidence",
  );
});

Deno.test("the Swamp model writes exactly the deterministic ranking resource", async () => {
  const writes: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  const input = fixture();
  const response = await model.methods.rank.execute({
    requestId: "synthetic-1",
    input,
  }, {
    writeResource: (spec, name, data) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  });
  assert(response.dataHandles.length === 1);
  assert(
    writes.length === 1 && writes[0].spec === "ranking" &&
      writes[0].name === "ranking-synthetic-1",
  );
  assert(
    JSON.stringify(writes[0].data) === JSON.stringify(rankBottlenecks(input)),
  );
});

Deno.test("rejects practical collection and identifier boundaries", () => {
  const tooManyCandidates = fixture() as {
    candidates: Array<Record<string, unknown>>;
  };
  tooManyCandidates.candidates = Array.from({ length: 201 }, (_, index) => ({
    ...tooManyCandidates.candidates[0],
    candidateId: `candidate-${index}`,
  }));
  rejects(() => rankBottlenecks(tooManyCandidates), "Too big");

  const tooManyEvidence = fixture() as {
    evidence: Array<Record<string, unknown>>;
  };
  tooManyEvidence.evidence = Array.from({ length: 501 }, (_, index) => ({
    ...tooManyEvidence.evidence[0],
    evidenceId: `evidence-${index}`,
  }));
  rejects(() => rankBottlenecks(tooManyEvidence), "Too big");

  const tooManyEvidenceIds = fixture() as {
    candidates: Array<{ ratings: Array<{ evidenceIds: string[] }> }>;
  };
  tooManyEvidenceIds.candidates[0].ratings[0].evidenceIds = Array.from(
    { length: 101 },
    (_, index) => `evidence-${index}`,
  );
  rejects(() => rankBottlenecks(tooManyEvidenceIds), "Too big");

  const oversizedId = fixture() as {
    candidates: Array<{ candidateId: string }>;
  };
  oversizedId.candidates[0].candidateId = `a${"b".repeat(200)}`;
  rejects(() => rankBottlenecks(oversizedId), "Invalid string");
});
