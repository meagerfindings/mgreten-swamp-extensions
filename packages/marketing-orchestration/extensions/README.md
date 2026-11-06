# @mgreten/marketing-orchestration

Approval-gated, digest-bound marketing release orchestration with a tightly
coupled content calendar report. Approval principals, roles, channels, publisher
model/method bindings, intended states, and successful observed states are model
configuration rather than package constants.

Approval includes a digest of each complete publication request (item, publisher
model, method, and arguments). Consumer workflows call `prepareDispatch`, invoke
only a newly returned claim's configured model/method/arguments, and then call
`recordDelivery` with the claim ID, attempt ID, and approved release digest. The
emitted arguments remain canonically identical to the approved arguments;
consumers use the separate claim ID as the transport idempotency key without
mutating those arguments. Attempt ID remains separate claim-name metadata. A
schedule entry is durably bound to `dispatching`, the attempt ID, and claim ID
before claim creation. Same-attempt replay emits no handle unless it repairs an
interrupted claim write; a failed delivery may be retried only with a new
attempt ID. See the repository README for the complete contract, configuration
example, guarantees, and verification commands.

```yaml
approvalPrincipals:
  - principal: approver@example.test
    role: marketing-owner
ideationPolicy:
  minIdeas: 12
  maxIdeas: 40
  minGroups: 3
dispatchBindings:
  - channel: newsletter
    model: newsletter-publisher
    method: send
    intendedState: send
    successfulObservedStates: [delivered]
```

Principal/role matching records a claimed approval identity; it does not
authenticate a human. Consumer workflows must bind trusted approval evidence to
the principal and role at their authentication and authorization boundary.

A consumer workflow uses the prepared immutable handoff, never mutable draft
content:

```text
prepareDispatch -> configured publisher method -> recordDelivery
```

The model applies a consumer-configurable ideation policy (default 20–60 ideas
and 4 groups) under a package-wide 100-idea cap. It bounds releases at 1–100
items, approval principals at 20, and channel bindings at 30. Approved releases
use create-once-or-verify semantics. Dispatch fails closed when approval,
digest, schedule state, or due time does not match. Delivery records preserve
separate intended and observed states and enforce terminal state transitions.

Dispatch coordination relies on Swamp's exclusive per-model-instance method
lock, which spans the complete invocation across workflow workers and processes.
Use one shared model instance for a release; distinct model instances are
independent coordination domains.

MIT licensed.
