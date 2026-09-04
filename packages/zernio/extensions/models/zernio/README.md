# Zernio Swamp Extension

`@mgreten/zernio` is a deliberately read-only Zernio API boundary.
`inspectAccounts` verifies one configured profile and its allowlisted account
IDs using `GET /v1/profiles` and `GET /v1/accounts?profileId=…`, while
`inspectAccountHealth` reads the corresponding health summary.

The API key must be a restricted, vault-backed key. The extension never writes
to Zernio and does not expose publishing, scheduling, ads, messages, webhooks,
or account-connection methods. It stores only a redacted readiness receipt: the
configured profile ID, expected account IDs, safe display metadata, connection
state, observation time, and a blocked/ready result. Provider error bodies and
the API key are never written to a Swamp resource or log.

Configure a model instance with a vault expression for `apiKey`, the Zernio
profile ID, and every connected-account ID it may inspect. The allowlist may
cover up to 100 account/platform pairs. Keep campaign approvals, content, and
any eventual provider mutation in your application workflows rather than this
generic extension.

```yaml
type: "@mgreten/zernio"
name: my-zernio-read
globalArguments:
  apiKey: "${vault.my-secrets.zernio_read_api_key}"
  credentialSource: vault
  profileId: "zernio-profile-id"
  expectedAccounts:
    - { platform: facebook, accountId: "zernio-facebook-account-id" }
    - { platform: instagram, accountId: "zernio-instagram-account-id" }
methods: {}
```

Run either read-only method after the model has been created:

```bash
swamp model method run my-zernio-read inspectAccounts
swamp model method run my-zernio-read inspectAccountHealth
```

`inspectAccounts` makes only GET requests—one to `/v1/profiles` and one or more
to `/v1/accounts?profileId=…`. A missing, disconnected, or unexpectedly mapped
account produces a `blocked` receipt rather than attempting any repair or
reconnection. The account-connection dashboard, native Meta roles, OAuth scope
selection, billing, and any later mutation are deliberate manual boundaries.

Both methods are read-only. `inspectAccounts` reads up to ten 100-account pages
and marks its receipt as truncated rather than silently trusting an incomplete
listing. `inspectAccountHealth` records Zernio's health, token, reconnect,
posting, analytics, and issue fields for only the configured allowlist.
