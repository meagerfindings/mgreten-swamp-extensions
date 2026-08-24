/** Normalize Playwright JSON reports into structured browser-test evidence. */
import { z } from "npm:zod@4";

const MAX_REPORT_BYTES = 5_000_000;
const MAX_TESTS = 10_000;
const SafeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
const BoundedTextSchema = z.string().min(1).max(500);
const PlaywrightMetadataValueSchema = z.union([
  z.string().min(1).max(500),
  z.number().finite(),
  z.boolean(),
]);
const PublicUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password && !url.search && !url.hash;
}, "URL must not contain credentials, query parameters, or fragments");

const BrowserTestSchema = z.strictObject({
  name: BoundedTextSchema,
  tags: z.array(z.string().min(1).max(100)).max(100),
  project: BoundedTextSchema,
  browserEngine: BoundedTextSchema,
  viewportProfile: BoundedTextSchema,
  viewport: BoundedTextSchema,
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
  failureMessage: z.string().min(1).max(10_000).optional(),
  cleanupOutcome: z.enum([
    "completed",
    "failed",
    "not-applicable",
    "not-reported",
  ]),
});

const BrowserRunSchema = z.strictObject({
  runAt: z.iso.datetime({ offset: true }),
  runId: SafeIdSchema,
  sha: z.string().regex(/^[a-fA-F0-9]{7,64}$/),
  branch: BoundedTextSchema,
  pullRequest: BoundedTextSchema.optional(),
  deployment: BoundedTextSchema.optional(),
  runUrl: PublicUrlSchema,
  environment: SafeIdSchema,
  trigger: BoundedTextSchema,
  appUrl: PublicUrlSchema,
  reportSha256: z.string().regex(/^[a-f0-9]{64}$/),
  authority: z.literal("recording-only"),
  artifact: z.strictObject({
    name: BoundedTextSchema,
    url: PublicUrlSchema,
  }),
  totals: z.strictObject({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    flaky: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
  tests: z.array(BrowserTestSchema).max(MAX_TESTS),
});

/** Strict provenance and local-report arguments accepted by the import method. */
export const ImportArgumentsSchema = z.strictObject({
  reportPath: z.string().min(1),
  runId: SafeIdSchema,
  sha: z.string().regex(/^[a-fA-F0-9]{7,64}$/),
  branch: BoundedTextSchema,
  pullRequest: BoundedTextSchema.optional(),
  deployment: BoundedTextSchema.optional(),
  runUrl: PublicUrlSchema,
  environment: SafeIdSchema,
  trigger: BoundedTextSchema,
  appUrl: PublicUrlSchema,
  artifactName: BoundedTextSchema,
  artifactUrl: PublicUrlSchema,
});

type ImportArguments = z.infer<typeof ImportArgumentsSchema>;
type BrowserTest = z.infer<typeof BrowserTestSchema>;
type BrowserRun = z.infer<typeof BrowserRunSchema>;

const PlaywrightResultSchema = z.object({
  status: z.enum(["passed", "failed", "skipped", "timedOut", "interrupted"]),
  duration: z.number().int().nonnegative(),
  retry: z.number().int().nonnegative(),
  error: z.object({ message: z.string().min(1).max(10_000) }).optional(),
});
type PlaywrightResult = z.infer<typeof PlaywrightResultSchema>;
const PlaywrightSuiteSchema: z.ZodType<PlaywrightSuite> = z.lazy(() =>
  z.object({
    suites: z.array(PlaywrightSuiteSchema).optional(),
    specs: z.array(z.object({
      title: z.string().min(1),
      tags: z.array(z.string().min(1)).optional(),
      tests: z.array(z.object({
        projectName: z.string().min(1),
        annotations: z.array(z.object({
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
const PlaywrightReportSchema = z.object({
  config: z.object({
    projects: z.array(z.object({
      name: z.string().min(1),
      metadata: z.object({
        browserEngine: PlaywrightMetadataValueSchema,
        viewportProfile: PlaywrightMetadataValueSchema,
        viewport: PlaywrightMetadataValueSchema,
      }),
    })).min(1),
  }),
  suites: z.array(PlaywrightSuiteSchema).min(1),
  stats: z.object({ startTime: z.iso.datetime({ offset: true }) }),
});

type ResourceHandle = { name: string };
type ImportContext = {
  logger: {
    info: (message: string, values?: Record<string, unknown>) => void;
  };
  readResource: (name: string) => Promise<unknown | null>;
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

function metadataText(value: string | number | boolean): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return value.toString();
  return value ? "true" : "false";
}

/** Convert the relevant Playwright JSON reporter fields into the public run contract. */
export function normalizePlaywrightReport(
  raw: unknown,
  args: ImportArguments,
  reportSha256 = "0".repeat(64),
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
        const projectName = test.projectName;
        const project = projects.get(projectName);
        if (!project) {
          throw new TypeError(`Unknown Playwright project: ${projectName}`);
        }
        const metadata = project.metadata;
        if (tests.length >= MAX_TESTS) {
          throw new TypeError(`Playwright report exceeds ${MAX_TESTS} tests`);
        }
        tests.push({
          name: spec.title,
          tags: tagsFor(spec.title, spec.tags),
          project: projectName,
          browserEngine: metadataText(metadata.browserEngine),
          viewportProfile: metadataText(metadata.viewportProfile),
          viewport: metadataText(metadata.viewport),
          status: finalStatus(results),
          durationMs: results.reduce(
            (sum, result) => sum + result.duration,
            0,
          ),
          retries: Math.max(...results.map((result) => result.retry)),
          failureMessage: results.at(-1)?.error?.message,
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
    reportSha256,
    authority: "recording-only",
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
  version: "2026.08.24.1",
  globalArguments: z.object({}),
  upgrades: [{
    toVersion: "2026.08.24.1",
    description:
      "Preserve the retained browser-run contract while accepting complete Playwright JSON reports",
    upgradeAttributes: (
      old: Record<string, unknown>,
    ): Record<string, unknown> => old,
  }],
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
        const parsedArgs = ImportArgumentsSchema.parse(args);
        context.logger.info("Importing browser evidence for run {runId}", {
          runId: parsedArgs.runId,
        });
        const stat = await Deno.stat(parsedArgs.reportPath);
        if (!stat.isFile || stat.size > MAX_REPORT_BYTES) {
          throw new TypeError(
            `Playwright report must be a file no larger than ${MAX_REPORT_BYTES} bytes`,
          );
        }
        const bytes = await Deno.readFile(parsedArgs.reportPath);
        const reportSha256 = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        const raw = JSON.parse(new TextDecoder().decode(bytes));
        const run = normalizePlaywrightReport(raw, parsedArgs, reportSha256);
        // Retain the active consumer contract: one versioned stream per environment.
        const name = `browser-${parsedArgs.environment}`;
        const existing = await context.readResource(name);
        if (existing !== null) {
          const prior = BrowserRunSchema.safeParse(existing);
          if (!prior.success) {
            throw new TypeError(
              `Resource ${name} contains invalid browser evidence`,
            );
          }
          if (
            prior.data.runId === run.runId &&
            JSON.stringify(prior.data) !== JSON.stringify(run)
          ) {
            throw new TypeError(
              `Run identity ${parsedArgs.environment}/${parsedArgs.runId} already records different evidence`,
            );
          }
          if (prior.data.runId === run.runId) {
            context.logger.info(
              "Browser evidence for run {runId} already recorded",
              {
                runId: parsedArgs.runId,
              },
            );
            return { dataHandles: [] };
          }
        }
        const handle = await context.writeResource("browser-run", name, run);
        context.logger.info("Recorded browser evidence for run {runId}", {
          runId: parsedArgs.runId,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
