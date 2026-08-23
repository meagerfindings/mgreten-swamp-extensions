# `@mgreten/product-lineage`

A standalone Swamp model for recording a verifiable product-delivery lineage. It
accepts producer-owned evidence from a source signal through post-release
measurement, validates its ordering and provenance, and writes the validated
document as a versioned `lineage` resource. It never produces stages, mutates
evidence, or contacts external services.

The package is generic: it contains no product, organization, repository, or
deployment-policy assumptions. The fixed stage names are a stable interchange
contract, documented in [CONTRACT.md](CONTRACT.md).

## Install and create an instance

```sh
swamp extension pull @mgreten/product-lineage
swamp model create @mgreten/product-lineage lineage-store
```

## Record a lineage

```sh
swamp model method run lineage-store record \
  --input recordId=checkout-improvement-v1 \
  --input lineage="$(cat lineage.json)"
```

`recordId` is a local resource-name component (`A–Z`, `a–z`, `0–9`, `_`, `-`, up
to 100 characters). The resulting resource is named `lineage-<recordId>`.

## Validation guarantees

- exactly nine ordered stages, with an explicit incomplete suffix when work has
  not happened yet;
- immutable lineage ID/version, unique artifact IDs, SHA-256 digests, and an
  exact predecessor chain;
- strictly increasing artifact timestamps and source evidence that predates each
  artifact;
- strict object schemas and canonical-input enforcement, so no whitespace or
  other normalizations silently alter producer evidence.

## Local verification

```sh
deno task check
deno task test
swamp extension fmt manifest.yaml --check --json
swamp extension quality manifest.yaml --json
swamp extension push manifest.yaml --dry-run
```
