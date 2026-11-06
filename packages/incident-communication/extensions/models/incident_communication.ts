import { z } from "npm:zod@4";
import {
  incidentCommunicationPacketSchema,
  validateIncidentCommunicationPacket,
} from "./_lib/incident_communication_contracts.ts";

/** Published version of the persistence-only incident communication model. */
export const INCIDENT_COMMUNICATION_MODEL_VERSION = "2026.08.23.1" as const;
const argumentsSchema = z.strictObject({
  packetId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  packet: z.unknown(),
});

/**
 * Records only validated, explicitly unapproved incident communication drafts.
 * Approval and delivery are intentionally outside this model's authority.
 */
export const model = {
  type: "@mgreten/incident-communication",
  version: INCIDENT_COMMUNICATION_MODEL_VERSION,
  globalArguments: z.strictObject({}),
  resources: {
    packet: {
      description: "Unapproved human-controlled incident communication draft",
      schema: incidentCommunicationPacketSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    record: {
      description:
        "Validate and persist a supplied unapproved draft; performs no collection, sending, publishing, remediation, or production access.",
      arguments: argumentsSchema,
      execute: async (
        args: z.infer<typeof argumentsSchema>,
        context: {
          logger: {
            info(message: string, properties: Record<string, unknown>): void;
          };
          readResource(name: string): Promise<Record<string, unknown> | null>;
          writeResource(
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ): Promise<unknown>;
        },
      ) => {
        context.logger.info(
          "Validating incident communication draft {packetId}",
          {
            packetId: args.packetId,
          },
        );
        const result = validateIncidentCommunicationPacket(args.packet);
        if (!result.valid) {
          throw new TypeError(
            `Invalid incident communication packet: ${
              JSON.stringify(result.diagnostics)
            }`,
          );
        }
        if (result.value.packetId !== args.packetId) {
          throw new TypeError("packetId must exactly match packet.packetId");
        }
        const existing = await context.readResource(args.packetId);
        if (existing) {
          const parsed = incidentCommunicationPacketSchema.parse(existing);
          if (JSON.stringify(parsed) !== JSON.stringify(result.value)) {
            throw new Error(`Conflicting replay for packet ${args.packetId}`);
          }
          context.logger.info(
            "Incident communication draft {packetId} already recorded",
            { packetId: args.packetId },
          );
          return { dataHandles: [] };
        }
        const handle = await context.writeResource(
          "packet",
          args.packetId,
          result.value,
        );
        context.logger.info(
          "Recorded incident communication draft {packetId}",
          {
            packetId: args.packetId,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
