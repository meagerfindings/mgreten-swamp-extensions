# Work Order Intake

`@mgreten/work-order-intake` deterministically accepts or rejects a bounded work
proposal after validating an explicit, active human decision bound to the same
subject and proposal.

## Authority boundary

This extension is decision-only. It does not execute work, invoke external
services, approve implementation, mutate third-party systems, or grant a caller
authority to do so. `intake` only writes its validated result to Swamp's
resource store. An accepted result retains the human decision and states that
implementation requires a separate `plan-approval` gate.

## Contract

`intake` accepts an `intakeId` and a `proposal`. A proposal contains:

- a stable proposal ID and content-bound subject;
- a human decision whose subject, scope, action, and active time window match;
- a bounded target list, change budget, acceptance criteria, and deterministic
  checks.

Valid proposals become an `acceptedProposal`; invalid proposals fail closed as
`invalid`, `unapproved`, or `split_required`, with stable diagnostics. The
subject SHA-256 is computed over the canonical proposal content (excluding the
decision and evaluation timestamp), so post-approval content changes fail
closed. The accepted result retains the complete decision provenance.

```ts
const proposal = {
  proposalId: "change-42",
  subject: {
    kind: "change",
    id: "change-42",
    version: 1,
    sha256: "a".repeat(64),
  },
  approval: {
    decision: "approved",
    allowedNextAction: "accept_bounded_proposal",
  },
  // title, context, active decision timestamps, bounds, and checks omitted
};
```

## Methods

- `intake`: validate and persist the deterministic disposition.
- `assertAccepted`: accept only `intakeId`, read `intake-<intakeId>` through
  Swamp resource storage, require the caller's expected subject to exactly match
  the accepted subject, and stop a calling workflow when that persisted
  disposition was not accepted. Caller-supplied result objects are not trusted.
  It does not perform or authorize implementation.

## Development

Run the checks from the repository root:

```sh
deno fmt --check
deno lint
deno check extensions/models/work_order_intake.ts extensions/models/work_order_intake_test.ts
deno test
swamp extension fmt manifest.yaml --repo-dir . --check
swamp extension quality manifest.yaml --repo-dir .
swamp extension push manifest.yaml --repo-dir . --dry-run
```

Licensed under the MIT License. See [LICENSE](LICENSE).
