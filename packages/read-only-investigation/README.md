# Read-only investigation

`@mgreten/read-only-investigation` validates caller-supplied authorization,
source-registry snapshots, and proposed evidence queries. Its sole `prepare`
method writes a deterministic authorization plan. It does not execute a query,
open a network connection, call an external service, or mutate a production
system.

The model is intentionally an authorization-planning boundary, not a data
collector or an execution adapter. A separate, explicitly approved adapter may
interpret a plan only after enforcing its own authorization and runtime policy.

## Safety properties

- Only `lookup`, `list`, `search`, and `aggregate` are accepted operations.
- Every query must name an approved, available, unexpired source snapshot,
  allowed scope, and allowed operation.
- Query, byte, row, time-window, anomaly, and total-query limits fail closed.
- Non-public source material cannot be marked for external or public routing.
- The output states `execution`, `network`, `providerInvocation`, and
  `productionMutation` are all `none`; adapters require separate approval.

These are declarative controls, not a substitute for platform sandbox
enforcement. Deploy this extension in a runtime that independently denies
network access, filesystem writes, credential access, and mutation-capable tools
unless those capabilities are intentionally and separately granted.

## Use

Create a model instance with no global arguments, then submit a caller-owned
authorization and source snapshot:

```sh
swamp model create investigation --type @mgreten/read-only-investigation
swamp model method run investigation prepare --input requestId=demo-1 \
  --input input='{"schemaVersion":"1.0", "authorizationId":"auth-1", ...}'
```

The resulting `plan` resource is a request for a separately authorized adapter
to act; it is never a grant of execution authority.

## Development

```sh
deno test extensions/models/read_only_investigation_test.ts
deno check extensions/models/read_only_investigation.ts
swamp extension fmt manifest.yaml --check --json
swamp extension quality manifest.yaml --json
swamp extension push manifest.yaml --dry-run
```

Licensed under the MIT License. See [LICENSE](LICENSE).
