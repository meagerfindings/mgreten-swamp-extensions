/**
 * Git worktree health checker that parses `git worktree list --porcelain`,
 * validates worktree paths exist on disk, detects stale or locked entries,
 * and optionally prunes them. Works with any git repository that uses
 * worktrees — no project-specific assumptions.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Global configuration for the git-worktree-doctor model. */
const GlobalArgsSchema: z.ZodObject<{
  repoPath: z.ZodDefault<z.ZodString>;
}> = z.object({
  repoPath: z.string().default(".").describe(
    "Path to the git repository (main worktree or any linked worktree)",
  ),
});

/** Schema for a single worktree entry parsed from porcelain output. */
const WorktreeEntrySchema: z.ZodObject<{
  path: z.ZodString;
  head: z.ZodString;
  branch: z.ZodOptional<z.ZodString>;
  isDetached: z.ZodBoolean;
  isBare: z.ZodBoolean;
  isLocked: z.ZodBoolean;
  lockReason: z.ZodOptional<z.ZodString>;
  isPrunable: z.ZodBoolean;
  pruneReason: z.ZodOptional<z.ZodString>;
  pathExists: z.ZodBoolean;
  isMain: z.ZodBoolean;
}> = z.object({
  path: z.string(),
  head: z.string(),
  branch: z.string().optional(),
  isDetached: z.boolean(),
  isBare: z.boolean(),
  isLocked: z.boolean(),
  lockReason: z.string().optional(),
  isPrunable: z.boolean(),
  pruneReason: z.string().optional(),
  pathExists: z.boolean(),
  isMain: z.boolean(),
});

/** Schema for the diagnose method output. */
const DiagnosisSchema: z.ZodObject<{
  repoPath: z.ZodString;
  totalWorktrees: z.ZodNumber;
  healthy: z.ZodNumber;
  stale: z.ZodNumber;
  locked: z.ZodNumber;
  prunable: z.ZodNumber;
  detached: z.ZodNumber;
  worktrees: z.ZodArray<typeof WorktreeEntrySchema>;
  overallHealthy: z.ZodBoolean;
  diagnosedAt: z.ZodString;
}> = z.object({
  repoPath: z.string(),
  totalWorktrees: z.number(),
  healthy: z.number(),
  stale: z.number(),
  locked: z.number(),
  prunable: z.number(),
  detached: z.number(),
  worktrees: z.array(WorktreeEntrySchema),
  overallHealthy: z.boolean(),
  diagnosedAt: z.string(),
});

/** Schema for the prune method output. */
const PruneResultSchema: z.ZodObject<{
  repoPath: z.ZodString;
  dryRun: z.ZodBoolean;
  prunedCount: z.ZodNumber;
  prunedPaths: z.ZodArray<z.ZodString>;
  stdout: z.ZodString;
  stderr: z.ZodString;
  exitCode: z.ZodNumber;
  success: z.ZodBoolean;
  prunedAt: z.ZodString;
}> = z.object({
  repoPath: z.string(),
  dryRun: z.boolean(),
  prunedCount: z.number(),
  prunedPaths: z.array(z.string()),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  success: z.boolean(),
  prunedAt: z.string(),
});

/** Method execution context provided by swamp. */
type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

/** Result of running a shell command. */
interface CmdResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run a shell command and return stdout, stderr, and exit code. */
async function runCmd(cmd: string[], cwd?: string): Promise<CmdResult> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
    cwd,
  });
  const output = await command.output();
  return {
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    code: output.code,
  };
}

/** Resolve a repo path to an absolute path. */
async function resolveRepoPath(repoPath: string): Promise<string> {
  if (repoPath === ".") return Deno.cwd();
  const result = await runCmd(["realpath", repoPath]);
  if (result.code !== 0) throw new Error(`Cannot resolve path: ${repoPath}`);
  return result.stdout.trim();
}

/** Check whether a filesystem path exists. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Parse one worktree block from porcelain output into a structured entry. */
function parseWorktreeBlock(
  block: string,
  isFirst: boolean,
): z.infer<typeof WorktreeEntrySchema> | null {
  const lines = block.trim().split("\n");
  if (lines.length === 0) return null;

  const entry: Record<string, unknown> = {
    isDetached: false,
    isBare: false,
    isLocked: false,
    isPrunable: false,
    isMain: isFirst,
    pathExists: false,
  };

  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      entry.path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      entry.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      entry.branch = line.slice("branch ".length);
    } else if (line === "detached") {
      entry.isDetached = true;
    } else if (line === "bare") {
      entry.isBare = true;
    } else if (line.startsWith("locked")) {
      entry.isLocked = true;
      const reason = line.slice("locked".length).trim();
      if (reason) entry.lockReason = reason;
    } else if (line.startsWith("prunable")) {
      entry.isPrunable = true;
      const reason = line.slice("prunable".length).trim();
      if (reason) entry.pruneReason = reason;
    }
  }

  if (!entry.path || !entry.head) return null;
  return entry as unknown as z.infer<typeof WorktreeEntrySchema>;
}

/** The git-worktree-doctor swamp model definition. */
export const model = {
  type: "@mgreten/git-worktree-doctor",
  version: "2026.07.16.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    diagnosis: {
      description:
        "Structured health report of all git worktrees in a repository",
      schema: DiagnosisSchema,
      lifetime: "7d" as const,
      garbageCollection: 50,
    },
    pruneResult: {
      description: "Result of a git worktree prune operation",
      schema: PruneResultSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    diagnose: {
      description:
        "Parse `git worktree list --porcelain`, validate paths, and report health of all worktrees",
      arguments: z.object({
        repoPath: z.string().optional().describe(
          "Override the global repoPath for this invocation",
        ),
      }),
      execute: async (
        args: { repoPath?: string },
        context: MethodContext,
      ): Promise<{ dataHandles: Record<string, unknown>[] }> => {
        const rawPath = args.repoPath || context.globalArgs.repoPath;
        const repoPath = await resolveRepoPath(rawPath);

        context.logger.info("Diagnosing worktrees in {path}", {
          path: repoPath,
        });

        const result = await runCmd(
          ["git", "worktree", "list", "--porcelain"],
          repoPath,
        );
        if (result.code !== 0) {
          throw new Error(
            `git worktree list failed (exit ${result.code}): ${
              result.stderr.slice(0, 500)
            }`,
          );
        }

        const blocks = result.stdout.split("\n\n").filter((b) =>
          b.trim().length > 0
        );
        const worktrees: z.infer<typeof WorktreeEntrySchema>[] = [];

        for (let i = 0; i < blocks.length; i++) {
          const entry = parseWorktreeBlock(blocks[i], i === 0);
          if (!entry) continue;
          entry.pathExists = await pathExists(entry.path);
          worktrees.push(entry);
        }

        const stale = worktrees.filter((w) => !w.pathExists && !w.isMain);
        const locked = worktrees.filter((w) => w.isLocked);
        const prunable = worktrees.filter((w) => w.isPrunable);
        const detached = worktrees.filter((w) => w.isDetached && !w.isMain);
        const healthy = worktrees.filter((w) =>
          w.pathExists && !w.isLocked && !w.isPrunable
        );

        const diagnosis = {
          repoPath,
          totalWorktrees: worktrees.length,
          healthy: healthy.length,
          stale: stale.length,
          locked: locked.length,
          prunable: prunable.length,
          detached: detached.length,
          worktrees,
          overallHealthy: stale.length === 0 && prunable.length === 0,
          diagnosedAt: new Date().toISOString(),
        };

        if (stale.length > 0) {
          context.logger.warning("{count} stale worktrees (path missing)", {
            count: stale.length,
          });
        }
        if (prunable.length > 0) {
          context.logger.warning("{count} prunable worktrees", {
            count: prunable.length,
          });
        }
        if (locked.length > 0) {
          context.logger.info("{count} locked worktrees", {
            count: locked.length,
          });
        }

        context.logger.info(
          "Diagnosis complete: {total} worktrees, {healthy} healthy, {stale} stale",
          {
            total: worktrees.length,
            healthy: healthy.length,
            stale: stale.length,
          },
        );

        const handle = await context.writeResource(
          "diagnosis",
          `diagnosis-${Date.now()}`,
          diagnosis as unknown as Record<string, unknown>,
        );

        return { dataHandles: [handle] };
      },
    },

    prune: {
      description:
        "Run `git worktree prune` to remove stale worktree entries. Use dryRun=true to preview without removing.",
      arguments: z.object({
        dryRun: z.boolean().default(true).describe(
          "Preview what would be pruned without actually removing (default: true)",
        ),
        repoPath: z.string().optional().describe(
          "Override the global repoPath for this invocation",
        ),
        verbose: z.boolean().default(false).describe(
          "Pass --verbose to git worktree prune",
        ),
      }),
      execute: async (
        args: { dryRun?: boolean; repoPath?: string; verbose?: boolean },
        context: MethodContext,
      ): Promise<{ dataHandles: Record<string, unknown>[] }> => {
        const rawPath = args.repoPath || context.globalArgs.repoPath;
        const repoPath = await resolveRepoPath(rawPath);
        const dryRun = args.dryRun ?? true;
        const verbose = args.verbose ?? false;

        const cmd = ["git", "worktree", "prune"];
        if (dryRun) cmd.push("--dry-run");
        if (verbose) cmd.push("--verbose");

        context.logger.info("{mode} worktree prune in {path}", {
          mode: dryRun ? "Dry-run" : "Live",
          path: repoPath,
        });

        const result = await runCmd(cmd, repoPath);
        const combinedOutput = `${result.stdout}\n${result.stderr}`.trim();
        const prunedPaths = combinedOutput
          .split("\n")
          .filter((line) => line.includes("Removing"))
          .map((line) => {
            const match = line.match(/Removing\s+worktrees\/([^:]+)/);
            return match ? match[1] : line;
          });

        const pruneResult = {
          repoPath,
          dryRun,
          prunedCount: prunedPaths.length,
          prunedPaths,
          stdout: result.stdout.slice(0, 2000),
          stderr: result.stderr.slice(0, 2000),
          exitCode: result.code,
          success: result.code === 0,
          prunedAt: new Date().toISOString(),
        };

        if (prunedPaths.length > 0) {
          context.logger.info("{mode} {count} worktree entries", {
            mode: dryRun ? "Would prune" : "Pruned",
            count: prunedPaths.length,
          });
        } else {
          context.logger.info("No worktrees to prune");
        }

        const handle = await context.writeResource(
          "pruneResult",
          `prune-${Date.now()}`,
          pruneResult as unknown as Record<string, unknown>,
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
