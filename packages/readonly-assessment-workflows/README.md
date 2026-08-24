# Readonly Assessment Workflows

`@mgreten/readonly-assessment-workflows` provides four generic Swamp workflow
templates: decision review, feedback triage, cross-source evidence, and a
quarterly idea gate. They produce bounded, evidence-grounded recommendations;
they do not approve, implement, publish, contact people, or mutate external
systems.

Each workflow is a deterministic `contract assertions → prepare → readonly
provider request → contract assertions → validate` DAG. The feedback workflow
adds deterministic normalization/redaction before preparation. The included workflows use generic `@mgreten/*` model
packages only; no application models or application data contracts are bundled.

## Safety contract

The caller supplies compatible model-instance refs and bounded input. Provider
dispatch is fixed to Amp with the readonly tool profile, a required automatic
sandbox, provider-scoped credentials, and the network mode required by the
standalone validators. The provider must
emit an invocation record including its prompt hash, cwd, provider, model, and
success state. Validation binds that record to the prepared request and fails
closed on a missing field, launch mismatch, malformed response, unsupported
claim, or authority-bearing output.

Network access is fixed to the `allow` launch claim required by the published
standalone assessment contracts; it is never authority. These YAML workflows
verify persisted launch evidence, but cannot themselves enforce an
OS/container/provider sandbox or credential isolation. Those controls remain
the provider runtime's responsibility and must be independently configured.

## Install and configure

```bash
swamp extension pull @mgreten/readonly-assessment-workflows

# Create instances of the generic assessment and readonly-provider packages.
# Use your own bounded input and a policy that requires readonly tools.
swamp workflow run @mgreten/readonly-decision-review \
  --input requestId=decision-2026-q3-01 \
  --input assessmentModel=decision-review \
  --input providerModel=readonly-provider \
  --input input='{"schemaVersion":"1.0","reviewId":"decision-2026-q3-01",...}'
```

See [the provider and assessment contract](docs/CONTRACT.md) and
[`examples/`](examples/) for complete input shapes.

```bash
# Check structural safety before integrating an installed workflow.
swamp workflow validate @mgreten/readonly-decision-review --json
```

## Included workflows

| Workflow | Purpose |
| --- | --- |
| `@mgreten/readonly-decision-review` | Independent persona review of a decision packet. |
| `@mgreten/readonly-feedback-triage` | Normalize/redact feedback, then classify and prioritize it. |
| `@mgreten/readonly-cross-source-evidence` | Cluster evidence while preserving source boundaries and non-causal semantics. |
| `@mgreten/readonly-quarterly-idea-gate` | Rank a bounded idea packet and recommend at most one candidate to an owner. |

Licensed under the MIT License. See [LICENSE](LICENSE).
