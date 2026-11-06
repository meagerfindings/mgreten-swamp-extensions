# Pricing Unit Economics

`@mgreten/pricing-unit-economics` is a standalone Swamp model for validating a
unit-economics summary before persisting it as a resource. It accepts caller
provided observed cost proxies, hypothetical revenue scenarios, provenance,
caveats, and a threshold policy. The model is deterministic: it performs no
network I/O, reads no external state, and makes no changes other than writing
its validated summary resource.

The model is intentionally recommendation-only. An observed cost proxy is never
treated as an authoritative bill, revenue scenarios are always marked
`hypothetical_not_realized`, and the only possible recommendation authority is
`none`. Inputs that claim realized revenue or profit, grant side-effect
authority, have stale provenance, or mix incompatible monetary units are
rejected.

## Install

```sh
swamp extension pull @mgreten/pricing-unit-economics
swamp model create @mgreten/pricing-unit-economics economics-summary
```

## Use

```sh
swamp model method run economics-summary summarize --input requestId=review-1 \
  --input input='{"schemaVersion":"1.0","summaryId":"sample","evaluationTime":"2026-08-23T12:00:00Z","generatedAt":"2026-08-23T12:01:00Z","authority":{"mode":"recommendation_only","sideEffectAuthority":"none"},"caveats":[{"caveatId":"cost","statement":"Observed proxy, not an authoritative bill."}],"thresholdPolicy":{"policyId":"review","observedCostProxyId":"cost-1","comparator":"less_than_or_equal","maximum":{"amount":500,"currency":"TST","unit":"currency_minor","denominator":"account_period"},"onBreach":"recommend_review"},"observedCostProxies":[{"kind":"observed_cost_proxy","proxyId":"cost-1","label":"Observed processing proxy","measure":{"amount":450,"currency":"TST","unit":"currency_minor","denominator":"account_period"},"source":{"sourceId":"metrics-1","system":"example","resourceType":"aggregate","resourceId":"period-1","resourceVersion":"v1","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","observedAt":"2026-08-23T10:00:00Z","collectedAt":"2026-08-23T10:30:00Z","asOf":"2026-08-23T11:00:00Z","expiresAt":"2026-08-24T00:00:00Z"},"caveatIds":["cost"],"isAuthoritativeBill":false}],"hypotheticalRevenueScenarios":[]}'
```

The `summary` resource contains the supplied evidence plus a deterministic
threshold recommendation. A proxy at or below its configured maximum produces
`within_threshold`; a higher proxy produces `review_recommended`. Neither result
authorizes execution, approval, publishing, or any other side effect.

## Development

```sh
deno test
swamp extension fmt manifest.yaml --check --json
swamp extension quality manifest.yaml --json
```

Licensed under the MIT License. See [LICENSE](LICENSE).
