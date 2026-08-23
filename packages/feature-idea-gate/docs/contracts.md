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

The invocation audit and platform claim bind both the prepared prompt and the
parsed agent output by SHA-256 hash. `validate` rejects either-side hash, model,
invocation ID, workspace, provider, success, or read-only sandbox claim drift
before writing data.

The module exports Zod schemas and TypeScript inference types for callers that
need to construct or verify payloads before invoking the Swamp model.
