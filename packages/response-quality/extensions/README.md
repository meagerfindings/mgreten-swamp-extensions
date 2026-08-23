# @mgreten/response-quality

`@mgreten/response-quality` deterministically evaluates caller-supplied
draft-response evidence and a caller-supplied scoring policy. It validates
bindings for the draft, source, reviewer, policy, and evidence; normalizes six
contract dimensions; and returns `pass` or `review` with explicit reasons. The
model has no credentials, configuration, network calls, contact actions,
provider actions, or production actions.

Its sole `evaluate` method persists one `evaluation` resource named
`response-quality-<recordId>`. Its public type and schema version remain
compatible with `@mgreten/response-quality` version `2026.08.23.1`.

## Install

Add this extension source to a Swamp repository, then load it through Swamp's
normal extension workflow.

```sh
swamp extension source add ./extensions
swamp doctor extensions --json
```

## Evaluate a response

Call `evaluate` with a safe record identifier and an input conforming to schema
version `1.0`. Each available score needs evidence from its own dimension.
Unavailable scores need a reason and cannot carry a value or evidence IDs.
Results are deterministic for identical inputs.

```ts
const result = evaluateResponseQuality({
  schemaVersion: "1.0",
  evaluationId: "example-evaluation",
  // Provide bindings, policy, evidence, and six scores.
});
```

## Behavior and limits

The ordered dimensions are `factualAccuracy`, `privacy`, `empathy`,
`responseTime`, `userFollowUp`, and `effortReduction`. Each is normalized using
the supplied minimum, maximum, and preferred direction. Required unavailable
dimensions, failing per-dimension thresholds, or a failing overall threshold
produce `review`. The output authority records that evaluation is
persistence-only and that sending, user contact, source closure, network
effects, and production effects are forbidden.

Licensed under the MIT License. See [LICENSE](LICENSE).
