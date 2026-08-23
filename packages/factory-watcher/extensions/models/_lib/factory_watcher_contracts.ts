import { z } from "npm:zod@4";
import { sourceReferenceSchema } from "./source_reference.ts";

export const FACTORY_WATCHER_SCHEMA_VERSION = "1.0" as const;
export const FACTORY_WATCHER_CATEGORIES = [
  "repeated_cycle",
  "context_gap",
  "permission_friction",
  "rejected_plan",
  "recurring_finding",
  "wasteful_model_routing",
  "factory_improvement",
] as const;

const Category = z.enum(FACTORY_WATCHER_CATEGORIES);
const Id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
const Text = z.string().trim().min(1).max(2_000);
const Timestamp = z.iso.datetime({ offset: true });
const Evidence = z.strictObject({
  evidenceId: Id,
  evidenceLink: z.url(),
  summary: Text,
  sourceReference: sourceReferenceSchema,
});
const Availability = z.strictObject({
  category: Category,
  status: z.enum(["available", "unavailable"]),
  unavailableReason: Text.nullable(),
});
const Threshold = z.strictObject({
  category: Category,
  minimumOccurrences: z.number().int().positive().max(100),
  lookbackHours: z.number().int().positive().max(24 * 366),
  priority: z.number().int().min(0).max(100),
  recommendation: Text,
});
const Observation = z.strictObject({
  observationId: Id,
  category: Category,
  signalKey: Id,
  occurredAt: Timestamp,
  evidenceIds: z.array(Id).min(1).max(20),
});

export const factoryWatcherInputSchema = z.strictObject({
  schemaVersion: z.literal(FACTORY_WATCHER_SCHEMA_VERSION),
  watchId: Id,
  evaluatedAt: Timestamp,
  policy: z.strictObject({
    thresholds: z.array(Threshold).length(FACTORY_WATCHER_CATEGORIES.length),
    tieBreak: z.literal("priority_desc_category_asc_signal_key_asc"),
    maximumRecommendations: z.number().int().positive().max(100),
  }),
  availability: z.array(Availability).length(FACTORY_WATCHER_CATEGORIES.length),
  evidence: z.array(Evidence).max(500),
  observations: z.array(Observation).max(500),
}).superRefine((input, context) => {
  const issue = (path: PropertyKey[], message: string) =>
    context.addIssue({ code: "custom", path, message });
  const requireExactlyOne = (
    values: readonly { category: typeof FACTORY_WATCHER_CATEGORIES[number] }[],
    path: string,
  ) =>
    FACTORY_WATCHER_CATEGORIES.forEach((category) => {
      if (values.filter((value) => value.category === category).length !== 1) {
        issue([path], `exactly one ${category} entry is required`);
      }
    });

  requireExactlyOne(input.policy.thresholds, "policy.thresholds");
  requireExactlyOne(input.availability, "availability");
  input.availability.forEach((entry, index) => {
    if (entry.status === "unavailable" && entry.unavailableReason === null) {
      issue(
        ["availability", index, "unavailableReason"],
        "unavailable data requires a reason",
      );
    }
    if (entry.status === "available" && entry.unavailableReason !== null) {
      issue(
        ["availability", index, "unavailableReason"],
        "available data cannot have an unavailable reason",
      );
    }
  });
  const evidenceIds = new Set<string>();
  input.evidence.forEach((evidence, index) => {
    if (evidenceIds.has(evidence.evidenceId)) {
      issue(["evidence", index, "evidenceId"], "duplicate evidenceId");
    }
    evidenceIds.add(evidence.evidenceId);
    if (
      Date.parse(evidence.sourceReference.freshness.asOf) >
        Date.parse(input.evaluatedAt)
    ) {
      issue(
        ["evidence", index, "sourceReference", "freshness", "asOf"],
        "evidence must be available by evaluatedAt",
      );
    }
    if (
      Date.parse(evidence.sourceReference.freshness.expiresAt) <
        Date.parse(input.evaluatedAt)
    ) {
      issue(
        ["evidence", index, "sourceReference", "freshness", "expiresAt"],
        "evidence must be fresh at evaluatedAt",
      );
    }
  });
  const observationIds = new Set<string>();
  input.observations.forEach((observation, index) => {
    if (observationIds.has(observation.observationId)) {
      issue(
        ["observations", index, "observationId"],
        "duplicate observationId",
      );
    }
    observationIds.add(observation.observationId);
    if (Date.parse(observation.occurredAt) > Date.parse(input.evaluatedAt)) {
      issue(
        ["observations", index, "occurredAt"],
        "observation cannot be in the future",
      );
    }
    if (
      input.availability.find((entry) =>
        entry.category === observation.category
      )?.status !== "available"
    ) {
      issue(
        ["observations", index, "category"],
        "observations cannot claim unavailable data",
      );
    }
    const references = new Set<string>();
    observation.evidenceIds.forEach((id, evidenceIndex) => {
      if (references.has(id)) {
        issue(
          ["observations", index, "evidenceIds", evidenceIndex],
          "duplicate evidence reference",
        );
      }
      references.add(id);
      if (!evidenceIds.has(id)) {
        issue(
          ["observations", index, "evidenceIds", evidenceIndex],
          "unknown evidenceId",
        );
      }
    });
  });
});

const Recommendation = z.strictObject({
  category: Category,
  signalKey: Id,
  occurrenceCount: z.number().int().positive(),
  threshold: Threshold,
  recommendation: Text,
  priority: z.number().int().min(0).max(100),
  observationIds: z.array(Id),
  evidenceIds: z.array(Id),
});

export const factoryWatcherOutputSchema = z.strictObject({
  schemaVersion: z.literal(FACTORY_WATCHER_SCHEMA_VERSION),
  watchId: Id,
  evaluatedAt: Timestamp,
  policy: factoryWatcherInputSchema.shape.policy,
  availability: factoryWatcherInputSchema.shape.availability,
  evidence: factoryWatcherInputSchema.shape.evidence,
  recommendations: z.array(Recommendation).max(100),
  truncated: z.boolean(),
  unavailableData: z.array(
    z.strictObject({ category: Category, reason: Text }),
  ),
  authority: z.strictObject({
    disposition: z.literal("recommendation_only"),
    factoryMutation: z.literal(false),
    sideEffects: z.literal("persistence_only"),
    providerCalls: z.literal(false),
    networkCalls: z.literal(false),
  }),
});

export type FactoryWatcherOutput = z.infer<typeof factoryWatcherOutputSchema>;

export function watchFactory(raw: unknown): FactoryWatcherOutput {
  const input = factoryWatcherInputSchema.parse(raw);
  const evaluatedAt = Date.parse(input.evaluatedAt);
  const groups = new Map<string, typeof input.observations>();
  for (const observation of input.observations) {
    const threshold = input.policy.thresholds.find((item) =>
      item.category === observation.category
    )!;
    if (
      evaluatedAt - Date.parse(observation.occurredAt) >
        threshold.lookbackHours * 3_600_000
    ) continue;
    const key = `${observation.category}\u0000${observation.signalKey}`;
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }
  const candidates = [...groups.values()].flatMap((observations) => {
    const category = observations[0].category;
    const threshold = input.policy.thresholds.find((item) =>
      item.category === category
    )!;
    if (observations.length < threshold.minimumOccurrences) return [];
    const ordered = [...observations].sort((a, b) =>
      a.occurredAt.localeCompare(b.occurredAt) ||
      a.observationId.localeCompare(b.observationId)
    );
    return [{
      category,
      signalKey: observations[0].signalKey,
      occurrenceCount: observations.length,
      threshold,
      recommendation: threshold.recommendation,
      priority: threshold.priority,
      observationIds: ordered.map((item) => item.observationId),
      evidenceIds: [...new Set(ordered.flatMap((item) => item.evidenceIds))]
        .sort(),
    }];
  }).sort((a, b) =>
    b.priority - a.priority || a.category.localeCompare(b.category) ||
    a.signalKey.localeCompare(b.signalKey)
  );
  const recommendations = candidates.slice(
    0,
    input.policy.maximumRecommendations,
  );

  return factoryWatcherOutputSchema.parse({
    schemaVersion: input.schemaVersion,
    watchId: input.watchId,
    evaluatedAt: input.evaluatedAt,
    policy: input.policy,
    availability: input.availability,
    evidence: input.evidence,
    recommendations,
    truncated: candidates.length > recommendations.length,
    unavailableData: input.availability.filter((item) =>
      item.status === "unavailable"
    )
      .map((item) => ({
        category: item.category,
        reason: item.unavailableReason!,
      }))
      .sort((a, b) => a.category.localeCompare(b.category)),
    authority: {
      disposition: "recommendation_only",
      factoryMutation: false,
      sideEffects: "persistence_only",
      providerCalls: false,
      networkCalls: false,
    },
  });
}
