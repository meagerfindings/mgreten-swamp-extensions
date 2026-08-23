/**
 * Swamp model entrypoint for deterministic, recommendation-only bottleneck ranking.
 * All scores and policies are caller supplied; this model performs no external I/O.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  bottleneckRankingOutputSchema,
  rankBottlenecks,
} from "./_lib/bottleneck_ranking_contracts.ts";

const globalArgumentsSchema = z.strictObject({});
const argumentsSchema = z.strictObject({
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
  input: z.unknown(),
});

type Arguments = z.infer<typeof argumentsSchema>;
type Context = {
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
};

/** The Swamp model definition for ranking bottleneck candidates. */
export const model = {
  type: "@mgreten/bottleneck-ranking",
  version: "2026.08.23.1",
  globalArguments: globalArgumentsSchema,
  resources: {
    ranking: {
      description:
        "Deterministic recommendation-only bottleneck ranking with explicit policy and provenance.",
      schema: bottleneckRankingOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    rank: {
      description:
        "Rank bottlenecks using only caller-supplied scales, normalization, weights, and missing-data policy.",
      arguments: argumentsSchema,
      execute: async (
        args: Arguments,
        context: Context,
      ): Promise<{ dataHandles: unknown[] }> => {
        const ranking = rankBottlenecks(args.input);
        const handle = await context.writeResource(
          "ranking",
          `ranking-${args.requestId}`,
          ranking,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
