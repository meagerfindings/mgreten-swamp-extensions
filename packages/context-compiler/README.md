# @mgreten/context-compiler

A domain-neutral Swamp model that compiles caller-supplied metadata into fresh,
bounded, deterministic context artifacts. It is the model dependency for
`@mgreten/bounded-context-workflows`.

The compiler accepts references and provenance only. It does not retrieve source
content, use credentials, call providers or the network, execute work, or grant
authority. Every output fixes `sideEffectAuthority` to `none`.

## Contract

The type is `@mgreten/context-compiler` with no global arguments:

- `compileRegistered` writes a `context` resource named by `manifestId`. It
  requires a caller role taxonomy, registry source IDs and provenance, bounded
  freshness, cited/minimized candidates, and a token budget.
- `compileConstitution` writes a `constitution` resource named by `artifactId`.
  It preserves a minimized policy reference and caller-supplied SHA-256 digest;
  policy content is never accepted.
- `compileOperatingPacket` writes an `operatingPacket` resource named by
  `packetId`. It accepts fresh, cited, minimized entries and stable-sorts them.

All methods require `reject-conflicting-replay` and
`reference-only-advisory-no-authority`. Exact replay is a no-op; changed content
under an existing identifier is rejected without a write.

## Use

```sh
swamp extension pull @mgreten/context-compiler
swamp model create @mgreten/context-compiler example-context-compiler
swamp extension pull @mgreten/bounded-context-workflows
```

Use the examples supplied by `@mgreten/bounded-context-workflows`. A compatible
registry record exposes `sourceIds`, `generatedAt`, and strict provenance with
`collector`, `collectorVersion`, `method`, `collectedAt`, and `contentDigest`.

## Verification

```sh
deno task verify
swamp extension fmt manifest.yaml --check --json
swamp extension quality manifest.yaml --json
swamp extension push manifest.yaml --dry-run --json
```

Licensed under the MIT License. See [LICENSE](LICENSE).
