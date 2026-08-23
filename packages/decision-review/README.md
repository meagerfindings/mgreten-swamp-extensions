# @mgreten/decision-review

`@mgreten/decision-review` prepares and validates a bounded three-lens decision
review. It is designed for callers that need a structured recommendation while
retaining all execution and approval authority themselves. The extension never
invokes a provider, executes a tool, approves a change, bypasses a gate, or
causes side effects. A caller may use its deterministic prompt with a separately
audited, read-only provider invocation, then submit the provider result to the
`validate` method.

The public contract is strict and versioned. It requires evidence provenance,
five ordered Customer Advocate findings, six ordered Skeptic findings, and one
or more Dreamer alternatives. Each finding must cite supplied evidence. Dreamer
alternatives must honor every supplied constraint and preserve every required
gate exactly once. Valid outputs are always marked `recommendation-only` with
all authority flags false.

## Install

```sh
swamp extension pull @mgreten/decision-review
swamp model create @mgreten/decision-review decision-review
```

## Prepare a request

The `prepare` method validates the input, produces a deterministic prompt and
SHA-256 integrity hashes, and records a workspace beneath the configurable
absolute `agentCwd` root for the separately managed invocation. Preparation
does not create files or directories. Evidence is fresh for 90 days by default;
set `maxEvidenceAgeDays` on the model to adopt a different explicit policy. The
input names the review's target audience with the existing `targetFamily` field
for contract compatibility; it may contain any audience description.

```sh
swamp model method run decision-review prepare \
  --input reviewId=review-1 \
  --input input='{"reviewId":"review-1","decisionArtifactId":"decision-1","decisionArtifactVersion":1,"targetFamily":"people who preserve shared history","question":"Should we run a limited trial?","constraints":["No external publication"],"requiredGates":["A human owner must approve"],"evidence":[{"evidenceId":"evidence-1","claim":"Participants requested a private trial","provenance":{"sourceId":"research-1","sourceType":"research","collectedBy":"researcher","collectedAt":"2026-08-23T12:00:00Z","method":"interview"}}]}'
```

## Validate an audited result

Run a provider outside this extension using the prepared prompt. Its invocation
claim must record `toolProfile: "readonly"`, an isolated sandbox, matching
prompt hash, and the prepared workspace. Submit the exact request, output, and
audit records to `validate`. Invalid contracts, future timestamps, altered
prompts, changed input, incorrect provider claims, and authority escalation all
fail before any resource is written.

```sh
swamp model method run decision-review validate \
  --input reviewId=review-1 \
  --input request='<prepared-request-json>' \
  --input agentOutput='<three-lens-contract-json>' \
  --input invocation='<audited-invocation-json>' \
  --input invocationClaim='<read-only-invocation-claim-json>'
```

## Safety and authority boundary

The extension only stores a prepared request or a validated review. It does not
contain provider credentials, make network calls, execute commands, or expose a
method that can mutate an external system. Its output is advisory only; callers
remain responsible for their own authorization, provider isolation, and gate
enforcement.

Licensed under the MIT License. See [LICENSE](LICENSE).
