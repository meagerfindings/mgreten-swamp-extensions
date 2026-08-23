import { z } from "npm:zod@4";
import {
  operationalTriageSnapshotSchema,
  validateOperationalTriageSnapshot,
} from "./_lib/operational_triage_contracts.ts";

/** Version of the operational-triage model contract. */
export const OPERATIONAL_TRIAGE_MODEL_VERSION = "2026.08.23.1" as const;

/** Empty global-argument contract for this provider-neutral model. */
export const globalArgumentsSchema = z.strictObject({});

// Swamp merges configured global arguments into the method argument envelope.
// The durable public snapshot remains strict after this boundary strips extras.
/** Method envelope accepting one producer-normalized snapshot. */
export const normalizeSnapshotArgumentsSchema = z.object({
  snapshot: z.unknown(),
});

type WriteContext = {
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
};

/** Parses a provider-produced snapshot without fetching or transforming source data. */
export function validatedSnapshot(input: unknown) {
  const result = validateOperationalTriageSnapshot(input);
  if (!result.success) {
    throw new TypeError(
      `Invalid operational triage snapshot: ${
        JSON.stringify(result.diagnostics)
      }`,
    );
  }
  return result.data;
}

/** A deterministic, provider-neutral, zero-authority snapshot normalizer. */
export const model = {
  type: "@mgreten/operational-triage",
  version: OPERATIONAL_TRIAGE_MODEL_VERSION,
  globalArguments: globalArgumentsSchema,
  resources: {
    snapshot: {
      description:
        "Bounded snapshot validated against producer attestations and a pattern denylist",
      schema: operationalTriageSnapshotSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    normalizeSnapshot: {
      description:
        "Validate producer attestations and a bounded denylist before persisting a provider-neutral snapshot.",
      arguments: normalizeSnapshotArgumentsSchema,
      execute: async (
        args: z.infer<typeof normalizeSnapshotArgumentsSchema>,
        context: WriteContext,
      ) => {
        const snapshot = validatedSnapshot(args.snapshot);
        const handle = await context.writeResource(
          "snapshot",
          `snapshot-${snapshot.snapshotId}`,
          snapshot,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
