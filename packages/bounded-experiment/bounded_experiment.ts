import { z } from "npm:zod@4";
import {
  boundedExperimentOutputSchema,
  type BoundedExperimentProposal,
  evaluateBoundedExperiment,
} from "./_lib/bounded_experiment_contracts.ts";

/** Calendar version of this self-contained extension. */
export const BOUNDED_EXPERIMENT_MODEL_VERSION = "2026.08.23.1" as const;
/** This model has no instance-wide configuration. */
export const globalArgumentsSchema = z.strictObject({});
const SafeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
/** Arguments for a single persistence-only recommendation request. */
export const proposeArgumentsSchema = z.strictObject({
  requestId: SafeId,
  input: z.unknown(),
});

/** Validates a proposal against deterministic structural and policy contracts. */
export function validateBoundedExperiment(
  input: unknown,
  now = new Date(),
): BoundedExperimentProposal {
  const result = evaluateBoundedExperiment(input);
  if (!result.success) {
    throw new TypeError(
      `Invalid bounded experiment proposal: ${
        JSON.stringify(result.diagnostics)
      }`,
    );
  }
  if (Date.parse(result.value.evaluatedAt) > now.getTime()) {
    throw new TypeError("Future evaluatedAt is prohibited");
  }
  result.value.evidence.forEach((e, index) => {
    if (now.getTime() >= Date.parse(e.provenance.expiresAt)) {
      throw new TypeError(
        `Stale evidence at evidence.${index}.provenance.expiresAt`,
      );
    }
  });
  return boundedExperimentOutputSchema.parse(result.value);
}

type Context = {
  globalArgs: z.infer<typeof globalArgumentsSchema>;
  now?: () => Date;
  logger: {
    info: (message: string, args?: Record<string, unknown>) => void;
  };
  readResource: (
    name: string,
  ) => Promise<Record<string, unknown> | null>;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
};

/** Swamp model: it writes a recommendation record and has no execution methods. */
export const model = {
  type: "@mgreten/bounded-experiment",
  version: BOUNDED_EXPERIMENT_MODEL_VERSION,
  globalArguments: globalArgumentsSchema,
  resources: {
    proposal: {
      description:
        "Bounded recommendation-only pricing or positioning experiment proposal",
      schema: boundedExperimentOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    propose: {
      description:
        "Validate fresh evidence, bounds, stops, decisions, and approvals; persist only.",
      arguments: proposeArgumentsSchema,
      execute: async (
        args: z.infer<typeof proposeArgumentsSchema>,
        context: Context,
      ) => {
        context.logger.info("Validating bounded experiment {requestId}", {
          requestId: args.requestId,
        });
        const proposal = validateBoundedExperiment(
          args.input,
          context.now?.() ?? new Date(),
        );
        const instanceName = `proposal-${args.requestId}`;
        const existing = await context.readResource(instanceName);
        if (existing) {
          const parsed = boundedExperimentOutputSchema.safeParse(existing);
          if (
            !parsed.success ||
            JSON.stringify(parsed.data) !== JSON.stringify(proposal)
          ) {
            throw new TypeError(
              `Request ${args.requestId} was already used for a different proposal`,
            );
          }
          context.logger.info(
            "Bounded experiment {requestId} already persisted",
            {
              requestId: args.requestId,
            },
          );
          return { dataHandles: [] };
        }
        const handle = await context.writeResource(
          "proposal",
          instanceName,
          proposal,
        );
        context.logger.info("Persisted bounded experiment {requestId}", {
          requestId: args.requestId,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
