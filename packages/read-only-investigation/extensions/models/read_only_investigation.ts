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
      ) => ({
        dataHandles: [
          await context.writeResource(
            "plan",
            `plan-${args.requestId}`,
            prepareReadOnlyInvestigation(args.input),
          ),
        ],
      }),
    },
  },
};
