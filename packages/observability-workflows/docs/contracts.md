# Adapter contracts

The workflows intentionally bind model *instances* at runtime. This makes them
portable across providers and avoids treating any provider's resource model as a
universal contract.

## Read adapter

`readMethod` receives one `request` object:

```yaml
request:
  selector: {}
  window: {}
  options: {}
```

It must perform a bounded, read-only collection and write a data artifact. Its
artifact must include source identity, collection time, selected window,
truncation/limit facts, and any redaction facts. It must not mutate a source.
`readSpecName` must name that artifact's resource spec. Other artifacts emitted
by the same method are excluded from the handoff.

## Normalizer

`normalizeMethod` receives `observations`, `selector`, `window`,
`normalization`, `severityPolicy`, and `freshnessPolicy`. It must emit a stable
normalized observation collection. Each observation needs a deterministic key,
source reference, observed time, normalized state, severity, freshness result,
and evidence reference. Policy values are opaque to the workflow and belong to
the normalizer. `normalizedSpecName` must name this collection's resource spec;
diagnostics and state artifacts under other specs are excluded.

## Digest builder

`digestMethod` receives normalized `observations` plus selector, window,
severity, and freshness policy. It must produce a source-cited digest; it must
not re-read raw sources or mutate them.

## Transition evaluator

`evaluateMethod` receives normalized observations and policy. It owns durable
state keyed by the normalized observation key and emits zero or more transition
intents under `transitionSpecName` (default `transition`). State and diagnostic
artifacts must use other specs. Re-observation of the same state must emit no
intent. The evaluator must not perform transport I/O.

Each transition is already mapped to the notification-outbox vocabulary and
has exactly `{ workItem, event, urgency, era, payload }`. `event` is one of
`approval-needed`, `failed`, or `completed`; `workItem`, `event`, and `era`
together are its stable outbox identity. A newly opened failure or severity
escalation normally maps to `failed`, a resolution to `completed`, and a state
requiring a human decision to `approval-needed`. `payload` must contain only
redacted delivery content.
An evaluator must emit at most one transition per stable outbox identity in a
run so the batch child has unique, resumable step names.

## Optional notification outbox sink

The delivery workflow uses `@mgreten/notification-outbox`'s
`enqueueNotification` method with transition fields `workItem`, `event`,
`urgency`, `era`, and `payload`. It then invokes
`@mgreten/dispatch-enqueued-notifications`, which ultimately folds delivery
through `drainNotifications` via `@mgreten/send-one-notification`. Configure
`transportModel`, `transportMethod`, and optional `transportOptions`. Consumers
may override `sendWorkflow` with a contract-compatible workflow; the default is
the dependency workflow above. To disable delivery, leave `outboxSink` empty; the watchdog then
expands no delivery steps while still recording and evaluating transitions.
When a sink is enabled, the first assertion requires a non-empty transport
model and method before any adapter method executes.

The delivery child dispatches only the notification created by its exact
enqueue run. If enqueue or delivery fails, resume that failed Swamp workflow
run; a new watchdog run intentionally will not recreate an unchanged
transition. Once enqueue succeeds, the outbox record remains the durable retry
authority. Operators must also run their outbox failure-drain policy for failed
records. This bundle does not scan or retry a global pending queue.

The watchdog does not expand a same-run data query directly. After the
evaluator succeeds, it resolves the exact transition artifacts into the
`@mgreten/observability-deliver-transitions` child input. That child expands the
concrete array and invokes the single-transition enqueue/dispatch boundary with
concurrency one. Empty batches are skipped by the parent; the batch child
requires at least one transition and rejects repeated stable outbox identities.
Expanded steps use engine-assigned iteration indexes so malformed duplicate
identities cannot create duplicate DAG node names before the validation step
runs. This ordering is required by Swamp's workflow evaluation semantics.

Adapter, method, model, workflow, and spec identifiers are constrained to a
safe character set before execution. This prevents caller input from changing
the meaning of exact `data.query` predicates and rejects blank delivery targets
before read or enqueue side effects.

The concrete dependency contract verified for this release is
`@mgreten/notification-outbox` type version `2026.08.01.2` and the active
`@mgreten/dispatch-enqueued-notifications` workflow ID
`512aa8fd-1529-4ea6-9a6f-e21699e5ec55`. The dispatch workflow requires exact
enqueue run/job/step coordinates, the outbox model, transport model, and
transport method; it accepts `sendWorkflow` and `transportOptions`. These are
compatibility references, not IDs embedded in the executable workflows.

## Trust boundary

Runtime-selected adapters are trusted capabilities. These workflows enforce
ordering and exact artifact selection, but Swamp grants determine whether a
selected method may mutate an external system. The read-only and redaction
claims therefore require adapters whose reviewed contracts enforce bounded
reads, source non-mutation, and safe output schemas. The workflows never inspect
or sanitize arbitrary artifact fields themselves.

These contracts define a protocol, not an automatic adapter for other method
schemas. A product workflow with prepare-before-read planning, multiple source
collectors, optional source failures, or differently shaped digest/evaluator
inputs should remain the product composition root. It may reuse a child
boundary only after a strict bridge maps native artifacts to that child's exact
schema. Arbitrary input maps and caller-authored field-mapping expressions are
outside this package because they would bypass method-input validation and
weaken the exact artifact boundary.
