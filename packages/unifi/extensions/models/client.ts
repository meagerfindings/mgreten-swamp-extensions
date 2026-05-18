// @mgreten/unifi/client
// List connected/known clients on a UniFi controller.

import { z } from "npm:zod@4";
import { list, login, UnifiGlobalArgsSchema } from "./_lib/unifi.ts";

const ClientSchema = z.object({
  _id: z.string().optional(),
  mac: z.string(),
  ip: z.string().optional(),
  hostname: z.string().optional(),
  name: z.string().optional(),
  oui: z.string().optional(),
  network: z.string().optional(),
  network_id: z.string().optional(),
  is_wired: z.boolean().optional(),
  last_seen: z.number().optional(),
  first_seen: z.number().optional(),
}).passthrough();

type Client = z.infer<typeof ClientSchema>;

/**
 * Swamp model for UniFi clients (known devices on the controller).
 *
 * One method:
 * - `sync` (factory) — when `activeOnly=true`, fetches only currently-connected
 *   clients from `/stat/sta`; otherwise fetches the full known-client list from
 *   `/list/user`. Stores one data artifact per client, keyed by MAC address
 *   (falling back to `_id` or a generated UUID when MAC is absent).
 */
export const model = {
  type: "@mgreten/unifi/client",
  version: "2026.05.18.1",
  globalArguments: UnifiGlobalArgsSchema,
  resources: {
    client: {
      description: "A client (device) known to the UniFi controller.",
      schema: ClientSchema,
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
  },
  methods: {
    sync: {
      description:
        "List all known clients (active + configured) and store one data per client.",
      arguments: z.object({
        activeOnly: z.boolean().default(false).describe(
          "If true, only fetch currently-connected clients (/stat/sta). " +
            "Otherwise fetches the full known-client list (/list/user).",
        ),
      }),
      execute: async (
        args: { activeOnly: boolean },
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
          const endpoint = args.activeOnly ? "/stat/sta" : "/list/user";
          const clients = await list<Client>(client, endpoint);
          context.logger.info(
            "Fetched {count} clients from {endpoint}",
            { count: clients.length, endpoint },
          );
          const handles: unknown[] = [];
          for (const c of clients) {
            // MAC is the stable id; fall back to _id if MAC missing.
            const id = c.mac || c._id || crypto.randomUUID();
            const handle = await context.writeResource("client", id, c);
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
