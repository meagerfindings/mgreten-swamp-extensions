# Tailscale OAuth-client replacement for Swamp

`@mgreten/tailscale-oauth-client` stages replacement of Tailscale OAuth clients through the official API. It fixes the origin to `https://api.tailscale.com`, refuses redirects, bounds responses and timeouts, and separates one-time credentials from safe operational state.

## Safety lifecycle

1. `previewCreate` validates a bounded request without network access and writes a SHA-256 confirmation bound to the request ID, description, scopes, and tags.
2. `createCandidate` requires that exact preview. After acquiring its manager bearer and immediately before `POST`, it durably records a non-secret creation-attempt journal containing the normalized request and hash. It stores safe metadata separately and writes `{clientId, clientSecret}` only to a `sensitiveOutput` resource. A completed request is locally idempotent. An attempted or partial result blocks another provider mutation until an operator reconciles Tailscale, metadata, and the vaulted credential.
3. `verifyCandidate` reads the vaulted candidate credential, requests a token with all configured scopes and tags, discards its access token, and stores only the exact requested grant and issuance receipt. This verifies OAuth issuance; it does not test node enrollment.
4. `previewCutover` and `recordCutover` require matching candidate metadata and verification, then record bounded non-secret operator evidence. They do not deploy the credential.
5. `previewRevoke` requires candidate, verification, and cutover receipts and emits an irreversible warning.
6. `revokePrevious` re-exchanges the candidate credential at its full configured grant, reads exact candidate and previous IDs, and rejects missing/inactive candidates or non-client targets. It mints its mutation bearer before recording a durable revocation-attempt journal immediately before `DELETE`. Prior missing/revoked targets and exact completed receipts are local idempotent success. An incomplete attempt requires manual reconciliation.
7. `syncCandidate` refreshes non-secret metadata; a `404` records `missing` state.

Tailscale provides a `PUT`/update operation for OAuth clients. This model intentionally omits it: staged replacement preserves a verifiable rollback boundary and avoids changing a live credential in place.

If the manager OAuth client is also the previous target, the model acquires the delete bearer before revocation, but a post-delete interruption can prevent automated diagnosis. Keep a break-glass manager credential outside this rotation and use Tailscale's admin UI/API manually to reconcile the non-secret attempt journal before any retry.

## Configure with a vault

Never place credentials directly in a committed model definition. Resolve both conservative-sensitive manager fields from a Swamp vault:

```yaml
name: tailscale-oauth-replacement
type: "@mgreten/tailscale-oauth-client"
globalArguments:
  managerClientId: '${{ vault.get("tailscale-secrets", "oauth-manager-client-id") }}'
  managerClientSecret: '${{ vault.get("tailscale-secrets", "oauth-manager-client-secret") }}'
  timeoutSeconds: 10
```

The candidate secret returned by Tailscale exists only once. Swamp automatically vaults the entire `candidateCredential` output. Safe metadata, previews, and receipts contain no client secret or access token. Do not put secrets in request IDs, descriptions, tags, scopes, or evidence.

## Example sequence

```text
swamp model method run tailscale-oauth-replacement previewCreate --input '{"requestId":"candidate-20260730-01","description":"replacement automation client","scopes":["oauth_keys:read"],"tags":[]}'
# Inspect the preview, then supply its exact confirmation.
swamp model method run tailscale-oauth-replacement createCandidate --input '{"requestId":"candidate-20260730-01","description":"replacement automation client","scopes":["oauth_keys:read"],"tags":[],"confirmation":"create-candidate:<sha256>"}'
swamp model method run tailscale-oauth-replacement verifyCandidate --input '{"requestId":"candidate-20260730-01"}'
swamp model method run tailscale-oauth-replacement previewCutover --input '{"requestId":"cutover-20260730-01","candidateRequestId":"candidate-20260730-01","candidateId":"<candidate-id>","evidence":["consumer deployment completed","authorized functional check passed"]}'
swamp model method run tailscale-oauth-replacement recordCutover --input '{"requestId":"cutover-20260730-01","candidateRequestId":"candidate-20260730-01","candidateId":"<candidate-id>","evidence":["consumer deployment completed","authorized functional check passed"],"confirmation":"record-cutover:<sha256>"}'
swamp model method run tailscale-oauth-replacement previewRevoke --input '{"requestId":"cutover-20260730-01","previousClientId":"<previous-id>","candidateRequestId":"candidate-20260730-01","candidateId":"<candidate-id>"}'
swamp model method run tailscale-oauth-replacement revokePrevious --input '{"requestId":"cutover-20260730-01","previousClientId":"<previous-id>","candidateRequestId":"candidate-20260730-01","candidateId":"<candidate-id>","confirmation":"revoke-previous:<sha256>"}'
```

Scopes are conservative bounded identifiers. Tags must match `tag:<name>`; at least one tag is required only for literal `devices:core` or `auth_keys` scopes. The model never auto-retries mutations. Infinite, non-secret creation and revocation attempt journals make interrupted operations diagnosable without retaining credentials. Status errors disclose only HTTP status and actionable `Retry-After`, never provider bodies.

## Scope boundary

This is a generic public lifecycle primitive. It does not discover private consumers, deploy credentials, decide whether private services are healthy, or orchestrate an organization-specific cutover. Keep those decisions in a private workflow that invokes these methods and records appropriately redacted evidence.

## License

MIT © 2026 Mat Greten.
