/** A deterministic, non-executing read-only investigation-plan model. */
import { z } from "npm:zod@4";
import {
  prepareReadOnlyInvestigation,
  readOnlyInvestigationPlanSchema,
} from "./_lib/read_only_investigation_contracts.ts";

/** This model has no global configuration or credentials. */
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
  logger: {
    info: (message: string, properties?: Record<string, unknown>) => void;
  };
};

/**
 * Produces a validated authorization plan only; it contains no execution,
 * networking, provider, or production-mutation collaborator.
 */
export const model = {
  type: "@mgreten/read-only-investigation",
  version: "2026.08.23.1",
  globalArguments: globalArgumentsSchema,
  resources: {
    plan: {
      description:
        "Bounded deterministic read-only investigation authorization plan",
      schema: readOnlyInvestigationPlanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    prepare: {
      description:
        "Validate supplied authorization and source snapshots, then persist a zero-execution investigation plan.",
      arguments: argumentsSchema,
      execute: async (
        args: z.infer<typeof argumentsSchema>,
        context: Context,
      ) => {
        context.logger.info(
          "Preparing read-only investigation plan {requestId}",
          {
            requestId: args.requestId,
          },
        );
        const plan = await prepareReadOnlyInvestigation(args.input);
        const dataHandle = await context.writeResource(
          "plan",
          `plan-${args.requestId}-${plan.requestDigest.slice(0, 16)}`,
          plan,
        );
        context.logger.info(
          "Prepared read-only investigation plan {requestId}",
          {
            requestId: args.requestId,
          },
        );
        return { dataHandles: [dataHandle] };
      },
    },
  },
};
