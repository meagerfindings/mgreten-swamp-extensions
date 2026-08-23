/**
 * Builds a bounded, deterministic decision-review queue from supplied
 * dossiers and a supplied bottleneck ranking. It performs no external I/O or
 * side effects.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  generateWeeklyDecisionQueue,
  weeklyDecisionQueueOutputSchema,
} from "./_lib/weekly_decision_queue_contracts.ts";

/** Global arguments accepted by the model. */
export const globalArgumentsSchema = z.strictObject({});
const argumentsSchema = z.strictObject({
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
  input: z.unknown(),
});
type Context = {
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
};

/** Swamp model definition for the weekly decision queue. */
export const model = {
  type: "@mgreten/weekly-decision-queue",
  version: "2026.08.23.1",
  globalArguments: globalArgumentsSchema,
  resources: {
    queue: {
      description: "Bounded recommendation-only weekly decision queue",
      schema: weeklyDecisionQueueOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    generate: {
      description:
        "Select at most three fresh dossiers and recommend the top current bottleneck deterministically.",
      arguments: argumentsSchema,
      execute: async (
        args: z.infer<typeof argumentsSchema>,
        context: Context,
      ) => ({
        dataHandles: [
          await context.writeResource(
            "queue",
            `queue-${args.requestId}`,
            generateWeeklyDecisionQueue(args.input),
          ),
        ],
      }),
    },
  },
};
