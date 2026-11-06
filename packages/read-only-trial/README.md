# `@mgreten/read-only-trial`

A standalone, deterministic Swamp model for evaluating caller-supplied read-only
trial evidence. It has no source, provider, network, vault, workflow, report,
production, communication, remediation, spending, or mutation binding.

## Type decision

The public type intentionally changes from `@mgreten/phase-one-read-only-trial`
to `@mgreten/read-only-trial`. The former encoded a product-specific phase and
two fixed source names; this package uses caller-defined source IDs and an
explicit `durationDays` instead. The rename is additive: install this type as a
separate model and leave existing `@mgreten/phase-one-read-only-trial` models,
workflows, reports, and retained data in place. There is no compatibility alias
or automatic migration because the input, output, methods, and resource names
are not equivalent.

For an existing trial, keep the old type as the system of record through its
current trial and retention period. Use this generic type only for a new trial
with a new model identity. A future migration would require an explicit,
reviewed adapter and data mapping; publication of this package does not provide
evidence that such a migration is safe.

## Contract

`evaluate` accepts only supplied evidence:

- an explicit human activation, or `null` for a dormant trial;
- a finite trial duration and per-source freshness windows;
- day observations whose coverage exactly matches the declared source set;
- retry/failure evidence and prohibited-condition evidence; and
- an optional human final review after the trial boundary.

The model validates evidence and writes one `evaluation` resource. It neither
retrieves evidence nor performs a side effect beyond that resource persistence.
`evaluationId` must equal the supplied `trialId`, preventing evidence from one
trial from being replayed into another trial's resource identity. Source
readiness must be known by evaluation time and remain fresh through the complete
declared duration. Observations, pulse deliveries, failures, and prohibited
conditions must occur inside the trial window and no later than evaluation.
Licensed under the MIT License. See [LICENSE](LICENSE).

## Minimal input shape

```ts
const input = {
  schemaVersion: "1.0",
  trialId: "trial-42",
  durationDays: 7,
  evaluatedAt: "2026-08-30T00:00:00Z",
  activation: null,
  sourceReadiness: [{/* caller-defined, fresh source evidence */}],
  observations: [],
  failures: [],
  prohibitedConditions: [],
  finalReview: null,
};
```

## Checks

```sh
/home/user/.swamp/deno/deno test --allow-none extensions/models/read_only_trial_test.ts
swamp extension fmt manifest.yaml --check --json
swamp extension quality manifest.yaml --json
swamp extension push manifest.yaml --dry-run --json
```
