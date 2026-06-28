// @mgreten/unifi/firewall-group
// Manage UniFi firewall groups (IP/MAC/port address groups used by firewall rules).

import { z } from "npm:zod@4";
import {
  list,
  login,
  networkPath,
  UnifiGlobalArgsSchema,
} from "./_lib/unifi.ts";

const GROUP_TYPES = [
  "address-group", // IPv4 addresses / CIDRs
  "ipv6-address-group", // IPv6
  "port-group", // TCP/UDP port numbers
] as const;

const FirewallGroupSchema = z.object({
  _id: z.string(),
  name: z.string(),
  group_type: z.enum(GROUP_TYPES),
  group_members: z.array(z.string()),
  site_id: z.string().optional(),
});

const FirewallGroupResponseSchema = z.object({
  data: z.array(FirewallGroupSchema).optional(),
});

type FirewallGroup = z.infer<typeof FirewallGroupSchema>;

/**
 * Swamp model for UniFi firewall groups (address/IPv6/port groups) on a UDM.
 *
 * Two methods:
 * - `sync` (factory) — pulls every firewall group from the UDM and stores one
 *   data artifact per group, keyed by `_id`.
 * - `set-members` — full-replacement update of a group's members, addressed by
 *   `id` (preferred) or `name`. Emits warnings if members don't look right for
 *   the group's declared type.
 */
export const model = {
  type: "@mgreten/unifi/firewall-group",
  version: "2026.06.27.2",
  globalArguments: UnifiGlobalArgsSchema,
  resources: {
    group: {
      description: "A UniFi firewall group (address/port group).",
      schema: FirewallGroupSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    sync: {
      description:
        "List all firewall groups on the controller and store one data per group (factory).",
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
          const groups = await list<FirewallGroup>(
            client,
            "/list/firewallgroup",
          );
          context.logger.info("Fetched {count} firewall groups", {
            count: groups.length,
          });
          const handles: unknown[] = [];
          for (const g of groups) {
            const handle = await context.writeResource(
              "group",
              g._id,
              g,
            );
            handles.push(handle);
          }
          return { dataHandles: handles };
        } finally {
          await client.cleanup();
        }
      },
    },

    "set-members": {
      description:
        "Replace the members of a firewall group with the provided list. Identify the group by id or by name.",
      checks: [
        {
          label: "live",
          description:
            "Verify UniFi controller connectivity and authentication",
          execute: async (
            // deno-lint-ignore no-explicit-any
            _args: any,
            context: { globalArgs: z.infer<typeof UnifiGlobalArgsSchema> },
          ) => {
            const client = await login(context.globalArgs);
            try {
              await client.request("/api/self", "GET");
            } finally {
              await client.cleanup();
            }
          },
        },
      ],
      arguments: z.object({
        id: z.string().optional().describe("Group _id (preferred)"),
        name: z.string().optional().describe(
          "Group name (resolved if id is omitted)",
        ),
        members: z.array(z.string()).describe(
          "Full replacement member list (MACs, IPs, CIDRs, or ports)",
        ),
      }),
      execute: async (
        args: { id?: string; name?: string; members: string[] },
        context: {
          globalArgs: z.infer<typeof UnifiGlobalArgsSchema>;
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<unknown>;
          logger: {
            info: (msg: string, props?: unknown) => void;
            warning: (msg: string, props?: unknown) => void;
          };
        },
      ) => {
        if (!args.id && !args.name) {
          throw new Error(
            "Provide either `id` or `name` to identify the group",
          );
        }
        const client = await login(context.globalArgs);
        try {
          const groups = await list<FirewallGroup>(
            client,
            "/list/firewallgroup",
          );
          const target = args.id
            ? groups.find((g) => g._id === args.id)
            : groups.find((g) => g.name === args.name);
          if (!target) {
            throw new Error(
              `Firewall group not found: ${args.id ?? args.name}`,
            );
          }

          context.logger.info(
            "Updating group {name} ({type}): {old} → {new} members",
            {
              name: target.name,
              type: target.group_type,
              old: target.group_members.length,
              new: args.members.length,
            },
          );

          // Sanity: warn if members look wrong for the group type.
          for (const m of args.members) {
            if (
              target.group_type === "address-group" &&
              !/^[\d.]+(\/\d{1,2})?$/.test(m)
            ) {
              context.logger.warning(
                "Member {m} doesn't look like an IPv4 address/CIDR",
                { m },
              );
            }
            if (
              target.group_type === "port-group" &&
              !/^\d{1,5}(-\d{1,5})?$/.test(m)
            ) {
              context.logger.warning(
                "Member {m} doesn't look like a port/range",
                { m },
              );
            }
          }

          const rawUpdated = await client.request<unknown>(
            networkPath(client.site, `/rest/firewallgroup/${target._id}`),
            "PUT",
            {
              name: target.name,
              group_type: target.group_type,
              group_members: args.members,
              site_id: target.site_id,
            },
          );

          const updated = FirewallGroupResponseSchema.parse(rawUpdated);

          const saved = updated.data?.[0] ?? {
            ...target,
            group_members: args.members,
          };

          const handle = await context.writeResource(
            "group",
            target._id,
            saved,
          );
          return { dataHandles: [handle] };
        } finally {
          await client.cleanup();
        }
      },
    },
  },
};
