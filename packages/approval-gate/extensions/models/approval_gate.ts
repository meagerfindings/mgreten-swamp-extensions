import { z } from "npm:zod@4";
import {
  approvalDiagnosticsSchema,
  evaluateApprovalPacket,
} from "./_lib/approval_gate_contracts.ts";

/** Global configuration accepted by the domain-neutral approval gate. */
export const globalArgumentsSchema = z.strictObject({});
/** Arguments for evaluating and persistently recording one approval packet. */
export const evaluateArgumentsSchema = z.strictObject({
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
  packet: z.unknown(),
});

type PersistenceContext = {
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
};

/** Swamp model definition for deterministic, recommendation-only diagnostics. */
export const model = {
  type: "@mgreten/approval-gate",
  version: "2026.08.23.1",
  globalArguments: globalArgumentsSchema,
  resources: {
    diagnostics: {
      description:
        "Deterministic approval diagnostics with permanently disabled operational authority",
      schema: approvalDiagnosticsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    evaluate: {
      description:
        "Validate a supplied approval packet and persist diagnostics only; never cause effects.",
      arguments: evaluateArgumentsSchema,
      execute: async (
        args: z.infer<typeof evaluateArgumentsSchema>,
        context: PersistenceContext,
      ) => ({
        dataHandles: [
          await context.writeResource(
            "diagnostics",
            `diagnostics-${args.requestId}`,
            evaluateApprovalPacket(args.packet),
          ),
        ],
      }),
    },
  },
};
