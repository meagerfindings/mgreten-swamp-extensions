/**
 * Tests for cli-process-audit. The model shells out to `hostname` and `ps`
 * through Deno.Command with no injection seam, so each test swaps
 * Deno.Command for a fake that returns synthetic ps output and restores the
 * real constructor in a finally block. No real process is ever spawned.
 */

import { assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1";
import { model, parseCpuTime } from "./cli_process_audit.ts";

type FakeOutput = { success: boolean; stdout?: string; stderr?: string };
type Write = { spec: string; name: string; data: Record<string, unknown> };
type Log = { level: string; msg: string; props?: Record<string, unknown> };
type Snapshot = {
  hostname: string;
  totalFound: number;
  healthyCount: number;
  orphanedCount: number;
  zombieCount: number;
  longRunningCount: number;
  processes: Array<Record<string, unknown>>;
};

const encoder = new TextEncoder();

async function withFakeCommands<T>(
  responses: Record<string, FakeOutput>,
  fn: (calls: string[][]) => Promise<T>,
): Promise<T> {
  const calls: string[][] = [];
  const original = Deno.Command;
  class FakeCommand {
    #argv: string[];
    constructor(cmd: string, opts?: { args?: string[] }) {
      this.#argv = [cmd, ...(opts?.args ?? [])];
      calls.push(this.#argv);
    }
    output() {
      const res = responses[this.#argv[0]];
      if (!res) throw new Error(`unexpected command: ${this.#argv.join(" ")}`);
      return Promise.resolve({
        success: res.success,
        code: res.success ? 0 : 1,
        signal: null,
        stdout: encoder.encode(res.stdout ?? ""),
        stderr: encoder.encode(res.stderr ?? ""),
      });
    }
  }
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = FakeCommand;
  try {
    return await fn(calls);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = original;
  }
}

function makeContext(globalArgs: Record<string, unknown> = {}) {
  const writes: Write[] = [];
  const logs: Log[] = [];
  const log =
    (level: string) => (msg: string, props?: Record<string, unknown>) =>
      logs.push({ level, msg, props });
  const context = {
    globalArgs: model.globalArguments.parse(globalArgs),
    logger: { info: log("info"), warning: log("warning"), error: log("error") },
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  };
  return { context, writes, logs };
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const pad = (n: number) => String(n).padStart(2, "0");

/** Build a ps LSTART string ("Fri Nov 6 10:00:00 2026") for `minutesAgo`. */
function lstart(minutesAgo: number): { text: string; iso: string } {
  const d = new Date(Date.now() - minutesAgo * 60_000);
  d.setMilliseconds(0);
  const text = `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()} ${
    pad(d.getHours())
  }:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getFullYear()}`;
  return { text, iso: d.toISOString() };
}

const HEADER =
  "  PID TTY      STAT      TIME STARTED                      COMMAND";

function psLine(
  pid: number,
  tty: string,
  stat: string,
  time: string,
  minutesAgo: number,
  command: string,
): string {
  return `${pid} ${tty} ${stat} ${time} ${lstart(minutesAgo).text} ${command}`;
}

function run(
  ps: string[],
  globalArgs: Record<string, unknown> = {},
  args: { providers?: string[] } = {},
) {
  return withFakeCommands(
    {
      hostname: { success: true, stdout: "host.example.com\n" },
      ps: { success: true, stdout: [HEADER, ...ps].join("\n") + "\n" },
    },
    async (calls) => {
      const { context, writes, logs } = makeContext(globalArgs);
      const result = await model.methods.scan.execute(args, context);
      assertEquals(writes.length, 1);
      return {
        calls,
        logs,
        result,
        write: writes[0],
        snapshot: writes[0].data as unknown as Snapshot,
      };
    },
  );
}

Deno.test("global args default to 24h threshold and all four providers", () => {
  assertEquals(model.globalArguments.parse({}), {
    longRunningThresholdHours: 24,
    providers: ["claude", "opencode", "amp", "gemini"],
  });
  assertEquals(
    model.globalArguments.safeParse({ providers: ["cursor"] }).success,
    false,
  );
  assertEquals(
    model.methods.scan.arguments.safeParse({ providers: ["amp"] }).success,
    true,
  );
  assertEquals(
    model.methods.scan.arguments.safeParse({ providers: ["vim"] }).success,
    false,
  );
});

Deno.test("scan classifies healthy, orphaned (no tty / background), zombie, long-running", async () => {
  const { snapshot, write, calls, result, logs } = await run([
    psLine(
      101,
      "ttys001",
      "S+",
      "0:05.40",
      120,
      "/usr/local/bin/claude --resume",
    ),
    psLine(102, "??", "S", "1:02:30", 60, "node /opt/bin/opencode serve"),
    psLine(103, "ttys002", "S", "2:00", 30, "amp"),
    psLine(104, "ttys003", "Z+", "0:00", 10, "/usr/bin/gemini"),
    psLine(105, "ttys004", "S+", "10:00", 30 * 60, "claude"),
  ]);

  assertEquals(calls, [["hostname"], [
    "ps",
    "axo",
    "pid,tty,stat,time,lstart,command",
  ]]);
  assertEquals(write.spec, "snapshot");
  assertMatch(write.name, /^snapshot-\d+$/);
  assertEquals(result.dataHandles, [{ name: write.name }]);
  assertEquals(snapshot.hostname, "host.example.com");
  assertEquals(
    [
      snapshot.totalFound,
      snapshot.healthyCount,
      snapshot.orphanedCount,
      snapshot.zombieCount,
      snapshot.longRunningCount,
    ],
    [5, 1, 2, 1, 1],
  );

  const byPid = Object.fromEntries(snapshot.processes.map((p) => [p.pid, p]));
  assertEquals(byPid[101].provider, "claude");
  assertEquals(byPid[101].health, "healthy");
  assertEquals(byPid[101].healthReason, "Foreground on ttys001, stat S+.");
  assertEquals(byPid[101].cpuTimeMinutes, 0.09); // 5.4s rounded to 2dp
  assertEquals(byPid[101].elapsedHours, 2);
  assertEquals(byPid[101].startedAt, lstart(120).iso);

  assertEquals(byPid[102].provider, "opencode");
  assertEquals(byPid[102].health, "orphaned");
  assertEquals(
    byPid[102].healthReason,
    "No controlling terminal — detached from any TTY.",
  );
  assertEquals(byPid[102].cpuTimeMinutes, 62.5); // H:MM:SS

  assertEquals(byPid[103].provider, "amp");
  assertEquals(byPid[103].health, "orphaned");
  assertEquals(
    byPid[103].healthReason,
    "Attached to ttys002 but not in foreground process group (stat: S).",
  );
  assertEquals(byPid[103].cpuTimeMinutes, 2);

  assertEquals(byPid[104].health, "zombie");
  assertEquals(byPid[105].health, "long_running");
  assertEquals(byPid[105].elapsedHours, 30);
  assertEquals(
    byPid[105].healthReason,
    "Running for 30.0h, exceeds 24h threshold.",
  );

  assertEquals(
    model.resources.snapshot.schema.safeParse(snapshot).success,
    true,
  );
  assertEquals(logs.at(-1)?.props, {
    total: 5,
    healthy: 1,
    orphaned: 2,
    zombie: 1,
    longRunning: 1,
  });
});

Deno.test("Linux-style '?' tty is treated as detached", async () => {
  const { snapshot } = await run([
    psLine(201, "?", "Ss", "0:01", 5, "/usr/bin/claude"),
  ]);
  assertEquals(snapshot.processes[0].health, "orphaned");
  assertEquals(snapshot.orphanedCount, 1);
});

Deno.test("long-running threshold applies on both sides of the boundary", async () => {
  const { snapshot } = await run(
    [
      psLine(301, "ttys001", "S+", "0:01", 119, "claude"),
      psLine(302, "ttys002", "S+", "0:01", 121, "claude"),
    ],
    { longRunningThresholdHours: 2 },
  );
  const health = Object.fromEntries(
    snapshot.processes.map((p) => [p.pid, p.health]),
  );
  assertEquals(health, { 301: "healthy", 302: "long_running" });
});

Deno.test("only exact provider binaries match; helpers and short lines are skipped", async () => {
  const { snapshot } = await run([
    psLine(
      401,
      "ttys001",
      "S+",
      "0:01",
      5,
      "/usr/local/bin/claude-code-x --flag",
    ),
    psLine(402, "ttys001", "S+", "0:01", 5, "vim notes/claude.txt"),
    psLine(
      403,
      "ttys001",
      "S+",
      "0:01",
      5,
      "/opt/app/claude --type=gpu Helper",
    ),
    psLine(404, "ttys001", "S+", "0:01", 5, "/opt/app/claude crashpad"),
    psLine(405, "??", "S", "0:01", 5, "/Apps/X.app/Contents/Frameworks/amp"),
    psLine(406, "ttys001", "S+", "0:01", 5, "/usr/bin/bash"),
    "407 ttys001 S+ 0:01 claude",
    psLine(
      408,
      "ttys001",
      "S+",
      "0:01",
      5,
      "/home/user/.local/bin/gemini chat",
    ),
  ]);
  assertEquals(snapshot.processes.map((p) => p.pid), [408]);
  assertEquals(
    snapshot.processes[0].command,
    "/home/user/.local/bin/gemini chat",
  );
});

Deno.test("method providers argument overrides the global provider list", async () => {
  const lines = [
    psLine(501, "ttys001", "S+", "0:01", 5, "claude"),
    psLine(502, "ttys001", "S+", "0:01", 5, "gemini"),
  ];
  const fromArgs = await run(lines, { providers: ["claude"] }, {
    providers: ["gemini"],
  });
  assertEquals(fromArgs.snapshot.processes.map((p) => p.pid), [502]);
  const fromGlobals = await run(lines, { providers: ["claude"] });
  assertEquals(fromGlobals.snapshot.processes.map((p) => p.pid), [501]);
});

Deno.test("commands longer than 200 chars are truncated", async () => {
  const long = "claude " + "x".repeat(300);
  const { snapshot } = await run([
    psLine(601, "ttys001", "S+", "0:01", 5, long),
  ]);
  assertEquals((snapshot.processes[0].command as string).length, 200);
  assertEquals(snapshot.processes[0].command, long.slice(0, 200));
});

Deno.test("hostname failure falls back to 'unknown'", async () => {
  await withFakeCommands(
    {
      hostname: { success: false, stderr: "nope" },
      ps: { success: true, stdout: HEADER },
    },
    async () => {
      const { context, writes } = makeContext();
      await model.methods.scan.execute({}, context);
      const snap = writes[0].data as unknown as Snapshot;
      assertEquals(snap.hostname, "unknown");
      assertEquals(snap.totalFound, 0);
      assertEquals(snap.processes, []);
    },
  );
});

Deno.test("ps failure throws and writes nothing", async () => {
  await withFakeCommands(
    {
      hostname: { success: true, stdout: "host.example.com" },
      ps: { success: false, stderr: "ps: permission denied" },
    },
    async () => {
      const { context, writes } = makeContext();
      await assertRejects(
        () => model.methods.scan.execute({}, context),
        Error,
        "ps command failed: ps: permission denied",
      );
      assertEquals(writes.length, 0);
    },
  );
});

Deno.test("CPU time with a day count (D-HH:MM:SS) parses and the snapshot stays valid", async () => {
  const { snapshot } = await run([
    psLine(201, "ttys001", "S+", "1-02:03:04", 60, "claude"),
    psLine(202, "ttys001", "S+", "12-00:00:00", 60, "amp"),
  ]);
  const byPid = Object.fromEntries(snapshot.processes.map((p) => [p.pid, p]));
  assertEquals(byPid[201].cpuTimeMinutes, 1563.07); // 1440 + 120 + 3 + 4/60
  assertEquals(byPid[202].cpuTimeMinutes, 17280);
  assertEquals(
    model.resources.snapshot.schema.safeParse(snapshot).success,
    true,
  );
  assertEquals([
    parseCpuTime("2:00"),
    parseCpuTime("1:00:30"),
    parseCpuTime("x-1:00"),
    parseCpuTime("?"),
  ], [2, 60.5, 0, 0]);
});
