// @mgreten/unifi/client
// List connected/known clients on a UniFi controller.

import { z } from "npm:zod@4";
import {
  list,
  login,
  networkPath,
  UnifiGlobalArgsSchema,
} from "./_lib/unifi.ts";

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
});

type Client = z.infer<typeof ClientSchema>;

const ConnectedClientSchema = z.object({
  mac: z.string(),
  hostname: z.string().optional(),
  name: z.string().optional(),
  is_wired: z.boolean().optional(),
  sw_mac: z.string().optional(),
  sw_port: z.coerce.number().int().positive().optional(),
});

const SwitchPortSchema = z.object({
  port_idx: z.coerce.number().int().positive(),
  port_poe: z.boolean().optional(),
  poe_caps: z.coerce.number().optional(),
  poe_mode: z.string().optional(),
  poe_enable: z.boolean().optional(),
  is_uplink: z.boolean().optional(),
  up: z.boolean().optional(),
  mac_table: z.array(z.object({ mac: z.string().optional() })).optional(),
});

const SwitchSchema = z.object({
  mac: z.string(),
  name: z.string().optional(),
  type: z.string(),
  port_table: z.array(SwitchPortSchema).optional(),
});

const PowerCycleResponseSchema = z.object({
  meta: z.object({
    rc: z.string(),
    msg: z.string().optional(),
  }),
  data: z.array(z.unknown()).optional(),
});

const PowerCycleResultSchema = z.object({
  requested_device: z.string(),
  client_name: z.string().optional(),
  client_hostname: z.string().optional(),
  client_mac: z.string(),
  switch_name: z.string().optional(),
  switch_mac: z.string(),
  port: z.number().int().positive(),
  port_poe: z.boolean().optional(),
  poe_caps: z.number().optional(),
  poe_mode: z.string().optional(),
  poe_enable: z.boolean().optional(),
  is_uplink: z.boolean().optional(),
  link_up: z.boolean().optional(),
  learned_mac_count: z.number().int().nonnegative(),
  controller_rc: z.string(),
  command_accepted_at: z.string().datetime(),
});

type ConnectedClient = z.infer<typeof ConnectedClientSchema>;
type Switch = z.infer<typeof SwitchSchema>;
type PowerCycleTarget = {
  client: ConnectedClient;
  switchDevice: Switch;
  port: z.infer<typeof SwitchPortSchema>;
};

/** Normalize a MAC address for format-independent exact comparison. */
export function normalizeMac(value: string): string {
  return value.toLowerCase().replace(/[^0-9a-f]/g, "");
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function isMacSelector(value: string): boolean {
  const trimmed = value.trim();
  return /^[0-9a-f:.-]+$/i.test(trimmed) && normalizeMac(trimmed).length === 12;
}

function nameSignature(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

function learnedMacs(port: z.infer<typeof SwitchPortSchema>): Set<string> {
  return new Set(
    (port.mac_table ?? [])
      .map((entry) => entry.mac ? normalizeMac(entry.mac) : "")
      .filter((mac) => mac.length === 12),
  );
}

/**
 * Resolve and validate one active wired client, its switch, and its PoE port.
 * Throws before mutation when identity, topology, or safety checks fail.
 */
export function resolvePowerCycleTarget(
  device: string,
  clients: ConnectedClient[],
  switches: Switch[],
  expected?: { switch?: string; port?: number },
): PowerCycleTarget {
  const selector = normalizeName(device);
  const selectorMac = normalizeMac(device);
  const looksLikeMac = isMacSelector(device);
  let matches = clients.filter((client) =>
    looksLikeMac
      ? normalizeMac(client.mac) === selectorMac
      : [client.name, client.hostname].some((name) =>
        name !== undefined && normalizeName(name) === selector
      )
  );

  // Human names often contain the same camel-cased words in a different order
  // (for example, "HouseFrontDuo" vs "HouseDuoFront"). Only use this fallback
  // when exact matching found nothing, and still require a unique result.
  if (!looksLikeMac && matches.length === 0) {
    const signature = nameSignature(device);
    matches = clients.filter((client) =>
      [client.name, client.hostname].some((name) =>
        name !== undefined && nameSignature(name) === signature
      )
    );
  }

  if (matches.length === 0) {
    throw new Error(
      `No active UniFi client matched device \`${device}\` by exact name, hostname, or MAC`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Device selector \`${device}\` is ambiguous; matched ${matches.length} active clients`,
    );
  }

  const matchedClient = matches[0];
  if (matchedClient.is_wired === false) {
    throw new Error(
      `Client \`${device}\` is wireless and has no switch PoE port to cycle`,
    );
  }
  if (!matchedClient.sw_mac || matchedClient.sw_port === undefined) {
    throw new Error(
      `Client \`${device}\` is missing live switch/port topology (sw_mac or sw_port)`,
    );
  }

  const switchMac = normalizeMac(matchedClient.sw_mac);
  const matchingSwitches = switches.filter((candidate) =>
    candidate.type === "usw" && normalizeMac(candidate.mac) === switchMac
  );
  if (matchingSwitches.length !== 1) {
    throw new Error(
      `Could not uniquely resolve UniFi switch ${matchedClient.sw_mac} for client \`${device}\``,
    );
  }

  const switchDevice = matchingSwitches[0];
  if (expected?.switch) {
    const expectedSwitch = normalizeName(expected.switch);
    const expectedMac = normalizeMac(expected.switch);
    const switchMatches = isMacSelector(expected.switch)
      ? normalizeMac(switchDevice.mac) === expectedMac
      : switchDevice.name !== undefined &&
        normalizeName(switchDevice.name) === expectedSwitch;
    if (!switchMatches) {
      throw new Error(
        `Resolved switch ${
          switchDevice.name ?? switchDevice.mac
        } does not match expected switch \`${expected.switch}\``,
      );
    }
  }
  if (expected?.port !== undefined && matchedClient.sw_port !== expected.port) {
    throw new Error(
      `Resolved port ${matchedClient.sw_port} does not match expected port ${expected.port}`,
    );
  }

  const port = switchDevice.port_table?.find((candidate) =>
    candidate.port_idx === matchedClient.sw_port
  );
  if (!port) {
    throw new Error(
      `Switch ${
        switchDevice.name ?? switchDevice.mac
      } did not report port ${matchedClient.sw_port} in its live port table`,
    );
  }
  const poeCapable = port.port_poe === true ||
    (port.poe_caps !== undefined && port.poe_caps > 0) ||
    port.poe_mode === "auto" || port.poe_mode === "passthrough";
  if (!poeCapable) {
    throw new Error(
      `Switch port ${matchedClient.sw_port} has no positive PoE capability evidence`,
    );
  }
  if (port.poe_mode === "off") {
    throw new Error(
      `Switch port ${matchedClient.sw_port} has PoE administratively disabled; a power cycle would not restore power`,
    );
  }
  if (port.poe_enable === false) {
    throw new Error(
      `Switch port ${matchedClient.sw_port} is not currently PoE-enabled`,
    );
  }
  if (port.is_uplink === true) {
    throw new Error(
      `Refusing to power-cycle switch port ${matchedClient.sw_port} because UniFi marks it as an uplink`,
    );
  }
  const portMacs = learnedMacs(port);
  if (portMacs.size > 1) {
    throw new Error(
      `Refusing to power-cycle switch port ${matchedClient.sw_port} because it has ${portMacs.size} learned client MACs`,
    );
  }
  if (
    portMacs.size === 1 && !portMacs.has(normalizeMac(matchedClient.mac))
  ) {
    throw new Error(
      `Refusing to power-cycle switch port ${matchedClient.sw_port} because its learned MAC does not match client ${matchedClient.mac}`,
    );
  }

  return {
    client: matchedClient,
    switchDevice,
    port,
  };
}

/**
 * Swamp model for UniFi clients (known devices on the controller).
 *
 * One method:
 * - `sync` (factory) — when `activeOnly=true`, fetches only currently-connected
 *   clients from `/stat/sta`; otherwise fetches the full known-client list from
 *   `/list/user`. Stores one data artifact per client, keyed by MAC address
 *   (falling back to `_id` or a generated UUID when MAC is absent).
 * - `power-cycle-poe` — resolves an active wired client by name, hostname, or
 *   MAC and restarts it by power-cycling its live UniFi switch PoE port.
 */
export const model = {
  type: "@mgreten/unifi/client",
  version: "2026.07.27.1",
  globalArguments: UnifiGlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.27.1",
      description: "Add guarded PoE power cycling; no global argument changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    client: {
      description: "A client (device) known to the UniFi controller.",
      schema: ClientSchema,
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
    power_cycle: {
      description:
        "An accepted UniFi PoE power-cycle action and its resolved client/switch topology.",
      schema: PowerCycleResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
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
    "power-cycle-poe": {
      description:
        "Restart an active wired device by exact name, hostname, or MAC by power-cycling its resolved UniFi switch PoE port.",
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
        device: z.string().trim().min(1).describe(
          "Exact UniFi client name, hostname, or MAC address, e.g. front-door-camera",
        ),
        expectedSwitch: z.string().trim().min(1).optional().describe(
          "Optional safety assertion: expected switch name or MAC",
        ),
        expectedPort: z.coerce.number().int().positive().optional().describe(
          "Optional safety assertion: expected physical switch port",
        ),
      }),
      execute: async (
        args: {
          device: string;
          expectedSwitch?: string;
          expectedPort?: number;
        },
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
          const [rawClients, rawDevices] = await Promise.all([
            list<unknown>(client, "/stat/sta"),
            list<unknown>(client, "/stat/device"),
          ]);
          const clients = z.array(ConnectedClientSchema).parse(rawClients);
          const switches = z.array(SwitchSchema).parse(rawDevices);
          const target = resolvePowerCycleTarget(
            args.device,
            clients,
            switches,
            { switch: args.expectedSwitch, port: args.expectedPort },
          );

          context.logger.info(
            "Power-cycling {device} on switch {switchName} port {port}",
            {
              device: target.client.name ?? target.client.hostname ??
                target.client.mac,
              switchName: target.switchDevice.name ?? target.switchDevice.mac,
              port: target.port.port_idx,
            },
          );

          const rawResponse = await client.request<unknown>(
            networkPath(client.site, "/cmd/devmgr"),
            "POST",
            {
              cmd: "power-cycle",
              mac: target.switchDevice.mac,
              port_idx: target.port.port_idx,
            },
          );
          const response = PowerCycleResponseSchema.parse(rawResponse);
          if (response.meta.rc.toLowerCase() !== "ok") {
            throw new Error(
              `UniFi rejected PoE power cycle: ${
                response.meta.msg ?? response.meta.rc
              }`,
            );
          }

          const commandAcceptedAt = new Date().toISOString();
          const result = {
            requested_device: args.device,
            client_name: target.client.name,
            client_hostname: target.client.hostname,
            client_mac: target.client.mac,
            switch_name: target.switchDevice.name,
            switch_mac: target.switchDevice.mac,
            port: target.port.port_idx,
            port_poe: target.port.port_poe,
            poe_caps: target.port.poe_caps,
            poe_mode: target.port.poe_mode,
            poe_enable: target.port.poe_enable,
            is_uplink: target.port.is_uplink,
            link_up: target.port.up,
            learned_mac_count: learnedMacs(target.port).size,
            controller_rc: response.meta.rc,
            command_accepted_at: commandAcceptedAt,
          };
          const instance = `${normalizeMac(target.client.mac)}-${
            commandAcceptedAt.replace(/[:.]/g, "-")
          }`;
          const handle = await context.writeResource(
            "power_cycle",
            instance,
            result,
          );
          context.logger.info(
            "Accepted PoE power cycle for {device} on port {port}",
            {
              device: target.client.name ?? target.client.hostname ??
                target.client.mac,
              port: target.port.port_idx,
            },
          );
          return { dataHandles: [handle] };
        } finally {
          await client.cleanup();
        }
      },
    },
  },
};
