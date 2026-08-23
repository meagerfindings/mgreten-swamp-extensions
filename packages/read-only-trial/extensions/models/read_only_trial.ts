import { z } from "npm:zod@4";
import {
  evaluateReadOnlyTrial,
  readOnlyTrialEvaluationSchema,
} from "./_lib/read_only_trial_contracts.ts";

const argumentsSchema = z.strictObject({
  evaluationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/),
  input: z.unknown(),
});

type Context = {
  logger: {
    info: (message: string, properties: Record<string, unknown>) => void;
  };
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
      ) => {
        context.logger.info("Evaluating read-only trial {evaluationId}", {
          evaluationId: args.evaluationId,
        });
        const evaluation = evaluateReadOnlyTrial(args.input);
        if (evaluation.trialId !== args.evaluationId) {
          throw new Error(
            "evaluationId must match input.trialId to prevent cross-trial replay",
          );
        }
        const handle = await context.writeResource(
          "evaluation",
          `evaluation-${args.evaluationId}`,
          evaluation,
        );
        context.logger.info("Evaluated read-only trial {evaluationId}", {
          evaluationId: args.evaluationId,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
