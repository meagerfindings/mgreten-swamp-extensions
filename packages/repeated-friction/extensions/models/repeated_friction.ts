import { z } from "npm:zod@4";
import {
  detectRepeatedFriction,
  repeatedFrictionOutputSchema,
} from "./_lib/repeated_friction_contracts.ts";

/** Validates the model's empty global configuration. */
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

/** Defines the bounded, deterministic repeated-friction evaluator. */
export const model = {
  type: "@mgreten/repeated-friction",
  version: "2026.08.23.1",
  globalArguments: globalArgumentsSchema,
  resources: {
    evaluation: {
      description:
        "Deterministic recommendation-only repeated-friction evidence queue evaluation",
      schema: repeatedFrictionOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    evaluate: {
      description:
        "Evaluate preserved signals using only caller-supplied categories, thresholds, lookback, confidence, source-identity, and freshness policy.",
      arguments: argumentsSchema,
      execute: async (
        args: z.infer<typeof argumentsSchema>,
        context: Context,
      ) => ({
        dataHandles: [
          await context.writeResource(
            "evaluation",
            `evaluation-${args.requestId}`,
            detectRepeatedFriction(args.input),
          ),
        ],
      }),
    },
  },
};
