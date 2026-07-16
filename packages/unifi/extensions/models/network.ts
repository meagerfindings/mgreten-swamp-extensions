// @mgreten/unifi/network
// List configured networks (VLANs/subnets) on the controller.

import { z } from "npm:zod@4";
import { list, login, UnifiGlobalArgsSchema } from "./_lib/unifi.ts";

const NetworkSchema = z.object({
  _id: z.string(),
  name: z.string(),
  purpose: z.string().optional(), // corporate, guest, wan, vlan-only, …
  vlan: z.union([z.number(), z.string()]).optional(),
  ip_subnet: z.string().optional(),
  domain_name: z.string().optional(),
  enabled: z.boolean().optional(),
  is_nat: z.boolean().optional(),
  site_id: z.string().optional(),
});

type Network = z.infer<typeof NetworkSchema>;

/**
 * Swamp model for UniFi configured networks (VLANs / subnets) on a UDM.
 *
 * One method:
 * - `sync` (factory) — pulls every configured network from `/rest/networkconf`
 *   and stores one data artifact per network, keyed by `_id`.
 */
export const model = {
  type: "@mgreten/unifi/network",
  version: "2026.07.16.1",
  globalArguments: UnifiGlobalArgsSchema,
  resources: {
    network: {
      description: "A configured UniFi network (VLAN/subnet).",
      schema: NetworkSchema,
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
  },
  methods: {
    sync: {
      description:
        "List all configured networks and store one data per network (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: z.infer<typeof UnifiGlobalArgsSchema>;
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<unknown>;
          logger: { info: (msg: string, props?: unknown) => void };
        },
      ) => {
        const client = await login(context.globalArgs);
        try {
          const nets = await list<Network>(client, "/rest/networkconf");
          context.logger.info("Fetched {count} networks", {
            count: nets.length,
          });
          const handles: unknown[] = [];
          for (const n of nets) {
            const handle = await context.writeResource("network", n._id, n);
            handles.push(handle);
          }
          return { dataHandles: handles };
        } finally {
          await client.cleanup();
        }
      },
    },
  },
};
