# `@mgreten/bounded-experiment`

A standalone Swamp model that validates and persists a **recommendation-only**
bounded pricing or positioning experiment proposal. Version: `2026.08.23.1`.

It deterministically normalizes unordered collections and reports sorted
diagnostics. It requires two kinds of evidence (`product_metric` and
`unit_economics`), content-hash provenance, and evidence fresh at both proposal
evaluation time and runtime persistence.

## Authority boundary

`propose` has exactly one side effect: writing a `proposal` resource. The output
declares `recommendation_only` and explicitly prohibits price changes, spend,
publishing, user assignment, network/provider calls, production changes, and
launches. Approval entries are records with `status: "not_requested"`; they do
not grant approval or execute anything.

## Safety contracts

The validator rejects policy-overrun population, duration, spend, revenue
downside, and user-downside bounds; mismatched money units; missing/expired or
time-inconsistent evidence; dangling claims; duplicate identifiers; and approval
applicability/requiredness that disagrees with pricing, spend, publishing, or
launch context. Guardrails and stop conditions can only specify
`stop_and_review`.

## Install and invoke

```text
swamp extension source add /path/to/swamp-bounded-experiment
swamp model create @mgreten/bounded-experiment bounded-experiment
```

```text
swamp model method run bounded-experiment propose \
  --input requestId=proposal-001 \
  --input input='<validated proposal JSON>'
```

Both the caller policy and the evidence are input facts, not capabilities
granted to this extension. Its output must be reviewed in a separate authorized
process before anyone requests approvals or makes a change.

See [USAGE.md](USAGE.md) and [examples](examples/README.md). The package has no
credentials, integrations, HTTP client, filesystem API, execution driver, or
method for acting on a recommendation.
