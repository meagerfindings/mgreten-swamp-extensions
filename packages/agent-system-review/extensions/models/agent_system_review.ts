import { z } from "npm:zod@4";
import {
  agentSystemReviewOutputSchema,
  reviewAgentSystem,
} from "./_lib/agent_system_review_contracts.ts";

/** Validates the model's intentionally empty global configuration. */
export const globalArgumentsSchema = z.strictObject({});
const argumentsSchema = z.strictObject({
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
  input: z.unknown(),
});
type Context = {
  logger: {
    info: (message: string, properties?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
};

/**
 * Swamp model definition for deterministic, recommendation-only agent-system
 * reviews. The model persists the validated review result but cannot apply any
 * proposed change itself.
 */
export const model = {
  type: "@mgreten/agent-system-review",
  version: "2026.08.23.1",
  globalArguments: globalArgumentsSchema,
  resources: {
    review: {
      description:
        "Deterministic approval-gated agent system improvement proposals",
      schema: agentSystemReviewOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    review: {
      description:
        "Evaluate bounded supplied evidence and persist proposals without applying changes",
      arguments: argumentsSchema,
      execute: async (
        args: z.infer<typeof argumentsSchema>,
        context: Context,
      ) => {
        context.logger.info("Reviewing supplied agent-system evidence", {
          requestId: args.requestId,
        });
        const review = reviewAgentSystem(args.input);
        const dataHandle = await context.writeResource(
          "review",
          `review-${args.requestId}`,
          review,
        );
        context.logger.info("Persisted agent-system review", {
          requestId: args.requestId,
          reviewId: review.reviewId,
          proposalCount: review.proposals.length,
        });
        return { dataHandles: [dataHandle] };
      },
    },
  },
};
