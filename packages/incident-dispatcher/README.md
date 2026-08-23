# Swamp Incident Dispatcher

`@mgreten/incident-dispatcher` gates one minimized assessment request per incident.
It has no provider SDK, network client, notification client, or remediation capability.

`observe` creates a stable queued claim only for a new incident, an explicitly
material change, an eligible retry, or an authorized request. Duplicate and
active observations never create a second claim. `prepareInvocation` records a
small typed request and moves the claim to running. `validateAndRecordInvocation`
binds retained request, provider audit, and typed output before completing it.
`recordOutcome` records failures; repeated identical failure causes stop retries.
Only validated invocation output can complete a lifecycle.

Global policy parameterizes allowed providers, a model-name pattern, workspace
root, prompt byte limit, and same-cause failure limit. The model retains only
typed identifiers, opaque evidence references, a bounded prompt, and sanitized
typed findings; it never retains raw agent output.

`tools: "deny-all"` and `sandbox: "required"` are requested policy claims, not
enforcement. The invocation platform must enforce the boundary and produce the
audit; callers must accept audits only from a trusted `enforcementAuthority`.
This model validates audit bindings and claims but cannot authenticate an audit
producer or prove no-tools, sandbox, credential, or network enforcement.

## Configure and observe

Create an instance with at least one permitted provider. The model pattern is a
regular expression applied to the externally reported model name; the workspace
root must remain below `/tmp`.

```yaml
type: "@mgreten/incident-dispatcher"
globalArguments:
  allowedProviders: ["approved-provider"]
  modelPattern: "^approved-model-[0-9]+$"
  workspaceRoot: "/tmp/incident-dispatcher"
  maxPromptBytes: 12000
  sameCauseFailureLimit: 3
```

Call `observe` with typed references and opaque evidence identifiers. An
`authorized-request` trigger additionally requires an opaque `authorizationRef`;
the caller remains responsible for authenticating that external authorization.
A caller
must retain the returned lifecycle and use its `invocationId`; inventing a new
identifier will fail the later identity checks.

```json
{
  "observedAt": "2026-08-23T10:00:00Z",
  "trigger": "new",
  "materialEvidenceFingerprint": null,
  "incident": {
    "incidentId": "api-1",
    "status": "open",
    "openedAt": "2026-08-23T10:00:00Z",
    "observedAt": "2026-08-23T10:00:00Z",
    "evidenceRefs": ["evidence-1"]
  },
  "incidentRef": { "modelName": "monitor", "resourceName": "api-1" },
  "contextRef": { "modelName": "context", "resourceName": "current" }
}
```

Next call `prepareInvocation`, execute the resulting request outside this model
under the stated policy, and pass the unchanged request, typed agent output, and
trusted platform audit to `validateAndRecordInvocation`. The audit provider, model,
prompt hash, workspace, invocation ID, and execution-policy attestations are all
validated. `recordOutcome` is for recording a matching active invocation's
failure; it does not execute work or retry automatically.

Licensed under the MIT License. See [LICENSE](LICENSE).
