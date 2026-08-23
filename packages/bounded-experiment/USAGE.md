# Usage

Install or add this repository as an extension source, then create an instance
of `@mgreten/bounded-experiment`. Invoke only `propose` with a safe request ID
and a proposal conforming to `boundedExperimentInputSchema`.

```text
swamp model create @mgreten/bounded-experiment bounded-experiment
swamp model method run bounded-experiment propose --input requestId=proposal-001 --input input='<proposal JSON>'
```

The input must include caller-owned policy maxima, stricter-or-equal experiment
bounds, at least one `stop_and_review` guardrail and stop condition, all four
approval kinds, observed claims linked to evidence IDs, and fresh provenance.
The returned resource is a decision-support record only. A separate authorized
human workflow must decide whether to seek approvals or execute any action.

Run locally:

```text
deno test -A bounded_experiment_test.ts
deno check bounded_experiment.ts
swamp extension fmt manifest.yaml --check --json
swamp extension quality manifest.yaml --json
swamp extension push manifest.yaml --dry-run
```
