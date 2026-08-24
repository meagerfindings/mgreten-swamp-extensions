# Swamp Feature Idea Gate

`@mgreten/feature-idea-gate` turns a supplied, bounded set of feature ideas and
evidence into a deterministic **recommendation**. It does not fetch evidence,
invoke an agent, approve a candidate, create plans, mutate task systems, or
perform any other side effect.

## Safety and authority

`prepare` only creates a prompt and records an isolated `/tmp` workspace path;
it does not create files or directories. The caller may use an external
read-only assessor, then pass both its output and an audited invocation claim to
`validate`. `validate` rejects malformed, stale, incomplete, or mismatched
evidence/output and writes a recommendation record only after all checks pass.
Complete current cli-agent invocation and pre-spawn launch-claim resources are
accepted for compatibility, but persisted audits strictly project only the
prompt and launch bindings; unrelated cli-agent telemetry is discarded.

Every output states `recommendation-only`, `sideEffects: none`, and false for
approval, planning, execution, and tool authority. A `promote_one` result is an
owner decision request, never an automatic promotion.

## Product policy is input, not code

The input's `policy` specifies required candidate labels, every scoring scale
(including preferred direction and weight), accepted evidence types per
criterion and hard gate, required evidence labels, allowed provenance, and
maximum evidence age. The model contains no product names, task-system
integration, or business-specific evidence type. See
[contracts](docs/contracts.md).

## Verify

```sh
deno test --check extensions/models
swamp extension fmt manifest.yaml --check --json
swamp extension quality manifest.yaml --json
swamp extension push manifest.yaml --dry-run --json
```

Validated records remain explicitly non-authoritative:

```json
{
  "authority": {
    "disposition": "recommendation-only",
    "sideEffects": "none",
    "mayApprove": false,
    "mayPlan": false,
    "mayExecute": false,
    "mayInvokeTools": false
  }
}
```

Licensed under the MIT License. See [LICENSE](LICENSE).
