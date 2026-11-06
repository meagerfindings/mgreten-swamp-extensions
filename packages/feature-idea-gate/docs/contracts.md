# Contracts

The model intentionally retains the feature-idea gate's stable JSON contract:
six criteria, one deterministic candidate ranking, explicit evidence citations,
and a recommendation-only authority record.

`policy` externalizes product decisions:

- `requiredCandidateLabels` defines which labels identify an eligible pool.
- Each `scales` entry supplies bounds, direction, and weight.
- `requiredEvidenceTypes` maps each criterion to evidence types accepted for a
  present rating.
- `userSignalEvidenceTypes`, `activeBottleneckEvidenceTypes`, and
  `trustPrivacyBlockerEvidenceTypes` define the semantic evidence classes used
  by hard gates; no product-specific type name is embedded in evaluation logic.
- `requiredEvidenceLabels`, `allowedSourceSystems`, and
  `allowedProvenanceCollectors` constrain evidence admission.
- `maximumEvidenceAgeSeconds` caps age independently of a source-provided
  expiry.
- `minimumScore` and `minimumIndependentUserSignals` decide eligibility.

Evidence contains a generic source reference with provenance and freshness.
Inputs fail closed when time ordering is invalid, evidence is stale, ratings are
missing or cite the wrong evidence type, candidates are unassessed, or a
trust/privacy blocker lacks appropriate evidence.

The invocation audit and pre-spawn platform claim bind the prepared prompt by
SHA-256 hash plus invocation ID, model, workspace, provider, operation,
successful completion, and read-only sandbox settings. A launch claim cannot
bind output that does not exist until after spawn, so `outputHash` is neither
required nor persisted. `validate` accepts complete current cli-agent resources
and legacy no-hash records, then projects only those security-relevant fields
into strict persisted audit schemas; timing, token, cost, preview, tags,
definition, timeout, CLI-path, and other telemetry cannot enter gate records.

The module exports Zod schemas and TypeScript inference types for callers that
need to construct or verify payloads before invoking the Swamp model.
