# Browser Test Evidence

`@mgreten/browser-test-evidence` imports a Playwright JSON reporter output and writes
one durable `browser-run` resource. It is application-neutral: callers provide all CI
and deployment provenance as method arguments.

## Install and configure

After publishing this handoff repository to the Swamp registry, install it and create a
model instance:

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
  --input artifactUrl=https://ci.example.test/runs/123/artifacts
```

Optional `pullRequest` and `deployment` arguments are retained when non-empty. The
report path is read on the machine that executes the model method.

## Output contract

The public resource spec remains `browser-run`. It contains run provenance, the input
report's SHA-256 digest, artifact metadata, computed totals, and one normalized entry
per Playwright test. It records evidence only and grants no authority to deploy,
approve, retry, or mutate the tested system. A test that passes after more than one
result is `flaky`; `timedOut` and `interrupted` tests count as failures. A `cleanup`
annotation with description `completed` or `failed` is reflected in `cleanupOutcome`;
all other values are `not-applicable`. The final Playwright failure message is retained
for compatibility and diagnosis, so consumers should treat browser-run resources as
potentially sensitive test evidence.

Reports are limited to 5 MB and 10,000 tests. IDs are bounded safe identifiers, and
provenance URLs must not contain credentials, query parameters, or fragments. Each
environment retains its established resource name (`browser-ci`,
`browser-production-canary`, and so on), preserving existing queries while each new run
creates a resource version. A replay of the same environment/run ID is idempotent only
when its hash-bound normalized evidence is identical; conflicting reuse is rejected
before any write. Additional Playwright reporter fields are ignored. Metadata values use
an explicit string/number/boolean union; objects and arrays are rejected rather than
coerced.

See [`docs/playwright-json-example.json`](docs/playwright-json-example.json) for a
synthetic input fixture.

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
