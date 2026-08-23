# Repeated Friction

`@mgreten/repeated-friction` is a standalone Swamp model for deterministic,
recommendation-only evaluation of caller-supplied friction signals. It does not
use a network, invoke providers, communicate with users, merge experiences, or
affect production systems. The only method, `evaluate`, writes one bounded
`evaluation` resource named from the caller's request ID.

## Contract

The model accepts strict input with schema version `1.0`. Callers provide
category thresholds, a lookback interval, freshness policy, and normalized
signals. Each signal preserves both its source identity and provenance. Output
is sorted by category and group key and includes every preserved signal's
eligibility plus a disposition of either `recommend_for_evidence_queue` or
`do_not_queue`.

```ts
const result = detectRepeatedFriction({
  schemaVersion: "1.0",
  evaluationId: "evaluation-001",
  evaluatedAt: "2026-08-23T12:00:00Z",
  policy: {/* explicit categories, lookback, freshness, ordering */},
  signals: [],
});
```

The public model type remains `@mgreten/repeated-friction`; its release version
is `2026.08.23.1`. `extensions/models/_lib/` contains the self-contained input,
output, source-reference, and normalized-signal contracts required by the model.
No host-specific runtime, configuration, data, or identifiers are required.

## Development

Run these commands with either a system `deno` executable or Swamp's bundled
Deno executable:

```sh
deno fmt --check
deno lint
deno check extensions/models/repeated_friction.ts extensions/models/repeated_friction_test.ts
deno test --allow-read extensions/models
swamp extension fmt extensions/manifest.yaml --check --json
swamp extension quality extensions/manifest.yaml --json
swamp extension push extensions/manifest.yaml --dry-run --json
```

The tests use synthetic evidence only and cover deterministic grouping,
thresholds, strict validation, persistence behavior, inclusive time boundaries,
optional freshness gates, and the bounded group-output failure.

## License

MIT. See [LICENSE](LICENSE).
