/**
 * Tests for docker-orphan-sweep. The model calls `docker` and `git` through
 * Deno.Command with no injection seam, so each test swaps Deno.Command for a
 * fake returning synthetic output and restores it in a finally block. No real
 * docker or git command is run. repoPath points at a nonexistent synthetic
 * path so Deno.realPath falls back to the raw value.
 */

import { assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1";
import { model } from "./docker_orphan_sweep.ts";

type FakeOutput = { success: boolean; stdout?: string; stderr?: string };
type Call = { argv: string[]; cwd?: string };
type Write = { spec: string; name: string; data: Record<string, unknown> };
type Responder = (argv: string[]) => FakeOutput;

const encoder = new TextEncoder();
const REPO = "/nonexistent-test-root/repos/main";

async function withFakeCommands<T>(
  respond: Responder,
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

function makeContext(globalArgs: Record<string, unknown>) {
  const writes: Write[] = [];
  const noop = () => {};
  const context = {
    globalArgs: model.globalArguments.parse(globalArgs),
    logger: { info: noop, warning: noop, error: noop },
    writeResource: (spec: string, name: string, data: Record<string, unknown>) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ name });
    },
    modelType: model.type,
    modelId: "test-model-id",
    dataRepository: {
      findAllForModel: () => Promise.resolve([]),
      getContent: () => Promise.resolve(null),
    },
  };
  return { context, writes };
}

const PORCELAIN = [
  `worktree ${REPO}`,
  "HEAD 1111111111111111111111111111111111111111",
  "branch refs/heads/main",
  "",
  "worktree /nonexistent-test-root/repos/feature-live",
  "HEAD 2222222222222222222222222222222222222222",
  "branch refs/heads/feature-live",
  "",
  "worktree /nonexistent-test-root/repos/bare-store",
  "bare",
  "",
].join("\n");

// Containers: feature_live is backed by a live worktree; old_branch has two
// services and no worktree; bare_store maps to a bare entry, which is ignored.
const CONTAINERS = [
  "feature_live-web-1",
  "feature_live-db-1",
  "old_branch-web-1",
  "old_branch-worker-2",
  "bare_store-web-1",
].join("\n");

function standardResponder(rmFailures: Record<string, string> = {}): Responder {
  return (argv) => {
    const key = argv.slice(0, 2).join(" ");
    if (key === "docker ps") return { success: true, stdout: CONTAINERS + "\n" };
    if (key === "git worktree") return { success: true, stdout: PORCELAIN };
    if (key === "docker rm") {
      const name = argv[3];
      return name in rmFailures
        ? { success: false, stderr: rmFailures[name] }
        : { success: true, stdout: name };
    }
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };
}

Deno.test("global args default repoPath to '.' and sweep defaults to dryRun", () => {
  assertEquals(model.globalArguments.parse({}), { repoPath: "." });
  assertEquals(model.methods.sweep.arguments.parse({}), { dryRun: true });
  assertEquals(model.methods.sweep.arguments.safeParse({ dryRun: "no" }).success, false);
});

Deno.test("scan reports only containers whose worktree is missing or bare", async () => {
  await withFakeCommands(standardResponder(), async (calls) => {
    const { context, writes } = makeContext({ repoPath: REPO });
    const result = await model.methods.scan.execute({}, context);

    assertEquals(calls, [
      { argv: ["docker", "ps", "-a", "--format", "{{.Names}}"], cwd: undefined },
      { argv: ["git", "worktree", "list", "--porcelain"], cwd: REPO },
    ]);
    assertEquals(writes.length, 1);
    assertEquals(writes[0].spec, "orphanScan");
    assertMatch(writes[0].name, /^scan-\d+$/);
    assertEquals(result.dataHandles, [{ name: writes[0].name }]);

    const data = writes[0].data;
    assertEquals(data.composeProjectsFound, 3);
    assertEquals(data.worktreesFound, 2); // bare entry excluded
    assertEquals(data.orphanCount, 3);
    assertEquals(data.orphans, [
      {
        containerName: "old_branch-web-1",
        composeProject: "old_branch",
        expectedPath: "/nonexistent-test-root/repos/old-branch",
        exists: false,
      },
      {
        containerName: "old_branch-worker-2",
        composeProject: "old_branch",
        expectedPath: "/nonexistent-test-root/repos/old-branch",
        exists: false,
      },
      {
        containerName: "bare_store-web-1",
        composeProject: "bare_store",
        expectedPath: "/nonexistent-test-root/repos/bare-store",
        exists: false,
      },
    ]);
    assertEquals(model.resources.orphanScan.schema.safeParse(data).success, true);
  });
});

Deno.test("containerPrefix adds an anchored docker name filter", async () => {
  await withFakeCommands(standardResponder(), async (calls) => {
    const { context } = makeContext({ repoPath: REPO, containerPrefix: "old_" });
    await model.methods.scan.execute({}, context);
    assertEquals(calls[0].argv, [
      "docker",
      "ps",
      "-a",
      "--format",
      "{{.Names}}",
      "--filter",
      "name=^old_",
    ]);
  });
});

Deno.test("git failure yields zero worktrees so every project is an orphan", async () => {
  const respond: Responder = (argv) =>
    argv[0] === "docker"
      ? { success: true, stdout: "feature_live-web-1" }
      : { success: false, stderr: "fatal: not a git repository" };
  await withFakeCommands(respond, async () => {
    const { context, writes } = makeContext({ repoPath: REPO });
    await model.methods.scan.execute({}, context);
    assertEquals(writes[0].data.worktreesFound, 0);
    assertEquals(writes[0].data.orphanCount, 1);
  });
});

Deno.test("docker ps failure throws and writes nothing", async () => {
  const respond: Responder = () => ({ success: false, stderr: "daemon not running" });
  await withFakeCommands(respond, async () => {
    const { context, writes } = makeContext({ repoPath: REPO });
    await assertRejects(
      () => model.methods.scan.execute({}, context),
      Error,
      "docker ps failed: daemon not running",
    );
    assertEquals(writes.length, 0);
  });
});

Deno.test("sweep dry run lists orphans without calling docker rm", async () => {
  await withFakeCommands(standardResponder(), async (calls) => {
    const { context, writes } = makeContext({ repoPath: REPO });
    await model.methods.sweep.execute({ dryRun: true }, context);
    assertEquals(calls.some((c) => c.argv[1] === "rm"), false);
    const data = writes[0].data;
    assertEquals(writes[0].spec, "sweepResult");
    assertEquals(data.dryRun, true);
    assertEquals([data.orphanCount, data.removedCount, data.errorCount], [3, 0, 0]);
    assertEquals(
      (data.details as Array<Record<string, unknown>>).map((d) => [d.containerName, d.removed]),
      [["old_branch-web-1", false], ["old_branch-worker-2", false], ["bare_store-web-1", false]],
    );
  });
});

Deno.test("live sweep removes only orphans and records per-container failures", async () => {
  const responder = standardResponder({ "old_branch-worker-2": "Error: permission denied" });
  await withFakeCommands(responder, async (calls) => {
    const { context, writes } = makeContext({ repoPath: REPO });
    await model.methods.sweep.execute({ dryRun: false }, context);

    assertEquals(
      calls.filter((c) => c.argv[1] === "rm").map((c) => c.argv),
      [
        ["docker", "rm", "-f", "old_branch-web-1"],
        ["docker", "rm", "-f", "old_branch-worker-2"],
        ["docker", "rm", "-f", "bare_store-web-1"],
      ],
    );
    const data = writes[0].data;
    assertEquals(data.dryRun, false);
    assertEquals([data.orphanCount, data.removedCount, data.errorCount], [3, 2, 1]);
    assertEquals(data.details, [
      { containerName: "old_branch-web-1", composeProject: "old_branch", removed: true },
      {
        containerName: "old_branch-worker-2",
        composeProject: "old_branch",
        removed: false,
        removeError: "Error: permission denied",
      },
      { containerName: "bare_store-web-1", composeProject: "bare_store", removed: true },
    ]);
    assertEquals(model.resources.sweepResult.schema.safeParse(data).success, true);
  });
});
