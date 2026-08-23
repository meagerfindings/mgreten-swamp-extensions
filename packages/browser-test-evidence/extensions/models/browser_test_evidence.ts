/** Normalize Playwright JSON reports into structured browser-test evidence. */
import { z } from "npm:zod@4";

const BrowserTestSchema = z.strictObject({
  name: z.string(),
  tags: z.array(z.string()),
  project: z.string(),
  browserEngine: z.string(),
  viewportProfile: z.string(),
  viewport: z.string(),
  status: z.enum([
    "passed",
    "failed",
    "flaky",
    "skipped",
    "timedOut",
    "interrupted",
  ]),
  durationMs: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  failureMessage: z.string().optional(),
  cleanupOutcome: z.enum([
    "completed",
    "failed",
    "not-applicable",
    "not-reported",
  ]),
});

const BrowserRunSchema = z.strictObject({
  runAt: z.iso.datetime({ offset: true }),
  runId: z.string(),
  sha: z.string(),
  branch: z.string(),
  pullRequest: z.string().optional(),
  deployment: z.string().optional(),
  runUrl: z.string().url(),
  environment: z.string(),
  trigger: z.string(),
  appUrl: z.string().url(),
  artifact: z.strictObject({
    name: z.string(),
    url: z.string().url(),
  }),
  totals: z.strictObject({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    flaky: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
  tests: z.array(BrowserTestSchema),
});

/** Strict provenance and local-report arguments accepted by the import method. */
export const ImportArgumentsSchema = z.strictObject({
  reportPath: z.string().min(1),
  runId: z.string().min(1),
  sha: z.string().min(1),
  branch: z.string().min(1),
  pullRequest: z.string().optional(),
  deployment: z.string().optional(),
  runUrl: z.string().url(),
  environment: z.string().min(1),
  trigger: z.string().min(1),
  appUrl: z.string().url(),
  artifactName: z.string().min(1),
  artifactUrl: z.string().url(),
});

type ImportArguments = z.infer<typeof ImportArgumentsSchema>;
type BrowserTest = z.infer<typeof BrowserTestSchema>;
type BrowserRun = z.infer<typeof BrowserRunSchema>;

const PlaywrightResultSchema = z.strictObject({
  status: z.enum(["passed", "failed", "skipped", "timedOut", "interrupted"]),
  duration: z.number().int().nonnegative(),
  retry: z.number().int().nonnegative(),
  error: z.strictObject({ message: z.string().min(1) }).optional(),
});
type PlaywrightResult = z.infer<typeof PlaywrightResultSchema>;
const PlaywrightSuiteSchema: z.ZodType<PlaywrightSuite> = z.lazy(() =>
  z.strictObject({
    suites: z.array(PlaywrightSuiteSchema).optional(),
    specs: z.array(z.strictObject({
      title: z.string().min(1),
      tags: z.array(z.string().min(1)).optional(),
      tests: z.array(z.strictObject({
        projectName: z.string().min(1),
        annotations: z.array(z.strictObject({
          type: z.string().min(1),
          description: z.string().optional(),
        })).optional(),
        results: z.array(PlaywrightResultSchema).min(1),
      })).min(1),
    })).optional(),
  })
);
type PlaywrightSuite = {
  suites?: PlaywrightSuite[];
  specs?: Array<{
    title: string;
    tags?: string[];
    tests: Array<{
      projectName: string;
      annotations?: Array<{ type: string; description?: string }>;
      results: PlaywrightResult[];
    }>;
  }>;
};
const PlaywrightReportSchema = z.strictObject({
  config: z.strictObject({
    projects: z.array(z.strictObject({
      name: z.string().min(1),
      metadata: z.strictObject({
        browserEngine: z.string().min(1),
        viewportProfile: z.string().min(1),
        viewport: z.string().min(1),
      }),
    })).min(1),
  }),
  suites: z.array(PlaywrightSuiteSchema).min(1),
  stats: z.strictObject({ startTime: z.iso.datetime({ offset: true }) }),
});

type ResourceHandle = { name: string };
type ImportContext = {
  writeResource: (
    specName: string,
    name: string,
    data: BrowserRun,
  ) => Promise<ResourceHandle>;
};

function tagsFor(title: string, supplied: string[] | undefined): string[] {
  return [
    ...new Set([
      ...(supplied ?? []).map((tag) => (tag.startsWith("@") ? tag : `@${tag}`)),
      ...(title.match(/@[\w-]+/g) ?? []),
    ]),
  ];
}

function cleanupOutcome(
  annotations: Array<{ type?: string; description?: string }> | undefined,
): BrowserTest["cleanupOutcome"] {
  const annotation = annotations?.find((item) => item.type === "cleanup");
  if (!annotation) return "not-reported";
  if (annotation.description === "completed") return "completed";
  if (annotation.description === "failed") return "failed";
  return "not-applicable";
}

function finalStatus(results: PlaywrightResult[]): BrowserTest["status"] {
  const last = results.at(-1);
  if (!last) return "skipped";
  if (last.status === "passed" && results.length > 1) return "flaky";
  if (
    last.status === "passed" || last.status === "skipped" ||
    last.status === "timedOut" || last.status === "interrupted"
  ) {
    return last.status;
  }
  return "failed";
}

/** Convert the relevant Playwright JSON reporter fields into the public run contract. */
export function normalizePlaywrightReport(
  raw: unknown,
  args: ImportArguments,
): BrowserRun {
  const argsValue = ImportArgumentsSchema.parse(args);
  const report = PlaywrightReportSchema.parse(raw);
  const projects = new Map(
    (report.config?.projects ?? []).map((project) => [
      project.name,
      project,
    ]),
  );
  const tests: BrowserTest[] = [];

  const visit = (suite: PlaywrightSuite): void => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const results = test.results;
        const last = results.at(-1);
        const projectName = test.projectName;
        const project = projects.get(projectName);
        if (!project) {
          throw new TypeError(`Unknown Playwright project: ${projectName}`);
        }
        const metadata = project.metadata;
        tests.push({
          name: spec.title,
          tags: tagsFor(spec.title, spec.tags),
          project: projectName,
          browserEngine: metadata.browserEngine,
          viewportProfile: metadata.viewportProfile,
          viewport: metadata.viewport,
          status: finalStatus(results),
          durationMs: results.reduce(
            (sum, result) => sum + result.duration,
            0,
          ),
          retries: Math.max(...results.map((result) => result.retry)),
          failureMessage: last?.error?.message,
          cleanupOutcome: cleanupOutcome(test.annotations),
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  if (tests.length === 0) {
    throw new TypeError("Playwright report contains no tests");
  }

  return BrowserRunSchema.parse({
    runAt: report.stats.startTime,
    runId: argsValue.runId,
    sha: argsValue.sha,
    branch: argsValue.branch,
    pullRequest: argsValue.pullRequest || undefined,
    deployment: argsValue.deployment || undefined,
    runUrl: argsValue.runUrl,
    environment: argsValue.environment,
    trigger: argsValue.trigger,
    appUrl: argsValue.appUrl,
    artifact: { name: argsValue.artifactName, url: argsValue.artifactUrl },
    totals: {
      total: tests.length,
      passed: tests.filter((test) => test.status === "passed").length,
      failed: tests.filter((test) =>
        ["failed", "timedOut", "interrupted"].includes(test.status)
      ).length,
      flaky: tests.filter((test) =>
        test.status === "flaky"
      ).length,
      skipped: tests.filter((test) => test.status === "skipped").length,
    },
    tests,
  });
}

/** Swamp model definition. */
export const model = {
  type: "@mgreten/browser-test-evidence",
  version: "2026.08.23.1",
  globalArguments: z.object({}),
  resources: {
    "browser-run": {
      description:
        "Structured Playwright run evidence with project, viewport, retry, failure, cleanup, and CI provenance",
      schema: BrowserRunSchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
  },
  methods: {
    importPlaywrightJson: {
      description:
        "Normalize a Playwright JSON report and persist it as versioned browser test evidence",
      arguments: ImportArgumentsSchema,
      execute: async (
        args: ImportArguments,
        context: ImportContext,
      ): Promise<{ dataHandles: ResourceHandle[] }> => {
        const raw = JSON.parse(await Deno.readTextFile(args.reportPath));
        const run = normalizePlaywrightReport(raw, args);
        const name = `browser-${args.environment}-${args.runId}`.replace(
          /[^a-zA-Z0-9_-]/g,
          "-",
        );
        const handle = await context.writeResource("browser-run", name, run);
        return { dataHandles: [handle] };
      },
    },
  },
};
