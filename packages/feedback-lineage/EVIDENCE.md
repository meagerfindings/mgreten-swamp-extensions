# Package evidence

## Scope inventory

This package is deliberately self-contained:

| Artifact               | Evidence of inclusion                                                     |
| ---------------------- | ------------------------------------------------------------------------- |
| Model entrypoint       | `feedback_lineage.ts`, named by `manifest.yaml` under `models`            |
| Contract helper        | `_lib/feedback_lineage_contracts.ts`, imported directly by the entrypoint |
| Behavioral tests       | `feedback_lineage_test.ts`, listed in `additionalFiles`                   |
| Consumer documentation | `README.md`, listed in `additionalFiles`                                  |
| License                | `LICENSE`, listed in `additionalFiles`                                    |

The manifest uses `paths.base: manifest`, so its model entry and local helper
resolve from this standalone package directory. The only third-party import is
the pinned `npm:zod@4` specifier. There are no credentials, data sources,
drivers, workflows, vaults, network clients, or runtime dependencies.

## Behavioral claims covered by tests

The synthetic test suite verifies valid source-preserving relationships; rejects
missing source identity, unsupported artifact pairs, self-links, stale or
out-of-order evidence, unbound provenance, duplicates, and oversized inputs;
refuses silent canonicalization; and exercises first-write, identical replay,
and conflicting-replay behavior. All identifiers, timestamps, rationale text,
and hashes are synthetic examples.

## Metadata basis

The extension name and version are the requested publication coordinates:
`@mgreten/feedback-lineage` and `2026.08.23.1`. The manifest description is
limited to behavior demonstrable from the bundled code: strict validation,
immutable persistence, evidence freshness, and recommendation-only authority.
The repository URL identifies the standalone source repository.
