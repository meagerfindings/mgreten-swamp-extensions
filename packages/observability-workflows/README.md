# @mgreten/observability-workflows

A standalone workflow bundle for bounded operational observation. It contains
three generic DAGs: `@mgreten/observability-daily-digest`,
`@mgreten/observability-transition-watchdog`, and
`@mgreten/observability-deliver-transition`.
They accept caller-selected model instances and policies rather than embedding a
provider, deployment target, resource identifier, or transport.

The daily workflow preserves the read → normalize → digest boundary. The
watchdog uses the same boundary before passing normalized evidence to a durable
transition evaluator. That evaluator, not the workflow, decides whether a
condition is new, resolved, or unchanged. Consequently, unchanged states create
no alert intent. A sink is optional: leave `outboxSink` empty to record and
evaluate observations without dispatching notifications.

## Installation

```sh
swamp extension pull @mgreten/observability-workflows
swamp workflow validate @mgreten/observability-daily-digest --json
```

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
observation key. It emits an empty list for repeated state and one intent for a
meaningful change. Set `outboxSink` to a configured notification-outbox
instance and provide a transport model/method to deliver those intents, or
leave it empty for read-only monitoring.

```sh
swamp workflow run @mgreten/observability-transition-watchdog \
  --input-file examples/transition-watchdog-input.yaml
```

## Safety and scope

These workflows perform no remediation, acknowledgement, source mutation, or
transport configuration. The read adapter is responsible for bounded reads and
redaction; the normalizer applies the caller's normalization, severity, and
freshness policy; the evaluator owns deduplication and transition state. The
delivery workflow only enqueues and dispatches evaluator-provided identities.

Licensed under the MIT License. See [LICENSE](LICENSE).
