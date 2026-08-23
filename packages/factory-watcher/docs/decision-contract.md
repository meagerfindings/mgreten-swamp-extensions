# Decision contract

The `watch` method accepts a strict input envelope with a fixed schema version.
Each of the seven supported decision categories must have exactly one threshold
and availability declaration. Callers control the occurrence threshold, lookback
window, priority, recommendation text, and maximum result count.

Evidence must have unique IDs and be fresh at `evaluatedAt`. Observations must
refer to available categories and known evidence, be no later than
`evaluatedAt`, and have unique IDs. Observations outside a category's lookback
window are ignored.

Recommendations group in-window observations by category and signal key. They
are ordered by descending caller priority, then category and signal key, so the
same input always produces the same output. Unavailable data is disclosed, never
treated as a zero signal. The result's `truncated` boolean is `true` exactly
when qualifying recommendations were omitted by `maximumRecommendations`.

The result always declares `recommendation_only` authority with factory
mutation, provider calls, and network calls set to `false`. The only side effect
of the model method is persisting the result resource.
