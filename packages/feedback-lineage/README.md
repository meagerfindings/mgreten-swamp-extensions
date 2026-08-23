# `@mgreten/feedback-lineage`

`@mgreten/feedback-lineage` validates and persists relationships between
immutable feedback artifacts. It records evidence that one source artifact is
related to another artifact without treating that relationship as identity
resolution, a closure instruction, or an operational command. Every feedback
endpoint retains its own `sourceId` and `sourceRecordId`; relationships carry
caller-supplied hash assertions, timestamps, provenance, freshness, confidence,
and a `recommendation-only` disposition.

## Privacy and PII

This extension does not need names, email addresses, message bodies, account
identifiers, or other PII. Use opaque, non-sensitive artifact and source IDs. Do
not place private feedback text, direct contact details, authentication
material, or unpublished business data in `rationale`, IDs, hashes, or test
fixtures. Hash values are caller assertions used for identity and replay
comparison. This extension cannot recompute them because canonical source
content is not supplied, so they do not independently prove content integrity.
They are not a replacement for access control or a guarantee that sensitive
source material cannot be inferred. Keep source material in its authorized
system and grant access separately.

Within a record, the same artifact ID and version must always carry the same
digest. This rejects digest equivocation but does not turn caller assertions
into independently verified hashes.

## Boundaries: no contact, no authority

The sole model method, `record`, only validates supplied data and writes one
lineage resource. It makes no network calls and cannot contact a person,
organization, source system, or service. It has no authority to close source
records, merge identities, change a triage state, create work, or make a
decision. Consumers must treat every link as a recommendation supported by the
recorded evidence, not as an instruction or proof of identity.

## Installation

```sh
swamp extension install @mgreten/feedback-lineage
```

## Usage

Create a model instance according to your Swamp environment, then submit only
canonical, source-preserving values. The example uses synthetic IDs and hashes.

```sh
swamp model create @mgreten/feedback-lineage example-lineage
swamp model method run example-lineage record --input persistenceId=lineage-001 \
  --input record='{"schemaVersion":"1.0","recordId":"record-001","recordVersion":"1","recordSha256":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","generatedAt":"2026-08-23T12:00:00Z","links":[{"linkId":"link-001","linkVersion":"1","linkSha256":"1111111111111111111111111111111111111111111111111111111111111111","relationship":"duplicate_of","from":{"kind":"feedback","artifactId":"feedback-alpha","version":"1","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sourceIdentity":{"sourceId":"channel-alpha","sourceRecordId":"source-record-alpha"}},"to":{"kind":"feedback","artifactId":"feedback-beta","version":"1","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sourceIdentity":{"sourceId":"channel-beta","sourceRecordId":"source-record-beta"}},"observedAt":"2026-08-23T09:00:00Z","linkedAt":"2026-08-23T10:00:00Z","provenance":{"producer":"example-validator","producerVersion":"1","method":"exact-match","inputArtifactIds":["feedback-alpha","feedback-beta"]},"freshness":{"asOf":"2026-08-23T11:00:00Z","expiresAt":"2026-08-24T11:00:00Z"},"confidence":0.9,"rationale":"Equivalent synthetic symptoms; retain independent source records.","disposition":"recommendation-only"}],"authority":{"sideEffects":"none","mayCloseSources":false,"mayMergeIdentities":false,"recommendationOnly":true}}'
```

The same validation is available to TypeScript callers. `validateForPersistence`
rejects input that a schema parser could normalize, ensuring stored IDs and
evidence identifiers are exactly those supplied by the producer.

```ts
import { validateForPersistence } from "./feedback_lineage.ts";

const record = validateForPersistence(candidateRecord);
// `record` is validated; no sources have been contacted or changed.
```

## Evidence semantics

A record is valid only when artifact kinds match the declared relationship;
feedback has immutable source identity; provenance names its endpoint inputs;
and the observation, linking, freshness, and record-generation timestamps are
ordered and current. Duplicate semantic relationships are rejected rather than
merged. Links and provenance inputs must be supplied in deterministic ascending
order. `persistenceId` must exactly equal `recordId`; replaying that ID with
byte-equivalent canonical data is idempotent, while alternate-ID and conflicting
replays fail closed.

## Development checks

```sh
deno test feedback_lineage_test.ts
swamp extension fmt manifest.yaml --check --json
swamp extension quality manifest.yaml --json
swamp extension push manifest.yaml --dry-run --json
```

See [EVIDENCE.md](EVIDENCE.md) for the package inventory and verification scope.
The bundled tests are synthetic and intentionally contain no real feedback or
contact data.

## License

MIT — see [LICENSE](LICENSE).
