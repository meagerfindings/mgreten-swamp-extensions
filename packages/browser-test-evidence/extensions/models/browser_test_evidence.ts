/** Normalize Playwright JSON reports into structured browser-test evidence. */
import { z } from "npm:zod@4";

const MAX_REPORT_BYTES = 5_000_000;
const MAX_TESTS = 10_000;
const MAX_REPORT_ERRORS = 100;
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
  sourceFile: BoundedTextSchema.optional(),
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
  attempts: z.array(z.strictObject({
    status: z.enum(["passed", "failed", "skipped", "timedOut", "interrupted"]),
    durationMs: z.number().int().nonnegative(),
    retry: z.number().int().nonnegative(),
    failureMessage: z.string().min(1).max(10_000).optional(),
  })).min(1),
  skipRequirement: z.enum(["required", "optional"]),
  stateful: z.boolean(),
  orderSeedIsolation: z.boolean(),
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
  executionStatus: z.enum(["succeeded", "failed"]),
  reportSha256: z.string().regex(/^[a-f0-9]{64}$/),
  authority: z.literal("recording-only"),
  executionExitCode: z.number().int().nonnegative(),
  reportErrorMessages: z.array(z.string().min(1).max(10_000)).max(
    MAX_REPORT_ERRORS,
  ),
  outcome: z.enum(["passed", "degraded", "failed"]),
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
const RetainedBrowserTestSchema = BrowserTestSchema.extend({
  attempts: BrowserTestSchema.shape.attempts.optional(),
  skipRequirement: BrowserTestSchema.shape.skipRequirement.optional(),
  stateful: BrowserTestSchema.shape.stateful.optional(),
  orderSeedIsolation: BrowserTestSchema.shape.orderSeedIsolation.optional(),
}).passthrough();
const RetainedBrowserRunSchema = BrowserRunSchema.extend({
  executionStatus: BrowserRunSchema.shape.executionStatus.optional(),
  reportSha256: BrowserRunSchema.shape.reportSha256.optional(),
  authority: BrowserRunSchema.shape.authority.optional(),
  executionExitCode: BrowserRunSchema.shape.executionExitCode.optional(),
  reportErrorMessages: BrowserRunSchema.shape.reportErrorMessages.optional(),
  outcome: BrowserRunSchema.shape.outcome.optional(),
  tests: z.array(RetainedBrowserTestSchema).max(MAX_TESTS),
}).passthrough();

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
  executionStatus: z.enum(["succeeded", "failed"]),
  executionExitCode: z.number().int().nonnegative(),
});

type ImportArguments = z.infer<typeof ImportArgumentsSchema>;
type BrowserTest = z.infer<typeof BrowserTestSchema>;

type BrowserRun = z.infer<typeof BrowserRunSchema>;

/** Expected provenance and coverage used to verify one imported browser run. */
export const VerifyArgumentsSchema = z.strictObject({
  environment: SafeIdSchema,
  runId: SafeIdSchema,
  expectedProjects: z.array(BoundedTextSchema).default([]),
  expectedTags: z.array(z.string().min(1).max(100)).default([]),
  expectedClasses: z.array(BoundedTextSchema).default([]),
  expectedTestFilesOrCriteria: z.array(BoundedTextSchema).default([]),
  requireCleanup: z.boolean().default(false),
  reportSha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifactReportSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sha: z.string().regex(/^[a-fA-F0-9]{7,64}$/),
  branch: BoundedTextSchema,
});
type VerifyArguments = z.input<typeof VerifyArgumentsSchema>;

/** Factory subject bindings added to a deterministic browser-run verification. */
export const FactoryVerifyArgumentsSchema = VerifyArgumentsSchema.safeExtend({
  workItem: SafeIdSchema,
  packetVersion: z.number().int().positive(),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  stageCycle: z.number().int().positive(),
  runEra: z.iso.datetime({ offset: true }),
  expectedTestFilesOrCriteria: z.array(BoundedTextSchema).min(1),
});
type FactoryVerifyArguments = z.input<typeof FactoryVerifyArgumentsSchema>;

const PlaywrightResultSchema = z.object({
  status: z.enum(["passed", "failed", "skipped", "timedOut", "interrupted"]),
  duration: z.number().int().nonnegative(),
  retry: z.number().int().nonnegative(),
  error: z.object({ message: z.string().min(1).max(10_000) }).optional(),
});
type PlaywrightResult = z.infer<typeof PlaywrightResultSchema>;

type PlaywrightSuite = {
  file?: string;
  suites?: PlaywrightSuite[];
  specs?: Array<{
    title: string;
    file?: string;
    tags?: string[];
    tests: Array<{
      projectName: string;
      annotations?: Array<{ type: string; description?: string }>;
      results: PlaywrightResult[];
    }>;
  }>;
};

const PlaywrightSuiteSchema: z.ZodType<PlaywrightSuite> = z.lazy(() =>
  z.object({
    file: BoundedTextSchema.optional(),
    suites: z.array(PlaywrightSuiteSchema).optional(),
    specs: z.array(z.object({
      title: z.string().min(1),
      file: BoundedTextSchema.optional(),
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
  errors: z.array(
    z.object({
      message: z.string().min(1).max(10_000).optional(),
      stack: z.string().min(1).max(10_000).optional(),
      value: z.string().min(1).max(10_000).optional(),
      snippet: z.string().min(1).max(10_000).optional(),
    }).refine(
      (error) =>
        Boolean(error.message || error.stack || error.value || error.snippet),
      "Playwright report error must contain diagnostic text",
    ),
  ).max(MAX_REPORT_ERRORS).optional(),
});

type ResourceHandle = { name: string };
type ImportContext = {
  logger: { info: (message: string, values?: Record<string, unknown>) => void };
  readResource: (name: string) => Promise<unknown | null>;
  writeResource: (
    specName: string,
    name: string,
    data: BrowserRun | BrowserVerification | BrowserVerdict,
  ) => Promise<ResourceHandle>;
};

type VerifyContext = Pick<
  ImportContext,
  "logger" | "readResource" | "writeResource"
>;

const BrowserVerificationSchema = z.strictObject({
  authority: z.literal("deterministic-browser-verification"),
  valid: z.literal(true),
  candidateSha: z.string().regex(/^[a-fA-F0-9]{7,64}$/),
  branch: BoundedTextSchema,
  environment: SafeIdSchema,
  selectedProjects: z.array(BoundedTextSchema),
  selectedTags: z.array(BoundedTextSchema),
  selectedClasses: z.array(BoundedTextSchema),
  selectedTestFilesOrCriteria: z.array(BoundedTextSchema),
  reportSha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifactUrl: PublicUrlSchema,
  ciRunUrl: PublicUrlSchema,
  runId: SafeIdSchema,
  verifiedAt: z.iso.datetime({ offset: true }),
});
type BrowserVerification = z.infer<typeof BrowserVerificationSchema>;

const BrowserVerdictSchema = z.strictObject({
  authority: z.literal("deterministic-browser-verdict"),
  valid: z.literal(true),
  workItem: SafeIdSchema,
  packetVersion: z.number().int().positive(),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  candidateSha: z.string().regex(/^[a-fA-F0-9]{7,64}$/),
  branch: BoundedTextSchema,
  environment: SafeIdSchema,
  selectedProjects: z.array(BoundedTextSchema),
  selectedTags: z.array(BoundedTextSchema),
  selectedClasses: z.array(BoundedTextSchema),
  selectedTestFilesOrCriteria: z.array(BoundedTextSchema).min(1),
  reportSha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifactUrl: PublicUrlSchema,
  ciRunUrl: PublicUrlSchema,
  runId: SafeIdSchema,
  stageCycle: z.number().int().positive(),
  runEra: z.iso.datetime({ offset: true }),
  verifiedAt: z.iso.datetime({ offset: true }),
});
type BrowserVerdict = z.infer<typeof BrowserVerdictSchema>;

function semanticVerification(value: { verifiedAt: string }): string {
  const { verifiedAt: _verifiedAt, ...semanticValue } = value;
  return JSON.stringify(semanticValue);
}

/** Verify that normalized browser evidence satisfies exact provenance and coverage. */
export function verifyBrowserRun(
  raw: unknown,
  args: VerifyArguments,
): BrowserRun {
  const expected = VerifyArgumentsSchema.parse(args);
  const run = BrowserRunSchema.parse(raw);
  const problems: string[] = [];
  if (run.runId !== expected.runId) problems.push("run ID does not match");
  if (run.environment !== expected.environment) {
    problems.push("environment does not match");
  }
  if (run.executionStatus !== "succeeded") {
    problems.push("browser execution or infrastructure failed");
  }
  if (
    run.executionExitCode !== 0 || run.reportErrorMessages.length > 0 ||
    run.outcome !== "passed"
  ) {
    problems.push("browser report records a failed or degraded outcome");
  }
  if (run.tests.length <= 0) problems.push("report contains no tests");
  const actualTotals = {
    total: run.tests.length,
    passed: run.tests.filter((test) => test.status === "passed").length,
    failed:
      run.tests.filter((test) =>
        ["failed", "timedOut", "interrupted"].includes(test.status)
      ).length,
    flaky: run.tests.filter((test) => test.status === "flaky").length,
    skipped: run.tests.filter((test) => test.status === "skipped").length,
  };
  if (JSON.stringify(run.totals) !== JSON.stringify(actualTotals)) {
    problems.push("recorded totals do not match test results");
  }
  if (actualTotals.failed !== 0) {
    problems.push(`${actualTotals.failed} tests failed or errored`);
  }
  if (actualTotals.flaky !== 0) {
    problems.push(`${actualTotals.flaky} tests passed only after retry`);
  }
  const requiredSkips = run.tests.filter((test) =>
    test.status === "skipped" && test.skipRequirement === "required"
  );
  if (requiredSkips.length > 0) {
    problems.push(`${requiredSkips.length} required tests skipped`);
  }
  if (
    run.tests.some((test) =>
      (expected.requireCleanup ||
        (test.stateful && test.status !== "skipped")) &&
      test.cleanupOutcome !== "completed"
    )
  ) {
    problems.push("required cleanup failed or was not reported");
  }
  if (
    run.tests.some((test) =>
      test.stateful && test.status !== "skipped" && !test.orderSeedIsolation
    )
  ) {
    problems.push(
      "stateful persistent suite lacks order/seed isolation evidence",
    );
  }
  const passedTests = run.tests.filter((test) => test.status === "passed");
  const projects = new Set(passedTests.map((test) => test.project));
  const tags = new Set(passedTests.flatMap((test) => test.tags));
  for (const project of expected.expectedProjects) {
    if (!projects.has(project)) problems.push(`missing project: ${project}`);
  }
  for (const tag of expected.expectedTags) {
    const normalized = tag.startsWith("@") ? tag : `@${tag}`;
    if (!tags.has(normalized)) problems.push(`missing tag: ${normalized}`);
  }
  for (const testClass of expected.expectedClasses) {
    if (!passedTests.some((test) => test.name === testClass)) {
      problems.push(`missing class: ${testClass}`);
    }
  }
  for (const fileOrCriterion of expected.expectedTestFilesOrCriteria) {
    if (
      !passedTests.some((test) =>
        test.sourceFile === fileOrCriterion || test.name === fileOrCriterion
      )
    ) {
      problems.push(`missing test file or criterion: ${fileOrCriterion}`);
    }
  }
  if (
    run.reportSha256 !== expected.reportSha256 ||
    expected.reportSha256 !== expected.artifactReportSha256
  ) {
    problems.push("report/artifact digest mismatch");
  }
  if (run.sha.toLowerCase() !== expected.sha.toLowerCase()) {
    problems.push("source SHA does not match");
  }
  if (expected.branch && run.branch !== expected.branch) {
    problems.push("source branch does not match");
  }
  if (problems.length > 0) {
    throw new TypeError(
      `Browser evidence verification failed: ${problems.join("; ")}`,
    );
  }
  return run;
}

function tagsFor(title: string, supplied: string[] | undefined): string[] {
  return [
    ...new Set([
      ...(supplied ?? []).map((tag) => tag.startsWith("@") ? tag : `@${tag}`),
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
  if (
    annotation.description?.startsWith("failed:") ||
    annotation.description === "failed"
  ) return "failed";
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

function retainedEvidence(
  run: z.infer<typeof RetainedBrowserRunSchema>,
  legacyShape?: z.infer<typeof RetainedBrowserRunSchema>,
): unknown {
  const {
    authority: _authority,
    executionStatus = "succeeded",
    ...evidence
  } = run;
  const retained: Record<string, unknown> = { ...evidence, executionStatus };
  for (
    const field of [
      "executionExitCode",
      "reportErrorMessages",
      "outcome",
    ] as const
  ) {
    if (legacyShape && legacyShape[field] === undefined) delete retained[field];
  }
  return retained;
}

async function readBoundedReport(path: string): Promise<Uint8Array> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch (error) {
    throw new TypeError(
      `Unable to open Playwright report ${JSON.stringify(path)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    const bytes = new Uint8Array(MAX_REPORT_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = await file.read(bytes.subarray(offset));
      if (count === null) break;
      offset += count;
    }
    if (offset > MAX_REPORT_BYTES) {
      throw new TypeError(
        `Playwright report ${
          JSON.stringify(path)
        } exceeds ${MAX_REPORT_BYTES} bytes`,
      );
    }
    return bytes.subarray(0, offset);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(
      `Unable to read Playwright report ${JSON.stringify(path)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    file.close();
  }
}

/** Normalize a bounded Playwright JSON report into durable browser evidence. */
export function normalizePlaywrightReport(
  raw: unknown,
  args: ImportArguments,
  reportSha256 = "0".repeat(64),
): BrowserRun {
  const argsValue = ImportArgumentsSchema.parse(args);
  const report = PlaywrightReportSchema.parse(raw);
  const projects = new Map(
    report.config.projects.map((project) => [project.name, project]),
  );
  const tests: BrowserTest[] = [];

  const visit = (suite: PlaywrightSuite, inheritedFile?: string): void => {
    const suiteFile = suite.file ?? inheritedFile;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        const results = test.results;
        const projectName = test.projectName;
        const project = projects.get(projectName);
        if (!project) {
          throw new TypeError(`Unknown Playwright project: ${projectName}`);
        }
        if (tests.length >= MAX_TESTS) {
          throw new TypeError(`Playwright report exceeds ${MAX_TESTS} tests`);
        }
        const metadata = project.metadata;
        tests.push({
          name: spec.title,
          sourceFile: spec.file ?? suiteFile,
          tags: tagsFor(spec.title, spec.tags),
          project: projectName,
          browserEngine: metadataText(metadata.browserEngine),
          viewportProfile: metadataText(metadata.viewportProfile),
          viewport: metadataText(metadata.viewport),
          status: finalStatus(results),
          durationMs: results.reduce((sum, result) => sum + result.duration, 0),
          retries: Math.max(...results.map((result) => result.retry)),
          attempts: results.map((result) => ({
            status: result.status,
            durationMs: result.duration,
            retry: result.retry,
            failureMessage: result.error?.message,
          })),
          skipRequirement: test.annotations?.some((item) =>
              item.type === "optional-skip"
            )
            ? "optional"
            : "required",
          stateful: test.annotations?.some((item) =>
            item.type === "stateful"
          ) ?? false,
          orderSeedIsolation: test.annotations?.some((item) =>
            item.type === "order-seed-isolation"
          ) ?? false,
          failureMessage: results.at(-1)?.error?.message,
          cleanupOutcome: cleanupOutcome(test.annotations),
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child, suiteFile);
  };
  for (const suite of report.suites) visit(suite);
  if (tests.length === 0) {
    throw new TypeError("Playwright report contains no tests");
  }
  const reportErrorMessages = (report.errors ?? []).map((error) =>
    error.message ?? error.stack ?? error.value ?? error.snippet!
  );
  const noExecutedTests = tests.every((test) => test.status === "skipped");
  const failed = argsValue.executionExitCode !== 0 ||
    noExecutedTests ||
    tests.some((test) =>
      ["failed", "timedOut", "interrupted"].includes(test.status) ||
      test.cleanupOutcome === "failed"
    ) || reportErrorMessages.length > 0;
  const outcome = failed
    ? "failed"
    : tests.some((test) => test.status === "flaky")
    ? "degraded"
    : "passed";

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
    executionStatus: argsValue.executionStatus,
    reportSha256,
    authority: "recording-only",
    executionExitCode: argsValue.executionExitCode,
    reportErrorMessages,
    outcome,
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

/** Swamp model for importing and deterministically verifying browser evidence. */
export const model = {
  type: "@mgreten/browser-test-evidence",
  version: "2026.08.28.1",
  globalArguments: z.object({}),
  upgrades: [
    {
      toVersion: "2026.08.24.1",
      description:
        "Preserve the retained browser-run contract while accepting complete Playwright JSON reports",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.08.26.1",
      description:
        "Add fail-closed semantic verification and trustworthy execution outcomes",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.08.26.2",
      description:
        "Version bump for global-argument compatibility; retained resources are not migrated",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.08.26.3",
      description:
        "Bind browser reports to the test runner outcome and retain exact source-file coverage",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => ({
        ...old,
        executionStatus: old.executionStatus ?? "succeeded",
      }),
    },
    {
      toVersion: "2026.08.26.4",
      description:
        "Bind runner exit code, report errors, and normalized outcome alongside immutable browser evidence",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.08.26.5",
      description:
        "Read historical browser streams while requiring strict evidence for every new run",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.08.27.1",
      description:
        "Accept additive fields from newer retained browser evidence",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.08.28.1",
      description:
        "Release strict normalized evidence with spec-distinct names, exact-byte replay binding, and deterministic immutable verification contracts",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
  ],
  resources: {
    "browser-run": {
      description:
        "Structured Playwright run evidence with project, viewport, retry, failure, cleanup, and CI provenance",
      schema: BrowserRunSchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
    "browser-verification": {
      description:
        "Immutable deterministic verification of one browser run; not factory lifecycle authority",
      schema: BrowserVerificationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
    "browser-verdict": {
      description:
        "Immutable deterministic verdict bound to a factory plan, candidate, cycle, and browser evidence",
      schema: BrowserVerdictSchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
  },
  methods: {
    verifyImportedRun: {
      description:
        "Fail closed unless an imported browser run is successful and has the expected provenance and coverage",
      arguments: VerifyArgumentsSchema,
      execute: async (
        args: VerifyArguments,
        context: VerifyContext,
      ): Promise<{ dataHandles: ResourceHandle[] }> => {
        const parsedArgs = VerifyArgumentsSchema.parse(args);
        context.logger.info("Starting imported browser run verification", {
          method: "verifyImportedRun",
          environment: parsedArgs.environment,
          runId: parsedArgs.runId,
        });
        const name = `browser-run-${parsedArgs.environment}`;
        const existing = await context.readResource(name);
        if (existing === null) {
          throw new TypeError(
            `Browser evidence resource ${name} does not exist`,
          );
        }
        const run = verifyBrowserRun(existing, parsedArgs);
        const verification: BrowserVerification = BrowserVerificationSchema
          .parse({
            authority: "deterministic-browser-verification",
            valid: true,
            candidateSha: parsedArgs.sha,
            branch: parsedArgs.branch,
            environment: parsedArgs.environment,
            selectedProjects: parsedArgs.expectedProjects,
            selectedTags: parsedArgs.expectedTags.map((tag) =>
              tag.startsWith("@") ? tag : `@${tag}`
            ),
            selectedClasses: parsedArgs.expectedClasses,
            selectedTestFilesOrCriteria: parsedArgs.expectedTestFilesOrCriteria,
            reportSha256: run.reportSha256,
            artifactUrl: run.artifact.url,
            ciRunUrl: run.runUrl,
            runId: run.runId,
            verifiedAt: new Date().toISOString(),
          });
        const verificationName =
          `browser-verification-${parsedArgs.environment}-${parsedArgs.runId}`;
        const existingVerification = await context.readResource(
          verificationName,
        );
        if (existingVerification !== null) {
          const prior = BrowserVerificationSchema.safeParse(
            existingVerification,
          );
          if (
            !prior.success ||
            semanticVerification(prior.data) !==
              semanticVerification(verification)
          ) {
            throw new TypeError(
              `Immutable browser verification conflicts with replay: ${verificationName}`,
            );
          }
          context.logger.info(
            "Completed imported browser run verification",
            {
              method: "verifyImportedRun",
              environment: parsedArgs.environment,
              runId: parsedArgs.runId,
            },
          );
          return { dataHandles: [] };
        }
        const handle = await context.writeResource(
          "browser-verification",
          verificationName,
          verification,
        );
        context.logger.info("Completed imported browser run verification", {
          method: "verifyImportedRun",
          environment: parsedArgs.environment,
          runId: parsedArgs.runId,
        });
        return { dataHandles: [handle] };
      },
    },
    verifyFactoryRun: {
      description:
        "Persist an immutable browser verdict bound to an exact factory plan, candidate, cycle, and run era",
      arguments: FactoryVerifyArgumentsSchema,
      execute: async (
        args: FactoryVerifyArguments,
        context: VerifyContext,
      ): Promise<{ dataHandles: ResourceHandle[] }> => {
        const parsedArgs = FactoryVerifyArgumentsSchema.parse(args);
        context.logger.info("Starting factory browser run verification", {
          method: "verifyFactoryRun",
          environment: parsedArgs.environment,
          runId: parsedArgs.runId,
        });
        const name = `browser-run-${parsedArgs.environment}`;
        const existing = await context.readResource(name);
        if (existing === null) {
          throw new TypeError(
            `Browser evidence resource ${name} does not exist`,
          );
        }
        const run = verifyBrowserRun(existing, {
          environment: parsedArgs.environment,
          runId: parsedArgs.runId,
          expectedProjects: parsedArgs.expectedProjects,
          expectedTags: parsedArgs.expectedTags,
          expectedClasses: parsedArgs.expectedClasses,
          expectedTestFilesOrCriteria: parsedArgs.expectedTestFilesOrCriteria,
          requireCleanup: parsedArgs.requireCleanup,
          reportSha256: parsedArgs.reportSha256,
          artifactReportSha256: parsedArgs.artifactReportSha256,
          sha: parsedArgs.sha,
          branch: parsedArgs.branch,
        });
        if (Date.parse(run.runAt) < Date.parse(parsedArgs.runEra)) {
          throw new TypeError(
            "Browser evidence verification failed: run predates current run era",
          );
        }
        const verdict: BrowserVerdict = BrowserVerdictSchema.parse({
          authority: "deterministic-browser-verdict",
          valid: true,
          workItem: parsedArgs.workItem,
          packetVersion: parsedArgs.packetVersion,
          planDigest: parsedArgs.planDigest,
          candidateSha: parsedArgs.sha,
          branch: parsedArgs.branch,
          environment: parsedArgs.environment,
          selectedProjects: parsedArgs.expectedProjects,
          selectedTags: parsedArgs.expectedTags.map((tag) =>
            tag.startsWith("@") ? tag : `@${tag}`
          ),
          selectedClasses: parsedArgs.expectedClasses,
          selectedTestFilesOrCriteria: parsedArgs.expectedTestFilesOrCriteria,
          reportSha256: run.reportSha256,
          artifactUrl: run.artifact.url,
          ciRunUrl: run.runUrl,
          runId: run.runId,
          stageCycle: parsedArgs.stageCycle,
          runEra: parsedArgs.runEra,
          verifiedAt: new Date().toISOString(),
        });
        const verdictName =
          `browser-verdict-${parsedArgs.workItem}-p${parsedArgs.packetVersion}-c${parsedArgs.stageCycle}`;
        const existingVerdict = await context.readResource(verdictName);
        if (existingVerdict !== null) {
          const prior = BrowserVerdictSchema.safeParse(existingVerdict);
          if (
            !prior.success ||
            semanticVerification(prior.data) !== semanticVerification(verdict)
          ) {
            throw new TypeError(
              `Immutable browser verdict conflicts with replay: ${verdictName}`,
            );
          }
          context.logger.info(
            "Completed factory browser run verification",
            {
              method: "verifyFactoryRun",
              environment: parsedArgs.environment,
              runId: parsedArgs.runId,
            },
          );
          return { dataHandles: [] };
        }
        const handle = await context.writeResource(
          "browser-verdict",
          verdictName,
          verdict,
        );
        context.logger.info("Completed factory browser run verification", {
          method: "verifyFactoryRun",
          environment: parsedArgs.environment,
          runId: parsedArgs.runId,
        });
        return { dataHandles: [handle] };
      },
    },
    importPlaywrightJson: {
      description:
        "Normalize a Playwright JSON report and persist it as versioned browser test evidence",
      arguments: ImportArgumentsSchema,
      execute: async (
        args: ImportArguments,
        context: ImportContext,
      ): Promise<{ dataHandles: ResourceHandle[] }> => {
        const parsedArgs = ImportArgumentsSchema.parse(args);
        context.logger.info("Starting Playwright JSON import", {
          method: "importPlaywrightJson",
          environment: parsedArgs.environment,
          runId: parsedArgs.runId,
        });
        const bytes = await readBoundedReport(parsedArgs.reportPath);
        const digestInput = new Uint8Array(bytes.byteLength);
        digestInput.set(bytes);
        const reportSha256 = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput)),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        let raw: unknown;
        try {
          raw = JSON.parse(new TextDecoder().decode(bytes));
        } catch (error) {
          throw new TypeError(
            `Invalid Playwright JSON in ${
              JSON.stringify(parsedArgs.reportPath)
            }: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const run = normalizePlaywrightReport(raw, parsedArgs, reportSha256);
        const name = `browser-run-${parsedArgs.environment}`;
        const existing = await context.readResource(name);
        if (existing !== null) {
          const prior = RetainedBrowserRunSchema.safeParse(existing);
          if (!prior.success) {
            throw new TypeError(
              `Resource ${name} contains invalid browser evidence`,
            );
          }
          if (
            prior.data.runId === run.runId &&
            JSON.stringify(retainedEvidence(prior.data, prior.data)) !==
              JSON.stringify(retainedEvidence(run, prior.data))
          ) {
            throw new TypeError(
              `Run identity ${parsedArgs.environment}/${parsedArgs.runId} already records different evidence`,
            );
          }
          if (prior.data.runId === run.runId) {
            context.logger.info(
              "Completed Playwright JSON import",
              {
                method: "importPlaywrightJson",
                environment: parsedArgs.environment,
                runId: parsedArgs.runId,
              },
            );
            return { dataHandles: [] };
          }
        }
        const handle = await context.writeResource("browser-run", name, run);
        context.logger.info("Completed Playwright JSON import", {
          method: "importPlaywrightJson",
          environment: parsedArgs.environment,
          runId: parsedArgs.runId,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
