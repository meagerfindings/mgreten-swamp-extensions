# Mealie

`@mgreten/mealie` is a reusable Swamp model and TypeScript client for Mealie's
recipe API. It is designed for the current Mealie API contract (including the
v3.30.0 release) and deliberately does not claim migration or endpoint
compatibility with legacy v1 deployments.

The package-root `mod.ts` exports the client, schemas, and model for local
composition and tests. In a Swamp package archive, `mod.ts` is stored under
`files/`; the matching `extensions/models/mealie.ts` source copy is also stored
there so the relative import remains resolvable. The executable model is bundled
separately under `models/`. Tests stay in the GitHub source tree and are not
runtime files.

The client and all nine Swamp methods share the same bounded HTTP
implementation. When a host application invokes this model, use Swamp Serve's
`context.runModel` so the Mealie request runs inside the Swamp runtime rather
than duplicating its transport in another service.

## Methods and resources

Every successful method writes a resource and returns Swamp data handles. The
recipe/page returned by Mealie is available as the resource record's
`attributes`; the method result itself is not the recipe JSON.

| Method                   | Method arguments                            | Resource             | Behavior                                                                                                                                     |
| ------------------------ | ------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `verifyAccess`           | `{}`                                        | `access/current`     | Reads Mealie version and makes an authenticated, one-item recipe-list request.                                                               |
| `listRecipes`            | `{ search?, page?, perPage? }`              | `recipePage/current` | Returns the bounded, unremapped Mealie page; `perPage` is at most 100.                                                                       |
| `getRecipe`              | `{ slug }`                                  | `recipe/current`     | Reads a complete recipe by slug or Mealie recipe ID.                                                                                         |
| `createRecipe`           | `{ recipe }`                                | `recipe/current`     | Creates by name, reads the new recipe, applies supplied structured fields with full-replacement `PUT`, then reads back the canonical recipe. |
| `createStructuredRecipe` | `{ recipe, ingredients }`                   | `recipe/current`     | Resolves/creates Food and Unit records from names, creates a manual recipe, then reads back canonical `Recipe-Output`.                       |
| `updateRecipe`           | `{ slug, recipe }`                          | `recipe/current`     | Sends a non-empty partial recipe patch using Mealie `PATCH`, then reads back the canonical recipe. Omitted fields stay unchanged.            |
| `updateStructuredRecipe` | `{ slug, recipe?, ingredients }`            | `recipe/current`     | Resolves/creates Food and Unit records from names, replaces structured ingredients with `PATCH`, then reads back canonical `Recipe-Output`.  |
| `importRecipeFromUrl`    | `{ url, includeTags?, includeCategories? }` | `recipe/current`     | Imports and persists immediately, then reads back the canonical recipe.                                                                      |
| `importRecipeFromPhoto`  | `{ source, fileName, mediaType }`           | `recipe/current`     | Reads one bounded Swamp-managed image file, submits it to Mealie's AI import, then reads back the canonical recipe.                          |

Swamp runs the `live`-labelled authenticated access check before create, update,
and import methods. The standalone `verifyAccess` method exposes the same
bounded version/authentication check for explicit health verification.

The canonical recipe output schema preserves unknown fields returned by the
configured Mealie version. This keeps recipe fields such as `recipeServings`,
`recipeYieldQuantity`, `recipeYield`, nested ingredient references, instruction
references, organizer data, and future version fields from being silently
discarded. Write inputs use a separate strict editable-field allowlist: create
and update reject identity fields and unknown top-level keys rather than
forwarding canonical output fields. The update method accepts non-empty partial
allowlisted `RecipeIn` fields and relies on Mealie's documented PATCH semantics
rather than reserializing the full output object. Writable top-level fields are
`name`, `description`, `recipeServings`, `recipeYield`, `recipeYieldQuantity`,
`recipeIngredient`, and `recipeInstructions`; legacy snake-case aliases and
identity fields are not accepted as v3.30 write inputs.

### Structured Food and Unit references

For a consumer DTO that represents ingredient and unit names as strings, call
`createStructuredRecipe` or `updateStructuredRecipe` inside Swamp Serve instead
of constructing Mealie's nested ingredient payload in the consuming service.
Each ingredient has this shape:

```ts
{
  name: string;                 // Food name
  quantity: number | null;      // keep null when not structured; never parse note/display
  unit?: string | null;         // Unit name, plural, alias, or abbreviation
  note?: string | null;
}
```

`createStructuredRecipe` requires `recipe.name`; `updateStructuredRecipe`
requires `slug`. Their `recipe` object accepts `name`, `description`,
`recipeServings`, `recipeYield`, `recipeYieldQuantity`, and `recipeInstructions`
(all optional for update). The methods load the group-scoped `GET /api/foods`
and `GET /api/units` catalogs using bounded pages of 100 and a 1,000-item safety
limit. Names are matched exactly after Unicode NFKC normalization, trimming, and
lowercasing; food plural names/aliases and unit plural
names/aliases/abbreviations also count as exact matches. Ambiguous matches fail
instead of selecting one. If no exact item exists, the extension creates it with
`POST /api/foods` or `POST /api/units` and the minimal body `{"name":"…"}`.
Creating catalog entries requires Mealie's group-organizer permission
(`GROUP_ORGANIZE`).

The emitted RecipeIn ingredients contain `{ id, name }` Food/Unit references,
the supplied nullable quantity, and optional `note`. The extension does not
infer an abbreviation, display string, original text, or volatile ingredient
reference ID; Mealie calculates display text and the extension returns canonical
GET readback. `MealieRecipeIngredientReferenceSchema` exports the exact nested
Food/Unit reference and quantity/note shape used by this adapter.

These are single Swamp operations, **not Mealie database transactions**. Food or
Unit records created before a later failure may remain in the group catalog. A
timed-out catalog POST raises `MealieWriteOutcomeUnknownError` with operation
`createFood` or `createUnit`; the extension does not retry that write
automatically. Inspect the catalog before deciding whether to invoke the method
again. URL/photo imports remain unparsed candidate data: consumers must not
infer quantities from `note`, `display`, or `originalText`; human structuring
and canonical round-trip verification are required before treating imported
amounts as quantified.

### Swamp composition from a consumer behavior

Install `@mgreten/mealie` in the Swamp repository and pre-create a model
definition such as `mealie-example`. A consuming behavior makes the network
operation in its own Swamp Serve execution:

```ts
const result = await context.runModel({
  definition: "mealie-example",
  method: "importRecipeFromUrl",
  arguments: {
    url: args.url,
    includeTags: false,
    includeCategories: false,
  },
});
if (!result.ok) throw new Error(result.error.message);

const recipeHandle = result.resources.find(
  (resource) =>
    resource.kind === "resource" &&
    resource.specName === "recipe" &&
    resource.name === "current",
);
if (
  !recipeHandle || !Number.isSafeInteger(recipeHandle.version) ||
  recipeHandle.version < 1
) {
  throw new Error(
    "Mealie invocation did not return a usable recipe data handle",
  );
}

const records = await context.readModelData(
  "mealie-example",
  recipeHandle.specName,
);
const target = records.find(
  (record) =>
    record.name === recipeHandle.name &&
    record.specName === recipeHandle.specName,
);
if (!target) throw new Error("Mealie recipe data metadata is unavailable");

// readModelData returns latest records. Use it only to locate the stable model
// identity; getContent's final version argument binds this read to this call.
const bytes = await context.dataRepository.getContent(
  target.modelType,
  target.modelId,
  recipeHandle.name,
  recipeHandle.version,
);
if (!bytes) throw new Error("Mealie invocation output version is unavailable");
const canonicalRecipe = JSON.parse(new TextDecoder().decode(bytes));
```

For typed manual capture or structured edits, use the same exact-version
`recipe/current` handle flow with `method: "createStructuredRecipe"` or
`method: "updateStructuredRecipe"`. The method arguments are:

```ts
{
  slug: args.slug, // omit for create
  recipe: {
    recipeServings: args.servings,
    recipeYield: args.yieldUnit,
    recipeYieldQuantity: args.yieldQuantity,
  },
  ingredients: args.ingredients.map((ingredient) => ({
    name: ingredient.name,
    quantity: ingredient.quantity, // keep null if unknown
    unit: ingredient.unit,
    note: ingredient.note,
  })),
}
```

Pass method fields under `arguments`. The `runModel` success value contains
versioned `DataHandle`s, not the parsed recipe. `readModelData` returns latest
data only and must not be used as the canonical invocation result: another call
can replace `recipe/current` between the method run and the read. Instead,
select the matching handle and pass its `version` to
`context.dataRepository.getContent(type, modelId, name, version)`. The
`readModelData` lookup above supplies the target model identity; its attributes
are deliberately not used. If the exact version is unavailable, fail rather than
falling back to a newer recipe. For list output select the `recipePage` handle;
for access verification select `access`. Swamp supplies configured global keys
at its method-validation boundary, so do not pass connection settings or secrets
in method arguments.

Consumer applications own their eligibility, review, approval, and snapshot
policies. Mealie URL/photo imports create recipes immediately; this extension
does not make imported candidates review-only or publish an application-owned
snapshot.

## Configuration and secrets

Connection and photo-source policy settings are global arguments on the
pre-created model definition; method arguments never override them:

| Global argument        | Requirements/default                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`              | Admin-configured HTTP(S) service URL, without embedded credentials, query, or fragment. Include a path prefix only if the Mealie deployment is mounted under one. |
| `apiToken`             | Required Mealie bearer token; marked sensitive in the schema.                                                                                                     |
| `requestTimeoutMs`     | 1,000–120,000 ms; default 30,000.                                                                                                                                 |
| `maximumResponseBytes` | 1,024–8,388,608 bytes; default 2,097,152.                                                                                                                         |
| `maximumRequestBytes`  | 1,024–16,777,216 bytes; default 4,194,304.                                                                                                                        |
| `photoSourceAllowlist` | Default empty. Admin-only exact `{ modelType, modelId }` pairs for Swamp file sources accepted by photo import; at most 100 entries.                              |

Create the definition before app invocation. Store the token in a Swamp vault
and place only its expression in the definition; do **not** use a `modelType`
plus `name` auto-create call with a plaintext token or pass a token in the app's
`runModel.arguments`:

```yaml
type: "@mgreten/mealie"
globalArguments:
  baseUrl: "https://mealie.example.invalid"
  apiToken: "${{ vault.get(mealie-secrets, MEALIE_API_TOKEN) }}"
  requestTimeoutMs: 30000
  maximumResponseBytes: 2097152
  maximumRequestBytes: 4194304
  photoSourceAllowlist: []
```

Use a deployment-internal service URL for `baseUrl` when Mealie is reachable
only on a private service network. Avoid including tokens in URLs, CLI
arguments, environment variables, logs, or source files.

## Import and retry semantics

- URL import uses `POST /api/recipes/create/url`; Mealie persists the recipe
  before returning its slug. Photo import uses `POST /api/recipes/create/ai`
  with one multipart `images` file. Both are followed by
  `GET /api/recipes/{slug}` and return that canonical output.
- Imports and creates have **no idempotency key and no duplicate detection**.
  Calling them twice can create two recipes. A consumer must not blindly retry a
  request whose outcome is unknown.
- A transport timeout or other ambiguous server result on a write raises
  `MealieWriteOutcomeUnknownError`; inspect Mealie before deciding whether to
  submit again. A successful write followed by failed readback is represented
  separately (`MealieReadbackError` or `MealiePartialCreateError`). These error
  messages omit recipe slugs and content; `.slug`, `.operation`, and `.phase`
  remain available for local recovery code. Avoid forwarding those metadata
  fields to telemetry or user-visible generic errors.
- HTTP redirects are not followed, so the bearer token is not forwarded to a
  redirect target. Response/request body sizes and request duration are bounded;
  response bodies and credentials are not included in API errors.

### URL-fetch and SSRF boundary

The adapter accepts only HTTPS import URLs with a public-looking DNS hostname;
it rejects URL credentials, local-name suffixes, and IP literals. That check is
defense in depth, **not** an SSRF guarantee: DNS resolution, rebinding,
redirects performed by Mealie, and server-side fetch behavior remain under
Mealie and network control. Mealie v3.26.0 and later document server-side
`HTTP_ALLOW_LIST`/`HTTP_DISALLOW_LIST` controls (the deny list takes
precedence). `HTTP_ALLOW_LIST` is an exception for otherwise-blocked
private/internal destinations, not an outbound hostname allowlist; it does not
restrict requests to public destinations. Keep egress restricted at the network
layer. A private synthetic fixture may require a deliberate, narrow exception on
the Mealie server; do not loosen it broadly.

### Mealie v3.30.0 URL-import security limitation

In Mealie v3.30.0, the server-side transport used to fetch recipe pages and
imported images sets `verify=False`, disabling TLS certificate verification.
This is separate from the extension's adapter-to-Mealie API request: the
extension client uses injected/default `fetch` and sets no certificate
verification bypass for that hop. This says nothing about whether a deployment
uses HTTP or HTTPS for its Mealie API URL. Mealie's default direct-fetch path
still validates the resolved destination and pins the connection to the checked
IP addresses to mitigate DNS rebinding; that does not authenticate the TLS
certificate or hostname. The optional scraper proxy is not a workaround: the
same `verify=False` applies to its TLS connection, and Mealie cannot pin the
target DNS resolution when the proxy resolves it. `HTTP_ALLOW_LIST` is neither
TLS configuration nor an outbound host restriction. There is no documented proxy
or allowlist setting that restores certificate verification.

The v3.30.0 URL-import path also logs full fetch URLs at DEBUG, imported image
URLs at INFO, and can log URL-bearing exception details or tracebacks on errors.
Scraper DEBUG messages include scraped instruction content; the video
transcription strategy can also log transcript text when that strategy is
enabled. These are Mealie server logs, not logs emitted by the adapter's
API-request transport.

Until an upstream Mealie build is verified to validate certificates for direct
and proxied fetches and to keep URLs and recipe content out of logs, disable
`importRecipeFromUrl` for household use. This package retains the generic import
method for other deployments. Manual structured create/update is separate from
this server-side URL-fetch path. This finding does not certify Mealie's separate
photo-import/provider path.

Pinned v3.30.0 source and configuration:

- [`safehttp/fetch.py`](https://github.com/mealie-recipes/mealie/blob/9552df62118224a377d9c9b0a62706a62220ab86/mealie/pkgs/safehttp/fetch.py)
- [`safehttp/transport.py`](https://github.com/mealie-recipes/mealie/blob/9552df62118224a377d9c9b0a62706a62220ab86/mealie/pkgs/safehttp/transport.py)
- [`scraper_strategies.py`](https://github.com/mealie-recipes/mealie/blob/9552df62118224a377d9c9b0a62706a62220ab86/mealie/services/scraper/scraper_strategies.py)
- [`recipe_data_service.py`](https://github.com/mealie-recipes/mealie/blob/9552df62118224a377d9c9b0a62706a62220ab86/mealie/services/recipe/recipe_data_service.py)
- [backend configuration](https://github.com/mealie-recipes/mealie/blob/9552df62118224a377d9c9b0a62706a62220ab86/docs/docs/documentation/getting-started/installation/backend-config.md)

### Photo upload boundary

Version `2026.11.09.2` adds this source policy. Its upgrade adds
`photoSourceAllowlist: []` only when that global is absent, preserving an
existing configured allowlist and preserving explicit `null` so validation can
reject it rather than silently replacing it. The empty default keeps photo
import disabled until an administrator explicitly configures the global
`photoSourceAllowlist`. The strict write schemas accept only documented v3.30
camel-case fields and reject identity, legacy snake-case, or unknown top-level
write fields.

Photo import accepts only JPEG, PNG, or WebP files already stored as Swamp file
data. The method resolves the file by `(modelType, modelId, dataName, version)`
through Swamp's `dataRepository`, requires the `type=file` tag, validates size,
metadata MIME type and magic bytes, and never accepts a host filesystem path.
The hard image limit is 8 MiB and the effective request limit is also bounded by
`maximumRequestBytes`.

Photo import is **default-deny**. An administrator must configure an exact
`{ modelType, modelId }` pair in the global `photoSourceAllowlist`; the photo
method's arguments cannot override this list. The pair allows any file data
name/version in that model identity, so only allow models whose photo files are
appropriate for the Mealie service. This is an independent package boundary, not
a Serve grant: the pinned Serve worker data-repository path may separately
reject a cross-type source even when it is allowlisted, and the extension does
not widen runtime capabilities. Conversely, that path does not enforce the
invoking principal's per-record `data:read` permission for same-type IDs. Limit
`importRecipeFromPhoto` run access to callers trusted to read and submit files
from every model identity in the list. The package cannot provide caller-level
source authorization; leave the list empty unless that deployment condition is
met.

Repository read failures produce a sanitized `MealiePhotoSourceReadError` with
only a local `stage` (`metadata` or `content`); generic error messages do not
include source model IDs, file names, private paths, or underlying repository
error text.

Mealie requires a configured image-recognition-capable AI provider for image
extraction. A missing endpoint is reported as `MealieFeatureUnavailableError`;
an HTTP 400 photo rejection is reported as `MealiePhotoImportRejectedError`,
with a generic prompt to check provider configuration and upload validity. No
provider is bundled, selected, or paid for by this extension. A provider must be
approved and configured by the Mealie administrator before photo imports can
work.

## Reusable client and local install

The package root `mod.ts` exports `createMealieClient`, public argument and
recipe schemas, types, typed errors, limits, and the Swamp `model` definition.
The client is useful for deterministic tests and other Swamp-side reuse. For
applications, keep service requests in Swamp Serve rather than exposing the
Mealie token or duplicating this transport in an unrelated application server.

To install a local, unpublished copy, mount only this package root read-only in
the Swamp environment, then run:

```sh
swamp extension source add ./packages/mealie --repo-dir /path/to/swamp-repo
swamp behavior type describe @mgreten/mealie --repo-dir /path/to/swamp-repo --json
```

The source directory contains `manifest.yaml`, `extensions/models/mealie.ts`,
and `mod.ts`. `mod.ts` can also be imported directly by a Deno test or Swamp
behavior source when that runtime mount is available; it must not be used as a
Node-side HTTP client.

The package is MIT licensed; see [LICENSE](LICENSE).
