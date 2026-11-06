/**
 * Tests for git-worktree-doctor.
 *
 * Porcelain parsing and classification are tested by swapping Deno.Command
 * for a fake that returns synthetic `git worktree list --porcelain` output
 * (restored in a finally block); worktree directories live in a temp dir so
 * the real Deno.stat path check is exercised. One end-to-end test runs real
 * git against a throwaway repository created with `git init` in a temp dir,
 * with global/system git config disabled.
 */

import { assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1";
import { model } from "./git_worktree_doctor.ts";

type FakeOutput = { code: number; stdout?: string; stderr?: string };
type Call = { argv: string[]; cwd?: string };
type Write = { spec: string; name: string; data: Record<string, unknown> };
type Log = { level: string; msg: string; props?: Record<string, unknown> };
type Entry = Record<string, unknown>;

const encoder = new TextEncoder();

async function withFakeCommands<T>(
  respond: (argv: string[]) => FakeOutput,
  fn: (calls: Call[]) => Promise<T>,
): Promise<T> {
  const calls: Call[] = [];
  const original = Deno.Command;
  class FakeCommand {
    #argv: string[];
    constructor(cmd: string, opts?: { args?: string[]; cwd?: string }) {
      this.#argv = [cmd, ...(opts?.args ?? [])];
      calls.push({ argv: this.#argv, cwd: opts?.cwd });
    }
    output() {
      const res = respond(this.#argv);
      return Promise.resolve({
        success: res.code === 0,
        code: res.code,
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
  const log = (level: string) => (msg: string, props?: Record<string, unknown>) =>
    logs.push({ level, msg, props });
  const context = {
    globalArgs: model.globalArguments.parse(globalArgs),
    logger: { info: log("info"), warning: log("warning"), error: log("error") },
    writeResource: (spec: string, name: string, data: Record<string, unknown>) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  };
  return { context, writes, logs };
}

/** Fake responder: `realpath X` echoes X; `git worktree list` returns porcelain. */
function gitResponder(porcelain: string, prune?: FakeOutput) {
  return (argv: string[]): FakeOutput => {
    if (argv[0] === "realpath") return { code: 0, stdout: argv[1] + "\n" };
    if (argv.slice(0, 3).join(" ") === "git worktree list") {
      return { code: 0, stdout: porcelain };
    }
    if (argv.slice(0, 3).join(" ") === "git worktree prune" && prune) return prune;
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };
}

async function withTempDirs<T>(
  existing: string[],
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "wt-doctor-test-" });
  try {
    for (const d of existing) await Deno.mkdir(`${root}/${d}`);
    return await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("argument schemas default repoPath, dryRun and verbose", () => {
  assertEquals(model.globalArguments.parse({}), { repoPath: "." });
  assertEquals(model.methods.prune.arguments.parse({}), { dryRun: true, verbose: false });
  assertEquals(model.methods.prune.arguments.safeParse({ dryRun: "yes" }).success, false);
  assertEquals(model.methods.diagnose.arguments.safeParse({ repoPath: 7 }).success, false);
});

Deno.test("diagnose parses porcelain and classifies stale, locked, prunable and detached", async () => {
  await withTempDirs(["main", "wt-ok", "wt-locked"], async (root) => {
    const porcelain = [
      `worktree ${root}/main`,
      "HEAD aaaa",
      "branch refs/heads/main",
      "",
      `worktree ${root}/wt-ok`,
      "HEAD bbbb",
      "branch refs/heads/feature-ok",
      "",
      `worktree ${root}/wt-locked`,
      "HEAD cccc",
      "branch refs/heads/feature-locked",
      "locked under review",
      "",
      `worktree ${root}/wt-gone`,
      "HEAD dddd",
      "detached",
      "",
      `worktree ${root}/wt-prunable`,
      "HEAD eeee",
      "branch refs/heads/feature-p",
      "prunable gitdir file points to non-existent location",
      "",
      `worktree ${root}/no-head`,
      "branch refs/heads/broken",
      "",
    ].join("\n");

    await withFakeCommands(gitResponder(porcelain), async (calls) => {
      const { context, writes, logs } = makeContext();
      const result = await model.methods.diagnose.execute(
        { repoPath: `${root}/main` },
        context,
      );
      assertEquals(calls, [
        { argv: ["realpath", `${root}/main`], cwd: undefined },
        { argv: ["git", "worktree", "list", "--porcelain"], cwd: `${root}/main` },
      ]);
      assertEquals(writes.length, 1);
      assertEquals(writes[0].spec, "diagnosis");
      assertMatch(writes[0].name, /^diagnosis-\d+$/);
      assertEquals(result.dataHandles, [{ name: writes[0].name }]);

      const d = writes[0].data;
      assertEquals(d.repoPath, `${root}/main`);
      assertEquals(
        [d.totalWorktrees, d.healthy, d.stale, d.locked, d.prunable, d.detached],
        [5, 2, 2, 1, 1, 1],
      );
      assertEquals(d.overallHealthy, false);

      const wts = d.worktrees as Entry[];
      assertEquals(wts[0], {
        path: `${root}/main`,
        head: "aaaa",
        branch: "refs/heads/main",
        isDetached: false,
        isBare: false,
        isLocked: false,
        isPrunable: false,
        isMain: true,
        pathExists: true,
      });
      assertEquals(wts[2].lockReason, "under review");
      assertEquals(wts[2].isLocked, true);
      assertEquals(wts[2].pathExists, true);
      assertEquals(wts[3].isDetached, true);
      assertEquals(wts[3].branch, undefined);
      assertEquals(wts[3].pathExists, false);
      assertEquals(wts[4].pruneReason, "gitdir file points to non-existent location");
      assertEquals(wts.filter((w) => w.isMain).length, 1);
      assertEquals(model.resources.diagnosis.schema.safeParse(d).success, true);

      const warnings = logs.filter((l) => l.level === "warning").map((l) => l.props);
      assertEquals(warnings, [{ count: 2 }, { count: 1 }]);
    });
  });
});

Deno.test("a missing main worktree is not stale and does not break overall health", async () => {
  await withTempDirs(["wt-ok"], async (root) => {
    const porcelain = [
      `worktree ${root}/main`,
      "HEAD aaaa",
      "detached",
      "",
      `worktree ${root}/wt-ok`,
      "HEAD bbbb",
      "branch refs/heads/feature-ok",
      "",
    ].join("\n");
    await withFakeCommands(gitResponder(porcelain), async () => {
      const { context, writes } = makeContext({ repoPath: `${root}/wt-ok` });
      await model.methods.diagnose.execute({}, context);
      const d = writes[0].data;
      // main is missing on disk but is excluded from stale; detached main is not counted
      assertEquals([d.totalWorktrees, d.healthy, d.stale, d.detached], [2, 1, 0, 0]);
      assertEquals(d.overallHealthy, true);
    });
  });
});

Deno.test("diagnose throws with exit code and stderr when git fails", async () => {
  const respond = (argv: string[]): FakeOutput =>
    argv[0] === "realpath"
      ? { code: 0, stdout: "/nonexistent-test-root\n" }
      : { code: 128, stderr: "fatal: not a git repository" };
  await withFakeCommands(respond, async () => {
    const { context, writes } = makeContext({ repoPath: "/nonexistent-test-root" });
    await assertRejects(
      () => model.methods.diagnose.execute({}, context),
      Error,
      "git worktree list failed (exit 128): fatal: not a git repository",
    );
    assertEquals(writes.length, 0);
  });
});

Deno.test("diagnose throws when realpath cannot resolve the repo path", async () => {
  await withFakeCommands(() => ({ code: 1, stderr: "No such file" }), async (calls) => {
    const { context } = makeContext();
    await assertRejects(
      () => model.methods.diagnose.execute({ repoPath: "/nonexistent-test-root/x" }, context),
      Error,
      "Cannot resolve path: /nonexistent-test-root/x",
    );
    assertEquals(calls.length, 1);
  });
});

Deno.test("prune builds flags from dryRun/verbose and extracts pruned worktree names", async () => {
  const pruneOut: FakeOutput = {
    code: 0,
    stderr: "Removing worktrees/wt-gone: gitdir file points to non-existent location\n" +
      "Removing worktrees/wt-two: gitdir file points to non-existent location\n",
  };
  const repo = "/nonexistent-test-root/repo";

  await withFakeCommands(gitResponder("", pruneOut), async (calls) => {
    const { context, writes, logs } = makeContext({ repoPath: repo });
    await model.methods.prune.execute({}, context);
    assertEquals(calls[1], {
      argv: ["git", "worktree", "prune", "--dry-run"],
      cwd: repo,
    });
    const d = writes[0].data;
    assertEquals(writes[0].spec, "pruneResult");
    assertEquals(d.dryRun, true);
    assertEquals(d.prunedPaths, ["wt-gone", "wt-two"]);
    assertEquals([d.prunedCount, d.exitCode, d.success], [2, 0, true]);
    assertEquals(logs.at(-1)?.props, { mode: "Would prune", count: 2 });
    assertEquals(model.resources.pruneResult.schema.safeParse(d).success, true);
  });

  await withFakeCommands(gitResponder("", { code: 0 }), async (calls) => {
    const { context, writes, logs } = makeContext({ repoPath: repo });
    await model.methods.prune.execute({ dryRun: false, verbose: true }, context);
    assertEquals(calls[1].argv, ["git", "worktree", "prune", "--verbose"]);
    assertEquals(writes[0].data.prunedCount, 0);
    assertEquals(writes[0].data.dryRun, false);
    assertEquals(logs.at(-1)?.msg, "No worktrees to prune");
  });

  await withFakeCommands(gitResponder("", { code: 1, stderr: "fatal: boom" }), async () => {
    const { context, writes } = makeContext({ repoPath: repo });
    await model.methods.prune.execute({ dryRun: false }, context);
    assertEquals([writes[0].data.exitCode, writes[0].data.success], [1, false]);
    assertEquals(writes[0].data.stderr, "fatal: boom");
  });
});

// ---------------------------------------------------------------------------
// End-to-end with real git in a throwaway repository
// ---------------------------------------------------------------------------

const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

async function git(cwd: string, ...args: string[]): Promise<void> {
  const out = await new Deno.Command("git", {
    args: [
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    cwd,
    env: GIT_ENV,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`);
  }
}

Deno.test("real git: deleted linked worktree is diagnosed stale and pruned", async () => {
  const saved = Object.fromEntries(Object.keys(GIT_ENV).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(GIT_ENV)) Deno.env.set(k, v);
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "wt-doctor-git-" }));
  try {
    const repo = `${root}/repo`;
    await Deno.mkdir(repo);
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    await git(repo, "worktree", "add", "-q", "-b", "feat-live", `${root}/wt-live`);
    await git(repo, "worktree", "add", "-q", "-b", "feat-gone", `${root}/wt-gone`);
    await Deno.remove(`${root}/wt-gone`, { recursive: true });

    const before = makeContext({ repoPath: repo });
    await model.methods.diagnose.execute({}, before.context);
    const d = before.writes[0].data;
    assertEquals(d.repoPath, repo);
    assertEquals([d.totalWorktrees, d.healthy, d.stale, d.prunable], [3, 2, 1, 1]);
    assertEquals(d.overallHealthy, false);
    const wts = d.worktrees as Entry[];
    // Main is always first; git's order for linked worktrees is unspecified.
    assertEquals([wts[0].path, wts[0].branch, wts[0].isMain], [repo, "refs/heads/main", true]);
    const linked = wts.slice(1).map((w) => [w.path, w.branch, w.isMain, w.pathExists]).sort();
    assertEquals(linked, [
      [`${root}/wt-gone`, "refs/heads/feat-gone", false, false],
      [`${root}/wt-live`, "refs/heads/feat-live", false, true],
    ]);

    const dry = makeContext({ repoPath: repo });
    await model.methods.prune.execute({ dryRun: true, verbose: true }, dry.context);
    assertEquals(dry.writes[0].data.prunedPaths, ["wt-gone"]);
    assertEquals(dry.writes[0].data.success, true);

    const live = makeContext({ repoPath: repo });
    await model.methods.prune.execute({ dryRun: false }, live.context);
    assertEquals(live.writes[0].data.success, true);

    const after = makeContext({ repoPath: repo });
    await model.methods.diagnose.execute({}, after.context);
    const a = after.writes[0].data;
    assertEquals([a.totalWorktrees, a.healthy, a.stale, a.prunable], [2, 2, 0, 0]);
    assertEquals(a.overallHealthy, true);
  } finally {
    await Deno.remove(root, { recursive: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});
