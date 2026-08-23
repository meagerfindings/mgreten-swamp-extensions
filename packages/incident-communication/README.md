# Swamp Incident Communication

`@mgreten/incident-communication` is a generic, persistence-only Swamp model for
recording incident communication **drafts**. It accepts a strict,
evidence-linked packet and writes exactly one `packet` resource when the packet
is valid. It has no external clients, credentials, webhooks, network access, or
delivery integrations.

## Boundary

This extension is deliberately only the drafting and recording boundary:

- `record` validates and persists a draft that is explicitly `unapproved`.
- The contract requires `persistenceOnly: true` and all authority flags to be
  `false`, including `maySend` and `mayPublish`.
- Approval is a separate human-controlled process outside this extension.
- Delivery and publishing require a separate integration, authorization model,
  and an explicit handoff from an approved artifact. They are not implemented
  here.

Consequently, a stored `packet` is evidence of drafting/recording only. It must
never be interpreted as a sent, published, approved, or delivered message.

## Use

Create an instance without global arguments, then supply a complete packet:

```bash
swamp model create @mgreten/incident-communication incident-drafts
swamp model method run incident-drafts record --input packetId=packet-1 --input packet='@packet.json'
```

`packetId` must exactly equal `packet.packetId`. Retrying the exact same valid
packet is idempotent. Changed content under an existing ID is rejected,
preserving the packet's immutable identity; neither path emits a side effect
beyond persistence.

## Contract guarantees

The packet contract is schema version `1.0` and is strict: unknown fields are
rejected. It validates timestamp chronology, deterministic ordering, evidence
references, evidence freshness and availability for every evidence-bearing
section, privacy at least as restrictive as referenced evidence, timeline
references, and the unapproved/no-authority boundary. The model validates the
whole packet before calling `writeResource`, so invalid data produces no write.

The model exposes one resource (`packet`) and one method (`record`). It contains
no approval method and no send, deliver, publish, remediate, or production
access method. Consumers should preserve this separation by treating approval
and delivery as distinct downstream systems, not as states inferred from a
recorded draft.

## Development

```bash
deno test extensions/models/incident_communication_test.ts
deno check extensions/models/incident_communication.ts
swamp extension fmt manifest.yaml --check --json
swamp extension quality manifest.yaml --json
swamp extension push manifest.yaml --dry-run
```

Licensed under the MIT License. See [LICENSE](LICENSE).
