import { z } from "npm:zod@4";
import {
  type AndroidProperty,
  type CommandRunner,
  runDeviceRead,
} from "./adb.ts";

const PackageNameSchema = z.string().min(1).max(255).regex(
  /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/,
);

export const DeviceInventorySchema = z.object({
  androidProductModel: z.string().min(1).max(256),
  androidRelease: z.string().min(1).max(64),
  androidSdkLevel: z.number().int().min(1).max(1_000),
  securityPatch: z.iso.date().optional(),
  buildDisplayId: z.string().min(1).max(128).optional(),
  enabledPackages: z.array(PackageNameSchema).max(10_000),
  disabledPackages: z.array(PackageNameSchema).max(10_000),
  memory: z.object({
    totalBytes: z.number().int().nonnegative(),
    freeBytes: z.number().int().nonnegative(),
    availableBytes: z.number().int().nonnegative().optional(),
    cachedBytes: z.number().int().nonnegative().optional(),
  }).strict(),
  dataFilesystem: z.object({
    totalBytes: z.number().int().nonnegative(),
    usedBytes: z.number().int().nonnegative(),
    availableBytes: z.number().int().nonnegative(),
  }).strict(),
  capturedAt: z.iso.datetime(),
}).strict();

export type DeviceInventory = z.infer<typeof DeviceInventorySchema>;

const PROPERTY_READS = [
  "ro.product.model",
  "ro.build.version.release",
  "ro.build.version.sdk",
  "ro.build.version.security_patch",
  "ro.build.display.id",
] as const satisfies readonly AndroidProperty[];

async function readProperty(
  executable: string,
  target: string,
  name: AndroidProperty,
  timeoutMs: number,
  runner: CommandRunner,
): Promise<string> {
  const value = (await runDeviceRead(
    executable,
    target,
    { kind: "property", name },
    timeoutMs,
    runner,
  )).trim();
  const hasControlCharacter = Array.from(value).some((character) => {
    const codePoint = character.charCodeAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (value.length > 256 || hasControlCharacter) {
    throw new Error(`Android property ${name} was malformed.`);
  }
  return value;
}

function requiredText(value: string, name: string, maxLength: number): string {
  if (value.length === 0 || value.length > maxLength) {
    throw new Error(`Android property ${name} was empty or too long.`);
  }
  return value;
}

function optionalText(
  value: string,
  name: string,
  maxLength: number,
): string | undefined {
  if (!value) return undefined;
  return requiredText(value, name, maxLength);
}

function parsePackages(
  output: string,
  state: "enabled" | "disabled",
): string[] {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(
    Boolean,
  );
  if (lines.length === 0) {
    if (state === "disabled") return [];
    throw new Error("ADB returned no enabled user-0 packages.");
  }

  const packages = new Set<string>();
  for (const line of lines) {
    if (!line.startsWith("package:")) {
      throw new Error(`ADB returned malformed ${state} package output.`);
    }
    const parsed = PackageNameSchema.safeParse(line.slice("package:".length));
    if (!parsed.success || packages.has(parsed.data)) {
      throw new Error(
        `ADB returned malformed or duplicate ${state} package output.`,
      );
    }
    packages.add(parsed.data);
  }
  return [...packages].sort();
}

function kilobytesToBytes(value: string, label: string): number {
  const kilobytes = Number(value);
  const bytes = kilobytes * 1_024;
  if (
    !Number.isSafeInteger(kilobytes) || kilobytes < 0 ||
    !Number.isSafeInteger(bytes)
  ) {
    throw new Error(`ADB returned an invalid ${label} value.`);
  }
  return bytes;
}

function parseMemory(output: string): DeviceInventory["memory"] {
  const values = new Map<string, number>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9_()]*):\s*(\d+)\s+kB$/.exec(line.trim());
    if (match) values.set(match[1], kilobytesToBytes(match[2], match[1]));
  }

  const totalBytes = values.get("MemTotal");
  const freeBytes = values.get("MemFree");
  if (
    totalBytes === undefined || freeBytes === undefined ||
    freeBytes > totalBytes
  ) {
    throw new Error(
      "ADB returned incomplete or inconsistent /proc/meminfo data.",
    );
  }

  const availableBytes = values.get("MemAvailable");
  const cachedBytes = values.get("Cached");
  if (
    (availableBytes !== undefined && availableBytes > totalBytes) ||
    (cachedBytes !== undefined && cachedBytes > totalBytes)
  ) {
    throw new Error("ADB returned inconsistent /proc/meminfo totals.");
  }
  return {
    totalBytes,
    freeBytes,
    ...(availableBytes === undefined ? {} : { availableBytes }),
    ...(cachedBytes === undefined ? {} : { cachedBytes }),
  };
}

function parseDataFilesystem(
  output: string,
): DeviceInventory["dataFilesystem"] {
  const rows = output.split(/\r?\n/).map((line) => line.trim()).filter((line) =>
    line.endsWith(" /data")
  );
  if (rows.length !== 1) {
    throw new Error("ADB did not return exactly one /data filesystem row.");
  }

  const match = /^\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+\/data$/.exec(rows[0]);
  if (!match) throw new Error("ADB returned malformed /data filesystem data.");

  const [totalBytes, usedBytes, availableBytes] = match.slice(1).map((value) =>
    kilobytesToBytes(value, "/data filesystem")
  );
  if (
    usedBytes > totalBytes || availableBytes > totalBytes ||
    usedBytes + availableBytes > totalBytes
  ) {
    throw new Error("ADB returned inconsistent /data filesystem values.");
  }
  return { totalBytes, usedBytes, availableBytes };
}

export async function collectInventory(
  executable: string,
  target: string,
  timeoutMs: number,
  runner: CommandRunner,
  now: () => Date = () => new Date(),
): Promise<DeviceInventory> {
  const values = new Map<AndroidProperty, string>();
  for (const property of PROPERTY_READS) {
    values.set(
      property,
      await readProperty(executable, target, property, timeoutMs, runner),
    );
  }

  const androidProductModel = requiredText(
    values.get("ro.product.model") ?? "",
    "ro.product.model",
    256,
  );
  const androidRelease = requiredText(
    values.get("ro.build.version.release") ?? "",
    "ro.build.version.release",
    64,
  );
  const sdkText = requiredText(
    values.get("ro.build.version.sdk") ?? "",
    "ro.build.version.sdk",
    4,
  );
  if (!/^\d{1,4}$/.test(sdkText)) {
    throw new Error("Android SDK level was malformed.");
  }
  const androidSdkLevel = Number(sdkText);
  if (
    !Number.isSafeInteger(androidSdkLevel) || androidSdkLevel < 1 ||
    androidSdkLevel > 1_000
  ) {
    throw new Error("Android SDK level was outside the supported range.");
  }
  const securityPatchText = optionalText(
    values.get("ro.build.version.security_patch") ?? "",
    "ro.build.version.security_patch",
    10,
  );
  const securityPatch = securityPatchText === undefined
    ? undefined
    : z.iso.date().parse(securityPatchText);
  const buildDisplayId = optionalText(
    values.get("ro.build.display.id") ?? "",
    "ro.build.display.id",
    128,
  );

  const enabledPackages = parsePackages(
    await runDeviceRead(
      executable,
      target,
      { kind: "packages", state: "enabled" },
      timeoutMs,
      runner,
    ),
    "enabled",
  );
  const disabledPackages = parsePackages(
    await runDeviceRead(
      executable,
      target,
      { kind: "packages", state: "disabled" },
      timeoutMs,
      runner,
    ),
    "disabled",
  );
  const overlap = enabledPackages.find((packageName) =>
    disabledPackages.includes(packageName)
  );
  if (overlap) {
    throw new Error("ADB reported a package as both enabled and disabled.");
  }

  const memory = parseMemory(
    await runDeviceRead(
      executable,
      target,
      { kind: "memory" },
      timeoutMs,
      runner,
    ),
  );
  const dataFilesystem = parseDataFilesystem(
    await runDeviceRead(
      executable,
      target,
      { kind: "dataFilesystem" },
      timeoutMs,
      runner,
    ),
  );

  return DeviceInventorySchema.parse({
    androidProductModel,
    androidRelease,
    androidSdkLevel,
    ...(securityPatch === undefined ? {} : { securityPatch }),
    ...(buildDisplayId === undefined ? {} : { buildDisplayId }),
    enabledPackages,
    disabledPackages,
    memory,
    dataFilesystem,
    capturedAt: now().toISOString(),
  });
}
