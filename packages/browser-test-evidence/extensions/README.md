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
  --input sha=abc123 \
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

The public resource spec remains `browser-run`. It contains run provenance, artifact
metadata, computed totals, and one normalized entry per Playwright test. A test that
passes after more than one result is `flaky`; `timedOut` and `interrupted` tests count
as failures. A `cleanup` annotation with description `completed` or `failed` is
reflected in `cleanupOutcome`; all other values are `not-applicable`.

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
