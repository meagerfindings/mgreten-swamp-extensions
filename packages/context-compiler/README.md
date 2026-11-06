# @mgreten/context-compiler

A strict dual-contract Swamp model. It retains the active Moment Savor
context-manifest, constitution, operating-packet, and dispatch-context contracts
while also exposing domain-neutral compilation for
`@mgreten/bounded-context-workflows`.

The compiler accepts references and provenance only. It does not retrieve source
content, use credentials, call providers or the network, execute work, or grant
authority. Every output fixes `sideEffectAuthority` to `none`.

## Contract

The type is `@mgreten/context-compiler` with no global arguments:

- Retained `compile`, `compileRegistered`, `compileConstitution`,
  `compileOperatingPacket`, and `compileDispatchContext` payloads and resources
  preserve the active Moment Savor vocabulary and behavior.
- Generic `compileRegistered`, `compileConstitution`, and
  `compileOperatingPacket` accept only their complete domain-neutral contracts.
- Method argument and resource schemas are closed unions. Mixed retained/generic
  payloads are invalid; fields are never aliased, inferred, or translated.

Generic methods require `reject-conflicting-replay` and
`reference-only-advisory-no-authority`. For every public persistence method,
exact replay is a no-op and changed content under an existing identifier is
rejected before writing.

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
