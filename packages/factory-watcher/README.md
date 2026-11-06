# Factory Watcher

`@mgreten/factory-watcher` deterministically turns caller-supplied, fresh
observations into ranked recommendations. It is decision-only: it persists one
watch result and does not mutate a factory, call providers, or make network
requests.

## Install and use

```sh
swamp extension pull @mgreten/factory-watcher
swamp model create @mgreten/factory-watcher factory-watcher
swamp model method run factory-watcher watch \
  --input requestId=weekly-review \
  --input input='<watch-input-json>'
```

The caller supplies the categories, thresholds, availability declarations,
evidence, and observations. See [the decision contract](docs/decision-contract.md)
for the input and output invariants.

## Development

```sh
deno test extensions/models
swamp extension fmt manifest.yaml --check
swamp extension quality manifest.yaml --json
swamp extension push manifest.yaml --dry-run --json
```

Licensed under the MIT License. See [LICENSE](LICENSE).
