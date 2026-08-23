import { z } from "npm:zod@4";
import {
  PostReleaseOutcomeReview,
  validatePostReleaseOutcomeReview,
} from "./_lib/post_release_outcome_review_contracts.ts";

/** Released version of this Swamp model. */
export const POST_RELEASE_OUTCOME_REVIEW_MODEL_VERSION =
  "2026.08.23.1" as const;
const argumentsSchema = z.strictObject({
  recordId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
  review: z.unknown(),
});

/**
 * Persists caller-supplied reviews after strict validation. It cannot collect
 * evidence or execute a recommendation.
 */
export const model = {
  type: "@mgreten/post-release-outcome-review",
  version: POST_RELEASE_OUTCOME_REVIEW_MODEL_VERSION,
  globalArguments: z.strictObject({}),
  resources: {
    review: {
      description:
        "Human-controlled deterministic post-release outcome recommendation",
      schema: PostReleaseOutcomeReview,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    record: {
      description:
        "Validate and persist a supplied recommendation without observing systems or executing the recommendation.",
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
      ) => {
        const result = validatePostReleaseOutcomeReview(args.review);
        if (!result.valid) {
          throw new TypeError(
            `Invalid post-release outcome review: ${
              JSON.stringify(result.diagnostics)
            }`,
          );
        }
        const handle = await context.writeResource(
          "review",
          `review-${args.recordId}`,
          result.value,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
