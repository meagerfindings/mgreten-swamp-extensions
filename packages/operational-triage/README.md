# Operational Triage

`@mgreten/operational-triage` validates and persists a deterministic,
provider-neutral operational-triage snapshot. It does not fetch data, use
credentials, invoke tools, or perform remediation.

## Contract and use

Pass a complete `snapshot` to `normalizeSnapshot`. This model is an attestation
validator, not a redactor. It validates producer claims (`applied`,
`rawLogsRetained`, sensitivity and aggregate bounds), rejects unknown fields
and a bounded denylist of common credential, personal-data, URL, and IP
patterns, and writes exactly one `snapshot` resource named
`snapshot-<snapshotId>`.

Passing validation is not a general content-level confidentiality or PII
guarantee. Producers must redact arbitrary identifying facets and confidential
references before submission. Only `public` and `internal` source references
are accepted; account identifiers and confidential/restricted references are
outside this contract.

The snapshot contract supports incident, error, log-aggregate, heartbeat,
monitor, and trend records. Provider adapters belong outside this extension:
they must create this bounded public snapshot before calling the model.

Configure an instance with no global arguments, then pass the complete envelope
as the method's `snapshot` argument. For example, a minimal healthy result can
contain no records while still reporting the producer's bounds and redaction
work:

```json
{
  "snapshot": {
    "schemaVersion": "1.0",
    "snapshotId": "triage-20260823-1",
    "generatedAt": "2026-08-23T11:00:00Z",
    "records": [],
    "filtering": {
      "policy": "exact-resource-identity-allowlist",
      "includedCount": 0,
      "excludedCount": 0,
      "excludedByReason": { "identityNotAllowed": 0, "missingIdentity": 0 }
    },
    "limits": {
      "maxRows": 100,
      "maxBytes": 100000,
      "maxWindowSeconds": 3600,
      "rowsRead": 0,
      "bytesRead": 0,
      "windowStartedAt": "2026-08-23T10:00:00Z",
      "windowEndedAt": "2026-08-23T11:00:00Z",
      "truncated": false
    },
    "redaction": {
      "method": "deterministic-secret-and-identifier-redaction",
      "methodVersion": "1",
      "applied": true,
      "rawLogsRetained": false,
      "replacementCount": 0
    },
    "authority": {
      "mode": "read-only",
      "sideEffects": "none",
      "remediation": "prohibited",
      "mayAcknowledgeIncidents": false,
      "mayModifyMonitors": false
    },
    "escalation": { "disposition": "none", "evidenceIds": [], "rationale": null }
  }
}
```

Successful normalization writes `snapshot-<snapshotId>` with a 30-day
lifetime. Replaying the identical snapshot is a no-op; reusing a snapshot ID
with different content fails closed. Validation failures write nothing and
include stable diagnostics.

Snapshot IDs are restricted to resource-safe letters, numbers, `:`, `.`, `_`,
and `-`. Included plus excluded source-record counts cannot exceed `rowsRead`.
Evidence IDs must be unique within each record and escalation, and one
`sourceId` cannot describe multiple source identities in the same snapshot.

## Allowlist requirements

The producer is responsible for enforcing its allowlist before it constructs a
snapshot. Each source reference must carry an exact `system`, `resourceType`,
and `resourceId`; never substitute a display name or prefix match. Set
`filtering.policy` to `exact-resource-identity-allowlist`, retain only exact
matches, and report all exclusions through `identityNotAllowed` or
`missingIdentity`. Do not include raw resource IDs, URLs, or provider payloads
unless they have been explicitly approved for the public contract.

## Freshness requirements

Each record's `sourceReference.freshness.asOf` must be no later than
`generatedAt`, and `expiresAt` must be at or after it. The snapshot window must
end no later than `generatedAt`, and must not exceed `limits.maxWindowSeconds`.
Collection and freshness attestations must fall within the snapshot window.
Expired evidence is rejected, so consumers cannot mistake stale data for a
current triage result. `observedAt` may predate the window for a still-active
incident, but it cannot be later than the freshness attestation.

## Failure and replay behavior

Schema, leakage, consistency, freshness, and replay-conflict failures occur
before a write and return stable diagnostics where validation is involved. A
storage failure is propagated and is never reported as success. Identical
replay returns no new data handle. Callers should retry only the exact same
snapshot; changing content requires a new `snapshotId`.

## Moment Savor compatibility

Moment Savor's active `@mgreten/better-stack-triage` is a provider adapter with
`normalizeReadSnapshots` and a Better Stack-specific input contract. This
extension has a different type identity and intentionally exposes only
`normalizeSnapshot`; it is additive, not a drop-in replacement. A future
integration should keep the Better Stack collector/adapter, pass its already
normalized snapshot to a separately configured `@mgreten/operational-triage`
instance, then migrate downstream consumers only after contract fixtures prove
field-for-field compatibility. Existing model identities, resource names, and
workflow method names should remain unchanged during that trial.

Every non-empty record must include a bounded source reference. The following
shape illustrates the provenance and freshness contract; record-kind fields
such as `monitor`, `incident`, or `trend` are added alongside it.

```json
{
  "recordId": "monitor-record-1",
  "sourceReference": {
    "schemaVersion": "1.0",
    "sourceId": "source-1",
    "source": {
      "system": "monitoring",
      "resourceType": "health-check",
      "resourceId": "primary-check"
    },
    "provenance": {
      "collector": "bounded-adapter",
      "collectorVersion": "1",
      "method": "snapshot",
      "collectedAt": "2026-08-23T10:00:00Z"
    },
    "observedAt": "2026-08-23T09:59:00Z",
    "freshness": {
      "asOf": "2026-08-23T10:00:00Z",
      "expiresAt": "2026-08-23T12:00:00Z"
    },
    "sensitivity": "internal"
  }
}
```

## Fixtures and license

`extensions/models/fixtures/synthetic_redacted_snapshot.ts` attests that it contains only
synthetic, redacted examples. It has no live resource identifiers, account
identifiers, endpoints, credentials, or customer data.

Licensed under the MIT License. See [LICENSE](LICENSE).
