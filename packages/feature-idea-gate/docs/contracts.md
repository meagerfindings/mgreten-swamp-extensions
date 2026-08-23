# Contracts

The model intentionally retains the feature-idea gate's stable JSON contract: six
criteria, one deterministic candidate ranking, explicit evidence citations, and a
recommendation-only authority record.

`policy` externalizes product decisions:

- `requiredCandidateLabels` defines which labels identify an eligible pool.
- Each `scales` entry supplies bounds, direction, and weight.
- `requiredEvidenceTypes` maps each criterion to evidence types accepted for a present
  rating.
- `minimumScore` and `minimumIndependentUserSignals` decide eligibility.

Evidence contains a generic source reference with provenance and freshness. Inputs fail
closed when time ordering is invalid, evidence is stale, ratings are missing or cite the
wrong evidence type, candidates are unassessed, or a trust/privacy blocker lacks
appropriate evidence.

The module exports Zod schemas and TypeScript inference types for callers that need to
construct or verify payloads before invoking the Swamp model.
