/**
 * @module @mgreten/docker-orphan-sweep
 *
 * Find and remove orphaned Docker Compose containers whose git worktree
 * directory no longer exists. Cross-references live compose projects against
 * git worktree paths. Works with any repository that uses git worktrees
 * alongside Docker Compose stacks.
 */

import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  repoPath: z.string().default(".")
    .describe("Path to the git repository that manages worktrees."),
  containerPrefix: z.string().optional()
    .describe(
      "Optional prefix filter for docker container names. " +
        "When set, only containers whose name starts with this prefix are considered. " +
        "When omitted, all compose containers are scanned.",
    ),
});

const OrphanEntrySchema = z.object({
  containerName: z.string().describe("Docker container name."),
  composeProject: z.string().describe("Derived compose project name."),
  expectedPath: z.string().describe("Expected worktree directory path."),
  exists: z.boolean().describe(
    "Whether the expected worktree directory exists.",
  ),
});

const OrphanScanSchema = z.object({
  scannedAt: z.string().describe("ISO-8601 timestamp of the scan."),
  composeProjectsFound: z.number().describe(
    "Total unique compose projects discovered.",
  ),
  worktreesFound: z.number().describe(
    "Total git worktrees found in the repository.",
  ),
  orphanCount: z.number().describe("Number of orphaned compose projects."),
  orphans: z.array(OrphanEntrySchema).describe(
    "Details for each orphaned container.",
  ),
  skippedContainers: z.array(z.string()).describe(
    "Containers left alone because their compose project could not be derived with certainty.",
  ),
});

const SweepDetailSchema = z.object({
  containerName: z.string().describe("Docker container name."),
  composeProject: z.string().describe("Derived compose project name."),
  removed: z.boolean().describe("Whether the container was removed."),
  removeError: z.string().optional().describe(
    "Error message if removal failed.",
  ),
});

const SweepResultSchema = z.object({
  sweptAt: z.string().describe("ISO-8601 timestamp of the sweep."),
  dryRun: z.boolean().describe(
    "Whether the sweep was a dry run (no destructive action).",
  ),
  orphanCount: z.number().describe("Total orphaned containers found."),
  removedCount: z.number().describe("Containers successfully removed."),
  errorCount: z.number().describe("Containers that failed removal."),
  details: z.array(SweepDetailSchema).describe("Per-container sweep details."),
  skippedContainers: z.array(z.string()).describe(
    "Containers left alone because their compose project could not be derived with certainty.",
  ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CmdResult = { success: boolean; stdout: string; stderr: string };

/** Run a command and capture its output. */
async function runCmd(
  cmd: string[],
  opts?: { cwd?: string },
): Promise<CmdResult> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
    cwd: opts?.cwd,
  });
  const output = await command.output();
  return {
    success: output.success,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr).trim(),
  };
}

type ParsedWorktree = { path: string; branch: string; bare: boolean };

/** Parse `git worktree list --porcelain` into structured entries. */
async function getWorktrees(repoPath: string): Promise<ParsedWorktree[]> {
  const result = await runCmd(
    ["git", "worktree", "list", "--porcelain"],
    { cwd: repoPath },
  );
  // Fail closed: with no worktree list every project would look orphaned.
  if (!result.success) {
    throw new Error(`git worktree list failed: ${result.stderr}`);
  }

  const worktrees: ParsedWorktree[] = [];
  let current: ParsedWorktree = { path: "", branch: "", bare: false };

  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) worktrees.push(current);
      current = { path: line.slice(9), branch: "", bare: false };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace("refs/heads/", "");
    } else if (line === "bare") {
      current.bare = true;
    }
  }
  if (current.path) worktrees.push(current);

  return worktrees.filter((w) => !w.bare);
}

/**
 * Resolve the absolute path for a repo, expanding "." to cwd and resolving
 * symlinks so that worktree path comparisons work correctly.
 */
async function resolveRepoPath(raw: string): Promise<string> {
  if (raw === ".") {
    return Deno.cwd();
  }
  try {
    return await Deno.realPath(raw);
  } catch {
    return raw;
  }
}

/**
 * List all Docker containers, optionally filtered by a name prefix.
 * Returns an array of container name strings.
 */
async function listContainers(prefix?: string): Promise<Container[]> {
  const args = [
    "docker",
    "ps",
    "-a",
    "--format",
    '{{.Names}}\t{{.Label "com.docker.compose.project"}}',
  ];
  if (prefix) {
    args.push("--filter", `name=^${prefix}`);
  }
  const result = await runCmd(args);
  if (!result.success) {
    throw new Error(`docker ps failed: ${result.stderr}`);
  }
  return result.stdout.split("\n").filter((l) => l.trim()).map((line) => {
    const [name, projectLabel = ""] = line.split("\t");
    return { name: name.trim(), projectLabel };
  });
}

/**
 * Derive a container's compose project from its `com.docker.compose.project`
 * label, never from the name alone: project names may contain hyphens, so
 * "feature-a-web-1" cannot be split reliably. Returns null (the caller skips
 * the container) unless the label is present and the name is the
 * `<project>-<service>-<n>` (or v1 `<project>_<service>_<n>`) name Compose
 * gives that project.
 */
export function deriveComposeProject(
  containerName: string,
  projectLabel: string,
): string | null {
  const project = projectLabel.trim();
  if (!project) return null;
  for (const sep of ["-", "_"]) {
    if (!containerName.startsWith(`${project}${sep}`)) continue;
    const rest = containerName.slice(project.length + 1);
    const service = new RegExp(`^[a-zA-Z0-9][a-zA-Z0-9_.-]*\\${sep}\\d+$`);
    if (service.test(rest)) return project;
  }
  return null;
}

type Container = { name: string; projectLabel: string };

/** Group containers by compose project; containers without a certain project are skipped. */
function groupByProject(containers: Container[]): {
  projects: Map<string, string[]>;
  skipped: string[];
} {
  const projects = new Map<string, string[]>();
  const skipped: string[] = [];
  for (const c of containers) {
    const project = deriveComposeProject(c.name, c.projectLabel);
    if (project === null) {
      skipped.push(c.name);
      continue;
    }
    projects.set(project, [...(projects.get(project) ?? []), c.name]);
  }
  return { projects, skipped };
}

/** A project is live if a worktree exists under its literal or slug name. */
function projectIsLive(
  project: string,
  parentDir: string,
  livePaths: Set<string>,
): boolean {
  return livePaths.has(`${parentDir}/${project}`) ||
    livePaths.has(`${parentDir}/${projectToWorktreeSlug(project)}`);
}

/**
 * Convert a compose project name to a candidate worktree directory name.
 * Docker Compose converts hyphens to underscores in project names, so we
 * reverse that: underscores become hyphens.
 */
function projectToWorktreeSlug(project: string): string {
  return project.replace(/_/g, "-");
}

// ---------------------------------------------------------------------------
// Method context type
// ---------------------------------------------------------------------------

type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
  readResource?: (name: string) => Promise<Record<string, unknown> | null>;
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  modelType: string;
  modelId: string;
  dataRepository: {
    findAllForModel: (
      type: string,
      modelId: string,
    ) => Promise<Array<{ name: string; tags: Record<string, string> }>>;
    getContent: (
      type: string,
      modelId: string,
      dataName: string,
    ) => Promise<Uint8Array | null>;
  };
};

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/**
 * Docker Orphan Sweep model.
 *
 * Discovers Docker Compose containers whose associated git worktree directory
 * no longer exists and optionally removes them. This is useful for cleaning up
 * after merged or deleted branches when using git worktrees with per-branch
 * Docker Compose stacks.
 *
 * ### Methods
 *
 * - **scan** — Cross-reference compose containers against git worktrees and
 *   report which ones are orphaned.
 * - **sweep** — Remove orphaned containers. Defaults to `dryRun: true` for
 *   safety.
 */
export const model = {
  type: "@mgreten/docker-orphan-sweep" as const,
  version: "2026.07.16.1" as const,
  globalArguments: GlobalArgsSchema,

  resources: {
    orphanScan: {
      description:
        "Scan result showing compose projects, worktrees, and orphan details.",
      schema: OrphanScanSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    sweepResult: {
      description:
        "Result of an orphan sweep including per-container removal status.",
      schema: SweepResultSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
  },

  methods: {
    scan: {
      description:
        "Discover all Docker Compose projects, cross-reference each against " +
        "git worktrees in the configured repo, and report which containers " +
        "are orphaned (their worktree directory is gone).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: Record<string, unknown>[] }> => {
        const repoPath = await resolveRepoPath(context.globalArgs.repoPath);
        const prefix = context.globalArgs.containerPrefix;

        // Gather containers and worktrees
        const containers = await listContainers(prefix);
        const worktrees = await getWorktrees(repoPath);

        // Build a set of live worktree paths for fast lookup
        const livePaths = new Set(worktrees.map((w) => w.path));

        // Derive the worktree parent directory (one level above the repo root)
        const parentDir = repoPath.split("/").slice(0, -1).join("/");

        // Deduplicate containers into compose projects
        const { projects: projectContainers, skipped } = groupByProject(
          containers,
        );
        if (skipped.length) {
          context.logger.warning(
            "Skipping {count} container(s) with no certain compose project: {names}",
            { count: skipped.length, names: skipped.join(", ") },
          );
        }

        // Cross-reference each project against live worktrees
        type OrphanEntry = z.infer<typeof OrphanEntrySchema>;
        const orphans: OrphanEntry[] = [];

        for (const [project, containerNames] of projectContainers.entries()) {
          const slug = projectToWorktreeSlug(project);
          const expectedPath = `${parentDir}/${slug}`;
          const exists = projectIsLive(project, parentDir, livePaths);

          if (!exists) {
            for (const containerName of containerNames) {
              orphans.push({
                containerName,
                composeProject: project,
                expectedPath,
                exists: false,
              });
            }
          }
        }

        const scanData: z.infer<typeof OrphanScanSchema> = {
          scannedAt: new Date().toISOString(),
          composeProjectsFound: projectContainers.size,
          worktreesFound: worktrees.length,
          orphanCount: orphans.length,
          orphans,
          skippedContainers: skipped,
        };

        const handle = await context.writeResource(
          "orphanScan",
          `scan-${Date.now()}`,
          scanData,
        );

        context.logger.info(
          "Scan complete: projects={projects} worktrees={worktrees} orphans={orphans}",
          {
            projects: projectContainers.size,
            worktrees: worktrees.length,
            orphans: orphans.length,
          },
        );

        return { dataHandles: [handle] };
      },
    },

    sweep: {
      description:
        "Remove orphaned Docker Compose containers whose git worktree " +
        "directory no longer exists. Defaults to dryRun: true for safety — " +
        "set dryRun: false to actually remove containers.",
      arguments: z.object({
        dryRun: z.boolean().default(true).describe(
          "When true (default), only reports what would be removed without " +
            "taking destructive action.",
        ),
      }),
      execute: async (
        args: { dryRun: boolean },
        context: MethodContext,
      ): Promise<{ dataHandles: Record<string, unknown>[] }> => {
        const repoPath = await resolveRepoPath(context.globalArgs.repoPath);
        const prefix = context.globalArgs.containerPrefix;
        const dryRun = args.dryRun;

        // Gather containers and worktrees
        const containers = await listContainers(prefix);
        const worktrees = await getWorktrees(repoPath);
        const livePaths = new Set(worktrees.map((w) => w.path));
        const parentDir = repoPath.split("/").slice(0, -1).join("/");

        // Deduplicate containers into compose projects
        const { projects: projectContainers, skipped } = groupByProject(
          containers,
        );
        if (skipped.length) {
          context.logger.warning(
            "Skipping {count} container(s) with no certain compose project: {names}",
            { count: skipped.length, names: skipped.join(", ") },
          );
        }

        // Find orphans and optionally remove them
        type Detail = z.infer<typeof SweepDetailSchema>;
        const details: Detail[] = [];

        for (const [project, containerNames] of projectContainers.entries()) {
          const exists = projectIsLive(project, parentDir, livePaths);

          if (!exists) {
            for (const containerName of containerNames) {
              const detail: Detail = {
                containerName,
                composeProject: project,
                removed: false,
              };

              if (!dryRun) {
                const rmResult = await runCmd([
                  "docker",
                  "rm",
                  "-f",
                  containerName,
                ]);
                detail.removed = rmResult.success;
                if (!rmResult.success) {
                  detail.removeError = rmResult.stderr;
                }
              }

              details.push(detail);
            }
          }
        }

        const removedCount = details.filter((d) => d.removed).length;
        const errorCount = details.filter(
          (d) => !d.removed && d.removeError !== undefined,
        ).length;

        const sweepData: z.infer<typeof SweepResultSchema> = {
          sweptAt: new Date().toISOString(),
          dryRun,
          orphanCount: details.length,
          removedCount,
          errorCount,
          details,
          skippedContainers: skipped,
        };

        const handle = await context.writeResource(
          "sweepResult",
          `sweep-${Date.now()}`,
          sweepData,
        );

        context.logger.info(
          "Sweep complete: orphans={orphans} removed={removed} errors={errors} dryRun={dryRun}",
          {
            orphans: details.length,
            removed: removedCount,
            errors: errorCount,
            dryRun,
          },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
