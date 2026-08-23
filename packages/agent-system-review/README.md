# Agent System Review

`@mgreten/agent-system-review` is a deterministic Swamp model that turns
caller-supplied, bounded evidence into ranked proposals for improving an agent
system. It does not collect evidence, call providers or networks, run a factory,
or modify a target. Every proposal remains unapproved and requires a separate
human approval record.

## Contract

The `review` method accepts a versioned input containing exactly four metrics:

- `context_failure_rate`
- `permission_denial_rate`
- `workflow_retry_rate`
- `median_completion_milliseconds`

Each metric has one threshold and one measurement. Available measurements above
their threshold and minimum sample size become proposals. The model ranks them
by weighted excess, applies the declared deterministic tie-break, and limits the
result to `maximumProposals`. The output's `truncated` boolean is `true` exactly
when qualifying proposals were omitted by that cap.

Evidence is bounded to 1–200 records and every measurement may cite at most 20
records. Evidence must be known, unique, and fresh at `evaluatedAt`. Synthetic
fixtures in `extensions/models/agent_system_review_test.ts` demonstrate normal,
stale, unknown, unavailable, duplicate, and authority-boundary cases without
accessing real systems.

## Usage

```bash
swamp extension pull @mgreten/agent-system-review
swamp model create @mgreten/agent-system-review agent-review
swamp model method run agent-review review --input requestId=review-20260823 --input input:json=@review-input.json
```

The only method writes one `review` resource named `review-<requestId>`. The
output's `authority` field is a machine-readable non-authority declaration:
`proposal_only`, no self-modification, no network or provider calls, no factory
calls, and no production changes.

## Development

```bash
deno check extensions/models/agent_system_review.ts
deno test extensions/models/agent_system_review_test.ts
swamp extension fmt manifest.yaml --check --json
swamp extension push manifest.yaml --dry-run --json
```

Licensed under the MIT License. See [LICENSE](LICENSE).
