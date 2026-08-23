# @mgreten/bounded-context-workflows

This bundle supplies two reusable DAGs for creating compact context artifacts
from structured evidence. `@mgreten/bounded-reference-context` catalogs a configured
metadata-only source registry, then asks a compatible context-compiler model to
select fresh, role-eligible references within a token budget.
`@mgreten/bounded-operating-context` separately compiles durable policy context and a
time-bounded operating packet. The workflows contain no agent or provider task
themselves and pass only validated record fields. Because model and method names
are caller inputs, this bundle cannot prove that a configured method has no
other effects; operators must review those methods before use.

## Dependency contract

Install a compatible `@mgreten/context-compiler` model and configure a source
registry model before running either workflow. The bundle has no bundled model,
provider, vault, driver, or side-effect dependency. Model instance and method
references are workflow inputs so each installation controls its own data
boundary. A registry must expose metadata only (no credentials or source
content), and the compiler must preserve reference-only output with no provider
or network calls.

```sh
swamp extension pull @mgreten/context-compiler
swamp extension pull @mgreten/bounded-context-workflows
```

## Reference context

Provide `sourceRegistryModel`, `sourceRegistryMethod`, and
`sourceRegistryRecordName` for the registry instance, plus
`contextCompilerModel` and `compileMethod` for the compatible compiler. The
`roleTaxonomy` is checked before compilation; `role` must be one of its values.
Each candidate must be explicitly cited and minimized and include observed and
expiry timestamps enclosing `evaluatedAt`; the workflow also enforces
`freshnessMaxAgeSeconds`. Registry output is projected to `sourceIds`,
`generatedAt`, and `provenance`, so unrelated registry fields cannot enter the
compiler. `maxTokens` is the packet budget the configured compiler must enforce.

```sh
swamp workflow run @mgreten/bounded-reference-context \
  --input-file examples/reference-context-inputs.yaml
```

## Operating context

The operating workflow accepts separate method references for compiling durable
policy and the current packet. It accepts entries explicitly marked minimized
and cited. The
caller supplies generation and expiry timestamps, so freshness remains explicit
and auditable rather than being inferred from execution time.
Both workflows require an advisory/no-authority attestation and a
reject-conflicting-replay policy. Compatible compiler methods must implement
that policy idempotently: an identical artifact identifier and payload may
return the existing artifact, while a conflicting payload must fail without
overwriting it.

```sh
swamp workflow run @mgreten/bounded-operating-context \
  --input-file examples/operating-context-inputs.yaml
```

## Safety boundary

These workflows are orchestration only. They validate and pass bounded record
fields, but caller-selected registry/compiler methods may have effects that YAML
cannot constrain. Review their schemas and implementations for source copying,
credentials, provider/network calls, execution, and mutation before use. The
synthetic examples illustrate shape only and are not production data.

Licensed under the MIT License. See [LICENSE](LICENSE).
