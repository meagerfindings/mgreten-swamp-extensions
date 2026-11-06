# Read-only investigation

`@mgreten/read-only-investigation` validates the shape and internal consistency
of caller-supplied authorization assertions,
source-registry snapshots, and proposed evidence queries. Its sole `prepare`
method writes a deterministic authorization plan. It does not execute a query,
open a network connection, call an external service, or mutate a production
system.

The caller assertions are unverified and grant no authority. The model is
intentionally a planning boundary, not an authorization service, data
collector or an execution adapter. A separate, explicitly approved adapter may
interpret a plan only after enforcing its own authorization and runtime policy.

## Safety properties

- Only `lookup`, `list`, `search`, and `aggregate` are accepted operations.
- Every query must name an approved, available, unexpired source snapshot,
  allowed scope, and allowed operation.
- Query, byte, row, time-window, anomaly, and total-query limits fail closed.
- Non-public source material cannot be marked for external or public routing.
- The output states `grant`, `execution`, `network`, `providerInvocation`, and
  `productionMutation` are all `none`; adapters require separate approval.
- A canonical SHA-256 request digest makes changed replays produce a distinct
  resource identity; it is tamper evidence, not a signature or trust proof.

These are declarative controls, not platform sandbox enforcement. This code
does not create or verify a sandbox and cannot attest to its host runtime.
Deploy it in a runtime that independently denies
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

The resulting `plan` resource is untrusted input for a separately authorized
adapter to revalidate; it is never a grant of execution authority. The model is
provider-neutral: destination classes describe data boundaries and do not name,
select, authenticate, or invoke a provider.

## Development

```sh
deno test extensions/models/read_only_investigation_test.ts
deno check extensions/models/read_only_investigation.ts
swamp extension fmt manifest.yaml --check --json
swamp extension quality manifest.yaml --json
swamp extension push manifest.yaml --dry-run
```

Licensed under the MIT License. See [LICENSE](LICENSE).
