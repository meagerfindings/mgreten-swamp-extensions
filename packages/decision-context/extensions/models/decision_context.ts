/** Deterministic, authority-free decision-context model. */
import { z } from "npm:zod@4";
import {
  compileDecisionContext,
  decisionContextInputSchema,
  decisionContextPacketSchema,
} from "./decision_context_contracts.ts";

/** Swamp model for compiling one retained decision-context packet. */
export const model = {
  type: "@mgreten/decision-context",
  version: "2026.08.23.1",
  globalArguments: z.strictObject({}),
  resources: {
    packet: {
      description: "Bounded authority-free decision context",
      schema: decisionContextPacketSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    compile: {
      description:
        "Compile and persist a bounded retained decision context without effects.",
      arguments: decisionContextInputSchema,
      execute: async (
        args: z.infer<typeof decisionContextInputSchema>,
        context: {
          readResource: (
            name: string,
          ) => Promise<Record<string, unknown> | null>;
          writeResource: (
            specName: string,
            name: string,
            attributes: unknown,
          ) => Promise<unknown>;
        },
      ) => {
        const packet = compileDecisionContext(args);
        const existing = await context.readResource(packet.packetId);
        if (existing) {
          const parsed = decisionContextPacketSchema.parse(existing);
          if (JSON.stringify(parsed) !== JSON.stringify(packet)) {
            throw new Error(`Conflicting replay for packet ${packet.packetId}`);
          }
          return { dataHandles: [] };
        }
        const handle = await context.writeResource(
          "packet",
          packet.packetId,
          packet,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
