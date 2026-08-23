# Notification Outbox Workflows

`@mgreten/notification-outbox-workflows` packages three transport-neutral
Swamp workflows around the published `@mgreten/notification-outbox` model. It
does not perform transport I/O itself or prescribe a provider. Callers select
the outbox instance, transport instance and method, and fully mapped transport
options. Every send derives `payload` and `idempotencyKey` from that iteration's
notification, so a fan-out cannot reuse another record's message or key. The
outbox remains the owner of deduplication and retry state.

## Install

```sh
swamp extension install @mgreten/notification-outbox
swamp extension install @mgreten/notification-outbox-workflows
```

Install and configure a transport model separately. For example, an ntfy
transport adapter accepts `{ payload, idempotencyKey, options }` and maps those
fields to its provider. These workflows intentionally do not infer transport success from
a provider-specific result resource.

## Workflows

### `@mgreten/send-one-notification`

Accepts one `pending` or `failed` outbox notification plus `outboxModel`,
`transportModel`, `transportMethod`, and optional `transportOptions`. The transport step
allows failure so exactly one explicit drain branch runs: a successful send
supplies `{ delivered: true }`; a failed send supplies `{ delivered: false,
error: "transport delivery failed" }`. The outbox itself preserves terminal
delivery state, rejects stale records, increments failed attempts, and stores
only its fixed safe failure classification.

### `@mgreten/dispatch-enqueued-notifications`

Queries only records emitted by one exact enqueue step: all of
`sourceWorkflowRunId`, `enqueueJobName`, `enqueueStepName`, `outboxModel`,
`outboxModelType`, and `specName == "notification"` must match. It never scans
the global pending queue. Every matching resource is sent through the first
workflow with concurrency one, preserving a conservative, transport-agnostic
delivery order.

### `@mgreten/deliver-thin-watchdog-alert`

Accepts a minimal watchdog transition, enqueues it, and invokes the dispatcher
with `run.id` and its own enqueue job/step names. `opened` and `failed` map to
the outbox `failed` event; `resolved` maps to `completed`. A dedupe hit emits no
fresh output, so there is nothing to dispatch. `outboxPayload` and
`transportOptions` are separate on purpose: the outbox persists only redacted
context while each transport call receives that notification's payload and key.

## Synthetic fixtures and validation

The `fixtures/` files are schema-valid synthetic inputs only; their model names
are deliberately non-routable. Evaluate them without invoking a transport:

```sh
swamp workflow evaluate @mgreten/send-one-notification \
  --input-file fixtures/send-one-notification.json --json
swamp workflow validate --json
```

The published outbox provides at-least-once delivery across the transport and
outbox persistence boundary. Use the `dedupKey` with a transport idempotency
feature when one exists.

## License

MIT. See [LICENSE](LICENSE).
