/**
 * Model `@mgreten/storage-health` — local and remote disk usage and backup
 * inventory monitoring.
 *
 * Inspects one or more mount points on any SSH-accessible host (or the local
 * machine) and optionally inventories snapshot-style backup directories. Each
 * scan produces typed, versioned artifacts that can be queried over time.
 *
 * When `sshHost` is `"local"` or empty, commands run directly on the local
 * machine via the shell. Otherwise they run over SSH (key-based auth required).
 *
 * @module storage-health
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Global args
// ---------------------------------------------------------------------------

/** Global configuration shared across all methods. */
const GlobalArgsSchema: z.ZodObject<{
  sshHost: z.ZodDefault<z.ZodString>;
  mounts: z.ZodDefault<z.ZodString>;
  warnPercent: z.ZodDefault<z.ZodNumber>;
  criticalPercent: z.ZodDefault<z.ZodNumber>;
  backupPaths: z.ZodDefault<z.ZodString>;
  backupKeepTarget: z.ZodDefault<z.ZodNumber>;
}> = z.object({
  sshHost: z
    .string()
    .default("local")
    .describe(
      'SSH hostname or IP to inspect. Use "local" (default) to run ' +
        "commands directly on the local machine without SSH.",
    ),
  mounts: z
    .string()
    .default("/")
    .describe(
      "Comma-separated list of mount paths to inspect " +
        "(e.g. '/,/mnt/data,/mnt/backup').",
    ),
  warnPercent: z
    .number()
    .default(75)
    .describe("Usage percentage that triggers a 'warning' status."),
  criticalPercent: z
    .number()
    .default(90)
    .describe("Usage percentage that triggers a 'critical' status."),
  backupPaths: z
    .string()
    .default("")
    .describe(
      "Comma-separated list of backup snapshot directories to inventory. " +
        "Each directory is expected to contain timestamped subdirectories " +
        "(e.g. '/mnt/backup/snapshots'). Leave empty to skip backup inventory.",
    ),
  backupKeepTarget: z
    .number()
    .default(0)
    .describe(
      "Expected maximum number of snapshots per backup path. " +
        "Set to 0 to disable compliance checking.",
    ),
});

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

/** Status level for a single resource. */
const StatusSchema: z.ZodEnum<["ok", "warning", "critical"]> = z.enum([
  "ok",
  "warning",
  "critical",
]);

/** Usage snapshot for a single mount point. */
const MountStatusSchema: z.ZodObject<{
  mount: z.ZodString;
  device: z.ZodString;
  sizeMb: z.ZodNumber;
  usedMb: z.ZodNumber;
  availMb: z.ZodNumber;
  usePercent: z.ZodNumber;
  status: typeof StatusSchema;
  timestamp: z.ZodString;
}> = z.object({
  mount: z.string().describe("Mount path (e.g. '/mnt/data')."),
  device: z.string().describe("Block device or filesystem backing this mount."),
  sizeMb: z.number().describe("Total size of the filesystem in MiB."),
  usedMb: z.number().describe("Used space in MiB."),
  availMb: z.number().describe("Available space in MiB."),
  usePercent: z.number().describe("Usage as an integer percentage (0–100)."),
  status: StatusSchema.describe(
    "'ok' below warn threshold, 'warning' at or above warnPercent, " +
      "'critical' at or above criticalPercent.",
  ),
  timestamp: z.string().describe("ISO-8601 timestamp of this observation."),
});

/** Inventory of a single backup snapshot directory. */
const BackupInventorySchema: z.ZodObject<{
  path: z.ZodString;
  snapshotCount: z.ZodNumber;
  oldestSnapshot: z.ZodString;
  newestSnapshot: z.ZodString;
  keepTarget: z.ZodNumber;
  compliant: z.ZodBoolean;
  timestamp: z.ZodString;
}> = z.object({
  path: z.string().describe("Absolute path to the backup snapshot directory."),
  snapshotCount: z
    .number()
    .describe("Number of timestamped subdirectories found."),
  oldestSnapshot: z
    .string()
    .describe("Name of the oldest snapshot subdirectory, or empty if none."),
  newestSnapshot: z
    .string()
    .describe("Name of the newest snapshot subdirectory, or empty if none."),
  keepTarget: z
    .number()
    .describe(
      "Configured maximum snapshot count (0 = no target, always compliant).",
    ),
  compliant: z
    .boolean()
    .describe(
      "True when keepTarget is 0 or snapshotCount <= keepTarget.",
    ),
  timestamp: z.string().describe("ISO-8601 timestamp of this observation."),
});

/** Aggregate storage health report for a host. */
const StorageReportSchema: z.ZodObject<{
  host: z.ZodString;
  overallStatus: typeof StatusSchema;
  mounts: z.ZodArray<typeof MountStatusSchema>;
  backups: z.ZodArray<typeof BackupInventorySchema>;
  recommendations: z.ZodArray<z.ZodString>;
  timestamp: z.ZodString;
}> = z.object({
  host: z
    .string()
    .describe("Host that was inspected ('local' for local execution)."),
  overallStatus: StatusSchema.describe(
    "Worst status across all mounts and backup compliance checks.",
  ),
  mounts: z
    .array(MountStatusSchema)
    .describe("Per-mount usage snapshots."),
  backups: z
    .array(BackupInventorySchema)
    .describe("Per-backup-path inventory results."),
  recommendations: z
    .array(z.string())
    .describe(
      "Human-readable action items derived from the scan results.",
    ),
  timestamp: z.string().describe("ISO-8601 timestamp of this report."),
});

/** Summary of all filesystems on a host. */
const MountListSchema: z.ZodObject<{
  host: z.ZodString;
  mounts: z.ZodArray<
    z.ZodObject<{
      device: z.ZodString;
      mount: z.ZodString;
      fstype: z.ZodString;
      sizeMb: z.ZodNumber;
      usedMb: z.ZodNumber;
      usePercent: z.ZodNumber;
    }>
  >;
  timestamp: z.ZodString;
}> = z.object({
  host: z.string(),
  mounts: z.array(
    z.object({
      device: z.string().describe("Block device or filesystem."),
      mount: z.string().describe("Mount point path."),
      fstype: z.string().describe("Filesystem type (ext4, btrfs, etc.)."),
      sizeMb: z.number().describe("Total size in MiB."),
      usedMb: z.number().describe("Used space in MiB."),
      usePercent: z.number().describe("Usage as an integer percentage."),
    }),
  ),
  timestamp: z.string().describe("ISO-8601 timestamp of this listing."),
});

// ---------------------------------------------------------------------------
// Exec helper — local or SSH
// ---------------------------------------------------------------------------

/** Run a shell command either locally or over SSH and return trimmed stdout. */
async function exec(host: string, command: string): Promise<string> {
  const isLocal = host === "local" || host === "" || host === "localhost";
  const cmd = isLocal
    ? new Deno.Command("/bin/sh", {
      args: ["-c", command],
      stdout: "piped",
      stderr: "piped",
    })
    : new Deno.Command("ssh", {
      args: [
        "-o",
        "ConnectTimeout=10",
        "-o",
        "BatchMode=yes",
        host,
        command,
      ],
      stdout: "piped",
      stderr: "piped",
    });

  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    const errText = new TextDecoder().decode(stderr);
    throw new Error(
      `Command failed on '${host}' (exit ${code}): ${errText.trim()}`,
    );
  }
  return new TextDecoder().decode(stdout).trim();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Classify a usage percentage against warn/critical thresholds. */
function classify(
  pct: number,
  warn: number,
  crit: number,
): z.infer<typeof StatusSchema> {
  if (pct >= crit) return "critical";
  if (pct >= warn) return "warning";
  return "ok";
}

/** Inspect a single mount point and return a MountStatus object. */
async function inspectMount(
  host: string,
  mount: string,
  warnPct: number,
  critPct: number,
): Promise<z.infer<typeof MountStatusSchema>> {
  // df -Pm gives Posix output in MiB blocks
  const raw = await exec(
    host,
    `df -Pm "${mount}" | awk 'NR==2 {print $1, $2, $3, $4, $5}'`,
  );
  const parts = raw.split(/\s+/);
  const device = parts[0] ?? "unknown";
  const sizeMb = parseInt(parts[1] ?? "0", 10);
  const usedMb = parseInt(parts[2] ?? "0", 10);
  const availMb = parseInt(parts[3] ?? "0", 10);
  const usePercent = parseInt((parts[4] ?? "0").replace("%", ""), 10);

  return {
    mount,
    device,
    sizeMb,
    usedMb,
    availMb,
    usePercent,
    status: classify(usePercent, warnPct, critPct),
    timestamp: new Date().toISOString(),
  };
}

/** Inventory a single backup snapshot directory. */
async function inventoryBackup(
  host: string,
  path: string,
  keepTarget: number,
): Promise<z.infer<typeof BackupInventorySchema>> {
  // List only timestamp-style subdirectories (start with 20)
  let listing = "";
  try {
    listing = await exec(
      host,
      `find "${path}" -maxdepth 1 -type d -name '20*' | sort`,
    );
  } catch {
    listing = "";
  }

  const snapshots = listing
    ? listing.split("\n").map((l) => l.split("/").pop() ?? "").filter(Boolean)
    : [];

  const snapshotCount = snapshots.length;
  const oldestSnapshot = snapshots[0] ?? "";
  const newestSnapshot = snapshots[snapshotCount - 1] ?? "";
  const compliant = keepTarget === 0 || snapshotCount <= keepTarget;

  return {
    path,
    snapshotCount,
    oldestSnapshot,
    newestSnapshot,
    keepTarget,
    compliant,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Context type
// ---------------------------------------------------------------------------

type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<unknown>;
};

// ---------------------------------------------------------------------------
// Model export
// ---------------------------------------------------------------------------

/**
 * `@mgreten/storage-health` — disk usage and backup inventory monitoring.
 *
 * Produces typed, versioned artifacts for each scanned mount point and backup
 * directory. Designed for daily cron or on-demand checks. Does not delete or
 * modify any files; observation only.
 */
export const model = {
  type: "@mgreten/storage-health",
  version: "2026.07.16.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    mountStatus: {
      description:
        "Usage snapshot for a single mount point at a point in time.",
      schema: MountStatusSchema,
      lifetime: "24h",
      garbageCollection: 100,
    },
    backupInventory: {
      description:
        "Snapshot count and retention compliance for a backup directory.",
      schema: BackupInventorySchema,
      lifetime: "24h",
      garbageCollection: 50,
    },
    storageReport: {
      description:
        "Aggregate host-level storage health report with overall status " +
        "and recommendations.",
      schema: StorageReportSchema,
      lifetime: "24h",
      garbageCollection: 30,
    },
    mountList: {
      description: "Enumeration of all filesystems on the target host.",
      schema: MountListSchema,
      lifetime: "1h",
      garbageCollection: 10,
    },
  },
  methods: {
    /**
     * Scan configured mount points and backup directories.
     *
     * Runs `df` on each mount and enumerates snapshot subdirectories in each
     * configured backup path. Writes one `mountStatus` resource per mount,
     * one `backupInventory` resource per backup path, and one `storageReport`
     * aggregating everything with an overall status and recommendations.
     *
     * Output resources: `mountStatus`, `backupInventory`, `storageReport`
     */
    scan: {
      description:
        "Inspect configured mount points and backup directories on the " +
        "target host. Writes mountStatus, backupInventory, and storageReport " +
        "resources.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const {
          sshHost,
          mounts,
          warnPercent,
          criticalPercent,
          backupPaths,
          backupKeepTarget,
        } = context.globalArgs;

        const mountList = mounts
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean);
        const backupList = backupPaths
          ? backupPaths
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean)
          : [];

        context.logger.info(
          "Scanning {mountCount} mount(s) and {backupCount} backup path(s) on {host}",
          {
            mountCount: mountList.length,
            backupCount: backupList.length,
            host: sshHost,
          },
        );

        const handles: unknown[] = [];
        const mountStatuses: z.infer<typeof MountStatusSchema>[] = [];
        const backupInventories: z.infer<typeof BackupInventorySchema>[] = [];
        const recommendations: string[] = [];

        // Inspect each mount
        for (const mount of mountList) {
          context.logger.info("Inspecting mount {mount}", { mount });
          const status = await inspectMount(
            sshHost,
            mount,
            warnPercent,
            criticalPercent,
          );
          mountStatuses.push(status);

          const handle = await context.writeResource(
            "mountStatus",
            `mountStatus-${sshHost}-${mount.replace(/\//g, "_") || "root"}`,
            status,
          );
          handles.push(handle);

          if (status.status === "critical") {
            recommendations.push(
              `CRITICAL: ${mount} is ${status.usePercent}% full ` +
                `(${(status.availMb / 1024).toFixed(1)} GiB free). ` +
                `Immediate action required.`,
            );
          } else if (status.status === "warning") {
            recommendations.push(
              `WARNING: ${mount} is ${status.usePercent}% full ` +
                `(${(status.availMb / 1024).toFixed(1)} GiB free). ` +
                `Review retention policies.`,
            );
          }
        }

        // Inventory each backup path
        for (const path of backupList) {
          context.logger.info("Inventorying backup path {path}", { path });
          const inventory = await inventoryBackup(
            sshHost,
            path,
            backupKeepTarget,
          );
          backupInventories.push(inventory);

          const handle = await context.writeResource(
            "backupInventory",
            `backupInventory-${sshHost}-${path.replace(/\//g, "_")}`,
            inventory,
          );
          handles.push(handle);

          if (!inventory.compliant) {
            recommendations.push(
              `Backup path ${path} has ${inventory.snapshotCount} snapshots ` +
                `(target: ${inventory.keepTarget}). ` +
                `Oldest: ${inventory.oldestSnapshot}. Consider pruning.`,
            );
          }
        }

        // Compute overall status
        const worstMount: z.infer<typeof StatusSchema> =
          mountStatuses.some((m) => m.status === "critical")
            ? "critical"
            : mountStatuses.some((m) => m.status === "warning")
            ? "warning"
            : "ok";

        const hasNonCompliantBackups = backupInventories.some(
          (b) => !b.compliant,
        );
        const overallStatus: z.infer<typeof StatusSchema> =
          worstMount === "critical"
            ? "critical"
            : worstMount === "warning" || hasNonCompliantBackups
            ? "warning"
            : "ok";

        if (recommendations.length === 0) {
          recommendations.push(
            "All monitored mounts and backup paths are within healthy limits.",
          );
        }

        const report: z.infer<typeof StorageReportSchema> = {
          host: sshHost,
          overallStatus,
          mounts: mountStatuses,
          backups: backupInventories,
          recommendations,
          timestamp: new Date().toISOString(),
        };

        const reportHandle = await context.writeResource(
          "storageReport",
          `storageReport-${sshHost}`,
          report,
        );
        handles.push(reportHandle);

        context.logger.info(
          "Scan complete — overall status: {status}",
          { status: overallStatus },
        );

        return { dataHandles: handles };
      },
    },

    /**
     * List all filesystems on the target host.
     *
     * Runs `df -Pm` on the host and returns a summary of every mounted
     * filesystem. Useful for discovering which mounts to pass to `scan`.
     *
     * Output resource: `mountList`
     */
    listMounts: {
      description: "Enumerate all filesystems on the target host using df. " +
        "Use this to discover mount paths before configuring a scan.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const { sshHost } = context.globalArgs;

        context.logger.info("Listing mounts on {host}", { host: sshHost });

        const raw = await exec(
          sshHost,
          `df -Pm --output=source,target,fstype,size,used,pcent | tail -n +2`,
        );

        const mountEntries = raw.split("\n").filter(Boolean).map((line) => {
          const parts = line.trim().split(/\s+/);
          return {
            device: parts[0] ?? "",
            mount: parts[1] ?? "",
            fstype: parts[2] ?? "",
            sizeMb: parseInt(parts[3] ?? "0", 10),
            usedMb: parseInt(parts[4] ?? "0", 10),
            usePercent: parseInt((parts[5] ?? "0").replace("%", ""), 10),
          };
        });

        const handle = await context.writeResource(
          "mountList",
          `mountList-${sshHost}`,
          {
            host: sshHost,
            mounts: mountEntries,
            timestamp: new Date().toISOString(),
          },
        );

        context.logger.info("Found {count} filesystem(s)", {
          count: mountEntries.length,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
