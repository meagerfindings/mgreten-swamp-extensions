# Swamp Decision Context

`@mgreten/decision-context` turns retained, versioned evidence into a canonical
decision packet. It is deliberately a *context compiler*, not a decision
executor: it can persist one packet and return an advisory recommendation, but
it cannot invoke providers, use the network, publish, communicate externally,
spend, change policy, or mutate production.

## Use

```bash
swamp extension source add .
swamp model create decision-context --type @mgreten/decision-context
swamp model method run decision-context compile --input packetId=packet-1
```

The compile input supplies `bindings`, `safeClaims`, `outcomes`, and `evidence`.
Every record carries a caller-supplied content-hash assertion and is time-bounded;
the compiler does not receive canonical source content and therefore cannot
independently verify those hashes. The persisted packet itself is immutable by
`packetId`: exact replay is idempotent and conflicting content is rejected. The compiler detects stale
or conflicting revisions, unsupported claims, rights and terms uncertainty,
immature or insufficiently diverse evidence, incompatible outcome dimensions,
and incomplete downstream outcomes. Diagnostics block `continue` and `select`;
`pause` and `revise` remain conservatively expressible. Output ordering is
canonical, so equivalent input ordering produces the same packet.

## Intentional type changes from the domain-specific predecessor

This is a new standalone type, `@mgreten/decision-context`, not a wire-compatible
replacement for `@mgreten/marketing-decision-context`. The extraction removes
domain-specific policy vocabulary: `campaign` becomes `initiative`, `segment`
becomes `subject`, `customerSafeClaims` becomes `safeClaims`, and `marketEvidence`
becomes `evidence`. Binding kinds are likewise generic
(`policy`, `operating_context`, `decision_brief`, and `action_brief`). The
marketing-specific `winner` recommendation is named `select`; `checkout` and
`paid` downstream outcomes are generalized to `completion` and `adoption`.

Those are intentional schema changes, documented rather than hidden behind a
compatibility layer. The behavioral invariants are retained: validation fails
closed, missing evidence is never treated as zero, positive recommendations are
blocked by diagnostics, and all non-persistence authority remains explicitly
false.

## Verification

```bash
deno test --allow-read extensions/models/decision_context_test.ts
swamp extension fmt manifest.yaml --check --json
swamp extension push manifest.yaml --dry-run --json
```

Licensed under the MIT License. See [LICENSE](LICENSE).
