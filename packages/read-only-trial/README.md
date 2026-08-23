# `@mgreten/read-only-trial`

A standalone, deterministic Swamp model for evaluating caller-supplied
read-only trial evidence. It has no source, provider, network, vault, workflow,
report, production, communication, remediation, spending, or mutation binding.

## Type decision

The public type intentionally changes from `@mgreten/phase-one-read-only-trial`
to `@mgreten/read-only-trial`. The former encoded a product-specific phase and
two fixed source names; this package uses caller-defined source IDs and an
explicit `durationDays` instead. This is a breaking type change, not a
compatibility alias.

## Contract

`evaluate` accepts only supplied evidence:

- an explicit human activation, or `null` for a dormant trial;
- a finite trial duration and per-source freshness windows;
- day observations whose coverage exactly matches the declared source set;
- retry/failure evidence and prohibited-condition evidence; and
- an optional human final review after the trial boundary.

The model validates evidence and writes one `evaluation` resource. It neither
retrieves evidence nor performs a side effect beyond that resource persistence.
Licensed under the MIT License. See [LICENSE](LICENSE).

## Minimal input shape

```ts
const input = {
  schemaVersion: "1.0",
  trialId: "trial-42",
  durationDays: 7,
  evaluatedAt: "2026-08-30T00:00:00Z",
  activation: null,
  sourceReadiness: [{ /* caller-defined, fresh source evidence */ }],
  observations: [], failures: [], prohibitedConditions: [], finalReview: null,
};
```

## Checks

```sh
/home/user/.swamp/deno/deno test --allow-none extensions/models/read_only_trial_test.ts
swamp extension fmt manifest.yaml --check --json
swamp extension quality manifest.yaml --json
swamp extension push manifest.yaml --dry-run --json
```
