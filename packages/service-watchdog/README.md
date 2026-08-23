# `@mgreten/service-watchdog`

Provider-neutral Swamp model for deterministic, **transition-only** service watchdogs. It deliberately has no network, delivery, remediation, or production-mutation capability.

## Boundary

1. `prepareInspection` freezes the retry window and policy before source reads.
2. A caller-owned adapter collects normalized `sourceSnapshots`.
3. `evaluateInspection` evaluates only those snapshots and writes state, incidents, and alert intents.

An `alertIntent` is an output record, not a notification. A separate delivery workflow may consume it. Retries of the same inspection do not create another intent; untrusted/missing/stale/truncated evidence cannot open or resolve an incident.

## Policy

Global arguments parameterize:

- `topology.subjects`: generic keys representing watched subjects.
- `sourceAdapters`: normalized adapter keys and healthy status values.
- `freshness`: snapshot and observation age limits.
- `retry.intervalSeconds`: deterministic plan window.
- `alert`: sustained-unhealthy and urgency policy.

Adapter snapshots contain only `adapterKey`, collection/window times, a truncation flag, and normalized `{ subjectKey, status, observedAt }` observations. Provider clients and provider-specific IDs do not exist in this package.

## Configure

Declare watched subjects, required adapters, freshness limits, retry cadence, and alert thresholds as model arguments:

```yaml
topology:
  subjects:
    - key: api
sourceAdapters:
  - adapterKey: primary-health
    healthyStatuses: [healthy]
    required: true
freshness:
  maxSnapshotAgeSeconds: 300
  maxObservationAgeSeconds: 300
retry:
  intervalSeconds: 60
alert:
  sustainedForSeconds: 120
  openUrgency: high
  resolveUrgency: default
```

## Synthetic test

```sh
deno test --allow-read extensions/models/service_watchdog_test.ts
```

## License

MIT. See [LICENSE](LICENSE).
