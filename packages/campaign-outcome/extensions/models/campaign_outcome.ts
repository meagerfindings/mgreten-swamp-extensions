import { z } from "npm:zod@4";
import {
  campaignOutcomeEvidenceSchema,
  evaluateCampaignOutcomeEvidence,
} from "./_lib/campaign_outcome_contracts.ts";

/** Published model version. */
export const CAMPAIGN_OUTCOME_MODEL_VERSION = "2026.08.23.1" as const;
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
/** Strict arguments accepted by the persistence-only `record` method. */
export const recordArgumentsSchema = z.strictObject({
  recordId: safeId,
  evidence: z.unknown(),
});

/** Swamp model that validates and persists canonical aggregate evidence. */
export const model = {
  type: "@mgreten/campaign-outcome",
  version: CAMPAIGN_OUTCOME_MODEL_VERSION,
  globalArguments: z.strictObject({}),
  resources: {
    evidence: {
      description: "Aggregate campaign outcome evidence for human decisions",
      schema: campaignOutcomeEvidenceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    record: {
      description:
        "Strictly validate, canonically order, and persist supplied campaign evidence without external effects.",
      arguments: recordArgumentsSchema,
      execute: async (args: z.infer<typeof recordArgumentsSchema>, context: {
        writeResource(
          spec: string,
          name: string,
          data: Record<string, unknown>,
        ): Promise<unknown>;
      }) => {
        const evaluated = evaluateCampaignOutcomeEvidence(args.evidence);
        if (!evaluated.success) {
          throw new TypeError(
            `Invalid campaign outcome evidence: ${
              JSON.stringify(evaluated.diagnostics)
            }`,
          );
        }
        const handle = await context.writeResource(
          "evidence",
          `evidence-${args.recordId}`,
          evaluated.value,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
