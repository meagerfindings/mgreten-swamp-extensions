# @mgreten/canva

Reusable Canva REST integration, with no brand-specific code. Initial release:
`2026.10.03.1`. Not yet tested against an authenticated live Canva account.

Install into an initialized Swamp repository:

```sh
swamp extension pull @mgreten/canva@2026.10.03.1
```

## Capabilities

| Method                  | Behavior                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `beginAuthorization`    | Creates PKCE verifier/state and a browser sign-in URL                                                                      |
| `completeAuthorization` | Checks the exact callback origin/path, state, age and one-use session, then exchanges the code                             |
| `refreshAuthorization`  | Rotates and persists Canva's single-use refresh token                                                                      |
| `prepareUploads`        | Freezes 1–100 relative PNG/JPEG paths, names, sizes and SHA-256 hashes; no provider writes                                 |
| `uploadBatch`           | One sequential fan-out under the model lock; durable intent before each POST, job IDs before polling, asset IDs on success |
| `recoverUpload`         | Read-only provider reconciliation of a manually verified job for an uncertain upload                                       |
| `createFolder`          | Creates a folder with a stable request ID and pre-effect intent                                                            |
| `listFolderItems`       | Reads one folder/image page; includes continuation and `truncated`                                                         |
| `moveItem`              | Moves an image/folder; uncertain moves are reconciled by membership reads, never repeated automatically                    |

No deletes, design publishing, Brand Kit writes, automatic image generation, or
credential-bearing calls to arbitrary API hosts. Canva URLs are pinned and
redirects are rejected. Uploads are direct file bytes, not publicly hosted URLs.

## Setup and OAuth

1. Create an app in <https://www.canva.com/developers/apps> and enable the REST
   API integration under **Outside Canva**. Check current development-account
   eligibility: private production distribution requires Canva Enterprise; this
   package does not bypass that restriction.
2. Enable `asset:read`, `asset:write`, `folder:read`, and `folder:write` scopes.
3. Register your exact callback URI. For manual local authorization, an example
   is `http://127.0.0.1:8977/canva/callback`. This extension does **not** start
   an HTTP listener. The browser can end at an unavailable loopback page; the
   complete URL still contains the code/state. For a remote user, loopback is on
   the user's device, not the runner. Use a private callback receiver or
   transfer the callback into a vault using hidden input; never paste it into
   agent chat or a committed model definition.
4. Store the client secret in a Swamp vault using hidden interactive input:

   ```sh
   swamp vault put your-canva-vault client_secret
   ```

5. After installing the extension (or loading its source under
   `extensions/models/canva`), create a managed instance:

   ```sh
   swamp model create @mgreten/canva my-canva --json
   ```

   Edit the scaffold's existing global arguments (preserve its assigned ID):

   ```yaml
   globalArguments:
     clientId: YOUR-CANVA-CLIENT-ID
     clientSecret: '${{ vault.get("your-canva-vault", "client_secret") }}'
     redirectUri: http://127.0.0.1:8977/canva/callback
     assetRoot: assets/to-upload
   ```

   `assetRoot` resolves against the Swamp repository directory. Only configure a
   dedicated directory containing approved uploadable material, not the
   repository root, home directory or credentials directory. Paths are resolved
   against it and escaping paths/symlinks are rejected. Keep that directory
   trusted and unchanged during upload execution.

6. Run `swamp model method run my-canva beginAuthorization`. Retrieve only the
   public URL using CEL, without dumping the resolved session:

   ```sh
   swamp data query 'modelName == "my-canva" && name == "oauth-session"' \
     --select attributes.authorizationUrl --json
   ```

   Open that URL and approve access. Within ten minutes, store the returned
   callback URL using hidden vault input:

   ```sh
   swamp vault put your-canva-vault callback_url
   swamp model method run my-canva completeAuthorization \
     --input 'callbackUrl=${{ vault.get("your-canva-vault", "callback_url") }}'
   ```

   All pending PKCE values and tokens are marked sensitive in resource schemas;
   Swamp vault protection must be available. Never dump resolved OAuth
   resources, raw token responses, or secret values. Delete the consumed
   callback secret after successful authorization.

Run `refreshAuthorization` before expiry; no automatic refresh/retry is hidden
inside upload calls. A refresh preserves the connection ID and upload intents.
Beginning a new authorization generates a new connection ID, so old intents
cannot silently be reused against a different account. Interrupted code/token
exchanges are blocked and require a new authorization. Review old completed
receipts before preparing new batches after reauthorization to avoid duplicates.

## Upload and organize

Prepare one bounded batch, with names up to 50 characters:

```sh
swamp model method run my-canva prepareUploads --input '{
  "requestId": "brand-kit-v1",
  "files": [
    {"path": "logo.png", "name": "Official logo"},
    {"path": "overlay.png", "name": "Text-left overlay"}
  ]
}'
swamp model method run my-canva uploadBatch \
  --input requestId=brand-kit-v1 --input confirmUpload=true
```

The batch is stored as `batch-brand-kit-v1`. Inspect its items through Swamp
data retrieval, not files in `.swamp`. Only `complete` items have confirmed
asset IDs. A successful **progress** method run does not mean every job is
complete: `submitted` jobs need another call to `uploadBatch`; `failed` jobs
remain failed and are not resubmitted. A different
filename/name/hash/order/root/connection cannot overwrite the same prepared
request ID. Duplicate image bytes within a batch are rejected; deduplication
does not span different batches or instances.

Create a folder, inspect its returned ID, then move confirmed assets into it:

```sh
swamp model method run my-canva createFolder \
  --input requestId=brand-folder-v1 --input name="Brand assets" \
  --input parentId=root --input confirmCreate=true
swamp model method run my-canva listFolderItems --input folderId=FOLDER_ID
swamp model method run my-canva moveItem \
  --input requestId=logo-move-v1 --input itemId=ASSET_ID \
  --input folderId=FOLDER_ID --input confirmMove=true
```

Use CEL references to recorded IDs in real workflows. Do not parallelize calls
on the same model; `uploadBatch` already performs fan-out while holding its
lock. Uploads are paced at 2.1 seconds per POST. Folder creation is limited by
Canva to 20/minute; pace repeated independent folder calls at least three
seconds apart. 429/other HTTP errors do not trigger mutation retries. Honor
provider rate limits before further reads/calls. Multiple instances sharing an
account must coordinate their combined rate budget outside this package.

## Interrupted effects and recovery

`uncertain` is an intentional safety stop: the provider may have acted even if
the response, schema validation or durable receipt write failed. Do not change
request IDs simply to retry. Inspect the generated method report and Canva
first.

- A persisted upload job ID is safe to poll without resubmitting bytes.
- If the job ID was lost, `recoverUpload` requires a manually verified job ID,
  zero-based item index and `confirmJobBelongsToIntent=true`. Canva's job API
  does not expose our input hash, so the extension cannot independently prove
  that this is the right job. If no ID can be recovered, resolve manually; no
  "reset and POST again" method is provided.
- An uncertain folder creation is blocked; discover/verify the created folder in
  Canva before deciding how to proceed manually. No automatic name-based folder
  deduplication is claimed.
- An uncertain move reads up to 20 destination pages. If membership cannot be
  confirmed, it stops rather than pretending the capped scan proved absence.
- Canva's `item_in_multiple_folders` error requires Canva UI intervention.

Keep one managed model per Canva connection. Using disposable/direct-execution
instances for each call loses the shared intent ledger. Do not delete the model
or its retained data while effects are unresolved.

## File and platform limits

PNG/JPEG only, each nonempty and smaller than 50,000,000 bytes. Header checks
reject obvious unsupported formats; Canva still validates full image decoding.
SVG logos must be exported to PNG or uploaded manually through Canva. Folder
listing intentionally filters to images/folders; designs and videos are outside
this initial package. Uploading reusable PNG layers does not turn flattened text
into editable Canva text or install a Brand Kit. Set colors/fonts/logos through
Canva UI where no supported REST endpoint exists.

## Verification

```sh
deno check --node-modules-dir=none --no-lock extensions/models/canva/canva.ts
deno test --node-modules-dir=none --no-lock --allow-read --allow-write \
  extensions/models/canva/canva_test.ts
swamp model type describe @mgreten/canva --json
swamp extension push extensions/models/canva/manifest.yaml --dry-run --json
```

Mocked tests check protocol bytes, PKCE/state, token rotation, pre-effect
intents, resume/no-duplicate behavior, changed files, path confinement, rate
errors, provider failures, and pagination. An isolated Swamp CLI smoke test also
verified vault-expression inputs, resolved resource reads, and vault-backed
PKCE/token output with a mocked transport. Running without a vault failed
safely.

Rails browser E2E is not applicable: this model adds no application view, route,
form or JavaScript UI. Browser OAuth consent and authenticated API smoke tests
are required before live uploads; they have not been run. See `REVIEW.md` for
the validation record and limitations.

Official references:

- <https://www.canva.dev/docs/connect/authentication/>
- <https://www.canva.dev/docs/connect/api-reference/assets/create-asset-upload-job/>
- <https://www.canva.dev/docs/apps/rest-apis/reference/folders/create-folder/>
- <https://www.canva.dev/docs/apps/rest-apis/reference/folders/move-folder-item/>
- <https://www.canva.dev/docs/apps/rest-apis/reference/folders/list-folder-items/>
