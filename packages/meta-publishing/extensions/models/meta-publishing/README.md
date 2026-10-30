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

Configure credentials through a Swamp vault expression and set
`credentialSource: vault` only as an explicit operator attestation of that
binding. Swamp resolves expressions before model execution, so the extension
cannot independently distinguish the resolved secret from a literal global
argument; review the model definition as part of credential setup. Tokens are
marked sensitive, and neither tokens nor raw Meta error bodies are persisted.
Readiness methods perform credential- and account-independent packet validation;
they do not prove that a token or account is live. Mutating methods additionally
run a labeled configuration preflight.

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
  instagramContainerPollDelayMs: 60000
methods: {}
```

`readiness` validates campaign, landing, social-copy, media, and rights
bindings. `publish` additionally requires the exact human approval, idempotency
key, vault-backed credentials, and relevant account IDs. Instagram media must be
reachable through a public HTTPS URL. Container status polling is bounded and
checkpointed before `/media_publish`.

The v26 Facebook Login path requires a Page access token and Meta's current Page
and Instagram publishing permissions. Follow Meta's official Pages API and
Instagram Content Publishing documentation when provisioning an app; account
roles, Page Publishing Authorization, app review, public JPEG media, and rate
limits cannot be proven by credential-free readiness.

## Paused Meta Ads model

Configure conservative budget ceilings before supplying credentials:

```yaml
type: "@mgreten/meta-ads-publisher"
typeVersion: "2026.08.26.2"
name: my-meta-ads-publisher
globalArguments:
  accessToken: ""
  credentialSource: unconfigured
  adAccountId: ""
  pageId: ""
  pixelId: ""
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
and Ad fixed to `PAUSED`. Marketing API v26's
`targeting_automation.advantage_audience` value is always explicit. There is no
activation or spend method.

Automated tests should inject deterministic Graph responses. Before any live
use, verify current Meta permissions and API behavior, use rights-cleared test
media, and reconcile every returned remote ID against Swamp's durable evidence.
