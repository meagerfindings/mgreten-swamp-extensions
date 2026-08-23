# @mgreten/context-conflict-detector

A generic Swamp model that deterministically reports conflicts in
caller-supplied registry records. It accepts `reference`, `decision`, `plan`,
and `proposal` categories. Each record carries claims, provenance, freshness,
and explicitly named authority; conflict rules are supplied by the caller.

The model is recommendation-only. It writes one immutable `evaluation` resource
and cannot resolve conflicts, update records, execute work, contact providers,
or make network calls. Every diagnostic requires human resolution. Results use a
stable severity/code/key/record-ID ordering so equal inputs yield equal outputs.

## Install and run

```sh
swamp model create @mgreten/context-conflict-detector registry-conflicts
swamp model method run registry-conflicts evaluate --input requestId=run-1 --input input='@snapshot.json'
```

## Input outline

```json
{
  "schemaVersion": "1.0",
  "evaluationId": "evaluation-1",
  "evaluatedAt": "2026-08-17T00:00:00Z",
  "references": [],
  "decisions": [],
  "plans": [],
  "proposals": [],
  "availability": [],
  "conflictRules": []
}
```

Malformed or ambiguous data is rejected rather than inferred: absent rules,
duplicate `recordId` + `version` pairs across any category, inconsistent
availability, invalid hashes, and missing authority all fail validation.
Diagnostics are globally sorted and capped at 500; `truncated` is true exactly
when diagnostics were omitted, while `verdict` always considers the complete
set. `blocked` is an escalation signal, not authorization to act.

## Verification

```sh
deno test extensions/models/context_conflict_detector_test.ts
swamp extension fmt manifest.yaml --check --json
swamp extension quality manifest.yaml --json
swamp extension push manifest.yaml --dry-run --json
```

## License

MIT. See [LICENSE](LICENSE).
