# Operational digest contracts

`@mgreten/daily-operational-digest` is a pure reduction boundary. It neither
collects evidence, calls network services, invokes agents, nor performs
remediation. Its primary method persists the deterministic result supplied by
`buildOperationalDigest`. The `digest` resource accepts the generic schema and
the historical digest schema so existing persisted data remains readable; the
`build` method still accepts and emits only the generic contract.

## Compatibility contracts

`buildFromBetterStackTriage` validates the historical strict Better Stack
snapshot and persists its historical digest projection. `buildPhaseOnePulse`
accepts explicit Better Stack, feedback triage or strict bounded feedback-batch,
and Railway evidence states and persists the exported `phaseOnePulseSchema`. All
required schemas are pinned in this package. The feedback-batch dependency
contains only its strict persisted contract—not PostgreSQL or reader code.
The compatibility contracts are pinned from Moment Savor commit
`8e2ec643ed75106daeb54f5c564d3ac6c0170888` and model version
`2026.08.22.1`. Their source identities are:

- digest model: `daily_operational_digest.ts`, SHA-256
  `e43cc5082ff9a2b3057033f00a5345acb967ce0dcf4f125bf01448808f382ec1`
- signal contract `1.0`: SHA-256
  `46599ada2716fc04435bc484649febdd1fa0ca9df8c8c80c5792348246001557`
- Better Stack triage contract `1.0`: SHA-256
  `7dd34409f81a4d9e199206caa46b27650a097aa4ebdee8606dc9835e0d58b77b`
- feedback triage contract `1.0`: SHA-256
  `48ead0b14ed525ecb2e0e2165df48c13a43fabe0a6f942cd7983d5a2005871fc`
- feedback batch producer `2026.08.19.1`: SHA-256
  `0b16a4725f6ded1ee33f3f0106d80d7099301a21033e7e9b5eaaa90f91e49bef`
- Railway reader contract `2026.08.21.1`: SHA-256
  `53ceaa33c5fca35c7e850a3da36bb82c84a073c94983ee64269e6879b0af51d3`

Changes require fixture-based compatibility verification before updating these
local copies.

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
