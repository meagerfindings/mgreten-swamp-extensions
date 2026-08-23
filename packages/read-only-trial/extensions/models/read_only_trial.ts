import { z } from "npm:zod@4";
import {
  evaluateReadOnlyTrial,
  readOnlyTrialEvaluationSchema,
} from "./_lib/read_only_trial_contracts.ts";

const argumentsSchema = z.strictObject({
  evaluationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
  input: z.unknown(),
});

type Context = {
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
};

/** Standalone read-only trial evaluator with no operational integrations or bindings. */
export const model = {
  type: "@mgreten/read-only-trial",
  version: "2026.08.23.1",
  globalArguments: z.strictObject({}),
  resources: {
    evaluation: {
      description:
        "Deterministic evaluation of caller-supplied read-only trial evidence",
      schema: readOnlyTrialEvaluationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
  },
  methods: {
    evaluate: {
      description:
        "Evaluate supplied evidence without retrieval, providers, network calls, or operational side effects",
      arguments: argumentsSchema,
      execute: async (
        args: z.infer<typeof argumentsSchema>,
        context: Context,
      ) => ({
        dataHandles: [
          await context.writeResource(
            "evaluation",
            `evaluation-${args.evaluationId}`,
            evaluateReadOnlyTrial(args.input),
          ),
        ],
      }),
    },
  },
};
