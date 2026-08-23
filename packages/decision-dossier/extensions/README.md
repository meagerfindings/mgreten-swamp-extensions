# `@mgreten/decision-dossier`

A standalone Swamp model for retaining a validated, versioned decision dossier.
It preserves the public model type `@mgreten/decision-dossier` and validates the
`DecisionDossier` schema version `1.0`.

## Scope and guarantees

- **Persistence only:** the sole method is `record`; it writes a `dossier`
  resource after schema validation.
- **No authority:** it does not make decisions, grant approval, dispatch work,
  invoke providers, call external services, or execute a recommended option.
- **Caller-owned authority:** `authority` is descriptive dossier data. The model
  does not authenticate, verify, delegate to, or act for the named decision
  maker.
- **Caller-supplied evidence:** provenance is validated, but never collected,
  refreshed, fetched, or independently verified.
- **Version safety:** exact replay is idempotent. Changed content requires a
  greater version, a later `createdAt`, and unchanged subject `kind` and `id`.

The package contains no host-application names, application-specific
integrations, credentials, external dependencies, or execution-capable methods.

## Use

Register the `extensions` directory as an extension source:

```bash
swamp extension source add /path/to/swamp-decision-dossier/extensions
swamp model create @mgreten/decision-dossier product-decision-dossier
swamp model method run product-decision-dossier record \
  --input dossier="$(cat extensions/examples/decision-dossier.json)"
```

The model has no global arguments. A valid example is in
[`examples/decision-dossier.json`](examples/decision-dossier.json).

## Package layout

- `manifest.yaml` — single-package registration, version `2026.08.23.1`
- `models/decision_dossier.ts` — public model and persistence logic
- `models/_lib/decision_dossier_contracts.ts` — self-contained contracts and
  validation diagnostics
- `models/*_test.ts` — model lifecycle and contract tests

## Verification

From the repository root, run:

```bash
deno check extensions/models/decision_dossier.ts \
  extensions/models/decision_dossier_test.ts \
  extensions/models/_lib/decision_dossier_contracts_test.ts
deno test extensions/models
swamp extension fmt extensions/manifest.yaml --check --json
swamp extension quality extensions/manifest.yaml --json
swamp extension push extensions/manifest.yaml --dry-run
```

`npm:zod@4` is intentionally pinned in both source files that need it.
