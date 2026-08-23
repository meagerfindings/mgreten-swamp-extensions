import { syntheticDossier } from "./_lib/decision_dossier_contracts_test.ts";
import {
  generateWeeklyDecisionQueue,
  MAX_QUEUE_INPUTS,
  MAX_WEEKLY_DOSSIERS,
} from "./_lib/weekly_decision_queue_contracts.ts";
import { model } from "./weekly_decision_queue.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function copy<T>(value: T): T {
  return structuredClone(value);
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
const at = "2026-08-17T12:00:00Z";
function dossier(id: string, dueDay: number) {
  const value = copy(syntheticDossier);
  value.dossierId = id;
  value.authority.decisionDueAt = `2026-08-${
    String(dueDay).padStart(2, "0")
  }T12:00:00Z`;
  value.evidence[0].sourceReference.freshness.expiresAt =
    "2026-09-17T12:00:00Z";
  return {
    status: "available" as const,
    dossier: value,
    sourceReference: `data://decision-dossier/${id}/1`,
  };
}
const ranking = {
  schemaVersion: "1.0",
  rankingId: "ranking-1",
  evaluatedAt: "2026-08-17T10:00:00Z",
  policy: {
    scales: [
      "customerValue",
      "confidence",
      "strategicFit",
      "economicValue",
      "risk",
      "effort",
    ].map((criterion) => ({
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
  evidence: [],
  ranking: [{
    rank: 1,
    candidateId: "bottleneck-1",
    title: "Synthetic bottleneck",
    score: .75,
    criteria: [{
      criterion: "confidence",
      rawValue: 7.5,
      normalizedValue: .75,
      effectiveWeight: 1,
      contribution: .75,
      evidenceIds: ["e-2", "e-1"],
      missingReason: null,
    }],
  }],
  missingDataDisclosure: [],
  authority: {
    disposition: "recommendation_only",
    replacesJudgment: false,
    sideEffects: "none",
  },
};
const input = () => ({
  schemaVersion: "1.0",
  queueId: "queue-1",
  generatedAt: at,
  dossiers: [
    dossier("d", 22),
    dossier("b", 20),
    dossier("c", 21),
    dossier("a", 20),
  ],
  bottleneckRanking: {
    status: "available" as const,
    ranking: copy(ranking),
    sourceReference: "data://bottleneck-ranking/ranking-1",
  },
});

Deno.test("queue is deterministic, due-date ordered, and bounded to three dossiers", () => {
  const first = generateWeeklyDecisionQueue(input());
  const second = generateWeeklyDecisionQueue(input());
  assert(JSON.stringify(first) === JSON.stringify(second));
  assert(first.dossiers.length === MAX_WEEKLY_DOSSIERS);
  assert(first.dossiers.map((item) => item.dossierId).join(",") === "a,b,c");
  assert(
    first.dossierOmissions.some((item) =>
      item.dossierId === "d" && item.state === "outside_queue_limit"
    ),
  );
  assert(first.dossiers[0].sourceReference === "data://decision-dossier/a/1");
});

Deno.test("exactly one top bottleneck is recommended without authority or side effects", () => {
  const result = generateWeeklyDecisionQueue(input());
  assert(result.currentBottleneck.status === "recommended");
  if (result.currentBottleneck.status === "recommended") {
    assert(result.currentBottleneck.candidateId === "bottleneck-1");
    assert(result.currentBottleneck.evidenceIds.join(",") === "e-1,e-2");
  }
  assert(
    !result.authority.mayExecute && !result.authority.replacesJudgment &&
      result.authority.sideEffects === "none",
  );
});

Deno.test("stale, unavailable, empty ranking, and future ranking states are explicit", () => {
  const value = input();
  value.dossiers = [
    dossier("fresh", 20),
    dossier("stale", 19),
    {
      status: "unavailable",
      dossierId: "missing",
      reason: "No dossier produced",
      sourceReference: "data://decision-dossier/missing",
    } as never,
  ];
  (value.dossiers[1] as ReturnType<typeof dossier>).dossier.evidence[0]
    .sourceReference.freshness.expiresAt = "2026-08-16T12:00:00Z";
  value.bottleneckRanking.ranking.ranking = [];
  const result = generateWeeklyDecisionQueue(value);
  assert(result.dossiers.length === 1);
  assert(
    result.dossierOmissions.map((item) => item.state).sort().join(",") ===
      "stale,unavailable",
  );
  assert(result.currentBottleneck.status === "unavailable");
  const future = input();
  future.bottleneckRanking.ranking.evaluatedAt = "2026-08-18T12:00:00Z";
  assert(
    generateWeeklyDecisionQueue(future).currentBottleneck.status ===
      "unavailable",
  );
});

Deno.test("strict schemas reject extras and oversized inputs", () => {
  rejects(
    () => generateWeeklyDecisionQueue({ ...input(), extra: true }),
    "unrecognized_keys",
  );
  const duplicate = input();
  duplicate.dossiers = [dossier("same", 20), dossier("same", 21)];
  rejects(() => generateWeeklyDecisionQueue(duplicate), "must be unique");
  const oversized = input();
  oversized.dossiers = Array.from(
    { length: MAX_QUEUE_INPUTS + 1 },
    (_, index) => dossier(`d-${index}`, 20),
  );
  rejects(() => generateWeeklyDecisionQueue(oversized), "too_big");
  assert(
    !model.methods.generate.arguments.safeParse({
      requestId: "queue",
      input: input(),
      bypass: true,
    }).success,
  );
});

Deno.test("imported ranking must be contiguous and correctly ordered", () => {
  const malformed = input();
  malformed.bottleneckRanking.ranking.ranking = [
    { ...ranking.ranking[0], rank: 2, candidateId: "b" },
    { ...ranking.ranking[0], rank: 1, candidateId: "a" },
  ];
  rejects(
    () => generateWeeklyDecisionQueue(malformed),
    "ranks must be contiguous",
  );

  const wrongTie = input();
  wrongTie.bottleneckRanking.ranking.ranking = [
    { ...ranking.ranking[0], rank: 1, candidateId: "b" },
    { ...ranking.ranking[0], rank: 2, candidateId: "a" },
  ];
  rejects(
    () => generateWeeklyDecisionQueue(wrongTie),
    "ascending candidateId ties",
  );
});
