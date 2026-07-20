# @mgreten/test-evidence-validator

A swamp model that decides whether a body of test evidence can be trusted. It
takes an already-parsed, structured test result — reported counts, the list of
commands that were actually run, and optional per-acceptance-criterion evidence
— and answers two questions at once: is the result internally consistent, and
is it pinned to the exact immutable commit it claims to test? The structural
check recognizes real test-runner invocations across Ruby, JavaScript,
TypeScript, Python, and Rust, so a submission cannot claim green tests while
only having read files or reviewed a diff. The commit-pin check shells out to
`git` in the caller's repository to confirm the worktree is clean, HEAD matches
the expected SHA, the checkout is on the expected branch, and the result's own
recorded `commit_sha` matches. It is deliberately I/O-decoupled: the caller
passes the test result in directly and owns persistence — the model only writes
a single optional verdict resource.

## Installation

```bash
swamp extension pull @mgreten/test-evidence-validator
```

## Setup

Create a model instance. The only global argument controls whether a verdict
resource is written on each run.

```bash
swamp model create evidence-validator \
  --type @mgreten/test-evidence-validator \
  --global-arg persistVerdict=true
```

## Usage

Call `validate` with the parsed test result and the commit/branch it must be
pinned to. The `testResult` object is caller-supplied — validate it against
`TestResultSchema` upstream (for example the output of a test agent) and pass
the parsed value directly.

```bash
swamp model method run evidence-validator validate \
  --arg label=feature-login \
  --arg repoPath=/abs/path/to/worktree \
  --arg expectedHeadSha=1234567890abcdef1234567890abcdef12345678 \
  --arg expectedBranch=main \
  --arg-json testResult='{
    "success": true,
    "summary": "3 examples, 0 failures",
    "tests_run": 3,
    "tests_passed": 3,
    "tests_failed": 0,
    "files_tested": ["spec/models/example_spec.rb"],
    "failures": [],
    "commands_run": [
      { "command": "bundle exec rspec spec/models/example_spec.rb", "exit_code": 0 }
    ],
    "commit_sha": "1234567890abcdef1234567890abcdef12345678",
    "criterion_evidence": []
  }'
```

The returned `verdict` resource has `valid: true` only when both the structural
and commit-pin checks pass with zero errors; otherwise `errors` lists every
violation and `summary` joins them.

## Global Arguments

| Argument         | Type      | Default | Description                                                                                 |
| ---------------- | --------- | ------- | ------------------------------------------------------------------------------------------- |
| `persistVerdict` | `boolean` | `true`  | Write a `verdict` resource keyed by `label`. The caller still owns any richer persistence.  |

## Method: validate

Runs structural validation plus the git commit-pin checks and returns (and
optionally persists) the verdict.

| Argument           | Type                    | Default | Description                                                                        |
| ------------------ | ----------------------- | ------- | ---------------------------------------------------------------------------------- |
| `label`            | path-safe string        | —       | Identifies this evidence submission; keys the verdict resource.                    |
| `repoPath`         | absolute path string    | —       | Absolute path to the repository worktree the evidence was produced in.             |
| `expectedHeadSha`  | 40-char hex Git SHA     | —       | The commit the evidence must be pinned to.                                         |
| `expectedBranch`   | non-empty string        | —       | The branch the worktree must be checked out on.                                    |
| `testResult`       | `TestResult`            | —       | The already-parsed test result to validate (not read from another model).          |
| `expectedCriteria` | array of `{id,storyId}` | `[]`    | Optional acceptance criteria the evidence must fully and uniquely cover.           |

## How It Works

The structural validator rejects a result that reports failure, has any failed
tests, whose `tests_run` does not equal `tests_passed + tests_failed`, that
contains a non-zero-exit command, that claims tests while no recorded command
matches the recognized runner pattern (`test`, `rspec`, `vitest`, `jest`,
`pytest`, `nextest`, `cucumber`, `mocha`, `playwright`), or that is "successful"
yet carries failures. When `expectedCriteria` is supplied it further checks for
duplicate expected IDs, duplicate/unknown/missing evidence IDs, failed
criteria, and command references that are empty, out of range, or point at a
failed command.

The commit-pin step runs `git status --porcelain --untracked-files=all`,
`git rev-parse HEAD`, and `git rev-parse --abbrev-ref HEAD` in `repoPath`, and
compares HEAD and the branch against the expected values as well as the
result's own `commit_sha`. It requires a `git` binary on `PATH` and a real
repository at `repoPath`.

## License

MIT — see LICENSE for details.
