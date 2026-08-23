# Operational digest contracts

`@mgreten/daily-operational-digest` is a pure reduction boundary. It neither
collects evidence, calls network services, invokes agents, nor performs
remediation. The sole model method persists the deterministic result supplied by
`buildOperationalDigest`.

## Normalized evidence

Every available section supplies one or more `sourceReferences`; every emitted
item cites one or more of those references by `sourceId`. A reference identifies
the source system and resource, records how and when it was collected, and has
an explicit sensitivity level. The extension does not dereference identifiers or
interpret source-specific payloads.

## Freshness

For an output generated at `generatedAt`, each source must satisfy:

`observedAt ≤ freshness.asOf ≤ freshness.expiresAt` and
`freshness.asOf ≤ generatedAt ≤ freshness.expiresAt`.

Items observed after `generatedAt` are rejected. Missing evidence is represented
explicitly as a missing section rather than inferred as healthy or empty.

## Redaction

Only evidence declared `redacted: true` is admitted. Callers must normalize and
redact raw content before calling this extension. The digest carries
identifiers, bounded summaries, recommendations, and references only; it does
not retain raw source payloads. Recommendations remain advisory: output
authority is always `recommendation-only` with `sideEffects: none` and
`agentInvocation: none`.

## Determinism and bounds

Sections are emitted in the fixed `DIGEST_SECTIONS` order. Items are
deduplicated by `dedupeKey`, selecting the highest severity and then a stable
timestamp/ID tie-breaker. Output is capped at five items per section, 24 total
items, 16,384 UTF-8 bytes, and 8,192 Unicode-code-point upper-bound tokens. The
measurement covers the complete canonical persisted resource, including the
`limits` metadata that records the measured byte and token counts. The output's
`truncated` boolean is `true` exactly when a deduplicated item was omitted by
the per-section or total-item cap; deduplication itself is not truncation.

Licensed under the MIT License. See [LICENSE](LICENSE).
