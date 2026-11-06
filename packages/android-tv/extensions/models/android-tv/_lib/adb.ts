import { z } from "npm:zod@4";

export const AdbBinarySchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) => !value.includes("\0") && value === value.trim(),
    "ADB executable path is invalid.",
  );

export const AdbTargetSchema = z.string().min(9).max(21).refine((value) => {
  const parts = value.split(":");
  if (parts.length !== 2 || !/^[1-9]\d{0,4}$/.test(parts[1])) return false;
  const octets = parts[0].split(".");
  if (octets.length !== 4) return false;
  const validOctets = octets.every((part) =>
    /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255
  );
  const port = Number(parts[1]);
  return validOctets && port <= 65_535;
}, "Target must be an IPv4 address and TCP port, such as 192.0.2.10:5555.");

export const AdbReadinessSchema = z.object({
  clientVersion: z.string().min(1).max(64),
  packageBuild: z.string().max(128).optional(),
}).strict();

export type AdbReadiness = z.infer<typeof AdbReadinessSchema>;

export interface CommandResult {
  readonly success: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number,
) => Promise<CommandResult>;

export type AndroidProperty =
  | "ro.product.model"
  | "ro.build.version.release"
  | "ro.build.version.sdk"
  | "ro.build.version.security_patch"
  | "ro.build.display.id";

export type DeviceRead =
  | { readonly kind: "property"; readonly name: AndroidProperty }
  | { readonly kind: "packages"; readonly state: "enabled" | "disabled" }
  | { readonly kind: "memory" }
  | { readonly kind: "dataFilesystem" };

const VERSION_OUTPUT_LIMIT = 16 * 1024;
const DEVICE_OUTPUT_LIMIT = 64 * 1024;

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  stopProcess: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (byteLength + value.byteLength > maxBytes) {
        stopProcess();
        await reader.cancel().catch(() => undefined);
        throw new Error(`ADB output exceeded the ${maxBytes}-byte limit.`);
      }
      chunks.push(value);
      byteLength += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("ADB returned output that is not valid UTF-8.");
  }
}

export const runDenoCommand: CommandRunner = async (
  executable,
  args,
  timeoutMs,
  maxOutputBytes,
) => {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(executable, {
      args: [...args],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch {
    throw new Error("Configured ADB executable could not be started.");
  }

  const stopProcess = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may already have exited.
    }
  };

  const execution = Promise.all(
    [
      readLimited(child.stdout, maxOutputBytes, stopProcess),
      readLimited(child.stderr, maxOutputBytes, stopProcess),
      child.status,
    ] as const,
  );

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      stopProcess();
      reject(new Error(`ADB command timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
  });

  try {
    const [stdout, stderr, status] = await Promise.race([execution, timeout]);
    return {
      success: status.success,
      exitCode: status.code,
      stdout,
      stderr,
    };
  } catch (error) {
    stopProcess();
    await child.status.catch(() => undefined);
    throw error;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
};

export function parseAdbVersion(output: string): AdbReadiness {
  const lines = output.split(/\r?\n/);
  const versionMatch = /^Android Debug Bridge version ([0-9]+\.[0-9]+\.[0-9]+)$/
    .exec(
      lines[0]?.trim() ?? "",
    );
  if (!versionMatch) {
    throw new Error("ADB did not report a recognized client version.");
  }

  const packageBuild = lines.slice(1).map((line) =>
    /^Version\s+(.+)$/.exec(line.trim())
  )
    .find((match) => match !== null)?.[1];

  return AdbReadinessSchema.parse({
    clientVersion: versionMatch[1],
    ...(packageBuild ? { packageBuild: packageBuild.slice(0, 128) } : {}),
  });
}

export async function checkAdbVersion(
  executable: string,
  timeoutMs: number,
  runner: CommandRunner = runDenoCommand,
): Promise<AdbReadiness> {
  const binary = AdbBinarySchema.parse(executable);
  const result = await runner(
    binary,
    ["version"],
    timeoutMs,
    VERSION_OUTPUT_LIMIT,
  );
  if (!result.success) {
    throw new Error(
      `ADB version command failed (exit code ${result.exitCode}).`,
    );
  }
  return parseAdbVersion(result.stdout);
}

function deviceArgs(target: string, read: DeviceRead): string[] {
  const selector = ["-s", AdbTargetSchema.parse(target), "shell"];
  switch (read.kind) {
    case "property":
      return [...selector, "getprop", read.name];
    case "packages":
      return [
        ...selector,
        "pm",
        "list",
        "packages",
        read.state === "enabled" ? "-e" : "-d",
        "--user",
        "0",
      ];
    case "memory":
      return [...selector, "cat", "/proc/meminfo"];
    case "dataFilesystem":
      return [...selector, "df", "-k", "/data"];
  }
}

export async function runDeviceRead(
  executable: string,
  target: string,
  read: DeviceRead,
  timeoutMs: number,
  runner: CommandRunner = runDenoCommand,
): Promise<string> {
  const binary = AdbBinarySchema.parse(executable);
  const result = await runner(
    binary,
    deviceArgs(target, read),
    timeoutMs,
    DEVICE_OUTPUT_LIMIT,
  );
  if (!result.success) {
    throw new Error(
      `ADB ${read.kind} read failed (exit code ${result.exitCode}).`,
    );
  }
  return result.stdout;
}
