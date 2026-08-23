# @mgreten/observability-workflows

A standalone workflow bundle for bounded operational observation. It contains
four generic DAGs: `@mgreten/observability-daily-digest`,
`@mgreten/observability-transition-watchdog`, and
the batch and single-record delivery boundaries
`@mgreten/observability-deliver-transitions` and
`@mgreten/observability-deliver-transition`.
They accept caller-selected model instances and policies rather than embedding a
provider, deployment target, resource identifier, or transport.

The daily workflow preserves the read → normalize → digest boundary. The
watchdog uses the same boundary before passing normalized evidence to a durable
transition evaluator. That evaluator, not the workflow, decides whether a
condition is new, resolved, or unchanged. Consequently, unchanged states create
no alert intent. A sink is optional: leave `outboxSink` empty to record and
evaluate observations without dispatching notifications.

## Local installation before publication

```sh
swamp extension source add /path/to/swamp-observability-workflows/workflows --only workflows
swamp workflow validate @mgreten/observability-daily-digest --json
```

After a registry release exists, consumers may instead pull the package by
name. Install compatible `@mgreten/notification-outbox` and
`@mgreten/notification-outbox-workflows` sources before enabling delivery.

## Compatibility boundary

This package is generic over the method and artifact protocols documented in
[`docs/contracts.md`](docs/contracts.md). It does not adapt arbitrary model
method schemas and is not a drop-in parent workflow for every observability
package. A consumer's selected models must implement the matching protocol, or
the consumer must retain a product-specific composition workflow and use a
small, strict bridge for compatible child boundaries.

| Capability | Required protocol | Known standalone package status |
| --- | --- | --- |
| Read | `request: { selector, window, options }` and one selected artifact spec | No bundled implementation |
| Normalize | `observations` plus selector/window/policy inputs and one selected normalized spec | `@mgreten/operational-triage` uses its stricter native `{ snapshot }` contract; not directly compatible |
| Digest | `observations` plus selector/window/policy inputs | `@mgreten/daily-operational-digest` uses six explicit neutral sections; not directly compatible |
| Transitions | `observations` plus selector/window/policy inputs and exact outbox-shaped intents | `@mgreten/service-watchdog` requires prepare-before-read and `{ sourceSnapshots }`; not directly compatible |
| Delivery | `{ workItem, event, urgency, era, payload }` | Compatible with `@mgreten/notification-outbox` and `@mgreten/notification-outbox-workflows` |

Do not weaken model schemas to opaque maps merely to make a workflow validate.
Keep provider credentials, product policy, multi-source planning, and optional
source behavior in the consumer's composition root. Bridge models should only
perform deterministic, zero-authority shape conversion and must not re-fetch
sources or duplicate transition state.

The delivery path interoperates with `@mgreten/notification-outbox` and
`@mgreten/notification-outbox-workflows`, using their `enqueueNotification` and
`drainNotifications` lifecycle. Read, normalization, digest, and
transition-evaluator instances are caller-owned generic adapters. Their method
contracts are documented in [docs/contracts.md](docs/contracts.md).

## Run a daily digest

Create instances that implement the documented contracts, then pass their names
and selectors at runtime. The example is intentionally synthetic and has no
provider-specific configuration.

```sh
swamp workflow run @mgreten/observability-daily-digest \
  --input-file examples/daily-digest-input.yaml
```

## Run a transition-only watchdog

The transition evaluator must durably remember its last state per stable
observation key. It emits no transition resource for repeated state and one
delivery-ready transition resource for a meaningful change. Set `outboxSink`
to a configured notification-outbox instance and provide a transport
model/method to deliver those intents, or leave it empty for read-only
monitoring.

```sh
swamp workflow run @mgreten/observability-transition-watchdog \
  --input-file examples/transition-watchdog-input.yaml
```

## Safety and scope

These workflows contain no built-in remediation, acknowledgement, source
mutation, or transport configuration. Runtime-selected model methods remain
trusted capabilities governed by Swamp grants; callers must select reviewed
read-only adapters to preserve that boundary. The read adapter is responsible
for bounded reads and redaction; the normalizer applies the caller's
normalization, severity, and freshness policy; the evaluator owns deduplication
and transition state. Exact model and spec filters prevent unrelated artifacts
from crossing each handoff. The delivery workflow only enqueues and dispatches
evaluator-provided identities. The watchdog resolves same-run transition data
after evaluation and passes it to the batch child; the child performs the
`forEach` expansion only after receiving that concrete array.

If delivery fails after transition state is recorded, resume the failed Swamp
workflow run or use the configured outbox failure-drain policy. A new watchdog
run does not repeat an unchanged transition and is not a delivery retry.

Licensed under the MIT License. See [LICENSE](LICENSE).
