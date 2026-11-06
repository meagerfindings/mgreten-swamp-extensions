# Synthetic example shape

Use only verified, source-attributable evidence in a real proposal. A minimal
proposal has a pricing or positioning hypothesis, two evidence entries (one
`product_metric`, one `unit_economics`), provenance timestamps where
`observedAt ≤ generatedAt ≤ evaluatedAt < expiresAt`, caller policy, narrower
bounds, at least one guardrail and stop condition with `stop_and_review`,
success/failure/ambiguity recommendation criteria, and four `not_requested`
approval records.

Tests deliberately use synthetic `.invalid` source URIs and label their data as
synthetic. They demonstrate contract behavior, not evidence for an operational
recommendation.
