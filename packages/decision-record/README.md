# `@mgreten/decision-record`

A standalone Swamp model for preserving an explicit human decision against one
exact version of a dossier. It is deliberately narrow: it validates and writes
decision records; it does not infer approval, dispatch work, or authorize side
effects. The public model type remains `@mgreten/decision-record`.

## Install and use

After publishing the package through the usual Swamp process, install it and
create an instance with no global arguments:

```sh
swamp extension pull @mgreten/decision-record
swamp model create @mgreten/decision-record product-decisions
```

Record an explicit human decision by supplying the complete immutable record.
All identifiers and SHA-256 values bind the decision to the supplied dossier and
subject.

```sh
swamp model method run product-decisions record --input record='{
  "schemaVersion":"1.0",
  "decisionId":"decision-2026-08-23",
  "proposalId":"proposal-42",
  "dossier":{"dossierId":"dossier-42","version":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","subject":{"kind":"proposal","id":"proposal-42","version":1,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}},
  "actor":{"id":"owner-1","role":"decision owner","humanAuthority":true},
  "decision":"accept",
  "rationale":"The explicitly reviewed dossier meets the stated criteria.",
  "conditions":[],
  "evidenceNeeded":[],
  "newEvidenceReferences":[],
  "decidedAt":"2026-08-23T12:00:00Z",
  "reviewAt":"2026-09-23T12:00:00Z",
  "authority":{"source":"explicit-human-input","inferred":false,"mayExecute":false,"sideEffects":"persist-record-only"}
}'
```

## Authority semantics

`actor.humanAuthority` must be `true`, and the authority block is fixed to
`explicit-human-input`, `inferred: false`, `mayExecute: false`, and
`sideEffects: "persist-record-only"`. Those constraints are part of the stored
schema, not documentation-only conventions. A successful `record` call is not
permission for any downstream action; downstream systems must independently
authorize and execute their own work.

The model writes an immutable `decision-<decisionId>` resource and updates
`proposal-<proposalId>` solely to enforce history. Replaying the exact same
decision is idempotent; a changed payload with the same decision ID is rejected.
Later decisions must be chronologically later. A proposal previously rejected
can only be reconsidered with at least one new-evidence reference and a dossier
whose version is newer and SHA-256 differs from the rejected dossier.

## Development

Licensed under the MIT License. See [LICENSE](LICENSE).

```sh
deno check extensions/models/decision_record.ts extensions/models/decision_record_test.ts
deno test extensions/models/decision_record_test.ts
swamp extension fmt manifest.yaml --check
swamp extension quality manifest.yaml --json
swamp extension push manifest.yaml --dry-run --json
```
