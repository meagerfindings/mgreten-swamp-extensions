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

## Normalizer

`normalizeMethod` receives `observations`, `selector`, `window`,
`normalization`, `severityPolicy`, and `freshnessPolicy`. It must emit a stable
normalized observation collection. Each observation needs a deterministic key,
source reference, observed time, normalized state, severity, freshness result,
and evidence reference. Policy values are opaque to the workflow and belong to
the normalizer.

## Digest builder

`digestMethod` receives normalized `observations` plus selector, window,
severity, and freshness policy. It must produce a source-cited digest; it must
not re-read raw sources or mutate them.

## Transition evaluator

`evaluateMethod` receives normalized observations and policy. It owns durable
state keyed by the normalized observation key and emits zero or more transition
intents. An intent must have a stable identity and represent only a state change
(for example opening, resolving, or severity escalation). Re-observation of the
same state must emit no intent. The evaluator must not perform transport I/O.

## Optional notification outbox sink

The delivery workflow uses `@mgreten/notification-outbox`'s
`enqueueNotification` method with transition fields `workItem`, `event`,
`urgency`, `era`, and `payload`. It then invokes
`@mgreten/dispatch-enqueued-notifications`, which ultimately folds delivery
through `drainNotifications`. Configure `transportModel`, `transportMethod`, and
optional `transportOptions`. To disable delivery, leave `outboxSink` empty; the watchdog then
expands no delivery steps while still recording and evaluating transitions.
