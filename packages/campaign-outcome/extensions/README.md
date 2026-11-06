# Swamp Campaign Outcome

`@mgreten/campaign-outcome` validates, canonicalizes, and persists aggregate
campaign outcome evidence. It has no network, filesystem, credential, or
execution side effects. Every recommendation requires a human decision and
cannot claim an action was already taken.

The `record` method accepts a strict `{ recordId, evidence }` object. Valid
evidence is written to `evidence-<recordId>`; invalid evidence throws a
`TypeError` with sorted diagnostics. The model enforces aggregate-only privacy,
immutable SHA-256 artifact references, complete unique funnel stages, source and
measurement chronology, and canonical ordering.

```ts
import { evaluateCampaignOutcomeEvidence } from "./models/_lib/campaign_outcome_contracts.ts";

const result = evaluateCampaignOutcomeEvidence(evidence);
if (!result.success) throw new TypeError(JSON.stringify(result.diagnostics));
const canonicalEvidence = result.value;
```

```sh
deno fmt --check
deno lint
deno check extensions/models/campaign_outcome.ts extensions/models/_lib/campaign_outcome_contracts.ts
deno test --allow-read extensions/models
```

Licensed under the MIT License. See [LICENSE](LICENSE).
