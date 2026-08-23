# Consumer contract boundary

The original application-bound model embedded a fixed outcome catalog in its
schema. That catalog is application policy, not a generic product-behavior invariant.
It cannot be removed while preserving the old "exactly these outcomes" behavior
unless the consumer declares the catalog somewhere.

This extension makes that smallest boundary explicit through the required model
global argument `expectedOutcomes: string[]`. The model enforces exactly one
metric for each declared outcome and rejects metrics outside that catalog. No
application outcome, metric name, database schema, or adapter is included.

All remaining behavior is unchanged: inputs are aggregate-only, identifying
keys are rejected, cohorts below their disclosure threshold cannot be measured,
causal claims are rejected, stale metrics fail before persistence, and rates are
deterministically calculated or null.

"Aggregate-only" is enforced structurally: strict schemas, an allowlisted set
of aggregate dimension keys, no user-identifier fields, and cohort thresholds.
It is not content-level PII scanning. Consumers must keep PII out of outcome
names, definitions, source metadata, and dimension values. Practical limits are
100 catalog outcomes/metrics, 12 dimensions per metric, and 500 characters per
free-text field.
