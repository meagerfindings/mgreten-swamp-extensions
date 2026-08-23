# @mgreten/bottleneck-ranking

A standalone Swamp model that ranks bottleneck candidates from **only** the
scales, directions, weights, ratings, evidence, and missing-data policy supplied
by its caller. It makes no network calls, persists no hidden state, and has no
authority to take action. Its result is explicitly `recommendation_only`, and
it labels evidence authenticity as caller-supplied and unverified.

## Install and run

Load the repository as a local extension and create a model instance with an
empty global argument object.

```sh
swamp extension source add ./swamp-bottleneck-ranking
swamp model create @mgreten/bottleneck-ranking bottleneck-ranking \
  --global-arguments '{}'
```

Run the model with a stable request identifier and an input matching
[`examples/rank.json`](examples/rank.json):

```sh
swamp model method run bottleneck-ranking rank \
  --input requestId=example-bottlenecks \
  --input input=@examples/rank.json
```

## Contract and policy

Every candidate must provide one rating for each of these criteria:
`customerValue`, `confidence`, `strategicFit`, `economicValue`, `risk`, and
`effort`. Every present value must cite preserved evidence. The caller must
provide exactly one linear min/max scale and non-negative weight for every
criterion, select a direction (`higher` or `lower`), choose a missing-data
policy, and acknowledge the fixed deterministic tie break
`candidate_id_ascending`.

`exclude_and_reweight` ignores missing criteria and normalizes the weights of
available values for that candidate. `score_as_zero` keeps all configured
weights and assigns a zero contribution to missing values. Missing values are
always disclosed in `missingDataDisclosure`; the model never guesses a score or
policy.

`requestId` must equal the input's `rankingId`. Replaying that request writes the
same resource, while replaying the payload under another identifier is rejected.
This deterministic behavior is not a global anti-replay ledger.

## Development

The tests use synthetic inputs only. They cover repeatability, ties, direction,
weights, both missing-data policies, invalid scale bounds, all-zero weights,
out-of-range ratings, policy omission, broken evidence references, and the Swamp
resource write.

```sh
deno check extensions/models/bottleneck_ranking.ts extensions/models/bottleneck_ranking_test.ts
deno test extensions/models/bottleneck_ranking_test.ts
swamp extension fmt manifest.yaml --check --json
```

See [`docs/ALGORITHM.md`](docs/ALGORITHM.md) for the scoring formula and
validation rules.
