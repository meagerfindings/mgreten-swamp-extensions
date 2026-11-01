// MIT License
//
// Copyright (c) 2026 Mat Greten
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * Validator for command-backed test evidence pinned to an immutable Git commit.
 *
 * Given a caller-supplied, already-parsed test result (structured counts,
 * command runs, and per-criterion evidence) plus an expected HEAD commit SHA
 * and branch, this model performs two independent checks and returns a single
 * verdict:
 *
 *   1. **Structural validation** — the reported test result is internally
 *      consistent: the agent reported success, no tests failed, the run/pass/
 *      fail counts add up, every validation command exited zero, and — when
 *      any tests were reported — at least one command actually invoked a
 *      recognized test runner. A multi-language runner regex recognizes
 *      `test`, `rspec`, `vitest`, `jest`, `pytest`, `nextest`, `cucumber`,
 *      `mocha`, and `playwright` invocations, so a result cannot claim green
 *      tests while only having reviewed diffs or read files. When expected
 *      acceptance criteria are supplied, per-criterion evidence is checked for
 *      completeness, duplicates, unknown IDs, failed criteria, and valid
 *      references into the recorded command list.
 *
 *   2. **Commit pinning** — the evidence is bound to the exact commit it claims
 *      to test. The model shells out to `git` in the caller-supplied repository
 *      to confirm the worktree is clean, HEAD equals the expected SHA, the
 *      checkout is on the expected branch, and the result's own recorded
 *      `commit_sha` matches the expected SHA.
 *
 * The model is deliberately free of any orchestration coupling: it does not
 * read the test result from another model and it does not decide where the
 * verdict is persisted. The caller passes the parsed result in directly and
 * owns record persistence. As a convenience, `validate` optionally writes a
 * single `verdict` resource keyed by a caller-supplied label.
 *
 * @module
 */

import { z } from "npm:zod@4";

/**
 * A full 40-character lowercase-hex Git SHA-1 commit identifier.
 */
export const CommitShaSchema: z.ZodString = z.string().regex(
  /^[0-9a-f]{40}$/,
  "commit SHA must be a full 40-character Git SHA-1",
);

/**
 * A path-safe stable identifier (used for acceptance-criterion IDs and for the
 * caller-supplied verdict label). Begins with an alphanumeric and thereafter
 * allows only alphanumerics, hyphens, and underscores.
 */
export const StableIdSchema: z.ZodString = z.string().min(1).regex(
  /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
  "stable ID must be path-safe",
);

/**
 * One command that was executed while producing the test evidence, together
 * with its exit code and an optional human summary.
 */
export const CommandRunSchema: z.ZodObject<{
  command: z.ZodString;
  exit_code: z.ZodNumber;
  summary: z.ZodDefault<z.ZodString>;
}> = z.object({
  command: z.string().min(1),
  exit_code: z.number().int(),
  summary: z.string().default(""),
});

/**
 * A single acceptance criterion the test result is expected to cover, linking
 * a criterion ID to the story it belongs to.
 */
export const ExpectedCriterionSchema: z.ZodObject<{
  id: typeof StableIdSchema;
  storyId: typeof StableIdSchema;
}> = z.object({
  id: StableIdSchema,
  storyId: StableIdSchema,
}).strict();

/**
 * A caller-supplied, structured test result. `criterion_evidence` maps each
 * covered acceptance criterion to its status, the recorded command indices
 * that produced it, and the test files involved.
 */
export const TestResultSchema: z.ZodObject<{
  success: z.ZodBoolean;
  summary: z.ZodString;
  tests_run: z.ZodNumber;
  tests_passed: z.ZodNumber;
  tests_failed: z.ZodNumber;
  files_tested: z.ZodArray<z.ZodString>;
  failures: z.ZodArray<z.ZodUnknown>;
  commands_run: z.ZodArray<typeof CommandRunSchema>;
  tests_missing: z.ZodDefault<z.ZodArray<z.ZodString>>;
  commit_sha: typeof CommitShaSchema;
  criterion_evidence: z.ZodArray<
    z.ZodObject<{
      criterion_id: typeof StableIdSchema;
      status: z.ZodEnum<{ passed: "passed"; failed: "failed" }>;
      command_indices: z.ZodArray<z.ZodNumber>;
      test_files: z.ZodArray<z.ZodString>;
      summary: z.ZodString;
    }>
  >;
}> = z.object({
  success: z.boolean(),
  summary: z.string().min(1),
  tests_run: z.number().int().nonnegative(),
  tests_passed: z.number().int().nonnegative(),
  tests_failed: z.number().int().nonnegative(),
  files_tested: z.array(z.string()),
  failures: z.array(z.unknown()),
  commands_run: z.array(CommandRunSchema).min(1),
  tests_missing: z.array(z.string()).default([]),
  commit_sha: CommitShaSchema,
  criterion_evidence: z.array(
    z.object({
      criterion_id: StableIdSchema,
      status: z.enum(["passed", "failed"]),
      command_indices: z.array(z.number().int().nonnegative()).refine(
        (indices) => new Set(indices).size === indices.length,
        "command_indices must not contain duplicates",
      ),
      test_files: z.array(z.string()),
      summary: z.string().min(1),
    }).strict(),
  ),
});

/**
 * The structured verdict returned by (and optionally persisted from) the
 * `validate` method. `valid` is true only when both structural validation and
 * commit pinning pass with zero errors.
 */
export const VerdictSchema: z.ZodObject<{
  label: z.ZodString;
  valid: z.ZodBoolean;
  errors: z.ZodArray<z.ZodString>;
  expectedHeadSha: typeof CommitShaSchema;
  expectedBranch: z.ZodString;
  testsRun: z.ZodNumber;
  testsPassed: z.ZodNumber;
  testsFailed: z.ZodNumber;
  summary: z.ZodString;
  validatedAt: z.ZodString;
}> = z.object({
  label: StableIdSchema,
  valid: z.boolean(),
  errors: z.array(z.string()),
  expectedHeadSha: CommitShaSchema,
  expectedBranch: z.string().min(1),
  testsRun: z.number().int().nonnegative(),
  testsPassed: z.number().int().nonnegative(),
  testsFailed: z.number().int().nonnegative(),
  summary: z.string(),
  validatedAt: z.string(),
});

/**
 * Regex matching a recognized multi-language test-runner invocation inside a
 * command string. The runner name must appear at a word-ish boundary so that,
 * for example, `git show HEAD` does not count as a test run but
 * `bundle exec rspec spec/` and `npx playwright test` do. Recognized runners
 * span Ruby (`rspec`, `cucumber`), JavaScript/TypeScript (`vitest`, `jest`,
 * `mocha`, `playwright`), Python (`pytest`), Rust (`nextest`), and the generic
 * `test` subcommand.
 */
export const TEST_RUNNER_PATTERN: RegExp =
  /(?:^|[\s/])(test|rspec|vitest|jest|pytest|nextest|cucumber|mocha|playwright)(?=$|[\s:])/i;

/** The result of running a shell command. */
export interface CommandResult {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command in a working directory and capture its exit status, stdout,
 * and stderr (both trimmed).
 */
export async function runCommand(
  command: string[],
  cwd: string,
): Promise<CommandResult> {
  const output = await new Deno.Command(command[0], {
    args: command.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();

  return {
    success: output.success,
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr).trim(),
  };
}

/**
 * Structurally validate a parsed test result, returning a list of human-
 * readable errors. An empty array means the result is internally consistent.
 *
 * When `expectedCriteria` is non-empty, per-criterion evidence is additionally
 * checked for duplicate expected IDs, duplicate/unknown/missing evidence IDs,
 * failed criteria, and command references that are absent, out of range, or
 * point at a failed command.
 */
export function testResultErrors(
  result: z.infer<typeof TestResultSchema>,
  expectedCriteria: z.infer<typeof ExpectedCriterionSchema>[] = [],
): string[] {
  const errors: string[] = [];
  if (!result.success) errors.push("the test agent reported failure");
  if (result.tests_failed > 0) {
    errors.push(`${result.tests_failed} tests failed`);
  }
  if (result.tests_run !== result.tests_passed + result.tests_failed) {
    errors.push("tests_run does not equal tests_passed + tests_failed");
  }
  const failedCommands = result.commands_run.filter((run) =>
    run.exit_code !== 0
  );
  if (failedCommands.length > 0) {
    errors.push(
      `validation commands failed: ${
        failedCommands.map((run) => run.command).join(", ")
      }`,
    );
  }
  if (
    result.tests_run > 0 &&
    !result.commands_run.some((run) => TEST_RUNNER_PATTERN.test(run.command))
  ) {
    errors.push("tests were reported without a test-runner command");
  }
  if (result.success && result.failures.length > 0) {
    errors.push("a successful test result cannot contain failures");
  }
  if (expectedCriteria.length > 0) {
    const expectedIds = expectedCriteria.map((criterion) => criterion.id);
    const duplicateExpectedIds = expectedIds.filter((id, index) =>
      expectedIds.indexOf(id) !== index
    );
    if (duplicateExpectedIds.length > 0) {
      errors.push("expected criteria contain duplicate criterion IDs");
    }

    const evidenceIds = result.criterion_evidence.map((evidence) =>
      evidence.criterion_id
    );
    if (evidenceIds.some((id, index) => evidenceIds.indexOf(id) !== index)) {
      errors.push("criterion evidence contains duplicate criterion IDs");
    }
    const expectedIdSet = new Set(expectedIds);
    const unknownIds = evidenceIds.filter((id) => !expectedIdSet.has(id));
    if (unknownIds.length > 0) {
      errors.push(
        `criterion evidence contains unknown IDs: ${unknownIds.join(", ")}`,
      );
    }
    const evidenceIdSet = new Set(evidenceIds);
    const missingIds = expectedIds.filter((id) => !evidenceIdSet.has(id));
    if (missingIds.length > 0) {
      errors.push(
        `criterion evidence is missing IDs: ${missingIds.join(", ")}`,
      );
    }
    for (const evidence of result.criterion_evidence) {
      if (evidence.status === "failed") {
        errors.push(`criterion ${evidence.criterion_id} failed`);
      }
      if (evidence.command_indices.length === 0) {
        errors.push(
          `criterion ${evidence.criterion_id} has no command reference`,
        );
      }
      for (const index of evidence.command_indices) {
        const command = result.commands_run[index];
        if (!command) {
          errors.push(
            `criterion ${evidence.criterion_id} references out-of-range command index ${index}`,
          );
        } else if (command.exit_code !== 0) {
          errors.push(
            `criterion ${evidence.criterion_id} references failed command index ${index}`,
          );
        }
      }
    }
  }
  return errors;
}

/**
 * Run the commit-pin checks against a repository worktree, appending any
 * violations to `errors`. Confirms the worktree is clean, HEAD equals the
 * expected SHA, the checkout is on the expected branch, and the result's own
 * recorded `commit_sha` matches the expected SHA.
 */
export async function commitPinErrors(
  result: z.infer<typeof TestResultSchema>,
  repoPath: string,
  expectedHeadSha: string,
  expectedBranch: string,
): Promise<string[]> {
  const errors: string[] = [];
  const status = await runCommand(
    ["git", "status", "--porcelain", "--untracked-files=all"],
    repoPath,
  );
  const head = await runCommand(["git", "rev-parse", "HEAD"], repoPath);
  const branch = await runCommand(
    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    repoPath,
  );
  if (!status.success || status.stdout !== "") {
    errors.push("the test worktree is not clean");
  }
  if (!head.success || head.stdout !== expectedHeadSha) {
    errors.push("HEAD changed after implementation validation");
  }
  if (!branch.success || branch.stdout !== expectedBranch) {
    errors.push("the test checkout is not on the validated branch");
  }
  if (result.commit_sha !== expectedHeadSha) {
    errors.push(
      "the tested commit_sha does not match the validated implementation",
    );
  }
  return errors;
}

/** Method execution context provided by swamp at runtime. */
export interface MethodContext {
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
}

/** Global configuration for the test-evidence-validator model. */
export const GlobalArgsSchema: z.ZodObject<{
  persistVerdict: z.ZodDefault<z.ZodBoolean>;
}> = z.object({
  persistVerdict: z.boolean().default(true).describe(
    "Whether validate should write a verdict resource keyed by label (the caller still owns any richer persistence)",
  ),
});

/**
 * The test-evidence-validator swamp model.
 *
 * Exposes a single `validate` method that takes a caller-supplied parsed test
 * result plus the expected commit/branch, runs the structural validator and
 * the git commit-pin checks, and returns (and optionally persists) a verdict.
 */
export const model = {
  type: "@mgreten/test-evidence-validator",
  version: "2026.07.20.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    verdict: {
      description:
        "The pass/fail verdict for one validated test-evidence submission",
      schema: VerdictSchema,
      lifetime: "30d" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    validate: {
      description:
        "Validate a caller-supplied parsed test result against structural rules and commit-pin the evidence to an immutable Git commit",
      arguments: z.object({
        label: StableIdSchema.describe(
          "Path-safe label identifying this evidence submission; keys the verdict resource",
        ),
        repoPath: z.string().min(1).regex(
          /^\//,
          "repoPath must be absolute",
        ).describe(
          "Absolute path to the repository worktree the evidence was produced in",
        ),
        expectedHeadSha: CommitShaSchema.describe(
          "The commit SHA the evidence is expected to be pinned to",
        ),
        expectedBranch: z.string().min(1).describe(
          "The branch name the worktree is expected to be checked out on",
        ),
        testResult: TestResultSchema.describe(
          "The already-parsed test result to validate (caller-supplied, not read from another model)",
        ),
        expectedCriteria: z.array(ExpectedCriterionSchema).default([]).describe(
          "Optional acceptance criteria the evidence must fully cover",
        ),
      }),
      execute: async (
        args: {
          label: string;
          repoPath: string;
          expectedHeadSha: string;
          expectedBranch: string;
          testResult: z.infer<typeof TestResultSchema>;
          expectedCriteria?: z.infer<typeof ExpectedCriterionSchema>[];
        },
        context: MethodContext,
      ): Promise<{ dataHandles: Record<string, unknown>[] }> => {
        context.logger.info("Validating test evidence {label}", {
          label: args.label,
        });

        const errors = testResultErrors(
          args.testResult,
          args.expectedCriteria ?? [],
        );
        const pinErrors = await commitPinErrors(
          args.testResult,
          args.repoPath,
          args.expectedHeadSha,
          args.expectedBranch,
        );
        for (const error of pinErrors) errors.push(error);

        const valid = errors.length === 0;
        const verdict = {
          label: args.label,
          valid,
          errors,
          expectedHeadSha: args.expectedHeadSha,
          expectedBranch: args.expectedBranch,
          testsRun: args.testResult.tests_run,
          testsPassed: args.testResult.tests_passed,
          testsFailed: args.testResult.tests_failed,
          summary: valid ? args.testResult.summary : errors.join("; "),
          validatedAt: new Date().toISOString(),
        };

        if (valid) {
          context.logger.info("Test evidence {label} is valid", {
            label: args.label,
            testsRun: args.testResult.tests_run,
          });
        } else {
          context.logger.warning("Test evidence {label} is invalid", {
            label: args.label,
            errorCount: errors.length,
          });
        }

        const dataHandles: Record<string, unknown>[] = [];
        if (context.globalArgs.persistVerdict) {
          const handle = await context.writeResource(
            "verdict",
            `test-evidence-${args.label}`,
            verdict as unknown as Record<string, unknown>,
          );
          dataHandles.push(handle);
        }
        return { dataHandles };
      },
    },
  },
};
