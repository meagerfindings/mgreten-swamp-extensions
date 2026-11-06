import { z } from "npm:zod@4";
import { bottleneckRankingOutputSchema } from "./bottleneck_ranking_contracts.ts";
import { DecisionDossier } from "./decision_dossier_contracts.ts";

export const WEEKLY_DECISION_QUEUE_SCHEMA_VERSION = "1.0" as const;
export const MAX_WEEKLY_DOSSIERS = 3 as const;
export const MAX_QUEUE_INPUTS = 50 as const;

const Text = z.string().trim().min(1);
const Timestamp = z.iso.datetime({ offset: true });
const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;
const unavailableDossierSchema = z.strictObject({
  status: z.literal("unavailable"),
  dossierId: Text,
  reason: Text,
  sourceReference: Text,
});
const availableDossierSchema = z.strictObject({
  status: z.literal("available"),
  dossier: DecisionDossier,
  sourceReference: Text,
});

export const weeklyDecisionQueueInputSchema = z.strictObject({
  schemaVersion: z.literal(WEEKLY_DECISION_QUEUE_SCHEMA_VERSION),
  queueId: Text,
  generatedAt: Timestamp,
  dossiers: z.array(
    z.discriminatedUnion("status", [
      availableDossierSchema,
      unavailableDossierSchema,
    ]),
  ).max(MAX_QUEUE_INPUTS),
  bottleneckRanking: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("available"),
      ranking: bottleneckRankingOutputSchema,
      sourceReference: Text,
    }),
    z.strictObject({
      status: z.literal("unavailable"),
      reason: Text,
      sourceReference: Text,
    }),
  ]),
}).superRefine((input, validation) => {
  const dossierIds = new Set<string>();
  input.dossiers.forEach((entry, index) => {
    const dossierId = entry.status === "available"
      ? entry.dossier.dossierId
      : entry.dossierId;
    if (dossierIds.has(dossierId)) {
      validation.addIssue({
        code: "custom",
        path: ["dossiers", index],
        message: "dossierId must be unique",
      });
    }
    dossierIds.add(dossierId);
  });
});

const dossierQueueItemSchema = z.strictObject({
  position: z.number().int().min(1).max(MAX_WEEKLY_DOSSIERS),
  dossierId: Text,
  dossierVersion: z.number().int().positive(),
  decisionDueAt: Timestamp,
  freshness: z.strictObject({
    status: z.literal("fresh"),
    expiresAt: Timestamp,
  }),
  sourceReference: Text,
  dossier: DecisionDossier,
});
const omissionSchema = z.strictObject({
  dossierId: Text,
  state: z.enum(["stale", "unavailable", "outside_queue_limit"]),
  reason: Text,
  sourceReference: Text,
});
const bottleneckSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("recommended"),
    candidateId: Text,
    title: Text,
    rank: z.literal(1),
    score: z.number().finite(),
    evidenceIds: z.array(Text).max(300),
    sourceReference: Text,
    evaluatedAt: Timestamp,
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: Text,
    sourceReference: Text,
  }),
]);

export const weeklyDecisionQueueOutputSchema = z.strictObject({
  schemaVersion: z.literal(WEEKLY_DECISION_QUEUE_SCHEMA_VERSION),
  queueId: Text,
  generatedAt: Timestamp,
  dossiers: z.array(dossierQueueItemSchema).max(MAX_WEEKLY_DOSSIERS),
  dossierOmissions: z.array(omissionSchema).max(MAX_QUEUE_INPUTS),
  currentBottleneck: bottleneckSchema,
  authority: z.strictObject({
    disposition: z.literal("recommendation_only"),
    replacesJudgment: z.literal(false),
    mayExecute: z.literal(false),
    sideEffects: z.literal("none"),
  }),
});
export type WeeklyDecisionQueue = z.infer<
  typeof weeklyDecisionQueueOutputSchema
>;

export function generateWeeklyDecisionQueue(raw: unknown): WeeklyDecisionQueue {
  const input = weeklyDecisionQueueInputSchema.parse(raw);
  const at = Date.parse(input.generatedAt);
  const omissions: z.infer<typeof omissionSchema>[] = [];
  const fresh = input.dossiers.flatMap((entry) => {
    if (entry.status === "unavailable") {
      omissions.push({
        dossierId: entry.dossierId,
        state: "unavailable",
        reason: entry.reason,
        sourceReference: entry.sourceReference,
      });
      return [];
    }
    const expiry = entry.dossier.evidence.reduce(
      (earliest, evidence) =>
        Date.parse(evidence.sourceReference.freshness.expiresAt) <
            Date.parse(earliest)
          ? evidence.sourceReference.freshness.expiresAt
          : earliest,
      entry.dossier.evidence[0].sourceReference.freshness.expiresAt,
    );
    const availableAt = entry.dossier.evidence.every((evidence) =>
      Date.parse(evidence.sourceReference.freshness.asOf) <= at
    );
    if (!availableAt || Date.parse(expiry) < at) {
      omissions.push({
        dossierId: entry.dossier.dossierId,
        state: "stale",
        reason: availableAt
          ? `Evidence expired at ${expiry}`
          : "Evidence was not available by generatedAt",
        sourceReference: entry.sourceReference,
      });
      return [];
    }
    return [{ entry, expiry }];
  }).sort((a, b) =>
    Date.parse(a.entry.dossier.authority.decisionDueAt) -
      Date.parse(b.entry.dossier.authority.decisionDueAt) ||
    compareText(a.entry.dossier.dossierId, b.entry.dossier.dossierId)
  );

  fresh.slice(MAX_WEEKLY_DOSSIERS).forEach(({ entry }) =>
    omissions.push({
      dossierId: entry.dossier.dossierId,
      state: "outside_queue_limit",
      reason: `Queue is limited to ${MAX_WEEKLY_DOSSIERS} dossiers`,
      sourceReference: entry.sourceReference,
    })
  );
  const dossiers = fresh.slice(0, MAX_WEEKLY_DOSSIERS).map((
    { entry, expiry },
    index,
  ) => ({
    position: index + 1,
    dossierId: entry.dossier.dossierId,
    dossierVersion: entry.dossier.version,
    decisionDueAt: entry.dossier.authority.decisionDueAt,
    freshness: { status: "fresh" as const, expiresAt: expiry },
    sourceReference: entry.sourceReference,
    dossier: entry.dossier,
  }));

  let currentBottleneck: z.infer<typeof bottleneckSchema>;
  if (input.bottleneckRanking.status === "unavailable") {
    currentBottleneck = {
      status: "unavailable",
      reason: input.bottleneckRanking.reason,
      sourceReference: input.bottleneckRanking.sourceReference,
    };
  } else if (
    Date.parse(input.bottleneckRanking.ranking.evaluatedAt) > at ||
    input.bottleneckRanking.ranking.evidence.some((evidence) =>
      Date.parse(evidence.sourceReference.freshness.asOf) > at ||
      Date.parse(evidence.sourceReference.freshness.expiresAt) < at
    ) ||
    input.bottleneckRanking.ranking.ranking.length === 0
  ) {
    const evidenceIsStale = input.bottleneckRanking.ranking.evidence.some(
      (evidence) =>
        Date.parse(evidence.sourceReference.freshness.asOf) > at ||
        Date.parse(evidence.sourceReference.freshness.expiresAt) < at,
    );
    currentBottleneck = {
      status: "unavailable",
      reason: Date.parse(input.bottleneckRanking.ranking.evaluatedAt) > at
        ? "Ranking was not available by generatedAt"
        : evidenceIsStale
        ? "Ranking evidence is not fresh at generatedAt"
        : "Ranking contains no candidates",
      sourceReference: input.bottleneckRanking.sourceReference,
    };
  } else {
    const first = input.bottleneckRanking.ranking.ranking[0];
    currentBottleneck = {
      status: "recommended",
      candidateId: first.candidateId,
      title: first.title,
      rank: 1,
      score: first.score,
      evidenceIds: [
        ...new Set(
          first.criteria.flatMap((criterion) => criterion.evidenceIds),
        ),
      ].sort(),
      sourceReference: input.bottleneckRanking.sourceReference,
      evaluatedAt: input.bottleneckRanking.ranking.evaluatedAt,
    };
  }
  return weeklyDecisionQueueOutputSchema.parse({
    schemaVersion: input.schemaVersion,
    queueId: input.queueId,
    generatedAt: input.generatedAt,
    dossiers,
    dossierOmissions: omissions.sort((a, b) =>
      compareText(a.dossierId, b.dossierId) || compareText(a.state, b.state)
    ),
    currentBottleneck,
    authority: {
      disposition: "recommendation_only",
      replacesJudgment: false,
      mayExecute: false,
      sideEffects: "none",
    },
  });
}
