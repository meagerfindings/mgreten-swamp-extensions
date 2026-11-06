# @mgreten/cross-source-evidence

`@mgreten/cross-source-evidence` is a standalone Swamp model for preparing and
validating bounded clusters of observations from independent source domains. It
does not collect data, call a provider, or execute a recommendation. Callers
supply the evidence and, if an offline agent is used, separately supply its
auditable invocation record. The model validates provenance, freshness,
cross-domain relationships, exact source preservation, and explicit disclosure
of absent domains.

## Privacy and data handling

This extension treats observations and the prompt as caller-controlled data. It
never transmits, logs, or enriches that data. Use stable opaque IDs rather than
personal identifiers; minimize observations before supplying them; and do not
put credentials, personal data, access tokens, or raw sensitive records in the
evidence. `prepare` writes a local request resource and records a unique,
bounded path under `/tmp` for a caller-managed readonly invocation; it does not
create that path or invoke an agent, so there is no temporary workspace to leak
or clean up. A caller that creates the path owns cleanup after every attempt,
including failed validation, and should reuse the persisted request on retry.
Fixtures are synthetic, sanitized, and capped to two short records.

## Authority boundary

The output is **recommendation-only**. A validated cluster always states that it
has no side-effect authority and may neither execute actions nor invoke tools.
Relationships are hypotheses, not causal conclusions. Integrators must make
independent authorization and execution decisions; this model never approves,
publishes, contacts, mutates, or dispatches anything.

## Install and create a model

```sh
swamp extension pull @mgreten/cross-source-evidence
swamp model create @mgreten/cross-source-evidence evidence-review
```

Prepare two or more observations spanning at least two of the supported domains
(`feedback`, `telemetry`, `product_behavior`, `economics`, `support`, and
`factory_findings`). Each observation requires a source reference with
provenance, temporal freshness, and a sensitivity label.

```sh
swamp model method run evidence-review prepare \
  --input requestId=review-1 \
  --input evidence='[{"evidenceId":"metric-1","domain":"telemetry","sourceReference":{"schemaVersion":"1.0","sourceId":"demo:metric:1","source":{"system":"demo","resourceType":"aggregate","resourceId":"metric-1"},"provenance":{"collector":"demo","collectorVersion":"1","method":"fixture","collectedAt":"2026-08-23T10:00:00Z"},"observedAt":"2026-08-23T09:00:00Z","freshness":{"asOf":"2026-08-23T10:00:00Z","expiresAt":"2026-08-24T10:00:00Z"},"sensitivity":"internal"},"observation":"Aggregate count changed."},{"evidenceId":"report-1","domain":"support","sourceReference":{"schemaVersion":"1.0","sourceId":"demo:report:1","source":{"system":"demo","resourceType":"aggregate","resourceId":"report-1"},"provenance":{"collector":"demo","collectorVersion":"1","method":"fixture","collectedAt":"2026-08-23T10:00:00Z"},"observedAt":"2026-08-23T09:00:00Z","freshness":{"asOf":"2026-08-23T10:00:00Z","expiresAt":"2026-08-24T10:00:00Z"},"sensitivity":"internal"},"observation":"Aggregate report count changed."}]'
```

`validate` accepts the prepared request, an agent-produced cluster, and an AMP
readonly invocation claim. It rejects altered evidence, a mismatched prompt or
workspace, non-readonly tool profiles, expired data, and outputs with authority
to act.

## Development

```sh
deno fmt --check
deno lint
deno task check
deno task test
swamp extension fmt manifest.yaml --check --json
swamp extension quality manifest.yaml --json
swamp extension push manifest.yaml --dry-run --json
```

Licensed under the MIT License. See [LICENSE](LICENSE).
