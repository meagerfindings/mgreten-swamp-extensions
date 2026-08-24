import { z } from "npm:zod@4";

const loopbackUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      ["127.0.0.1", "::1", "localhost"].includes(url.hostname) &&
      url.username === "" && url.password === "";
  } catch {
    return false;
  }
};

export const GlobalArgsSchema = z.object({
  authority: z.literal("local-development").default("local-development")
    .describe("Fixed authority boundary; production control is not supported"),
  workingDirectory: z.string().optional().describe(
    "Local directory in which lifecycle commands run; defaults to the Swamp repository root",
  ),
  startCommand: z.string().min(1).describe(
    "Idempotent local command that asks an existing supervisor to start the development server",
  ),
  stopCommand: z.string().min(1).describe(
    "Idempotent local command that asks the same supervisor to stop the development server",
  ),
  statusCommand: z.string().min(1).optional().describe(
    "Optional local command whose exit status is zero only while the server is running",
  ),
  commandTimeoutMs: z.number().int().min(100).max(300_000).default(30_000),
  commandOutputMaxBytes: z.number().int().min(256).max(65_536).default(8_192),
  healthCheck: z.object({
    url: z.string().url().refine(loopbackUrl, {
      message: "healthCheck.url must target localhost, 127.0.0.1, or ::1",
    }),
    expectedStatus: z.number().int().min(100).max(599).default(200),
    timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
    intervalMs: z.number().int().min(50).max(10_000).default(1_000),
  }).strict().optional().describe("Optional loopback-only HTTP health check"),
  certificate: z.discriminatedUnion("strategy", [
    z.object({ strategy: z.literal("none") }).strict(),
    z.object({
      strategy: z.literal("command"),
      expiryCommand: z.string().min(1).describe(
        "Local command that prints the certificate expiry as an ISO-8601 timestamp",
      ),
    }).strict(),
  ]).default({ strategy: "none" }).describe(
    "Optional local certificate inspection; this controller never issues or renews certificates",
  ),
}).strict();

export const StatusSchema = z.object({
  running: z.boolean(),
  health: z.enum(["not_configured", "healthy", "unhealthy"]),
  healthUrl: z.string().nullable(),
  commandExitCode: z.number().int().nullable(),
  certificateExpiresAt: z.iso.datetime().nullable(),
  checkedAt: z.iso.datetime(),
}).strict();

export type GlobalArgs =
  & Omit<z.input<typeof GlobalArgsSchema>, "certificate">
  & {
    certificate: z.output<typeof GlobalArgsSchema>["certificate"];
  };
export type ServerStatus = z.infer<typeof StatusSchema>;

/** Ensure configured commands cannot escape the current local Swamp repository. */
export async function validateWorkingDirectory(
  repoDir: string,
  workingDirectory: string,
): Promise<string> {
  const [repository, candidate] = await Promise.all([
    Deno.realPath(repoDir),
    Deno.realPath(workingDirectory),
  ]);
  const separator = Deno.build.os === "windows" ? "\\" : "/";
  if (
    candidate !== repository && !candidate.startsWith(repository + separator)
  ) {
    throw new Error(
      "workingDirectory must be the Swamp repository root or one of its subdirectories",
    );
  }
  return candidate;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LifecycleDependencies {
  run(
    command: string,
    workingDirectory: string,
    timeoutMs: number,
    outputMaxBytes: number,
    signal?: AbortSignal,
  ): Promise<CommandResult>;
  fetch(url: string, signal: AbortSignal): Promise<{ status: number }>;
  sleep(milliseconds: number): Promise<void>;
  now(): Date;
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
) {
  const reader = stream.getReader();
  const retained: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (size < maximum) {
      const chunk = value.subarray(0, maximum - size);
      retained.push(chunk);
      size += chunk.length;
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of retained) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes).trim();
}

/** Run one shell command with bounded duration and streaming, bounded capture. */
export async function runCommand(
  command: string,
  workingDirectory: string,
  timeoutMs: number,
  outputMaxBytes: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  signal?.throwIfAborted();
  const grouped = Deno.build.os === "linux";
  const child = new Deno.Command(grouped ? "/usr/bin/setsid" : "/bin/sh", {
    args: grouped ? ["/bin/sh", "-c", command] : ["-c", command],
    cwd: workingDirectory,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const stdout = readBounded(child.stdout, outputMaxBytes);
  const stderr = readBounded(child.stderr, outputMaxBytes);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`command timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  const cancellation = new Promise<never>((_, reject) => {
    if (!signal) return;
    abortHandler = () =>
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abortHandler, { once: true });
  });
  try {
    const status = await Promise.race([child.status, timeout, cancellation]);
    return { code: status.code, stdout: await stdout, stderr: await stderr };
  } catch (error) {
    try {
      if (grouped) Deno.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch { /* already exited */ }
    await Promise.race([
      child.status,
      new Promise((resolve) => setTimeout(resolve, 250)),
    ]);
    try {
      if (grouped) Deno.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch { /* already exited */ }
    await Promise.allSettled([child.status, stdout, stderr]);
    throw error;
  } finally {
    clearTimeout(timer);
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
  }
}

export const realDependencies: LifecycleDependencies = {
  run: runCommand,
  async fetch(url, signal) {
    const response = await fetch(url, { redirect: "manual", signal });
    return { status: response.status };
  },
  sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  },
  now() {
    return new Date();
  },
};

const safeFailureContext = (result: CommandResult) => {
  const text = result.stderr || result.stdout || "no output";
  return text.replace(
    /\b(?:bearer\s+\S+|(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+)/gi,
    "[REDACTED]",
  )
    .replace(/[\r\n]+/g, " ").slice(0, 500);
};
const run = (
  command: string,
  workingDirectory: string,
  config: GlobalArgs,
  dependencies: LifecycleDependencies,
  signal?: AbortSignal,
) =>
  dependencies.run(
    command,
    workingDirectory,
    config.commandTimeoutMs ?? 30_000,
    config.commandOutputMaxBytes ?? 8_192,
    signal,
  );

async function checkHealth(
  healthCheck: GlobalArgs["healthCheck"],
  dependencies: LifecycleDependencies,
  signal?: AbortSignal,
): Promise<"not_configured" | "healthy" | "unhealthy"> {
  if (!healthCheck) return "not_configured";
  signal?.throwIfAborted();

  const timeoutMs = healthCheck.timeoutMs ?? 30_000;
  const intervalMs = healthCheck.intervalMs ?? 1_000;
  const deadline = dependencies.now().getTime() + timeoutMs;
  do {
    try {
      const remaining = Math.max(1, deadline - dependencies.now().getTime());
      if (
        (await dependencies.fetch(
          healthCheck.url,
          signal
            ? AbortSignal.any([signal, AbortSignal.timeout(remaining)])
            : AbortSignal.timeout(remaining),
        )).status ===
          healthCheck.expectedStatus
      ) {
        return "healthy";
      }
    } catch {
      signal?.throwIfAborted();
      // A server may still be starting; retry only until the configured deadline.
    }
    if (dependencies.now().getTime() >= deadline) break;
    await dependencies.sleep(intervalMs);
    signal?.throwIfAborted();
  } while (dependencies.now().getTime() < deadline);

  return "unhealthy";
}

async function certificateExpiry(
  config: GlobalArgs,
  workingDirectory: string,
  dependencies: LifecycleDependencies,
  signal?: AbortSignal,
): Promise<string | null> {
  if (config.certificate.strategy === "none") return null;
  const result = await run(
    config.certificate.expiryCommand,
    workingDirectory,
    config,
    dependencies,
    signal,
  );
  if (result.code !== 0) {
    throw new Error(`certificate expiry command exited with ${result.code}`);
  }
  const timestamp = result.stdout.trim();
  if (!z.iso.datetime().safeParse(timestamp).success) {
    throw new Error("certificate expiry command returned an invalid timestamp");
  }
  return new Date(timestamp).toISOString();
}

export async function status(
  config: GlobalArgs,
  workingDirectory: string,
  dependencies: LifecycleDependencies = realDependencies,
  signal?: AbortSignal,
): Promise<ServerStatus> {
  const commandResult = config.statusCommand
    ? await run(
      config.statusCommand,
      workingDirectory,
      config,
      dependencies,
      signal,
    )
    : null;
  const health = await checkHealth(config.healthCheck, dependencies, signal);
  const running = commandResult
    ? commandResult.code === 0
    : health === "healthy";

  return {
    running,
    health,
    healthUrl: config.healthCheck?.url ?? null,
    commandExitCode: commandResult?.code ?? null,
    certificateExpiresAt: await certificateExpiry(
      config,
      workingDirectory,
      dependencies,
      signal,
    ),
    checkedAt: dependencies.now().toISOString(),
  };
}

export async function start(
  config: GlobalArgs,
  workingDirectory: string,
  dependencies: LifecycleDependencies = realDependencies,
  signal?: AbortSignal,
): Promise<{ command: CommandResult; status: ServerStatus }> {
  const command = await run(
    config.startCommand,
    workingDirectory,
    config,
    dependencies,
    signal,
  );
  if (command.code !== 0) {
    throw new Error(
      `startCommand exited with ${command.code}: ${
        safeFailureContext(command)
      }`,
    );
  }
  const observed = await status(config, workingDirectory, dependencies, signal);
  if (config.healthCheck && observed.health !== "healthy") {
    throw new Error(
      "startCommand completed but the loopback health check failed",
    );
  }
  if (config.statusCommand && !observed.running) {
    throw new Error("startCommand completed but statusCommand reports stopped");
  }
  return {
    command,
    status: observed,
  };
}

export async function stop(
  config: GlobalArgs,
  workingDirectory: string,
  dependencies: LifecycleDependencies = realDependencies,
  signal?: AbortSignal,
): Promise<{ command: CommandResult; status: ServerStatus }> {
  const command = await run(
    config.stopCommand,
    workingDirectory,
    config,
    dependencies,
    signal,
  );
  if (command.code !== 0) {
    throw new Error(
      `stopCommand exited with ${command.code}: ${safeFailureContext(command)}`,
    );
  }
  const observed = await status(config, workingDirectory, dependencies, signal);
  if (observed.running || observed.health === "healthy") {
    throw new Error(
      "stopCommand completed but the local server is still running",
    );
  }
  return {
    command,
    status: observed,
  };
}
