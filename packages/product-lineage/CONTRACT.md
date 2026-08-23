# Stable contract

`ProductLineage` is an evidence-preserving interchange document, currently at
schema version `2.0`. Consumers must reject unknown schema versions rather than
guessing at their meaning.

The `stages` array always contains exactly these ordered stages:

1. `signal`
2. `dossier`
3. `decision`
4. `work_packet`
5. `factory_artifacts`
6. `draft_pr`
7. `merged_change`
8. `released_outcome`
9. `post_release_measurement`

Every produced stage binds a unique artifact identity, version, SHA-256 digest,
immutable lineage identity/version, strictly later production time, evidence
observed/collected/freshened no later than production, and the exact preceding
artifact identity. `signal` has no predecessor. A lineage may stop only as a
contiguous `not_yet_produced` suffix; it cannot skip a stage.

The `record` method is intentionally not a workflow engine. It does not create
stages, derive artifacts, alter evidence, or call external services. It rejects
input that Zod would normalize, keeping persisted evidence byte-for-byte equal
to producer input (apart from JSON object key order).

Future incompatible changes require a new `schemaVersion`; additive behavior
must not silently reinterpret this contract.
