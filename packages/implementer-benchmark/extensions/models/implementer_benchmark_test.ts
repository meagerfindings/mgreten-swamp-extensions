// Tests for the standalone implementer benchmark extension.
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  allFixtures,
  getFixture,
  TASK_IDS,
} from "./implementer_benchmark_fixtures.ts";
import {
  aggregateSummary,
  buildTaskPacket,
  type CaseResult,
  classifyChangedPaths,
  classifyStatus,
  type CommandRequest,
  type CommandResult,
  denoCommandRunner,
  extractFirstJsonObject,
  model,
  parseFileResponse,
  runBenchmarkSuite,
  sha256,
  validateSuiteId,
  validateWorkspace,
} from "./implementer_benchmark.ts";

Deno.test("fixtures expose exactly the five validated task IDs", () => {
  assertEquals(TASK_IDS, [
    "task-01",
    "task-02",
    "task-03",
    "task-04",
    "task-05",
  ]);
  assertEquals(allFixtures().map((fixture) => fixture.id), [...TASK_IDS]);
  for (const id of TASK_IDS) {
    const fixture = getFixture(id);
    assert(fixture.prompt.length > 0);
    assert(Object.keys(fixture.files).includes("PROMPT.md"));
    assert(fixture.hiddenVerifier.includes("CANDIDATE_ROOT"));
  }
});

Deno.test("task packets are deterministic, bounded, and exclude hidden verification", async () => {
  for (const id of TASK_IDS) {
    const first = buildTaskPacket(id);
    const second = buildTaskPacket(id);
    assertEquals(first, second);
    assertEquals(await sha256(first), await sha256(second));
    assert(new TextEncoder().encode(first).length < 32 * 1024);
    assert(!first.includes("hiddenVerifier"));
    const packet = JSON.parse(first);
    assertEquals(packet.allowedPaths, [...getFixture(id).allowedPaths]);
    assert(!("PROMPT.md" in packet.files));
  }
});

Deno.test("file responses fail closed outside the packet contract", () => {
  assertEquals(
    parseFileResponse({ files: { "src/a.js": "content" } }, ["src/a.js"]),
    { "src/a.js": "content" },
  );
  for (
    const invalid of [
      null,
      {},
      { files: {} },
      { files: { "../secret": "x" } },
      { files: { "src/a.js": 1 } },
    ]
  ) {
    assertEquals(parseFileResponse(invalid, ["src/a.js"]), null);
  }
});

Deno.test("workspace and suite validation reject unsafe boundaries", () => {
  assertEquals(
    validateWorkspace("/tmp/bench", "/repo/project"),
    "/tmp/bench",
  );
  assertThrows(() => validateWorkspace("/repo/project/runs", "/repo/project"));
  assertThrows(() => validateWorkspace("relative", "/repo/project"));
  assertEquals(validateSuiteId("suite-01"), "suite-01");
  for (const unsafe of ["../suite", "Suite", "a/b", "-bad", "bad-"]) {
    assertThrows(() => validateSuiteId(unsafe));
  }
});

Deno.test("runSuite arguments reject duplicate task and candidate identities", () => {
  const argumentsSchema = model.methods.runSuite.arguments;
  assert(
    !argumentsSchema.safeParse({
      taskIds: ["task-01", "task-01"],
      candidates: [{ id: "one", provider: "claude", model: "haiku" }],
    }).success,
  );
  assert(
    !argumentsSchema.safeParse({
      taskIds: ["task-01"],
      candidates: [
        { id: "one", provider: "claude", model: "haiku" },
        { id: "one", provider: "opencode", model: "local" },
      ],
    }).success,
  );
});

Deno.test("extracts the first complete JSON object around noisy output", () => {
  assertEquals(
    extractFirstJsonObject(
      'noise {bad}\n{"dataArtifacts":[{"attributes":{"text":"} quoted"}}]} trailing',
    ),
    {
      dataArtifacts: [{ attributes: { text: "} quoted" } }],
    },
  );
  assertEquals(extractFirstJsonObject("no object"), null);
});

Deno.test("classifies changed path boundaries and status precedence", () => {
  assertEquals(
    classifyChangedPaths(["src/a.js", "../secret", "test/a.js", "src/a.js"], [
      "src/a.js",
    ]),
    {
      changedPaths: ["../secret", "src/a.js", "test/a.js"],
      disallowedPaths: ["../secret", "test/a.js"],
    },
  );
  const base = {
    timedOut: false,
    invocationSuccess: true,
    changedPaths: ["src/a.js"],
    disallowedPaths: [],
    visiblePassed: true,
    hiddenPassed: true,
  };
  assertEquals(classifyStatus(base), "pass");
  assertEquals(classifyStatus({ ...base, timedOut: true }), "timeout");
  assertEquals(
    classifyStatus({ ...base, invocationSuccess: false }),
    "invocation_error",
  );
  assertEquals(classifyStatus({ ...base, changedPaths: [] }), "no_change");
  assertEquals(
    classifyStatus({ ...base, disallowedPaths: ["test/a.js"] }),
    "scope_violation",
  );
  assertEquals(
    classifyStatus({ ...base, hiddenPassed: false }),
    "test_failure",
  );
  assertEquals(
    classifyStatus({ ...base, infrastructureError: true }),
    "infrastructure_error",
  );
});

Deno.test("aggregate summary totals statuses, timing, tokens, and cost", () => {
  const result = (
    status: CaseResult["status"],
    durationMs: number,
    total: number,
    costUsd: number,
  ): CaseResult => ({
    suiteId: "s",
    candidateId: status,
    effortLevel: "medium",
    taskId: "task-01",
    status,
    requiresIndependentReview: true,
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:00:01Z",
    durationMs,
    invocation: {
      invocationId: null,
      provider: "opencode",
      model: "local",
      success: status === "pass",
      timedOut: false,
      durationMs,
      tokens: { total },
      costUsd,
      failureReason: null,
    },
    packetHash: "hash",
    packetBytes: 10,
    outputBytes: 20,
    changedLines: 3,
    changedPaths: [],
    disallowedPaths: [],
    visibleTestsPassed: false,
    hiddenTestsPassed: false,
    evidenceRef: `e-${status}`,
    failureMessage: null,
  });
  const summary = aggregateSummary("s", [
    result("pass", 10, 20, 0.5),
    result("test_failure", 30, 40, 1.25),
  ], "done");
  assertEquals(summary.totalCases, 2);
  assertEquals(summary.counts.pass, 1);
  assertEquals(summary.counts.test_failure, 1);
  assertEquals(summary.totalDurationMs, 40);
  assertEquals(summary.totalTokens, 60);
  assertEquals(summary.totalReportedCostUsd, 1.75);
  assertEquals(summary.totalPacketBytes, 20);
  assertEquals(summary.totalOutputBytes, 40);
  assertEquals(summary.totalChangedLines, 6);
  assertEquals(summary.candidates, [
    {
      id: "pass",
      provider: "opencode",
      model: "local",
      effortLevel: "medium",
      totalCases: 1,
    },
    {
      id: "test_failure",
      provider: "opencode",
      model: "local",
      effortLevel: "medium",
      totalCases: 1,
    },
  ]);
});

Deno.test("command runner terminates an active child when cancelled", async () => {
  const controller = new AbortController();
  const pending = denoCommandRunner({
    command: Deno.execPath(),
    args: ["eval", "setTimeout(() => {}, 10000)"],
    cwd: Deno.cwd(),
    signal: controller.signal,
  });
  controller.abort();
  const result = await pending;
  assert(result.cancelled);
});

type Scenario =
  | "success"
  | "timeout"
  | "no-change"
  | "response-error"
  | "hidden-fail"
  | "no-artifact";

async function withSuite(
  scenario: Scenario,
  assertion: (
    written: Array<
      { spec: string; name: string; data?: unknown; content?: string }
    >,
    suiteDir: string,
  ) => Promise<void> | void,
) {
  const temp = await Deno.makeTempDir({
    prefix: "implementer-benchmark-test-",
  });
  const repo = await Deno.makeTempDir({
    prefix: "implementer-benchmark-repo-",
  });
  const written: Array<
    { spec: string; name: string; data?: unknown; content?: string }
  > = [];
  try {
    const runner = async (request: CommandRequest): Promise<CommandResult> => {
      await Promise.resolve();
      if (request.command === "/fake/swamp") {
        if (request.args[0] === "model" && request.args[1] === "get") {
          return {
            code: 0,
            success: true,
            stdout: '{"name":"benchmark-agent"}',
            stderr: "",
            timedOut: false,
            cancelled: false,
          };
        }
        const input = JSON.parse(
          request.args[request.args.indexOf("--input") + 1],
        );
        assertEquals(input.toolProfile, "readonly");
        assert(input.cwd.includes("/agents/"));
        assert(
          input.prompt.includes('"packetVersion":"implementer-packet-v2"'),
        );
        if (scenario === "timeout") {
          return {
            code: 143,
            success: false,
            stdout: "",
            stderr: "",
            timedOut: true,
            cancelled: false,
          };
        }
        if (scenario === "no-artifact") {
          return {
            code: 1,
            success: false,
            stdout: '{"error":"failed"}',
            stderr: "",
            timedOut: false,
            cancelled: false,
          };
        }
        return {
          code: 0,
          success: true,
          stdout: JSON.stringify({
            dataArtifacts: [{
              name: "invocation-1",
              attributes: {
                invocationId: "i-1",
                provider: "opencode",
                model: "fake",
                success: true,
                timedOut: false,
                durationMs: 12,
                tokens: { total: 7 },
                costUsd: 0,
                outputBytes: 80,
                parsedResponse: scenario === "response-error"
                  ? { files: { "../outside": "violation" } }
                  : scenario === "no-change"
                  ? {
                    files: {
                      "src/labels.js":
                        getFixture("task-01").files["src/labels.js"],
                    },
                  }
                  : {
                    files: {
                      "src/labels.js":
                        "export function normalizeLabels() { return ['known-edit']; }\n",
                    },
                  },
              },
            }],
          }),
          stderr: "",
          timedOut: false,
          cancelled: false,
        };
      }
      if (request.command === "/fake/bwrap") {
        assert(request.args.includes("--unshare-all"));
        assert(request.args.includes("--die-with-parent"));
        const hidden = request.args.includes(`/hidden/task-01.test.js`);
        if (
          request.args.includes("/workspace/test/smoke.test.js") &&
          request.cwd.includes("/.preflight/")
        ) {
          return {
            code: 0,
            success: true,
            stdout: "preflight",
            stderr: "",
            timedOut: false,
            cancelled: false,
          };
        }
        return {
          code: hidden && scenario === "hidden-fail" ? 1 : 0,
          success: !(hidden && scenario === "hidden-fail"),
          stdout: hidden ? "hidden" : "visible",
          stderr: "",
          timedOut: false,
          cancelled: false,
        };
      }
      return denoCommandRunner(request);
    };
    const context = {
      repoDir: repo,
      signal: new AbortController().signal,
      globalArgs: {
        workspaceRoot: temp,
        swampPath: "/fake/swamp",
        nodePath: "/fake/node",
        bubblewrapPath: "/fake/bwrap",
        agentModelName: "benchmark-agent",
      },
      logger: { info: () => {} },
      writeResource: (spec: string, name: string, data: unknown) => {
        written.push({ spec, name, data });
        return Promise.resolve({ specName: spec, name });
      },
      createFileWriter: (spec: string, name: string) => ({
        writeText: (content: string) => {
          written.push({ spec, name, content });
          return Promise.resolve({ specName: spec, name });
        },
      }),
    };
    await runBenchmarkSuite(
      {
        suiteId: `suite-${scenario}`,
        taskIds: ["task-01"],
        candidates: [{
          id: "fake",
          provider: "opencode",
          model: "fake",
          effortLevel: "medium",
        }],
        wallTimeoutMs: 1_000,
      },
      context,
      runner,
    );
    await assertion(written, `${temp}/suite-${scenario}`);
  } finally {
    await Deno.remove(temp, { recursive: true });
    await Deno.remove(repo, { recursive: true });
  }
}

Deno.test("integration: injected agent edit is materialized, git-inspected, verified, and persisted", async () => {
  await withSuite("success", async (written, suiteDir) => {
    const result = written.find((entry) => entry.spec === "caseResult")
      ?.data as CaseResult;
    assertEquals(result.status, "pass");
    assertEquals(result.effortLevel, "medium");
    assertEquals(result.changedPaths, ["src/labels.js"]);
    assert(result.requiresIndependentReview);
    assert(
      written.some((entry) =>
        entry.spec === "evidence" && entry.content?.includes("known-edit") &&
        entry.content.includes('"effortLevel": "medium"')
      ),
    );
    const summary = written.find((entry) => entry.spec === "suiteSummary")
      ?.data as ReturnType<typeof aggregateSummary>;
    assertEquals(summary.candidates[0].effortLevel, "medium");
    assert(await Deno.stat(`${suiteDir}/cases/fake/task-01/PROMPT.md`));
    await assertRejects(() => Deno.stat(`${suiteDir}/.hidden/fake-task-01`));
  });
});

for (
  const [scenario, expected] of [
    ["timeout", "timeout"],
    ["no-artifact", "invocation_error"],
    ["no-change", "no_change"],
    ["response-error", "response_error"],
    ["hidden-fail", "test_failure"],
  ] as const
) {
  Deno.test(`integration failure classification: ${scenario}`, async () => {
    await withSuite(
      scenario,
      (written) =>
        assertEquals(
          (written.find((entry) => entry.spec === "caseResult")
            ?.data as CaseResult).status,
          expected,
        ),
    );
  });
}
