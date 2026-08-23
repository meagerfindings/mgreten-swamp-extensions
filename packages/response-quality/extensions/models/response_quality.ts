/**
 * Defines the persistence-only response-quality evaluation model.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  evaluateResponseQuality,
  responseQualityOutputSchema,
} from "./_lib/response_quality_contracts.ts";

const argumentsSchema = z.strictObject({
  recordId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
  input: z.unknown(),
});

/** A deterministic, evidence-bound response-quality evaluator. */
export const model = {
  type: "@mgreten/response-quality",
  version: "2026.08.23.1",
  globalArguments: z.strictObject({}),
  resources: {
    evaluation: {
      description:
        "Deterministic, evidence-bound draft response quality evaluation",
      schema: responseQualityOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    evaluate: {
      description:
        "Evaluate caller-supplied scores and policy, then persist only; performs no sending, contact, closure, network, provider, or production action.",
      arguments: argumentsSchema,
      execute: async (
        args: z.infer<typeof argumentsSchema>,
        context: {
          writeResource(
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ): Promise<unknown>;
        },
      ) => ({
        dataHandles: [
          await context.writeResource(
            "evaluation",
            `response-quality-${args.recordId}`,
            evaluateResponseQuality(args.input),
          ),
        ],
      }),
    },
  },
};
