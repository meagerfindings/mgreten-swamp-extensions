import { model, normalizePlaywrightReport } from "./browser_test_evidence.ts";

const args = {
  reportPath: "unused.json",
  runId: "123",
  sha: "abc123",
  branch: "feature/browser-evidence",
  pullRequest: "42",
  runUrl: "https://github.com/example/repo/actions/runs/123",
  environment: "ci",
  trigger: "pull_request",
  appUrl: "https://example.test",
  artifactName: "playwright-123",
  artifactUrl: "https://github.com/example/repo/actions/runs/123/artifacts",
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
    stats: { startTime: "2026-08-23T10:00:00.000Z" },
    suites: [{
      specs: [{
        title: "responsive navigation @acceptance",
        tags: ["acceptance"],
        tests: [{
          projectName: "windowed-chromium",
          annotations: [{ type: "cleanup", description: "completed" }],
          results: [
            { status: "failed", duration: 10, retry: 0 },
            { status: "passed", duration: 8, retry: 1 },
          ],
        }],
      }, {
        title: "timed out flow @nightly",
        tests: [{
          projectName: "windowed-chromium",
          results: [{ status: "timedOut", duration: 5, retry: 0 }],
        }],
      }],
    }],
  }, args);

  if (run.totals.total !== 2 || run.totals.flaky !== 1 || run.totals.failed !== 1) {
    throw new Error(`Unexpected totals: ${JSON.stringify(run.totals)}`);
  }
  if (run.tests[0].status !== "flaky" || run.tests[0].retries !== 1) {
    throw new Error(`Expected flaky retry evidence: ${JSON.stringify(run.tests[0])}`);
  }
  if (
    run.tests[1].status !== "timedOut" || run.tests[1].cleanupOutcome !== "not-reported"
  ) {
    throw new Error(`Expected timed-out evidence: ${JSON.stringify(run.tests[1])}`);
  }
});

const report = () => ({
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
  stats: { startTime: "2026-08-23T10:00:00.000Z" },
  suites: [{
    specs: [{
      title: "test",
      tests: [{
        projectName: "chromium",
        results: [{ status: "passed", duration: 1, retry: 0 }],
      }],
    }],
  }],
});

Deno.test("rejects malformed, unrelated, unknown-status, and missing-time reports", () => {
  for (
    const invalid of [
      {},
      { ...report(), unrelated: true },
      (() => {
        const value = report();
        value.suites[0].specs[0].tests[0].results[0].status = "unknown";
        return value;
      })(),
      (() => {
        const value = report() as { stats: { startTime?: string } };
        delete value.stats.startTime;
        return value;
      })(),
    ]
  ) {
    let rejected = false;
    try {
      normalizePlaywrightReport(invalid, args);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("expected malformed report rejection");
  }
});

Deno.test("normalization is deterministic and model writes run-specific resource", async () => {
  if (
    JSON.stringify(normalizePlaywrightReport(report(), args)) !==
      JSON.stringify(normalizePlaywrightReport(report(), args))
  ) {
    throw new Error("normalization was not deterministic");
  }
  const path = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(path, JSON.stringify(report()));
    const writes: unknown[][] = [];
    await model.methods.importPlaywrightJson.execute({ ...args, reportPath: path }, {
      writeResource: (...values: unknown[]) => {
        writes.push(values);
        return Promise.resolve({ name: values[1] as string });
      },
    });
    if (writes.length !== 1 || writes[0][1] !== "browser-ci-123") {
      throw new Error(JSON.stringify(writes));
    }
  } finally {
    await Deno.remove(path);
  }
});
