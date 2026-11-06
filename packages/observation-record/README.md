# `@mgreten/observation-record`

This model retains one bounded piece of source evidence as a strict, unvalidated
qualitative record. It is intentionally neutral: it does not encode a domain, role,
organization, audience, or channel.

## Semantics

`retain` performs exactly one effect: it writes an `observation` resource. It does not
invoke providers or make network calls, claims, decisions, publication, external
communication, or spending. `recommendationDisposition` is a note about how a consumer
may consider the observation; it grants no authority. The generated `authority` object
makes that boundary explicit.

Source evidence is retained as supplied in `evidence`. The record fixes `sampleSize` to
`1`, identifies it as an `unvalidated_qualitative_signal`, and does not store source
identity or personal data. Strict provenance, freshness, and privacy metadata bound the
observation. Its SHA-256 identity is derived from canonical input content; exact retries
are no-ops, while conflicting or tampered replays fail closed. Consumers must supply
corroboration and authorization before treating it as a validated claim or action.

## Input

```json
{
  "schemaVersion": "1.0",
  "observedAt": "2026-08-23T12:00:00Z",
  "sourceKind": "direct_observer",
  "evidenceKind": "verbatim_quote",
  "evidence": "The archive should preserve the context behind this observation.",
  "sourceNote": null,
  "provenance": {
    "collectionMethod": "direct",
    "collectedAt": "2026-08-23T12:01:00Z",
    "sourceLocatorHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "freshness": { "expiresAt": "2026-09-23T12:01:00Z" },
  "privacy": {
    "classification": "private",
    "identityStored": false,
    "personalDataStored": false
  },
  "recommendationDisposition": "consider_as_hypothesis"
}
```

All input objects are strict. Unknown fields, including caller-selected identity or
authority fields, are rejected. `observedAt` cannot follow `collectedAt`, and a supplied
`expiresAt` cannot precede collection. Freshness is evidence metadata, not a claim that
the observation is currently fresh; consumers must compare it at use time.

## Development

```sh
deno fmt --check
deno lint
deno check extensions/models/observation_record.ts
deno test --no-prompt
swamp extension fmt manifest.yaml --check --json
swamp extension push manifest.yaml --dry-run
```

## License

MIT. See [LICENSE](LICENSE).

See [COMPATIBILITY.md](COMPATIBILITY.md) for intentional type and field changes.
