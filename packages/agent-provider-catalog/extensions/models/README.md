# @mgreten/agent-provider-catalog

A pure, deterministic **provider/model catalog with tiered fallback** for
agent-dispatch pipelines. It answers one question — *which CLI-agent provider
and model should a given abstract role bind for this attempt?* — and does so as
a versioned, **caller-supplied** data table rather than as literals scattered
across a workflow.

Every role maps to an ordered list of candidate `{ provider, model, costClass }`
tiers. Tier 0 is the default selection; each subsequent tier is the next
fallback. Roles are **abstract** (`implementer`, `focused-tester`, `reviewer`,
`verifier`, `browser`, `patcher`, `classifier`), so a deployment folds its own
concrete role names (for example distinct review-panel roles) onto abstract
roles with an injected role map. The fallback layer is deliberately
conservative: only the throttling signals `rate-limit` and `session-limit`
advance a provider tier. A contract violation, a genuine test/review failure, an
infrastructure error, or a semantic decline ("ran fine, the agent said no")
never trigger a fallback — those belong to the calling stage's own failure
handling.

This is the data companion to `@mgreten/cli-agent`: the provider set is a local
literal mirror of that extension's provider enum, kept as a literal so this model
carries no runtime dependency on it.

## Installation

```sh
swamp extension pull @mgreten/agent-provider-catalog
```

## Setup

Create an instance and supply your own catalog (the extension ships only a tiny
example — you own the production table). The `roleMap` folds concrete role names
onto abstract roles; it defaults to the identity map over the abstract roles.

```sh
swamp model create catalog @mgreten/agent-provider-catalog \
  --global-arg catalog='{
    "version": "1",
    "roles": {
      "reviewer": {
        "tiers": [
          { "provider": "codex", "model": "gpt-5.5", "costClass": "medium" },
          { "provider": "claude", "model": "opus", "costClass": "high" }
        ]
      },
      "implementer": {
        "tiers": [
          { "provider": "claude", "model": "opus", "costClass": "high" }
        ]
      }
    }
  }' \
  --global-arg roleMap='{ "correctness": "reviewer", "security": "reviewer" }'
```

## Usage

Resolve the effective provider/model an agent step should bind for one
`(workItem, role, attempt)`. With no signal it selects the current tier
byte-for-byte:

```sh
swamp model method run catalog resolveAgentDispatch \
  --arg workItem=WI-42 \
  --arg role=correctness \
  --arg instanceName=review-agent-correctness \
  --arg attempt=1
```

Record a fallback decision for a role that hit a throttling signal:

```sh
swamp model method run catalog recordProviderFallback \
  --arg workItem=WI-42 \
  --arg role=reviewer \
  --arg currentTier=0 \
  --arg signalClass=rate-limit \
  --arg attempt=1
```

## Global Arguments

| Argument        | Type   | Required | Default                            | Description                                                                 |
| --------------- | ------ | -------- | ---------------------------------- | --------------------------------------------------------------------------- |
| `catalog`       | object | yes      | —                                  | The versioned, role-indexed provider/model table (validated per role).      |
| `roleMap`       | object | no       | `{}` (identity over abstract roles)| Folds concrete role names onto abstract catalog roles.                      |
| `signalTagKeys` | object | no       | `{ workItem, phase }`              | Tag-key names the cross-cycle signal feed filters invocations on.           |

## Method: recordProviderFallback

Decide and persist a tiered-fallback decision, keyed idempotently by
`(workItem, role, attempt)`. Fail-closed on an unknown role or signal class
(writes no resource). Does not re-dispatch any stage.

| Argument      | Type   | Required | Default | Description                                                        |
| ------------- | ------ | -------- | ------- | ------------------------------------------------------------------ |
| `workItem`    | string | yes      | —       | Opaque work-item identifier the decision is keyed under.           |
| `role`        | string | yes      | —       | Caller-supplied role (folded to a catalog role via the role map).  |
| `currentTier` | number | no       | `0`     | 0-based tier the failing invocation ran on.                        |
| `signalClass` | string | yes      | —       | The classified invocation signal.                                  |
| `attempt`     | number | no       | `1`     | 1-based attempt number.                                            |
| `options`     | object | no       | —       | Fallback bounds; `{ maxAttempts }` (default 3).                    |

## Method: resolveAgentDispatch

Resolve and persist the effective `{ provider, model, tier }` an agent step
binds this attempt, keyed idempotently by `(workItem, role, attempt)`. The
per-role `instanceName` is recorded untouched, so a fallback can never collapse
distinct-instance roles onto fewer instances.

| Argument       | Type   | Required | Default | Description                                                            |
| -------------- | ------ | -------- | ------- | ---------------------------------------------------------------------- |
| `workItem`     | string | yes      | —       | Opaque work-item identifier the resolution is keyed under.             |
| `role`         | string | yes      | —       | Caller-supplied role (folded via the role map).                        |
| `instanceName` | string | yes      | —       | Per-role agent instance, recorded untouched.                           |
| `attempt`      | number | no       | `1`     | 1-based attempt number.                                                |
| `currentTier`  | number | no       | `0`     | 0-based tier the resolution starts from.                               |
| `signalClass`  | string | no       | —       | Explicit invocation signal; always wins over the auto-read feed.       |
| `phase`        | string | no       | —       | Opt into the cross-cycle feed: read the prior cycle's failed signal.   |
| `options`      | object | no       | —       | Fallback bounds; `{ maxAttempts }` (default 3).                        |

## How It Works

The core is a set of pure functions over a catalog validated by
`AgentCatalogSchema`. `agentCatalogEntry` returns the candidate at a role's tier,
throwing fail-closed on an unknown role or out-of-range tier.
`decideProviderFallback` maps `(role, tier, signalClass, attempt)` to exactly one
disposition — `advance`, `no-fallback`, or `park` — never a silent default, and
records the full from/to/attempt chain plus the catalog and policy versions.
`resolveAgentDispatch` composes selection and fallback into the record an agent
step reads.

Only `rate-limit` and `session-limit` advance a tier. Advancement is bounded
twice: by a role's tier count and by a `maxAttempts` ceiling (default 3), so a
deep catalog can never cause unbounded re-dispatch. When either bound is reached
the decision parks with the chain recorded for a human.

The optional cross-cycle signal feed reads the newest **failed** invocation for
`(workItem, phase)` off a telemetry model and feeds its `failureClass` in
automatically when the caller supplies `phase` but no explicit `signalClass`; a
successful or unclassified invocation yields no signal, so the resolution falls
through to today's byte-identical tier-0 selection.

No live provider defaults are baked in: the catalog is your data. The provider
set mirrors `@mgreten/cli-agent`'s enum as a local literal.

## License

MIT — see LICENSE for details.
