# Swamp Approval Gate

`@mgreten/approval-gate` evaluates a complete approval packet deterministically.
It accepts only retained input evidence, returns sorted diagnostics, and
persists one diagnostic result. It has no clock, network, provider, execution,
approval, or side-effect capability.

## Scope

The extension intentionally contains no marketing, product, publishing, pricing,
or outreach policy. Callers supply opaque `policyId`, `gateId`, action kinds,
and scopes. Domain-specific code is responsible for defining and producing those
values before it calls this gate.

`recommendation.requirementsSatisfied` is an evidence assessment, not an
authorization to act. Every output sets all operational authority flags to
`false`; a separate effectful adapter or a human must perform any action.

## Generic public type rename

This extracted API is intentionally not source-compatible with the original
marketing-specific API:

| Original public name                      | Generic public name            |
| ----------------------------------------- | ------------------------------ |
| `MARKETING_APPROVAL_GATE_SCHEMA_VERSION`  | `APPROVAL_GATE_SCHEMA_VERSION` |
| `MarketingActionType`                     | `ApprovalActionKind`           |
| `marketingAuthorizationPacketInputSchema` | `approvalPacketInputSchema`    |
| `MarketingAuthorizationDiagnostics`       | `ApprovalDiagnostics`          |
| `evaluateMarketingAuthorizationPacket`    | `evaluateApprovalPacket`       |

Related packet fields are renamed from marketing authorization terminology to
generic terms: `actionType` → `actionKind`, `approvalType` → `actionKind`,
`authorized` → `recommendation.requirementsSatisfied`, and fixed `MKT-03`
identifiers are caller-supplied `policyId` and `gateId` values.

## Development

```sh
deno check extensions/models/approval_gate.ts
deno test --no-lock extensions/models
swamp extension fmt manifest.yaml --check --json
swamp extension push manifest.yaml --dry-run
```

An evaluation produces diagnostics with no operational authority:

```json
{
  "authority": {
    "approval": false,
    "execution": false,
    "network": false,
    "providerInvocation": false,
    "productionMutation": false,
    "separateSideEffectAdapterOrHumanActionRequired": true
  }
}
```

The persisted diagnostic also echoes the caller-supplied `gateId`, complete
policy provenance, and exact requested action kind/scope pairs. These values are
identifiers for retained evidence only; their presence conveys no authority.

Licensed under the MIT License. See [LICENSE](LICENSE).
