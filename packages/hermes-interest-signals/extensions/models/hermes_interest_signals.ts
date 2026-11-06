/**
 * Aggregates compact, user-authorized Hermes observations into transparent
 * interest signals for downstream curation or recommendation tools.
 *
 * This model does not read Hermes sessions, access external systems, or infer a
 * profile from raw conversation text. A caller-controlled Hermes collector (or
 * any other source) submits minimized observations; the model only applies
 * deterministic aggregation and writes a typed result.
 *
 * @module
 */
import { z } from "npm:zod@4";

const ObservationSchema = z.object({
  topic: z.string().min(1).max(120),
  kind: z.enum(["interest", "desire", "active-project", "declined"]),
  confidence: z.number().int().min(1).max(5).default(1),
  recencyDays: z.number().int().min(0).max(365).default(0),
  rationale: z.string().min(1).max(300),
});

const GlobalArgsSchema = z.object({
  minimumActiveScore: z.number().int().min(1).max(50).default(3),
  maxInterests: z.number().int().min(1).max(50).default(20),
});

const InterestSignalSchema = z.object({
  topic: z.string(),
  score: z.number().int(),
  status: z.enum(["active", "watch", "deprioritized"]),
  observationCount: z.number().int().positive(),
  rationales: z.array(z.string()),
});

const DownstreamSignalSchema = z.object({
  term: z.string(),
  direction: z.enum(["promote", "deprioritize"]),
  weight: z.number().int().min(1).max(5),
  rationale: z.string(),
});

const InterestProfileSchema = z.object({
  generatedAt: z.string().datetime(),
  observationCount: z.number().int().positive(),
  activeInterests: z.array(InterestSignalSchema),
  watchInterests: z.array(InterestSignalSchema),
  deprioritizedInterests: z.array(InterestSignalSchema),
  downstreamSignals: z.array(DownstreamSignalSchema),
  markdown: z.string(),
});

const AggregateArgumentsSchema = z.object({
  observations: z.array(ObservationSchema).min(1).max(500),
});

type Observation = z.infer<typeof ObservationSchema>;
type Settings = z.infer<typeof GlobalArgsSchema>;
type InterestSignal = z.infer<typeof InterestSignalSchema>;
type InterestProfile = z.infer<typeof InterestProfileSchema>;
type Handles = { dataHandles: Array<{ name: string }> };

interface MethodContext {
  globalArgs: Settings;
  logger: {
    info: (message: string, properties?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** Normalize topic labels so equivalent whitespace and casing aggregate together. */
export function normalizeTopic(topic: string): string {
  return topic.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

/** Weight recent signals more heavily while retaining a bounded historic signal. */
export function recencyMultiplier(recencyDays: number): number {
  if (recencyDays <= 30) return 3;
  if (recencyDays <= 90) return 2;
  return 1;
}

function kindMultiplier(kind: Observation["kind"]): number {
  if (kind === "active-project") return 2;
  if (kind === "desire") return 2;
  return 1;
}

/** Aggregate caller-supplied observations into transparent interest classifications. */
export function aggregateObservations(
  observations: Observation[],
  settings: Settings,
): Omit<InterestProfile, "generatedAt" | "markdown"> {
  const aggregated = new Map<string, {
    display: string;
    score: number;
    rationales: string[];
    count: number;
  }>();

  for (const observation of observations) {
    const key = normalizeTopic(observation.topic);
    const current = aggregated.get(key) ?? {
      display: observation.topic.trim(),
      score: 0,
      rationales: [],
      count: 0,
    };
    const direction = observation.kind === "declined" ? -1 : 1;
    current.score += direction * observation.confidence *
      kindMultiplier(observation.kind) *
      recencyMultiplier(observation.recencyDays);
    current.count += 1;
    if (!current.rationales.includes(observation.rationale)) {
      current.rationales.push(observation.rationale);
    }
    aggregated.set(key, current);
  }

  const signals: InterestSignal[] = [...aggregated.values()]
    .map((value) => ({
      topic: value.display,
      score: value.score,
      status: value.score >= settings.minimumActiveScore
        ? "active" as const
        : value.score < 0
        ? "deprioritized" as const
        : "watch" as const,
      observationCount: value.count,
      rationales: value.rationales.slice(0, 3),
    }))
    .sort((left, right) =>
      Math.abs(right.score) - Math.abs(left.score) ||
      left.topic.localeCompare(right.topic)
    );

  const activeInterests = signals.filter((signal) => signal.status === "active")
    .slice(0, settings.maxInterests);
  const watchInterests = signals.filter((signal) => signal.status === "watch")
    .slice(0, settings.maxInterests);
  const deprioritizedInterests = signals.filter((signal) =>
    signal.status === "deprioritized"
  ).slice(0, settings.maxInterests);
  const downstreamSignals = [...activeInterests, ...deprioritizedInterests].map(
    (signal) => ({
      term: signal.topic,
      direction: signal.status === "deprioritized"
        ? "deprioritize" as const
        : "promote" as const,
      weight: Math.min(5, Math.max(1, Math.ceil(Math.abs(signal.score) / 5))),
      rationale: signal.rationales.join("; "),
    }),
  );

  return {
    observationCount: observations.length,
    activeInterests,
    watchInterests,
    deprioritizedInterests,
    downstreamSignals,
  };
}

/** Render a compact, reviewable profile summary for a human or downstream brief. */
export function renderProfile(
  profile: Omit<InterestProfile, "generatedAt" | "markdown">,
): string {
  const section = (title: string, values: InterestSignal[]) =>
    [
      `## ${title}`,
      values.length
        ? values.map((value) =>
          `- **${value.topic}** (${value.score}): ${
            value.rationales.join("; ")
          }`
        ).join("\n")
        : "- None",
    ].join("\n");
  return [
    "# Interest Signals",
    "",
    "This is a deterministic summary of caller-supplied, minimized observations. It is not an autonomous profile and must be reviewed before affecting recommendations.",
    "",
    section("Active", profile.activeInterests),
    "",
    section("Watch", profile.watchInterests),
    "",
    section("Deprioritized", profile.deprioritizedInterests),
  ].join("\n");
}

/** Model definition for user-controlled, portable interest-signal aggregation. */
export const model = {
  type: "@mgreten/hermes-interest-signals",
  version: "2026.07.19.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    profile: {
      description:
        "Typed, reviewable interest-signal profile from caller-supplied observations",
      schema: InterestProfileSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    aggregate: {
      description:
        "Aggregate user-authorized observations into active, watch, and deprioritized interest signals",
      arguments: AggregateArgumentsSchema,
      execute: async (
        args: z.infer<typeof AggregateArgumentsSchema>,
        context: MethodContext,
      ): Promise<Handles> => {
        const settings = GlobalArgsSchema.parse(context.globalArgs);
        context.logger.info("Aggregating {count} interest observations", {
          count: args.observations.length,
        });
        const core = aggregateObservations(args.observations, settings);
        const profile = {
          ...core,
          generatedAt: new Date().toISOString(),
          markdown: renderProfile(core),
        };
        const handle = await context.writeResource(
          "profile",
          "current",
          profile,
        );
        context.logger.info(
          "Interest aggregation complete: {active} active, {watch} watch, {deprioritized} deprioritized",
          {
            active: profile.activeInterests.length,
            watch: profile.watchInterests.length,
            deprioritized: profile.deprioritizedInterests.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
