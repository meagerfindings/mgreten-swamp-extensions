import {
  model,
  normalizePlaywrightReport,
  verifyBrowserRun,
} from "./browser_test_evidence.ts";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260823.31";

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}

function assertRejected(
  run: unknown,
  expected: Parameters<typeof verifyBrowserRun>[1],
  message: string,
) {
  let error = "";
  try {
    verifyBrowserRun(run, expected);
  } catch (caught) {
    error = (caught as Error).message;
  }
  if (!error.includes(message)) {
    throw new Error(`expected rejection containing ${message}: ${error}`);
  }
}

const args = {
  reportPath: "unused.json",
  runId: "123",
  sha: "abc1234",
  branch: "feature/browser-evidence",
  pullRequest: "42",
  runUrl: "https://github.com/example/repo/actions/runs/123",
  environment: "ci",
  trigger: "pull_request",
  appUrl: "https://example.test",
  artifactName: "playwright-123",
  artifactUrl: "https://github.com/example/repo/actions/runs/123/artifacts",
  executionStatus: "succeeded" as const,
  executionExitCode: 0,
};

const verification = {
  environment: "ci",
  runId: "123",
  reportSha256: "0".repeat(64),
  artifactReportSha256: "0".repeat(64),
  sha: "abc1234",
  branch: "feature/browser-evidence",
  requireCleanup: false,
};

Deno.test("normalizes project, viewport, retries, failures, cleanup, and totals", () => {
  const run = normalizePlaywrightReport({
    config: {
      projects: [{
        name: "windowed-chromium",
        metadata: {
          browserEngine: "chromium",
          viewportProfile: "constrained-window",
          viewport: "900x700",
        },
      }],
    },
    stats: { startTime: "2026-08-21T10:00:00.000Z" },
    suites: [{
      specs: [{
        title: "responsive navigation @acceptance",
        file: "scripts/browser_tests/responsive.spec.js",
        tags: ["acceptance"],
        tests: [{
          projectName: "windowed-chromium",
          annotations: [{ type: "cleanup", description: "completed" }],
          results: [
            {
              status: "failed",
              duration: 10,
              retry: 0,
              error: { message: "first attempt" },
            },
            { status: "passed", duration: 8, retry: 1 },
          ],
        }],
      }, {
        title: "broken flow @nightly",
        tests: [{
          projectName: "windowed-chromium",
          results: [{
            status: "failed",
            duration: 5,
            retry: 0,
            error: { message: "boom" },
          }],
        }],
      }],
    }],
  }, args);

  assertEquals(run.totals, {
    total: 2,
    passed: 0,
    failed: 1,
    flaky: 1,
    skipped: 0,
  });
  assertEquals(run.tests[0], {
    name: "responsive navigation @acceptance",
    sourceFile: "scripts/browser_tests/responsive.spec.js",
    tags: ["@acceptance"],
    project: "windowed-chromium",
    browserEngine: "chromium",
    viewportProfile: "constrained-window",
    viewport: "900x700",
    status: "flaky",
    durationMs: 18,
    retries: 1,
    attempts: [
      {
        status: "failed",
        durationMs: 10,
        retry: 0,
        failureMessage: "first attempt",
      },
      { status: "passed", durationMs: 8, retry: 1 },
    ],
    skipRequirement: "required",
    stateful: false,
    orderSeedIsolation: false,
    cleanupOutcome: "completed",
  });
  assertEquals(run.tests[1].failureMessage, "boom");
  assertEquals(run.tests[1].cleanupOutcome, "not-reported");
  assertEquals(run.outcome, "failed");
});

function report(status = "passed", annotations: unknown[] = []) {
  return {
    config: {
      projects: [{
        name: "chromium",
        metadata: {
          browserEngine: "chromium",
          viewportProfile: "desktop",
          viewport: "1280x720",
        },
      }],
    },
    stats: { startTime: "2026-08-21T10:00:00.000Z" },
    suites: [{
      specs: [{
        title: "test",
        tests: [{
          projectName: "chromium",
          annotations,
          results: [{ status, duration: 1, retry: 0 }],
        }],
      }],
    }],
  };
}

Deno.test("assigns passed, failed, and degraded execution outcomes", () => {
  assertEquals(normalizePlaywrightReport(report(), args).outcome, "passed");
  assertEquals(
    normalizePlaywrightReport(report(), { ...args, executionExitCode: 1 })
      .outcome,
    "failed",
  );
  assertEquals(
    normalizePlaywrightReport({
      ...report(),
      errors: [{ message: "worker crashed" }],
    }, args).outcome,
    "failed",
  );
  assertEquals(
    normalizePlaywrightReport(
      report("passed", [{ type: "cleanup", description: "failed" }]),
      args,
    ).outcome,
    "failed",
  );
  assertEquals(
    normalizePlaywrightReport(report("skipped"), args).outcome,
    "failed",
  );
  const flaky = report();
  flaky.suites[0].specs[0].tests[0].results.unshift({
    status: "failed",
    duration: 1,
    retry: 0,
  });
  flaky.suites[0].specs[0].tests[0].results[1].retry = 1;
  assertEquals(normalizePlaywrightReport(flaky, args).outcome, "degraded");
});

Deno.test("retains bounded report-level error messages", () => {
  const run = normalizePlaywrightReport({
    ...report(),
    errors: [
      { message: "global setup failed" },
      { value: "non-Error value thrown" },
    ],
  }, args);
  assertEquals(run.reportErrorMessages, [
    "global setup failed",
    "non-Error value thrown",
  ]);
});

Deno.test("verifies successful evidence coverage and provenance", () => {
  const run = normalizePlaywrightReport({
    config: {
      projects: [{
        name: "chromium",
        metadata: {
          browserEngine: "chromium",
          viewportProfile: "desktop",
          viewport: "1280x720",
        },
      }],
    },
    stats: { startTime: "2026-08-21T10:00:00.000Z" },
    suites: [{
      specs: [{
        title: "canary @canary",
        file: "scripts/browser_tests/canary.spec.js",
        tests: [{
          projectName: "chromium",
          results: [{ status: "passed", duration: 1, retry: 0 }],
        }],
      }, {
        title: "project-specific duplicate @canary",
        file: "scripts/browser_tests/canary.spec.js",
        tests: [{
          projectName: "chromium",
          annotations: [{ type: "optional-skip" }, { type: "stateful" }],
          results: [{ status: "skipped", duration: 0, retry: 0 }],
        }],
      }],
    }],
  }, args);
  verifyBrowserRun(run, {
    ...verification,
    expectedProjects: ["chromium"],
    expectedTags: ["canary"],
    expectedTestFilesOrCriteria: ["scripts/browser_tests/canary.spec.js"],
  });
});

Deno.test("rejects every authoritative browser failure independently", () => {
  const base = normalizePlaywrightReport({
    config: {
      projects: [{
        name: "chromium",
        metadata: {
          browserEngine: "chromium",
          viewportProfile: "desktop",
          viewport: "1280x720",
        },
      }],
    },
    stats: { startTime: "2026-08-21T10:00:00.000Z" },
    suites: [{
      specs: [{
        title: "canary @canary",
        file: "scripts/browser_tests/canary.spec.js",
        tests: [{
          projectName: "chromium",
          results: [{ status: "passed", duration: 1, retry: 0 }],
        }],
      }],
    }],
  }, args);
  const exact = {
    ...verification,
    expectedProjects: ["chromium"],
    expectedTags: ["@canary"],
    expectedClasses: ["canary @canary"],
    expectedTestFilesOrCriteria: ["scripts/browser_tests/canary.spec.js"],
  };
  assertRejected(
    { ...base, executionStatus: "failed" },
    exact,
    "execution or infrastructure failed",
  );
  assertRejected(
    { ...base, executionExitCode: 1, outcome: "failed" },
    exact,
    "failed or degraded outcome",
  );
  assertRejected(
    { ...base, reportErrorMessages: ["worker crashed"], outcome: "failed" },
    exact,
    "failed or degraded outcome",
  );
  assertRejected(
    { ...base, outcome: "degraded" },
    exact,
    "failed or degraded outcome",
  );
  assertRejected(base, { ...exact, environment: "production" }, "environment");
  assertRejected(
    base,
    { ...exact, artifactReportSha256: "2".repeat(64) },
    "digest mismatch",
  );
  assertRejected(
    base,
    { ...exact, requireCleanup: true },
    "cleanup failed or was not reported",
  );
  assertRejected(
    {
      ...base,
      totals: { total: 1, passed: 0, failed: 0, flaky: 0, skipped: 1 },
      tests: [{ ...base.tests[0], status: "skipped" }],
    },
    { ...verification },
    "required tests skipped",
  );
  assertRejected(
    {
      ...base,
      totals: { total: 1, passed: 0, failed: 0, flaky: 1, skipped: 0 },
      tests: [{ ...base.tests[0], status: "flaky" }],
    },
    { ...verification },
    "passed only after retry",
  );
  for (const status of ["failed", "timedOut", "interrupted"] as const) {
    assertRejected(
      {
        ...base,
        totals: { total: 1, passed: 0, failed: 1, flaky: 0, skipped: 0 },
        tests: [{ ...base.tests[0], status }],
      },
      { ...verification },
      "tests failed or errored",
    );
  }
  assertRejected(
    {
      ...base,
      tests: [{
        ...base.tests[0],
        stateful: true,
        cleanupOutcome: "completed",
        orderSeedIsolation: false,
      }],
    },
    exact,
    "lacks order/seed isolation evidence",
  );
  assertRejected(
    base,
    {
      ...exact,
      expectedTestFilesOrCriteria: ["scripts/browser_tests/missing.spec.js"],
    },
    "missing test file or criterion",
  );
  assertRejected(base, { ...exact, runId: "wrong" }, "run ID");
  assertRejected(base, { ...exact, sha: "def5678" }, "source SHA");
  assertRejected(base, { ...exact, branch: "master" }, "source branch");
  assertRejected(
    base,
    { ...exact, expectedProjects: ["webkit"] },
    "missing project",
  );
  assertRejected(
    base,
    { ...exact, expectedTags: ["@nightly"] },
    "missing tag",
  );
  assertRejected(
    base,
    { ...exact, expectedClasses: ["missing class"] },
    "missing class",
  );
  assertRejected(
    {
      ...base,
      totals: { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 },
      tests: [],
    },
    { ...verification },
    "report contains no tests",
  );
});

Deno.test("rejects absent, failing, uncovered, and mismatched evidence", () => {
  const base = normalizePlaywrightReport({
    config: {
      projects: [{
        name: "chromium",
        metadata: {
          browserEngine: "chromium",
          viewportProfile: "desktop",
          viewport: "1280x720",
        },
      }],
    },
    stats: { startTime: "2026-08-21T10:00:00.000Z" },
    suites: [{
      specs: [{
        title: "canary @canary",
        file: "scripts/browser_tests/canary.spec.js",
        tests: [{
          projectName: "chromium",
          results: [{ status: "passed", duration: 1, retry: 0 }],
        }],
      }],
    }],
  }, args);
  const flaky = {
    ...base,
    totals: { total: 1, passed: 0, failed: 0, flaky: 1, skipped: 0 },
    tests: [{ ...base.tests[0], status: "flaky" as const }],
  };
  const skipped = {
    ...base,
    totals: { total: 1, passed: 0, failed: 0, flaky: 0, skipped: 1 },
    tests: [{ ...base.tests[0], status: "skipped" as const }],
  };
  const cases = [
    { ...base, totals: { ...base.totals, total: 0 } },
    { ...base, totals: { ...base.totals, failed: 1 } },
    flaky,
    skipped,
    base,
  ];
  const expectations = [
    verification,
    verification,
    verification,
    {
      ...verification,
      expectedProjects: ["chromium"],
      expectedTags: ["canary"],
    },
    {
      ...verification,
      runId: "wrong",
      expectedProjects: ["webkit"],
      expectedTags: ["nightly"],
      sha: "def5678",
      branch: "master",
    },
  ];
  cases.forEach((run, index) => {
    let rejected = false;
    try {
      verifyBrowserRun(run, expectations[index]);
    } catch {
      rejected = true;
    }
    if (!rejected) {
      throw new Error(`negative verifier case ${index} was accepted`);
    }
  });
});

Deno.test("rejects environment, digest, cleanup, required skip, and isolation gaps", () => {
  const run = normalizePlaywrightReport({
    config: {
      projects: [{
        name: "chromium",
        metadata: {
          browserEngine: "chromium",
          viewportProfile: "desktop",
          viewport: "1280x720",
        },
      }],
    },
    stats: { startTime: "2026-08-21T10:00:00.000Z" },
    suites: [{
      specs: [{
        title: "stateful",
        tests: [{
          projectName: "chromium",
          annotations: [{ type: "stateful" }, {
            type: "cleanup",
            description: "failed: leaked account",
          }],
          results: [{ status: "skipped", duration: 1, retry: 0 }],
        }],
      }],
    }],
  }, args);
  for (
    const override of [
      { environment: "production" },
      { artifactReportSha256: "2".repeat(64) },
      { requireCleanup: true },
    ]
  ) {
    let rejected = false;
    try {
      verifyBrowserRun(run, { ...verification, ...override });
    } catch {
      rejected = true;
    }
    if (!rejected) {
      throw new Error(
        `accepted invalid browser evidence: ${JSON.stringify(override)}`,
      );
    }
  }
  assertEquals(run.tests[0].cleanupOutcome, "failed");
});

function successfulRun() {
  return normalizePlaywrightReport(report(), args);
}

async function withReportFile(
  contents: string | Uint8Array,
  run: (path: string) => Promise<void>,
) {
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    if (typeof contents === "string") {
      await Deno.writeTextFile(path, contents);
    } else {
      await Deno.writeFile(path, contents);
    }
    await run(path);
  } finally {
    await Deno.remove(path);
  }
}

Deno.test("importPlaywrightJson writes a hash-bound spec-distinct run", async () => {
  const contents = JSON.stringify(report());
  await withReportFile(contents, async (path) => {
    const { context, getLogs, getWrittenResources } = createModelTestContext({
      methodName: "importPlaywrightJson",
    });
    await model.methods.importPlaywrightJson.execute(
      { ...args, reportPath: path },
      context,
    );
    const writes = getWrittenResources();
    assertEquals(writes.length, 1);
    assertEquals(writes[0].specName, "browser-run");
    assertEquals(writes[0].name, "browser-run-ci");
    const expectedHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(contents),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    assertEquals(
      (writes[0].data as Record<string, unknown>).reportSha256,
      expectedHash,
    );
    assertEquals(getLogs(), [{
      level: "info",
      message: "Starting Playwright JSON import",
      args: [{
        method: "importPlaywrightJson",
        environment: "ci",
        runId: "123",
      }],
    }, {
      level: "info",
      message: "Completed Playwright JSON import",
      args: [{
        method: "importPlaywrightJson",
        environment: "ci",
        runId: "123",
      }],
    }]);
    if (JSON.stringify(getLogs()).includes(path)) {
      throw new Error("report path leaked into logs");
    }
  });
});

Deno.test("importPlaywrightJson accepts an exact-size report", async () => {
  const base = JSON.stringify(report());
  const suffix = `,"padding":""}`;
  const exact = `${base.slice(0, -1)},"padding":"${
    "x".repeat(5_000_000 - base.length - suffix.length + 1)
  }"}`;
  assertEquals(new TextEncoder().encode(exact).byteLength, 5_000_000);
  await withReportFile(exact, async (path) => {
    const testContext = createModelTestContext({
      methodName: "importPlaywrightJson",
    });
    await model.methods.importPlaywrightJson.execute(
      { ...args, reportPath: path },
      testContext.context,
    );
    assertEquals(testContext.getWrittenResources()[0].name, "browser-run-ci");
  });
});

Deno.test("normalization rejects 10,001 tests", () => {
  const oversized = report();
  const test = oversized.suites[0].specs[0].tests[0];
  oversized.suites[0].specs[0].tests = Array.from(
    { length: 10_001 },
    () => test,
  );
  assertRejectedNormalization(oversized, "exceeds 10000 tests");
});

Deno.test("importPlaywrightJson rejects malformed, oversized, and unsafe input", async () => {
  await withReportFile("{broken", async (path) => {
    const { context } = createModelTestContext({
      methodName: "importPlaywrightJson",
    });
    await assertMethodRejected(
      () =>
        model.methods.importPlaywrightJson.execute(
          { ...args, reportPath: path },
          context,
        ),
      `Invalid Playwright JSON in ${JSON.stringify(path)}`,
    );
  });
  await withReportFile(new Uint8Array(5_000_001), async (path) => {
    const { context } = createModelTestContext({
      methodName: "importPlaywrightJson",
    });
    await assertMethodRejected(
      () =>
        model.methods.importPlaywrightJson.execute(
          { ...args, reportPath: path },
          context,
        ),
      `${JSON.stringify(path)} exceeds 5000000 bytes`,
    );
  });
  const { context } = createModelTestContext({
    methodName: "importPlaywrightJson",
  });
  await assertMethodRejected(
    () =>
      model.methods.importPlaywrightJson.execute(
        { ...args, reportPath: "unused", runId: "unsafe/id" },
        context,
      ),
    "Invalid string",
  );
});

Deno.test("importPlaywrightJson accepts exact replay and rejects changed bytes", async () => {
  const exactBytes = JSON.stringify(report());
  await withReportFile(exactBytes, async (path) => {
    const first = createModelTestContext({
      methodName: "importPlaywrightJson",
    });
    await model.methods.importPlaywrightJson.execute(
      { ...args, reportPath: path },
      first.context,
    );
    const recorded = first.getWrittenResources()[0].data;
    const replay = createModelTestContext({
      methodName: "importPlaywrightJson",
      storedResources: { "browser-run-ci": recorded },
    });
    const result = await model.methods.importPlaywrightJson.execute(
      { ...args, reportPath: path },
      replay.context,
    );
    assertEquals(result.dataHandles, []);
    assertEquals(replay.getWrittenResources(), []);

    await Deno.writeTextFile(path, `${exactBytes}\n`);
    const changedBytes = createModelTestContext({
      methodName: "importPlaywrightJson",
      storedResources: { "browser-run-ci": recorded },
    });
    await assertMethodRejected(
      () =>
        model.methods.importPlaywrightJson.execute(
          { ...args, reportPath: path },
          changedBytes.context,
        ),
      "already records different evidence",
    );
    assertEquals(changedBytes.getWrittenResources(), []);
  });
});

Deno.test("importPlaywrightJson writes a later run to the retained stream", async () => {
  await withReportFile(JSON.stringify(report()), async (path) => {
    const prior = normalizePlaywrightReport(report(), args, "a".repeat(64));
    const next = createModelTestContext({
      methodName: "importPlaywrightJson",
      storedResources: { "browser-run-ci": prior },
    });
    await model.methods.importPlaywrightJson.execute(
      { ...args, reportPath: path, runId: "124" },
      next.context,
    );
    const writes = next.getWrittenResources();
    assertEquals(writes.length, 1);
    assertEquals(writes[0].name, "browser-run-ci");
    assertEquals((writes[0].data as Record<string, unknown>).runId, "124");
  });
});

Deno.test("verifyImportedRun accepts exact replay and rejects conflicting replay", async () => {
  const run = successfulRun();
  const resourceName = "browser-verification-ci-123";
  const first = createModelTestContext({
    methodName: "verifyImportedRun",
    storedResources: { "browser-run-ci": run },
  });
  await model.methods.verifyImportedRun.execute(verification, first.context);
  assertEquals(first.getWrittenResources()[0].specName, "browser-verification");
  assertEquals(first.getWrittenResources()[0].name, resourceName);
  assertVerificationLogs(first.getLogs(), "verifyImportedRun", "imported");

  const recorded = first.getWrittenResources()[0].data as Record<
    string,
    unknown
  >;
  const replay = createModelTestContext({
    methodName: "verifyImportedRun",
    storedResources: {
      "browser-run-ci": run,
      [resourceName]: { ...recorded, verifiedAt: "2020-01-01T00:00:00.000Z" },
    },
  });
  const result = await model.methods.verifyImportedRun.execute(
    verification,
    replay.context,
  );
  assertEquals(result.dataHandles, []);
  assertEquals(replay.getWrittenResources(), []);
  assertVerificationLogs(replay.getLogs(), "verifyImportedRun", "imported");

  const conflict = createModelTestContext({
    methodName: "verifyImportedRun",
    storedResources: {
      "browser-run-ci": run,
      [resourceName]: { ...recorded, branch: "different-branch" },
    },
  });
  await assertMethodRejected(
    () =>
      model.methods.verifyImportedRun.execute(verification, conflict.context),
    "conflicts with replay",
  );
});

Deno.test("verification methods reject a missing retained run", async () => {
  for (
    const [methodName, execute] of [
      ["verifyImportedRun", () =>
        model.methods.verifyImportedRun.execute(
          verification,
          createModelTestContext({ methodName: "verifyImportedRun" }).context,
        )],
      ["verifyFactoryRun", () =>
        model.methods.verifyFactoryRun.execute(
          factoryVerification(),
          createModelTestContext({ methodName: "verifyFactoryRun" }).context,
        )],
    ] as const
  ) {
    await assertMethodRejected(execute, "browser-run-ci does not exist");
    if (!methodName) throw new Error("missing method name");
  }
});

function factoryVerification() {
  return {
    ...verification,
    workItem: "browser-evidence",
    packetVersion: 2,
    planDigest: "1".repeat(64),
    stageCycle: 3,
    runEra: "2026-08-20T00:00:00.000Z",
    expectedTestFilesOrCriteria: ["test"],
  };
}

Deno.test("verifyFactoryRun accepts exact replay and rejects conflicting replay", async () => {
  const run = successfulRun();
  const factoryArgs = factoryVerification();
  const resourceName = "browser-verdict-browser-evidence-p2-c3";
  const first = createModelTestContext({
    methodName: "verifyFactoryRun",
    storedResources: { "browser-run-ci": run },
  });
  await model.methods.verifyFactoryRun.execute(
    factoryArgs,
    first.context,
  );
  assertEquals(first.getWrittenResources()[0].specName, "browser-verdict");
  assertEquals(first.getWrittenResources()[0].name, resourceName);
  assertVerificationLogs(first.getLogs(), "verifyFactoryRun", "factory");

  const recorded = first.getWrittenResources()[0].data as Record<
    string,
    unknown
  >;
  const replay = createModelTestContext({
    methodName: "verifyFactoryRun",
    storedResources: {
      "browser-run-ci": run,
      [resourceName]: { ...recorded, verifiedAt: "2020-01-01T00:00:00.000Z" },
    },
  });
  const result = await model.methods.verifyFactoryRun.execute(
    factoryArgs,
    replay.context,
  );
  assertEquals(result.dataHandles, []);
  assertEquals(replay.getWrittenResources(), []);
  assertVerificationLogs(replay.getLogs(), "verifyFactoryRun", "factory");

  const conflict = createModelTestContext({
    methodName: "verifyFactoryRun",
    storedResources: {
      "browser-run-ci": run,
      [resourceName]: { ...recorded, planDigest: "2".repeat(64) },
    },
  });
  await assertMethodRejected(
    () =>
      model.methods.verifyFactoryRun.execute(
        factoryArgs,
        conflict.context,
      ),
    "conflicts with replay",
  );
});

Deno.test("verifyFactoryRun rejects evidence before the run era", async () => {
  const testContext = createModelTestContext({
    methodName: "verifyFactoryRun",
    storedResources: { "browser-run-ci": successfulRun() },
  });
  await assertMethodRejected(
    () =>
      model.methods.verifyFactoryRun.execute({
        ...factoryVerification(),
        runEra: "2026-08-22T00:00:00.000Z",
      }, testContext.context),
    "run predates current run era",
  );
  assertEquals(testContext.getWrittenResources(), []);
});

function assertVerificationLogs(logs: unknown[], method: string, kind: string) {
  assertEquals(logs, [
    {
      level: "info",
      message: `Starting ${kind} browser run verification`,
      args: [{ method, environment: "ci", runId: "123" }],
    },
    {
      level: "info",
      message: `Completed ${kind} browser run verification`,
      args: [{ method, environment: "ci", runId: "123" }],
    },
  ]);
}

function assertRejectedNormalization(raw: unknown, message: string) {
  let error = "";
  try {
    normalizePlaywrightReport(raw, args);
  } catch (caught) {
    error = (caught as Error).message;
  }
  if (!error.includes(message)) {
    throw new Error(`expected rejection containing ${message}: ${error}`);
  }
}

async function assertMethodRejected(
  execute: () => Promise<unknown>,
  message: string,
) {
  let error = "";
  try {
    await execute();
  } catch (caught) {
    error = (caught as Error).message;
  }
  if (!error.includes(message)) {
    throw new Error(`expected rejection containing ${message}: ${error}`);
  }
}
