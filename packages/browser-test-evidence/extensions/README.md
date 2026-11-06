# Browser Test Evidence

`@mgreten/browser-test-evidence` imports a Playwright JSON reporter output and
writes one durable `browser-run` resource. It is application-neutral: callers
provide all CI and deployment provenance as method arguments.

## Install and configure

After publishing this handoff repository to the Swamp registry, install it and
create a model instance:

```sh
swamp extension pull @mgreten/browser-test-evidence
swamp model create @mgreten/browser-test-evidence browser-evidence
```

## Import a Playwright report

```sh
swamp model method run browser-evidence importPlaywrightJson \
  --input reportPath=playwright-report.json \
  --input runId=123 \
  --input sha=abc1234 \
  --input branch=main \
  --input runUrl=https://ci.example.test/runs/123 \
  --input environment=ci \
  --input trigger=pull_request \
  --input appUrl=https://app.example.test \
  --input artifactName=playwright-report \
  --input artifactUrl=https://ci.example.test/runs/123/artifacts \
  --input executionStatus=succeeded \
  --input executionExitCode=0
```

Optional `pullRequest` and `deployment` arguments are retained when non-empty.
The report path is read on the machine that executes the model method.

## Output contract

The public resource spec remains `browser-run`. It contains run provenance, the
input report's SHA-256 digest, runner execution status and exit code,
report-level errors, normalized outcome, artifact metadata, computed totals, and
one strict normalized entry per Playwright test. Each test retains its source
file and complete attempt history. `optional-skip`, `stateful`,
`order-seed-isolation`, and `cleanup` annotations become explicit verification
inputs. A test that passes after a failed attempt is `flaky`; `timedOut` and
`interrupted` tests count as failures. Cleanup descriptions `completed`,
`failed`, and `failed: ...` are normalized; all other values are
non-authoritative.

Import is recording-only. It grants no authority to deploy, approve, retry,
advance a factory, or mutate the tested system. Failure messages and report
errors can be sensitive, so consumers must protect retained evidence
accordingly.

Reports are limited to 5 MB and 10,000 tests. IDs are bounded safe identifiers,
and provenance URLs must not contain credentials, query parameters, or
fragments. Each environment uses a spec-distinct resource name
(`browser-run-ci`, `browser-run-production-canary`, and so on) while each new
run creates a resource version. A replay of the same environment/run ID is
idempotent only when its hash-bound normalized evidence is identical; changed
report bytes are rejected even when normalized fields are identical. Conflicting
reuse is rejected before any write. Additional Playwright reporter fields are
ignored. Metadata values use an explicit string/number/boolean union; objects
and arrays are rejected rather than coerced.

## Deterministic verification

`verifyImportedRun` reads the retained `browser-run-<environment>` run and fails
closed unless its run ID, environment, source SHA and branch, runner outcome,
totals, report and artifact digests, required coverage, skip policy, cleanup,
and state isolation all agree. Its required provenance inputs are `environment`,
`runId`, `reportSha256`, `artifactReportSha256`, `sha`, and `branch`. Optional
selectors are `expectedProjects`, `expectedTags`, `expectedClasses`, and
`expectedTestFilesOrCriteria`; `requireCleanup` defaults to false.

```sh
swamp model method run browser-evidence verifyImportedRun \
  --input environment=ci --input runId=123 \
  --input reportSha256=<sha256> --input artifactReportSha256=<sha256> \
  --input sha=abc1234 --input branch=main \
  --input expectedProjects=chromium \
  --input expectedTestFilesOrCriteria=tests/browser/canary.spec.ts
```

A successful call writes the immutable
`browser-verification-<environment>-<runId>` resource under the
`browser-verification` spec. Reusing that identity is rejected rather than
replaced.

`verifyFactoryRun` applies the same checks and additionally requires `workItem`,
`packetVersion`, `planDigest`, `stageCycle`, `runEra`, and at least one
`expectedTestFilesOrCriteria` value. The browser run must not predate `runEra`.
Success writes `browser-verdict-<workItem>-p<packetVersion>-c<stageCycle>` under
the `browser-verdict` spec. That immutable verdict binds evidence to one plan,
candidate, cycle, and run era, but remains browser-evidence authority only: the
owning factory or workflow decides whether and how to advance its lifecycle.

## Migration and compatibility

Version `2026.08.28.1` has a complete upgrade chain from published version
`2026.08.24.1`; global model arguments remain unchanged. Existing retained
resources named `browser-<environment>` are not renamed automatically; import
the next report to establish the spec-distinct `browser-run-<environment>`
stream. Every newly imported run must provide `executionStatus` and
`executionExitCode` and satisfies the strict current schema. Legacy runs are not
eligible for deterministic verification until replaced by a new strict import
with matching provenance and digests.

See [`docs/playwright-json-example.json`](docs/playwright-json-example.json) for
a synthetic input fixture.

## Development

```sh
deno fmt --check
deno lint
deno check extensions/models/browser_test_evidence.ts
deno test
swamp extension fmt extensions/manifest.yaml --check --json
swamp extension quality extensions/manifest.yaml --json
swamp extension push extensions/manifest.yaml --dry-run --json
```

Licensed under the MIT License. See [LICENSE](LICENSE).
