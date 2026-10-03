# Canva extension validation — 2026-10-03

Pre-publication validation record for version `2026.10.03.1`. Validation used
local execution and mocked transport only; no live authorization, Canva writes,
or uploads were performed. Registry publication is separate from live API
verification.

## Mechanical checks

- Schema/write conformance: PASS. Auth writes populate the OAuth session; batch
  writes preserve the frozen manifest and job/asset/error receipts; folder and
  move writes preserve intent and completion; page writes retain normalized
  items and continuation. Mock writes validate their target schema.
- Truncation honesty: PASS. One-page listing sets `truncated` from continuation;
  the capped move scan fails if membership cannot be confirmed.
- Instance names: PASS. Shared auth, batch, folder, and move writers use stable
  names and compatible schemas. Page names are separate from intent names.
- Schema coverage: PASS. Optional token, expiry, job, asset, error, folder ID,
  and continuation fields have actual population paths.

## Dimensional review

- Credentials/secrets: PASS. Sensitive metadata is on the outer optional token
  and client-secret schemas. Swamp-generated JSON schemas retain it. A CLI smoke
  test verified vault references in stored PKCE/token outputs; missing vault
  configuration fails before execution. No real credentials used.
- Logging: PASS for secret safety. Entry/completion logs omit credential data;
  repeat-safe no-op paths can return without another completion log.
- Error handling: PASS with deliberate exception to write-after-success:
  pre-effect intent must survive ambiguous provider responses. Errors never
  fabricate completion. Provider error bodies are omitted to avoid secret
  leakage; HTTP status and retry guidance remain available.
- Testing: PASS for local/mocked verification; live coverage pending. Sixteen
  tests cover protocol bytes, PKCE and state, token rotation, upload resume,
  interrupted effects and receipt-write failures, path confinement, changed
  images, request binding, HTTP 429, provider job mismatch, and pagination. The
  schema-validating in-memory harness is supplemented by actual Swamp CLI
  execution with an isolated vault and a mocked token transport.
- Idempotency/resilience: PASS. Stable request IDs bind exact intents; known
  jobs resume via GET only; unknown effects block resubmission. New OAuth
  connections cannot silently reuse old intents. Reauthorization/new request IDs
  require reviewing previous receipts; cross-batch deduplication is absent.
- API contracts: PASS against official documentation, not live-tested. Token
  form encoding/Basic auth, image bytes/metadata, job responses, folder
  creation/moves, and folder listing match the documented API.
- Resource management: PASS. File handles close in `finally`; HTTP calls have
  timeout/cancellation; error and unused move bodies are canceled; successful
  bodies are consumed. Temporary local smoke repositories are removed.
- Published-surface hygiene: PASS. Examples use fake IDs/credentials,
  `example.com`, and loopback, with no customer/account identifiers.
- Schema strictness: PASS. Object schemas strip unknown fields; no passthrough.
- Lifetime/GC: PASS. Durable intents have infinite lifetime and bounded version
  history; listing pages expire in one day. Do not delete unresolved ledgers.
- CRUD completeness: NOT APPLICABLE to the intentionally bounded upload/
  organization integration; deletes and full design lifecycle are not offered.
- Preflight: PASS within methods. Confirmation, auth/scopes/expiry, connection,
  root confinement, and all-file hashes are checked before provider mutations.
  These safety checks cannot be bypassed via `--skip-checks`.
- Instance names/data access: PASS. State is read through `readResource`;
  namespaces separate all incompatible outputs.
- Version upgrades: NOT APPLICABLE to initial release.

## Executed verification

- Deno type check: passed (including test compilation).
- Deno tests: 16 passed, zero failed, without network permission.
- Deno lint: passed excluding `no-import-prefix` (inline pinned dependency
  imports are required for Swamp extension bundling).
- Swamp discovery/type description: nine methods and five resource specs.
- CLI smoke: `beginAuthorization` rejects missing vault; with an isolated
  local-encryption vault it generates a URL and vaults PKCE fields.
- CLI smoke: mocked `completeAuthorization` accepts a vault-sourced callback,
  resolves the stored PKCE session/client secret and vaults mock tokens.
- Packaging: dry-run archive built. Static analyzer flags `token_type` as a
  possible secret; it is only the literal OAuth token-kind discriminator, not an
  access or refresh token. The dry-run does not publish to the registry.

## Required before live use

Create/configure the Canva REST developer app and exact callback URI, verify
development eligibility for the user's Canva plan, store secrets through hidden
vault input, then test actual browser consent and authenticated endpoints. Only
approved assets should be uploaded; do not use live uploads as an unapproved
smoke test. The API does not provide automatic Brand Kit setup in this
implementation. PNG/JPEG layers are supported, not editable text or SVG.

Rate pacing is per model, not an account-wide limiter. Asset directories must
remain trusted during execution. Manual recovery cannot prove a job's original
content hash because Canva does not return it. These limitations are explicit in
the runbook rather than hidden retries or guessed reconciliation.
