# Meta Publishing for Swamp

`@mgreten/meta-publishing` provides two typed, fail-closed Meta Graph API
boundaries:

- `@mgreten/meta-social-publisher` publishes an exact founder-approved bundle to
  a Facebook Page and/or Instagram Professional Account.
- `@mgreten/meta-ads-publisher` creates a Campaign, Ad Set, Creative, and Ad,
  while forcing every delivery-capable object to `PAUSED`. The Creative is inert
  and has no delivery status.

The models intentionally do not generate copy, choose audiences, approve
content, activate ads, change budgets, or schedule delivery. Keep those
responsibilities in separate generation and approval workflows.

## Safety contract

Both models bind an immutable versioned campaign manifest, complete landing
page, channel copy, media rights, and exact SHA-256 approval digests before an
external call. They persist redacted intent before effects and checkpoint every
partial success. Exact and conflicting idempotency-key replays fail closed so an
operator reconciles an uncertain call instead of blindly retrying it.

Credentials must come from a Swamp vault. Literal tokens are not accepted as a
valid configured credential source and tokens or raw Meta error bodies are never
persisted. Readiness methods perform credential-free packet validation; they do
not prove that a token or account is live.

## Organic social model

Create an instance with account IDs and a vault-backed token reference. Keep it
unconfigured while validating packet readiness:

```yaml
type: "@mgreten/meta-social-publisher"
typeVersion: "2026.08.26.3"
name: my-meta-social-publisher
globalArguments:
  accessToken: ""
  credentialSource: unconfigured
  facebookPageId: ""
  instagramBusinessAccountId: ""
  graphVersion: v26.0
  requestTimeoutMs: 10000
  instagramContainerPollAttempts: 5
  instagramContainerPollDelayMs: 1000
methods: {}
```

`readiness` validates campaign, landing, social-copy, media, and rights
bindings. `publish` additionally requires the exact human approval, idempotency
key, vault-backed credentials, and relevant account IDs. Instagram media must be
reachable through a public HTTPS URL. Container status polling is bounded and
checkpointed before `/media_publish`.

## Paused Meta Ads model

Configure conservative budget ceilings before supplying credentials:

```yaml
type: "@mgreten/meta-ads-publisher"
typeVersion: "2026.08.26.2"
name: my-meta-ads-publisher
globalArguments:
  accessToken: ""
  credentialSource: unconfigured
  businessId: ""
  adAccountId: ""
  pageId: ""
  pixelId: ""
  appId: ""
  graphVersion: v26.0
  requestTimeoutMs: 10000
  maxDailyBudgetMinor: 2000
  maxLifetimeBudgetMinor: 20000
methods: {}
```

`readiness` validates exact destination UTMs, website conversion, objective and
optimization compatibility, adult ISO-country targeting, Special Ad Category,
rights, chronology, and budget ceilings. `createDraft` requires exact human
approval and creates Campaign → Ad Set → Creative → Ad with Campaign, Ad Set,
and Ad fixed to `PAUSED`. There is no activation or spend method.

Automated tests should inject deterministic Graph responses. Before any live
use, verify current Meta permissions and API behavior, use rights-cleared test
media, and reconcile every returned remote ID against Swamp's durable evidence.
