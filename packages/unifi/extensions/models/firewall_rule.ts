// @mgreten/unifi/firewall-rule
// Manage UniFi legacy firewall rules. Sync produces one data per rule (factory).

import { z } from "npm:zod@4";
import {
  list,
  login,
  networkPath,
  UnifiGlobalArgsSchema,
} from "./_lib/unifi.ts";

const FirewallRuleSchema = z.object({
  _id: z.string(),
  name: z.string(),
  enabled: z.boolean().optional(),
  action: z.string(), // accept, drop, reject
  ruleset: z.string(), // WAN_IN, WAN_OUT, LAN_IN, LAN_OUT, GUEST_IN, …
  rule_index: z.union([z.number(), z.string()]).optional(),
  protocol: z.string().optional(),
  src_firewallgroup_ids: z.array(z.string()).optional(),
  dst_firewallgroup_ids: z.array(z.string()).optional(),
  src_address: z.string().optional(),
  dst_address: z.string().optional(),
  src_port: z.string().optional(),
  dst_port: z.string().optional(),
  src_networkconf_id: z.string().optional(),
  dst_networkconf_id: z.string().optional(),
  logging: z.boolean().optional(),
  state_new: z.boolean().optional(),
  state_established: z.boolean().optional(),
  state_invalid: z.boolean().optional(),
  state_related: z.boolean().optional(),
  site_id: z.string().optional(),
});

const FirewallRuleResponseSchema = z.object({
  data: z.array(FirewallRuleSchema).optional(),
});

type FirewallRule = z.infer<typeof FirewallRuleSchema>;

/**
 * Swamp model for UniFi legacy firewall rules (LAN/WAN/GUEST chains) on a UDM.
 *
 * Methods:
 * - `sync` (factory) — pulls every firewall rule from the UDM (optionally
 *   filtered by `ruleset`) and stores one data artifact per rule, keyed by `_id`.
 * - `create` — POSTs a new rule. `rule_index` is auto-assigned to the next free
 *   index in the target ruleset when omitted.
 * - `delete` — DELETEs a rule by id. Local data for the rule is not cleaned
 *   automatically; use `swamp data delete` to purge stale versions.
 * - `toggle-enabled` — PUTs the existing rule with the `enabled` flag flipped.
 */
export const model = {
  type: "@mgreten/unifi/firewall-rule",
  version: "2026.07.27.1",
  globalArguments: UnifiGlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.27.1",
      description: "Package version alignment; no global argument changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    rule: {
      description: "A UniFi legacy firewall rule.",
      schema: FirewallRuleSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    sync: {
      description:
        "List all firewall rules on the controller and store one data per rule (factory).",
      arguments: z.object({
        ruleset: z.string().optional().describe(
          "Filter by ruleset, e.g. LAN_IN, LAN_OUT, WAN_OUT, WAN_LOCAL",
        ),
      }),
      execute: async (
        args: { ruleset?: string },
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
          const rules = await list<FirewallRule>(client, "/list/firewallrule");
          const filtered = args.ruleset
            ? rules.filter((r) => r.ruleset === args.ruleset)
            : rules;
          context.logger.info(
            "Fetched {count} firewall rules ({filtered} after filter)",
            { count: rules.length, filtered: filtered.length },
          );
          const handles: unknown[] = [];
          for (const r of filtered) {
            const handle = await context.writeResource("rule", r._id, r);
            handles.push(handle);
          }
          return { dataHandles: handles };
        } finally {
          await client.cleanup();
        }
      },
    },

    create: {
      description:
        "Create a new firewall rule. rule_index is auto-assigned (next free index in the ruleset) when omitted.",
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
        name: z.string(),
        ruleset: z.enum([
          "WAN_IN",
          "WAN_OUT",
          "WAN_LOCAL",
          "LAN_IN",
          "LAN_OUT",
          "LAN_LOCAL",
          "GUEST_IN",
          "GUEST_OUT",
          "GUEST_LOCAL",
        ]),
        action: z.enum(["accept", "drop", "reject"]),
        protocol: z.string().default("all"),
        enabled: z.boolean().default(true),
        logging: z.boolean().default(false),
        rule_index: z.number().optional(),
        src_firewallgroup_ids: z.array(z.string()).default([]),
        dst_firewallgroup_ids: z.array(z.string()).default([]),
        src_address: z.string().default(""),
        dst_address: z.string().default(""),
        src_networkconf_id: z.string().default(""),
        dst_networkconf_id: z.string().default(""),
        src_port: z.string().default(""),
        dst_port: z.string().default(""),
        state_new: z.boolean().default(false),
        state_established: z.boolean().default(false),
        state_invalid: z.boolean().default(false),
        state_related: z.boolean().default(false),
      }),
      execute: async (
        // deno-lint-ignore no-explicit-any
        args: any,
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
          let ruleIndex = args.rule_index;
          if (ruleIndex === undefined) {
            const existing = await list<FirewallRule>(
              client,
              "/list/firewallrule",
            );
            const indexes = existing
              .filter((r) => r.ruleset === args.ruleset)
              .map((r) => Number(r.rule_index))
              .filter((n) => Number.isFinite(n));
            const max = indexes.length > 0 ? Math.max(...indexes) : 19999;
            ruleIndex = max + 1;
          }
          const body = { ...args, rule_index: ruleIndex };
          context.logger.info(
            "Creating rule {name} ({ruleset} idx={idx} action={action})",
            {
              name: args.name,
              ruleset: args.ruleset,
              idx: ruleIndex,
              action: args.action,
            },
          );
          const rawResp = await client.request<unknown>(
            networkPath(client.site, "/rest/firewallrule"),
            "POST",
            body,
          );
          const resp = FirewallRuleResponseSchema.parse(rawResp);
          const created = resp.data?.[0];
          if (!created) {
            throw new Error("UniFi returned no rule data on create");
          }
          const handle = await context.writeResource(
            "rule",
            created._id,
            created,
          );
          return { dataHandles: [handle] };
        } finally {
          await client.cleanup();
        }
      },
    },

    delete: {
      description:
        "Delete a firewall rule by id on the UDM. Local data for the rule is not removed " +
        "automatically — use `swamp data delete udm-rules <id>` to purge stale local versions.",
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
        id: z.string(),
      }),
      execute: async (
        args: { id: string },
        context: {
          globalArgs: z.infer<typeof UnifiGlobalArgsSchema>;
          logger: { info: (msg: string, props?: unknown) => void };
        },
      ) => {
        const client = await login(context.globalArgs);
        try {
          context.logger.info("Deleting rule {id}", { id: args.id });
          await client.request(
            networkPath(client.site, `/rest/firewallrule/${args.id}`),
            "DELETE",
          );
          return { dataHandles: [] };
        } finally {
          await client.cleanup();
        }
      },
    },

    "toggle-enabled": {
      description: "Enable or disable a rule by id.",
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
        id: z.string(),
        enabled: z.boolean(),
      }),
      execute: async (
        args: { id: string; enabled: boolean },
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
          const rules = await list<FirewallRule>(client, "/list/firewallrule");
          const target = rules.find((r) => r._id === args.id);
          if (!target) {
            throw new Error(`Firewall rule not found: ${args.id}`);
          }
          context.logger.info(
            "Setting rule {name} enabled={enabled}",
            { name: target.name, enabled: args.enabled },
          );
          const rawResp = await client.request<unknown>(
            networkPath(client.site, `/rest/firewallrule/${target._id}`),
            "PUT",
            { ...target, enabled: args.enabled },
          );
          const resp = FirewallRuleResponseSchema.parse(rawResp);
          const saved = resp.data?.[0] ?? { ...target, enabled: args.enabled };
          const handle = await context.writeResource(
            "rule",
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
