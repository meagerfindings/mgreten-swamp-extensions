import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  commitPinErrors,
  TEST_RUNNER_PATTERN,
  testResultErrors,
  TestResultSchema,
} from "./test_evidence_validator.ts";

const SHA = "1234567890abcdef1234567890abcdef12345678";

Deno.test("testResultErrors accepts a non-vacuous green result", () => {
  const result = TestResultSchema.parse({
    success: true,
    summary: "3 examples, 0 failures",
    tests_run: 3,
    tests_passed: 3,
    tests_failed: 0,
    files_tested: ["spec/models/example_spec.rb"],
    failures: [],
    commands_run: [
      { command: "bundle exec rspec spec/models/example_spec.rb", exit_code: 0 },
    ],
    tests_missing: [],
    commit_sha: SHA,
    criterion_evidence: [],
  });

  assertEquals(testResultErrors(result), []);
});

Deno.test("testResultErrors rejects failed commands and inconsistent counts", () => {
  const result = TestResultSchema.parse({
    success: true,
    summary: "incorrectly green",
    tests_run: 3,
    tests_passed: 1,
    tests_failed: 0,
    files_tested: [],
    failures: [{ test: "example" }],
    commands_run: [
      { command: "bundle exec rspec", exit_code: 1, summary: "failed" },
    ],
    tests_missing: [],
    commit_sha: SHA,
    criterion_evidence: [],
  });

  assertEquals(testResultErrors(result), [
    "tests_run does not equal tests_passed + tests_failed",
    "validation commands failed: bundle exec rspec",
    "a successful test result cannot contain failures",
  ]);
});

Deno.test("testResultErrors rejects reported tests without a test-runner command", () => {
  const result = TestResultSchema.parse({
    success: true,
    summary: "Reviewed two test files without executing them",
    tests_run: 2,
    tests_passed: 2,
    tests_failed: 0,
    files_tested: ["example.test.ts", "other.test.ts"],
    failures: [],
    commands_run: [
      { command: "git show HEAD", exit_code: 0, summary: "Reviewed diff" },
    ],
    tests_missing: [],
    commit_sha: SHA,
    criterion_evidence: [],
  });

  assertEquals(testResultErrors(result), [
    "tests were reported without a test-runner command",
  ]);
});

Deno.test("TEST_RUNNER_PATTERN recognizes runners across languages", () => {
  for (
    const command of [
      "bundle exec rspec spec/",
      "npx vitest run",
      "npx jest",
      "pytest tests/",
      "cargo nextest run",
      "cucumber features/",
      "mocha test/",
      "npx playwright test",
      "deno test story_test.ts",
    ]
  ) {
    assert(TEST_RUNNER_PATTERN.test(command), `expected match: ${command}`);
  }
  for (const command of ["git show HEAD", "cat README.md", "ls -la"]) {
    assert(!TEST_RUNNER_PATTERN.test(command), `expected no match: ${command}`);
  }
});

function criterionResult() {
  return TestResultSchema.parse({
    success: true,
    summary: "Acceptance criteria passed",
    tests_run: 2,
    tests_passed: 2,
    tests_failed: 0,
    files_tested: ["story_one_test.ts", "story_two_test.ts"],
    failures: [],
    commands_run: [
      { command: "deno test story_one_test.ts", exit_code: 0 },
      { command: "deno test story_two_test.ts", exit_code: 0 },
    ],
    commit_sha: SHA,
    criterion_evidence: [
      {
        criterion_id: "criterion-one",
        status: "passed",
        command_indices: [0],
        test_files: ["story_one_test.ts"],
        summary: "Story one behavior passed",
      },
      {
        criterion_id: "criterion-two",
        status: "passed",
        command_indices: [1],
        test_files: ["story_two_test.ts"],
        summary: "Story two behavior passed",
      },
    ],
  });
}

const expectedCriteria = [
  { id: "criterion-one", storyId: "story-one" },
  { id: "criterion-two", storyId: "story-two" },
];

Deno.test("testResultErrors accepts complete multi-story criterion evidence", () => {
  assertEquals(testResultErrors(criterionResult(), expectedCriteria), []);
});

Deno.test("testResultErrors rejects missing, duplicate, and unknown criteria", () => {
  const missing = criterionResult();
  missing.criterion_evidence.pop();
  assert(
    testResultErrors(missing, expectedCriteria).some((error) =>
      error.includes("missing IDs")
    ),
  );

  const duplicate = criterionResult();
  duplicate.criterion_evidence[1].criterion_id = "criterion-one";
  assert(
    testResultErrors(duplicate, expectedCriteria).some((error) =>
      error.includes("duplicate criterion IDs")
    ),
  );

  const unknown = criterionResult();
  unknown.criterion_evidence[1].criterion_id = "criterion-unknown";
  assert(
    testResultErrors(unknown, expectedCriteria).some((error) =>
      error.includes("unknown IDs")
    ),
  );
  assert(
    testResultErrors(criterionResult(), [
      expectedCriteria[0],
      expectedCriteria[0],
    ]).some((error) => error.includes("expected criteria contain duplicate")),
  );
});

Deno.test("testResultErrors rejects failed criterion evidence", () => {
  const result = criterionResult();
  result.criterion_evidence[0].status = "failed";
  assert(
    testResultErrors(result, expectedCriteria).includes(
      "criterion criterion-one failed",
    ),
  );
});

Deno.test("testResultErrors rejects missing, out-of-range, and failed command references", () => {
  const missing = criterionResult();
  missing.criterion_evidence[0].command_indices = [];
  assert(
    testResultErrors(missing, expectedCriteria).some((error) =>
      error.includes("no command reference")
    ),
  );

  const outOfRange = criterionResult();
  outOfRange.criterion_evidence[0].command_indices = [10];
  assert(
    testResultErrors(outOfRange, expectedCriteria).some((error) =>
      error.includes("out-of-range")
    ),
  );

  const failed = criterionResult();
  failed.commands_run[0].exit_code = 1;
  assert(
    testResultErrors(failed, expectedCriteria).some((error) =>
      error.includes("references failed command")
    ),
  );
});

/**
 * Create a throwaway git repo with a single commit and return its path and
 * HEAD SHA so the commit-pin checks can be exercised against real git output.
 */
async function makeRepo(): Promise<{ path: string; sha: string }> {
  const path = await Deno.makeTempDir();
  const run = async (cmd: string[]) => {
    const out = await new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      cwd: path,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return new TextDecoder().decode(out.stdout).trim();
  };
  await run(["git", "init", "-b", "main"]);
  await run(["git", "config", "user.email", "test@example.com"]);
  await run(["git", "config", "user.name", "Test"]);
  await Deno.writeTextFile(`${path}/file.txt`, "hello\n");
  await run(["git", "add", "."]);
  await run(["git", "commit", "-m", "initial"]);
  const sha = await run(["git", "rev-parse", "HEAD"]);
  return { path, sha };
}

Deno.test("commitPinErrors accepts a clean worktree pinned to the expected commit", async () => {
  const { path, sha } = await makeRepo();
  try {
    const result = TestResultSchema.parse({
      success: true,
      summary: "green",
      tests_run: 1,
      tests_passed: 1,
      tests_failed: 0,
      files_tested: ["file.txt"],
      failures: [],
      commands_run: [{ command: "deno test", exit_code: 0 }],
      tests_missing: [],
      commit_sha: sha,
      criterion_evidence: [],
    });
    assertEquals(await commitPinErrors(result, path, sha, "main"), []);
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

Deno.test("commitPinErrors rejects a dirty tree, wrong branch, and mismatched sha", async () => {
  const { path, sha } = await makeRepo();
  try {
    await Deno.writeTextFile(`${path}/file.txt`, "changed\n");
    const wrongSha = "0000000000000000000000000000000000000000";
    const result = TestResultSchema.parse({
      success: true,
      summary: "green",
      tests_run: 1,
      tests_passed: 1,
      tests_failed: 0,
      files_tested: ["file.txt"],
      failures: [],
      commands_run: [{ command: "deno test", exit_code: 0 }],
      tests_missing: [],
      commit_sha: sha,
      criterion_evidence: [],
    });
    const errors = await commitPinErrors(result, path, wrongSha, "other");
    assert(errors.includes("the test worktree is not clean"));
    assert(errors.includes("HEAD changed after implementation validation"));
    assert(errors.includes("the test checkout is not on the validated branch"));
    assert(
      errors.includes(
        "the tested commit_sha does not match the validated implementation",
      ),
    );
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});
