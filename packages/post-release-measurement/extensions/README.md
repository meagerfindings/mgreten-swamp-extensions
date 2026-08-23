# Post-release measurement

`@mgreten/post-release-measurement` records a strict, human-controlled
declaration for measuring one exact released artifact against one exact work
order.

It has one method, `record`. The method validates and persists a `plan`
resource. It does not query production, deploy or roll back software, or make
decisions. Its authority is deliberately fixed to `recommendation-only`, with a
human decision required and no production effects.

## Install

After this extension is published, install it in a Swamp repository:

```sh
swamp extension pull @mgreten/post-release-measurement
```

## Use

Create a model instance with no global arguments, then record a plan:

```sh
swamp model @mgreten/post-release-measurement create release-measurement
swamp model method run release-measurement record \
  --input recordId=release-2026-08-23 \
  --input plan="$(cat examples/measurement-plan.json)"
```

The `recordId` is 1–100 ASCII letters, digits, `_`, or `-`, beginning with a
letter or digit. The resource is stored as `plan-<recordId>`.

## Plan contract

The plan uses schema version `2.0`. It requires:

- exact released-artifact and work-order IDs, positive versions, and lowercase
  SHA-256 digests;
- a measurement-source reference with provenance and freshness metadata;
- explicit success, failure, and ambiguity recommendations;
- a window that begins no earlier than the release and ends after it begins; and
- evidence available no later than declaration and fresh through the entire
  observation window.

All timestamps are ISO 8601 datetimes with an explicit offset. See
[`examples/measurement-plan.json`](examples/measurement-plan.json) for a
synthetic valid plan.

## Development

```sh
deno fmt --check
deno lint
deno check models/post_release_measurement.ts
deno test
swamp extension fmt manifest.yaml --check --json
swamp extension quality manifest.yaml --json
swamp extension push manifest.yaml --dry-run
```

Licensed under the MIT License. See [LICENSE](LICENSE).
