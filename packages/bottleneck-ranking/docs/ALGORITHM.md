# Algorithm

## Validation

The model first parses its input with a strict Zod contract. Unknown keys,
missing policy fields, invalid timestamp ordering, stale evidence, duplicate
candidate/evidence identifiers, duplicate or absent criteria, invalid scale
bounds, out-of-range ratings, unsupported present ratings, and undisclosed
missing ratings are rejected. Each scale must have `maximum > minimum`; at least
one configured weight must be positive.

## Normalization and score

For a present raw rating \(x\) on a caller-supplied scale \([m, M]\), compute
the ascending normalized value:

\[ n = \frac{x - m}{M - m} \]

For a `higher` preferred direction, the normalized value is \(n\). For a `lower`
preferred direction, it is \(1 - n\). This preserves the caller's meaning of
each raw scale without applying any inferred or global calibration.

For `score_as_zero`, each present criterion contributes \(normalizedValue \times
weight / totalConfiguredWeight\); a missing criterion contributes zero. For
`exclude_and_reweight`, each present criterion contributes \(normalizedValue
\times weight / availableWeight\), where `availableWeight` is the sum of weights
for that candidate's present ratings. Missing values have zero effective weight
and zero contribution. If no weighted value is available, the candidate score is
zero.

## Ordering and output

Candidates are ordered by descending score. Equal scores are ordered by
ascending Unicode code-unit `candidateId` (without locale-sensitive comparison),
yielding a repeatable total order. Criteria and
missing-data disclosures are also sorted deterministically. The output preserves
input policy and evidence, exposes raw values, normalized values, effective
weights, and each contribution, then states that it is recommendation-only with
no side effects. Evidence provenance and freshness are validated for internal
consistency, but authenticity remains caller-supplied and unverified.

At the model boundary, `requestId` must equal `rankingId`. Replaying the same
request therefore writes the same deterministic resource; presenting the same
payload under a different request identifier fails closed. The model does not
claim to provide a global anti-replay ledger.
