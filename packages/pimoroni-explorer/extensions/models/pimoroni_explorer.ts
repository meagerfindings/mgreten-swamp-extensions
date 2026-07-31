/**
 * Swamp model for inspecting and controlling a USB-connected Pimoroni Explorer.
 * It uses MicroPython's mpremote tool for board probes, ephemeral scripts,
 * guarded app installation, and rendering Swamp Club scores.
 *
 * @module
 */

import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  device: z.string().min(1).default("auto").describe(
    "mpremote device selector, such as auto, id:<serial>, or /dev/cu.usbmodem…",
  ),
  mpremoteCommand: z.string().min(1).default("mpremote").describe(
    "mpremote executable name or absolute path.",
  ),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
});

const DeviceSchema = z.object({
  device: z.string(),
  machine: z.string(),
  micropythonVersion: z.string(),
  displayWidth: z.number().int(),
  displayHeight: z.number().int(),
  files: z.array(z.string()),
  probedAt: z.iso.datetime(),
});

const ProbeResponseSchema = DeviceSchema.omit({
  device: true,
  probedAt: true,
});

const FileProbeResponseSchema = z.object({
  exists: z.boolean(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
});

const DisplaySchema = z.object({
  device: z.string(),
  username: z.string(),
  score: z.number().int(),
  rank: z.number().int().nullable().optional(),
  streakDays: z.number().int().nullable().optional(),
  subtitle: z.string().optional(),
  sourceUpdatedAt: z.string().optional(),
  displayedAt: z.iso.datetime(),
});

const RunSchema = z.object({
  device: z.string(),
  scriptPath: z.string(),
  stdout: z.string(),
  ranAt: z.iso.datetime(),
});

const InstallationSchema = z.object({
  device: z.string(),
  appPath: z.string(),
  target: z.string(),
  sha256: z.string(),
  changed: z.boolean(),
  installedAt: z.iso.datetime(),
});

const DashboardSchema = z.object({
  device: z.string(),
  title: z.string(),
  value: z.number().int(),
  subtitle: z.string(),
  rank: z.number().int().nullable().optional(),
  streakDays: z.number().int().nullable().optional(),
  sourceUpdatedAt: z.string().optional(),
  updatedAt: z.iso.datetime(),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

type CommandResult = {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/** Injectable subprocess boundary used by the model and its unit tests. */
export type CommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<CommandResult>;

type Logger = {
  info: (message: string, properties?: Record<string, unknown>) => void;
  error: (message: string, properties?: Record<string, unknown>) => void;
};

type MethodContext = {
  globalArgs: GlobalArgs;
  logger: Logger;
  extensionFile: (relativePath: string) => string;
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

const textDecoder = new TextDecoder();
const PROBE_MARKER = "SWAMP_EXPLORER_PROBE=";
const FILE_MARKER = "SWAMP_EXPLORER_FILE=";
const SCORE_MARKER = "SWAMP_EXPLORER_SCORE_OK";
const DASHBOARD_MARKER = "SWAMP_EXPLORER_DASHBOARD_OK";
const MAX_CAPTURE_LENGTH = 32_000;

/** Run a bounded subprocess and capture a limited amount of output. */
export const runCommand: CommandRunner = async (command, args, timeoutMs) => {
  const child = new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // The process exited between the timer firing and kill.
    }
  }, timeoutMs);

  try {
    const output = await child.output();
    return {
      success: output.success && !timedOut,
      code: output.code,
      stdout: textDecoder.decode(output.stdout).slice(-MAX_CAPTURE_LENGTH),
      stderr: textDecoder.decode(output.stderr).slice(-MAX_CAPTURE_LENGTH),
      timedOut,
    };
  } finally {
    clearTimeout(timeout);
  }
};

function mpremoteArgs(device: string, args: string[]): string[] {
  return ["connect", device, ...args];
}

async function runMpremote(
  globals: GlobalArgs,
  args: string[],
  operation: string,
  runner: CommandRunner = runCommand,
): Promise<CommandResult> {
  let result: CommandResult;
  try {
    result = await runner(
      globals.mpremoteCommand,
      mpremoteArgs(globals.device, args),
      globals.timeoutMs,
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `Cannot ${operation}: "${globals.mpremoteCommand}" was not found. Install it with "pipx install mpremote" or set mpremoteCommand.`,
      );
    }
    throw error;
  }

  if (!result.success) {
    const detail = result.timedOut
      ? `timed out after ${globals.timeoutMs}ms`
      : result.stderr.trim() || result.stdout.trim() || `exited ${result.code}`;
    throw new Error(`Cannot ${operation} on ${globals.device}: ${detail}`);
  }
  return result;
}

function parseMarkedJson<T>(stdout: string, marker: string): T {
  const line = stdout.split(/\r?\n/).findLast((candidate) =>
    candidate.startsWith(marker)
  );
  if (!line) {
    throw new Error(`Device response did not contain ${marker}`);
  }
  try {
    return JSON.parse(line.slice(marker.length)) as T;
  } catch (error) {
    throw new Error(`Device returned invalid JSON after ${marker}: ${error}`);
  }
}

/** Build the MicroPython program that verifies Explorer identity and capabilities. */
export function buildProbeProgram(): string {
  return `import json, os, sys
from explorer import display
u = os.uname()
w, h = display.get_bounds()
version = ".".join([str(part) for part in sys.implementation.version[:3]])
print("${PROBE_MARKER}" + json.dumps({"machine": u.machine, "micropythonVersion": version, "displayWidth": w, "displayHeight": h, "files": sorted(os.listdir("/"))}))`;
}

function pythonLiteral(value: string): string {
  return JSON.stringify(value);
}

/** Build a safely encoded MicroPython program that renders a score card. */
export function buildScoreProgram(args: {
  username: string;
  score: number;
  rank?: number | null;
  streakDays?: number | null;
  subtitle?: string;
}): string {
  const username = pythonLiteral(args.username);
  const subtitle = pythonLiteral(args.subtitle ?? "SWAMP CLUB");
  const scoreText = pythonLiteral(args.score.toLocaleString("en-US"));
  const rank = args.rank == null ? "None" : String(args.rank);
  const streak = args.streakDays == null ? "None" : String(args.streakDays);

  return `from explorer import display, BLACK, WHITE
username = ${username}
subtitle = ${subtitle}
score = ${args.score}
score_text = ${scoreText}
rank = ${rank}
streak = ${streak}
green = display.create_pen(35, 210, 120)
muted = display.create_pen(135, 150, 145)
display.set_pen(BLACK)
display.clear()
display.set_font("bitmap8")
display.set_pen(green)
display.text(subtitle, 16, 16, scale=2)
display.set_pen(WHITE)
score_scale = 5 if len(score_text) <= 6 else (4 if len(score_text) <= 8 else 3)
display.text(score_text, 16, 54, scale=score_scale)
display.set_pen(muted)
display.text("@" + username, 18, 132, scale=2)
y = 172
if rank is not None:
    display.text("RANK #" + str(rank), 18, y, scale=2)
    y += 26
if streak is not None:
    display.text("STREAK " + str(streak) + " DAYS", 18, y, scale=2)
display.update()
print("${SCORE_MARKER}")`;
}

/** Build a MicroPython program that stages, saves, and immediately renders a dashboard snapshot. */
export function buildDashboardProgram(args: {
  title: string;
  value: number;
  subtitle?: string;
  rank?: number | null;
  streakDays?: number | null;
  sourceUpdatedAt?: string;
}): string {
  const subtitle = args.subtitle ?? "TOKENS BURNED TODAY";
  const snapshot = JSON.stringify({
    version: 1,
    title: args.title,
    value: args.value,
    valueText: args.value.toLocaleString("en-US"),
    subtitle,
    rank: args.rank ?? null,
    streakDays: args.streakDays ?? null,
    sourceUpdatedAt: args.sourceUpdatedAt ?? null,
  });
  return `from explorer import display
import os
snapshot = ${pythonLiteral(snapshot)}
with open("swamp_dashboard.tmp", "w") as f:
    f.write(snapshot)
try:
    os.remove("swamp_dashboard.json")
except OSError:
    pass
os.rename("swamp_dashboard.tmp", "swamp_dashboard.json")
${
    buildScoreProgram({
      username: args.title,
      score: args.value,
      rank: args.rank,
      streakDays: args.streakDays,
      subtitle,
    })
  }
print("${DASHBOARD_MARKER}")`;
}

/** Validate a factory-menu app filename and protect lifecycle/library files. */
export function validateTarget(target: string): void {
  if (!/^[a-z][a-z0-9_]*\.py$/.test(target)) {
    throw new Error(
      `Invalid target "${target}": use a lowercase Python module filename such as swamp_score.py`,
    );
  }
  if (["boot.py", "main.py", "explorer.py"].includes(target)) {
    throw new Error(`Refusing to replace reserved Explorer file "${target}"`);
  }
}

async function sha256File(path: string): Promise<string> {
  const bytes = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function buildFileProbeProgram(target: string): string {
  const filename = pythonLiteral(target);
  return `import binascii, hashlib, json, os
name = ${filename}
exists = name in os.listdir("/")
digest = None
if exists:
    h = hashlib.sha256()
    with open(name, "rb") as f:
        while True:
            chunk = f.read(1024)
            if not chunk:
                break
            h.update(chunk)
    digest = binascii.hexlify(h.digest()).decode()
print("${FILE_MARKER}" + json.dumps({"exists": exists, "sha256": digest}))`;
}

type InstallArgs = {
  appPath: string;
  target: string;
  force: boolean;
  _runner?: CommandRunner;
};

async function installApp(
  args: InstallArgs,
  context: MethodContext,
): Promise<{ dataHandles: Record<string, unknown>[] }> {
  validateTarget(args.target);
  const stat = await Deno.stat(args.appPath).catch(() => null);
  if (!stat?.isFile) {
    throw new Error(`Explorer app does not exist: ${args.appPath}`);
  }
  if (stat.size > 512_000) {
    throw new Error(
      `Explorer app is too large (${stat.size} bytes; maximum 512000)`,
    );
  }
  const sha256 = await sha256File(args.appPath);
  context.logger.info("Checking {target} on {device}", {
    target: args.target,
    device: context.globalArgs.device,
  });
  const remoteResult = await runMpremote(
    context.globalArgs,
    ["exec", buildFileProbeProgram(args.target)],
    `inspect ${args.target}`,
    args._runner,
  );
  const remote = FileProbeResponseSchema.parse(
    parseMarkedJson<unknown>(remoteResult.stdout, FILE_MARKER),
  );
  const changed = remote.sha256 !== sha256;
  if (remote.exists && changed && !args.force) {
    throw new Error(
      `${args.target} already exists with different content; rerun with force=true to replace it`,
    );
  }
  if (changed) {
    await runMpremote(
      context.globalArgs,
      ["fs", "cp", args.appPath, `:${args.target}`],
      `install ${args.target}`,
      args._runner,
    );
  }
  const handle = await context.writeResource(
    "installation",
    `installation-${args.target.replace(/\.py$/, "")}`,
    {
      device: context.globalArgs.device,
      appPath: args.appPath,
      target: args.target,
      sha256,
      changed,
      installedAt: new Date().toISOString(),
    },
  );
  context.logger.info(
    "Installed {target} on {device}; changed={changed}",
    {
      target: args.target,
      device: context.globalArgs.device,
      changed,
    },
  );
  return { dataHandles: [handle] };
}

/** Pimoroni Explorer model definition. */
export const model = {
  type: "@mgreten/pimoroni-explorer",
  version: "2026.07.31.2",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.31.1",
      description:
        "Add bundled rickroll installation; no global argument schema changes",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.07.31.2",
      description:
        "Add a persistent factory-menu dashboard and snapshot updates; no global argument schema changes",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
  ],
  resources: {
    device: {
      description: "Detected Pimoroni Explorer identity and filesystem summary",
      schema: DeviceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    display: {
      description: "Latest Swamp Club score rendered on the Explorer display",
      schema: DisplaySchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    run: {
      description: "Result of running a local MicroPython script from RAM",
      schema: RunSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    installation: {
      description: "Application installed into the Explorer factory menu",
      schema: InstallationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    dashboard: {
      description:
        "Latest persistent dashboard snapshot written to the Explorer",
      schema: DashboardSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    probe: {
      description:
        "Verify the USB device is a Pimoroni Explorer and record its firmware and files",
      arguments: z.object({}),
      execute: async (
        args: { _runner?: CommandRunner },
        context: MethodContext,
      ) => {
        context.logger.info("Probing Pimoroni Explorer on {device}", {
          device: context.globalArgs.device,
        });
        const result = await runMpremote(
          context.globalArgs,
          ["exec", buildProbeProgram()],
          "probe Pimoroni Explorer",
          args._runner,
        );
        const probe = ProbeResponseSchema.parse(
          parseMarkedJson<unknown>(result.stdout, PROBE_MARKER),
        );
        if (!probe.machine.toLowerCase().includes("pimoroni explorer")) {
          throw new Error(
            `Connected device is not a Pimoroni Explorer: ${probe.machine}`,
          );
        }
        const handle = await context.writeResource("device", "device-current", {
          device: context.globalArgs.device,
          ...probe,
          probedAt: new Date().toISOString(),
        });
        context.logger.info(
          "Detected {machine} running MicroPython {version}",
          {
            machine: probe.machine,
            version: probe.micropythonVersion,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    displayScore: {
      description: "Render a Swamp Club score on the Explorer over USB",
      arguments: z.object({
        username: z.string().min(1),
        score: z.number().int().nonnegative(),
        rank: z.number().int().positive().nullable().optional(),
        streakDays: z.number().int().nonnegative().nullable().optional(),
        subtitle: z.string().min(1).max(24).optional(),
        sourceUpdatedAt: z.string().optional(),
      }),
      execute: async (
        args: {
          username: string;
          score: number;
          rank?: number | null;
          streakDays?: number | null;
          subtitle?: string;
          sourceUpdatedAt?: string;
          _runner?: CommandRunner;
        },
        context: MethodContext,
      ) => {
        context.logger.info(
          "Displaying Swamp Club score {score} for {username}",
          {
            score: args.score,
            username: args.username,
          },
        );
        const result = await runMpremote(
          context.globalArgs,
          ["exec", buildScoreProgram(args)],
          "display Swamp Club score",
          args._runner,
        );
        if (!result.stdout.includes(SCORE_MARKER)) {
          throw new Error(
            "Explorer did not confirm that the score was displayed",
          );
        }
        const handle = await context.writeResource(
          "display",
          "display-current",
          {
            device: context.globalArgs.device,
            username: args.username,
            score: args.score,
            rank: args.rank,
            streakDays: args.streakDays,
            subtitle: args.subtitle,
            sourceUpdatedAt: args.sourceUpdatedAt,
            displayedAt: new Date().toISOString(),
          },
        );
        context.logger.info("Displayed Swamp Club score on {device}", {
          device: context.globalArgs.device,
        });
        return { dataHandles: [handle] };
      },
    },
    run: {
      description:
        "Run a local MicroPython script from RAM without changing the Explorer filesystem",
      arguments: z.object({ scriptPath: z.string().min(1) }),
      execute: async (
        args: { scriptPath: string; _runner?: CommandRunner },
        context: MethodContext,
      ) => {
        const stat = await Deno.stat(args.scriptPath).catch(() => null);
        if (!stat?.isFile) {
          throw new Error(
            `MicroPython script does not exist: ${args.scriptPath}`,
          );
        }
        context.logger.info("Running {script} on {device}", {
          script: args.scriptPath,
          device: context.globalArgs.device,
        });
        const result = await runMpremote(
          context.globalArgs,
          ["run", args.scriptPath],
          `run ${args.scriptPath}`,
          args._runner,
        );
        const handle = await context.writeResource("run", `run-${Date.now()}`, {
          device: context.globalArgs.device,
          scriptPath: args.scriptPath,
          stdout: result.stdout,
          ranAt: new Date().toISOString(),
        });
        context.logger.info("Finished running {script}", {
          script: args.scriptPath,
        });
        return { dataHandles: [handle] };
      },
    },
    install: {
      description:
        "Install one Python app into the factory Explorer menu without replacing main.py",
      arguments: z.object({
        appPath: z.string().min(1),
        target: z.string().default("swamp_score.py"),
        force: z.boolean().default(false),
      }),
      execute: (
        args: InstallArgs,
        context: MethodContext,
      ) => installApp(args, context),
    },
    installRickRoll: {
      description:
        "Install the bundled rickroll app into the factory Explorer menu without replacing main.py",
      arguments: z.object({
        force: z.boolean().default(false),
      }),
      execute: (
        args: { force: boolean; _runner?: CommandRunner },
        context: MethodContext,
      ) =>
        installApp(
          {
            appPath: context.extensionFile("apps/rick_roll.py.txt"),
            target: "rick_roll.py",
            force: args.force,
            _runner: args._runner,
          },
          context,
        ),
    },
    installDashboard: {
      description:
        "Install the bundled persistent Swamp dashboard into the factory Explorer menu without replacing main.py",
      arguments: z.object({
        force: z.boolean().default(false),
      }),
      execute: (
        args: { force: boolean; _runner?: CommandRunner },
        context: MethodContext,
      ) =>
        installApp(
          {
            appPath: context.extensionFile("apps/swamp_dashboard.py.txt"),
            target: "swamp_dashboard.py",
            force: args.force,
            _runner: args._runner,
          },
          context,
        ),
    },
    updateDashboard: {
      description:
        "Persist the latest dashboard snapshot on the Explorer with a staged write and render it immediately",
      arguments: z.object({
        title: z.string().min(1).max(24),
        value: z.number().int().nonnegative(),
        subtitle: z.string().min(1).max(24).default("TOKENS BURNED TODAY"),
        rank: z.number().int().positive().nullable().optional(),
        streakDays: z.number().int().nonnegative().nullable().optional(),
        sourceUpdatedAt: z.string().optional(),
      }),
      execute: async (
        args: {
          title: string;
          value: number;
          subtitle: string;
          rank?: number | null;
          streakDays?: number | null;
          sourceUpdatedAt?: string;
          _runner?: CommandRunner;
        },
        context: MethodContext,
      ) => {
        context.logger.info(
          "Updating persistent dashboard on {device} with {value}",
          { device: context.globalArgs.device, value: args.value },
        );
        const result = await runMpremote(
          context.globalArgs,
          ["exec", buildDashboardProgram(args)],
          "update persistent dashboard",
          args._runner,
        );
        if (!result.stdout.includes(DASHBOARD_MARKER)) {
          throw new Error(
            "Explorer did not confirm that the dashboard snapshot was saved",
          );
        }
        const handle = await context.writeResource(
          "dashboard",
          "dashboard-current",
          {
            device: context.globalArgs.device,
            title: args.title,
            value: args.value,
            subtitle: args.subtitle,
            rank: args.rank,
            streakDays: args.streakDays,
            sourceUpdatedAt: args.sourceUpdatedAt,
            updatedAt: new Date().toISOString(),
          },
        );
        context.logger.info("Updated persistent dashboard on {device}", {
          device: context.globalArgs.device,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
