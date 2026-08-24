# Provider and assessment contract

These workflow YAML files intentionally parameterize model-instance references
so a consumer can select compatible generic `@mgreten/*` packages and provider
instances without editing a workflow.

## Required workflow inputs

All workflows require `requestId`, `assessmentModel`, and `providerModel`.
Decision review and idea gate use `input`, cross-source evidence uses an array
under `input`, and feedback triage uses `envelopes`.

`requestId` is stable, non-empty, unique to the logical assessment, and safe
for data-resource naming. Retries of that same assessment reuse it; changed
input requires a new `requestId` so prior artifacts cannot be treated
as fresh evidence.
`assessmentModel` implements the named deterministic methods in its workflow:
`prepare` and `validate`, plus `normalize` for triage. `providerModel`
implements `invokeAndParse` and returns resources named `invocation-<requestId>`
and `launch-claim-<requestId>`.

The workflow maps these public inputs to each concrete standalone method
contract (`reviewId`, `requestId`, or `gateId`; `evidence` for cross-source
preparation). Provider launch arguments are not a generic policy envelope:
they are the published `@mgreten/cli-agent` arguments and fix Amp, readonly
tools, required sandboxing, provider-scoped credentials, and network `allow`.

## Binding and fail-closed rules

`prepare` emits `request-<requestId>` with the model-specific stable ID, a
bounded prompt, its hash, and (where the model contract provides it) an
isolated `agentCwd`. The provider receives exactly that prompt. `validate`
must reject unless all of the following match the prepared artifact:

1. request ID, prompt hash, cwd, provider ref, and model ref;
2. readonly tool profile, mandatory sandbox, and provider-only credential scope;
3. the permitted network launch mode;
4. the model-specific response schema; and
5. source/evidence IDs and every claim's cited support.

Validation is deterministic and has no fallback acceptance path. An assessment
is advisory only: the validator must reject outputs that claim approval,
promotion, execution, user contact, publication, or any other authority.

## Provider result shape

The workflows read the following fields from the provider's resources:

```yaml
parsedResponse: <structured recommendation-only output>
invocationId: <requestId>
provider: <configured provider>
model: <configured model ref>
promptHash: <hash of exact prepared prompt>
cwd: <isolated prepared cwd>
success: true
```

The launch claim also records `operation`, `toolProfile`, and `sandbox`. This
is intentionally evidence, not authorization. YAML assertions and validators
can reject missing or inconsistent evidence; they cannot prove or enforce the
provider's OS/container sandbox, network controls, or credential isolation.
The provider runtime must enforce those controls independently.

## Synthetic contract fixture

[`../examples/synthetic-contract-fixture.yaml`](../examples/synthetic-contract-fixture.yaml)
documents the minimum prepared request, invocation, launch claim, policy, and
authority fields exercised by workflow assertions. It is a compatibility
fixture, not evidence that a provider sandbox was actually enforced.
