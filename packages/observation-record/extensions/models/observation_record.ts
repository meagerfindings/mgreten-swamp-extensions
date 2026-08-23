import { z } from "npm:zod@4";
import {
  observationRecordInputSchema,
  observationRecordSchema,
  retainObservationRecord,
} from "./_lib/observation_record_contracts.ts";

/** Published version of the neutral observation-record model. */
export const OBSERVATION_RECORD_MODEL_VERSION = "2026.08.23.1" as const;

/**
 * A persistence-only model for one source-evidence observation.
 *
 * Its sole method emits a strict record with fixed no-authority invariants.
 */
export const model = {
  type: "@mgreten/observation-record",
  version: OBSERVATION_RECORD_MODEL_VERSION,
  globalArguments: z.strictObject({}),
  resources: {
    observation: {
      description:
        "One source-evidence observation retained as an unvalidated, recommendation-only record",
      schema: observationRecordSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    retain: {
      description:
        "Validate and persist one source-evidence observation without claims, decisions, or external effects.",
      arguments: observationRecordInputSchema,
      execute: async (
        args: z.infer<typeof observationRecordInputSchema>,
        context: {
          logger: {
            info(message: string, properties: Record<string, unknown>): void;
          };
          readResource(
            name: string,
          ): Promise<Record<string, unknown> | null>;
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<unknown>;
        },
      ) => {
        context.logger.info("Validating bounded observation", {});
        const observation = await retainObservationRecord(args);
        const existing = await context.readResource(observation.observationId);
        if (existing) {
          const parsed = observationRecordSchema.parse(existing);
          if (
            parsed.contentHash !== observation.contentHash ||
            JSON.stringify(parsed) !== JSON.stringify(observation)
          ) {
            throw new Error(
              `Conflicting or tampered replay for observation ${observation.observationId}`,
            );
          }
          context.logger.info(
            "Observation {observationId} already retained",
            { observationId: observation.observationId },
          );
          return { dataHandles: [] };
        }
        const handle = await context.writeResource(
          "observation",
          observation.observationId,
          observation,
        );
        context.logger.info("Retained observation {observationId}", {
          observationId: observation.observationId,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
