# @mgreten/product-behavior-summary

This standalone Swamp model validates and persists structurally aggregate-only
product behavior rates. It has no network clients, credentials, application
database access, or authority beyond writing its `summary/current` resource.
Consumers supply their own metric catalog with `expectedOutcomes`; the extension
requires exactly one metric for each declared outcome and no others. This keeps
application metrics and schemas outside the extension while retaining the
original fail-closed cohort, freshness, and non-causal behavior.

This is a structural privacy boundary, not content-level PII detection or a
general privacy guarantee. The model rejects identifying key shapes and limits
segment keys to aggregate facets, but producers remain responsible for ensuring
free-text catalog names, definitions, source metadata, and facet values contain
no personal data. Catalogs and metric arrays are limited to 100 entries,
dimensions to 12 per metric, and free text to 500 characters.

## Install and configure

```sh
swamp extension pull @mgreten/product-behavior-summary
swamp model create @mgreten/product-behavior-summary product-summary \
  --global-arg 'expectedOutcomes=["signup","engaged","subscribed"]'
```

## Run

```sh
swamp model method run product-summary summarize --input input='{
  "schemaVersion":"1.0",
  "summaryId":"week-32",
  "generatedAt":"2026-08-17T12:00:00Z",
  "inputPolicy":{"aggregateOnly":true,"userLevelIdentifiersAllowed":false},
  "sideEffectAuthority":"none",
  "metrics":[...]
}'
```

Each metric is a strict aggregate cohort record. A measured metric includes
nonnegative integer `numerator` and `denominator`; missing, unmeasured, and
privacy-suppressed metrics use null counts plus a reason. Every metric includes
an observation window, source metadata proving it contains no user-level data,
freshness metadata, a minimum cohort size, and a descriptive/non-causal claim.
Segment dimensions are limited to documented aggregate facets (`campaign`,
`channel`, `cohort`, `country`, `deviceType`, `experiment`, `language`,
`platform`, `region`, `subscriptionTier`, `timeBucket`, and `variant`);
arbitrary keys that could alias user identifiers are rejected.

## Contract boundary

Read [CONTRACT_BOUNDARY.md](CONTRACT_BOUNDARY.md) for why outcome names are a
consumer-owned global argument. No application code, schema, or metric catalog
is required to use it.

Licensed under the MIT License. See [LICENSE](LICENSE).
