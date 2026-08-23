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
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<unknown>;
        },
      ) => {
        const observation = retainObservationRecord(args);
        const handle = await context.writeResource(
          "observation",
          observation.observationId,
          observation,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
