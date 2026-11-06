import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { normalizeMac, resolvePowerCycleTarget } from "./client.ts";

const switches = [
  {
    mac: "02:00:00:00:00:01",
    name: "Example PoE Switch",
    type: "usw",
    port_table: [7, 8].map((port_idx) => ({
      port_idx,
      port_poe: true,
      poe_caps: 3,
      poe_mode: "auto",
      is_uplink: false,
      mac_table: [{ mac: "02:00:00:00:00:02" }],
    })),
  },
];

Deno.test("normalizeMac accepts common MAC formatting", () => {
  assertEquals(normalizeMac("02-00.00:00:00:01"), "020000000001");
});

Deno.test("resolves a wired client by exact case-insensitive name", () => {
  const target = resolvePowerCycleTarget("front-door-camera", [{
    mac: "02:00:00:00:00:02",
    name: "Front-Door-Camera",
    is_wired: true,
    sw_mac: "02-00-00-00-00-01",
    sw_port: 7,
  }], switches);

  assertEquals(target.client.name, "Front-Door-Camera");
  assertEquals(target.switchDevice.name, "Example PoE Switch");
  assertEquals(target.port.port_idx, 7);
});

Deno.test("resolves a wired client by hostname or normalized MAC", () => {
  const clients = [{
    mac: "02:00:00:00:00:02",
    hostname: "example-camera",
    is_wired: true,
    sw_mac: "02:00:00:00:00:01",
    sw_port: 8,
  }];

  assertEquals(
    resolvePowerCycleTarget("EXAMPLE-CAMERA", clients, switches).port.port_idx,
    8,
  );
  assertEquals(
    resolvePowerCycleTarget("0200.0000.0002", clients, switches).port.port_idx,
    8,
  );
});

Deno.test("does not treat garbage-wrapped hex text as a MAC selector", () => {
  assertThrows(
    () =>
      resolvePowerCycleTarget("xx020000000002", [{
        mac: "02:00:00:00:00:02",
        is_wired: true,
        sw_mac: "02:00:00:00:00:01",
        sw_port: 8,
      }], switches),
    Error,
    "No active UniFi client matched",
  );
});

Deno.test("resolves a unique name with camel-cased words reordered", () => {
  const target = resolvePowerCycleTarget("FrontDoorDuo", [{
    mac: "02:00:00:00:00:02",
    name: "FrontDuoDoor",
    is_wired: true,
    sw_mac: "02:00:00:00:00:01",
    sw_port: 7,
  }], switches);

  assertEquals(target.client.name, "FrontDuoDoor");
});

Deno.test("enforces expected switch and port assertions", () => {
  const clients = [{
    mac: "02:00:00:00:00:02",
    name: "camera",
    is_wired: true,
    sw_mac: "02:00:00:00:00:01",
    sw_port: 7,
  }];

  assertThrows(
    () =>
      resolvePowerCycleTarget("camera", clients, switches, {
        switch: "Wrong Switch",
      }),
    Error,
    "does not match expected switch",
  );
  assertThrows(
    () => resolvePowerCycleTarget("camera", clients, switches, { port: 8 }),
    Error,
    "does not match expected port",
  );
});

Deno.test("rejects ambiguous names", () => {
  const clients = [1, 2].map((port) => ({
    mac: `02:00:00:00:00:0${port}`,
    name: "camera",
    is_wired: true,
    sw_mac: "02:00:00:00:00:01",
    sw_port: port,
  }));

  assertThrows(
    () => resolvePowerCycleTarget("camera", clients, switches),
    Error,
    "ambiguous",
  );
});

Deno.test("rejects wireless clients and missing wired topology", () => {
  assertThrows(
    () =>
      resolvePowerCycleTarget("camera", [{
        mac: "02:00:00:00:00:02",
        name: "camera",
        is_wired: false,
      }], switches),
    Error,
    "wireless",
  );
  assertThrows(
    () =>
      resolvePowerCycleTarget("camera", [{
        mac: "02:00:00:00:00:02",
        name: "camera",
        is_wired: true,
      }], switches),
    Error,
    "missing live switch/port topology",
  );
});

Deno.test("rejects topology that does not resolve to a UniFi switch", () => {
  assertThrows(
    () =>
      resolvePowerCycleTarget("camera", [{
        mac: "02:00:00:00:00:02",
        name: "camera",
        is_wired: true,
        sw_mac: "00:00:00:00:00:01",
        sw_port: 7,
      }], switches),
    Error,
    "Could not uniquely resolve UniFi switch",
  );
});

Deno.test("rejects unsafe PoE state, uplinks, and conflicting clients", () => {
  const clients = [{
    mac: "02:00:00:00:00:02",
    name: "camera",
    is_wired: true,
    sw_mac: "02:00:00:00:00:01",
    sw_port: 7,
  }];
  const switchWithPort = (port: Record<string, unknown>) => [{
    mac: "02:00:00:00:00:01",
    name: "Example PoE Switch",
    type: "usw",
    port_table: [{ port_idx: 7, ...port }],
  }];

  assertThrows(
    () => resolvePowerCycleTarget("camera", clients, switchWithPort({})),
    Error,
    "no positive PoE capability evidence",
  );
  assertThrows(
    () =>
      resolvePowerCycleTarget(
        "camera",
        clients,
        switchWithPort({ port_poe: true, poe_mode: "off" }),
      ),
    Error,
    "administratively disabled",
  );
  assertThrows(
    () =>
      resolvePowerCycleTarget(
        "camera",
        clients,
        switchWithPort({ port_poe: true, poe_enable: false }),
      ),
    Error,
    "not currently PoE-enabled",
  );
  assertThrows(
    () =>
      resolvePowerCycleTarget(
        "camera",
        clients,
        switchWithPort({ port_poe: true, is_uplink: true }),
      ),
    Error,
    "marks it as an uplink",
  );
  assertThrows(
    () =>
      resolvePowerCycleTarget(
        "camera",
        clients,
        switchWithPort({
          port_poe: true,
          mac_table: [
            { mac: "02:00:00:00:00:02" },
            { mac: "02:00:00:00:00:03" },
          ],
        }),
      ),
    Error,
    "2 learned client MACs",
  );
  assertThrows(
    () =>
      resolvePowerCycleTarget(
        "camera",
        clients,
        switchWithPort({
          port_poe: true,
          mac_table: [{ mac: "02:00:00:00:00:03" }],
        }),
      ),
    Error,
    "learned MAC does not match client",
  );
});
