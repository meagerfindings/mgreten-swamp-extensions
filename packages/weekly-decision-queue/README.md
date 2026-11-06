# @mgreten/weekly-decision-queue

`@mgreten/weekly-decision-queue` is a pure Swamp model for producing a small,
deterministic decision-review queue. It accepts structured decision dossiers and
a structured bottleneck ranking supplied by the caller. It retains only fresh
dossiers, orders them by decision due date and identifier, caps the queue at
three entries, and reports every omitted dossier explicitly. It also returns at
most one ranked bottleneck recommendation. The model never fetches data,
executes decisions, or performs side effects.

## Install

```sh
swamp extension install @mgreten/weekly-decision-queue
swamp model create @mgreten/weekly-decision-queue weekly-decisions
```

## Generate a queue

Pass a request identifier and an input matching the model's public contract.
Each available dossier includes provenance and freshness metadata; unavailable
inputs remain visible as omissions. The bottleneck ranking is handled with the
same freshness discipline.

```sh
swamp model method run weekly-decisions generate \
  --input requestId=review-2026-w34 \
  --input input='{"schemaVersion":"1.0","queueId":"review-2026-w34","generatedAt":"2026-08-23T12:00:00Z","dossiers":[],"bottleneckRanking":{"status":"unavailable","reason":"No ranking was supplied","sourceReference":"data://ranking/unavailable"}}'
```

## Guarantees

The resource contract is strict: unexpected input fields and duplicate dossier
identifiers are rejected. Fresh dossiers are sorted by `decisionDueAt`, then by
`dossierId`, so identical input produces identical output. The output always
contains recommendation-only authority metadata: it does not replace human
judgment, execute anything, or create side effects. Inputs are bounded to 50
dossiers and outputs retain no more than three fresh dossiers.

The extension has no configuration, credentials, network requirements, or
dependent extensions. Its tests use only synthetic dossiers, rankings, and
source references.

## License

MIT. See [LICENSE](LICENSE).
