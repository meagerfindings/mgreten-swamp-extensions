# @mgreten/meal-planner

`@mgreten/meal-planner` is an app-specific Swamp behavior that executes queued
meal-planning operations through the application's private storage API. It is
**not** a standalone planner, web application, database, authentication system,
or recipe library. The PWA, account/session boundary, authoritative store, and
operation queue belong to the separately deployed meal-planner application.

All examples below are synthetic. This package contains no household records,
account credentials, bootstrap material, or provider secrets.

## Required services and trust boundary

The behavior's only method is `executeOperation`, which accepts one
app-generated 32-character lowercase hexadecimal `operationId`. It claims the
queued operation from the storage API, dispatches only the operation kinds
listed below, and reports completion there. It is not an unrestricted HTTP or
workflow proxy.

The current runtime accepts only these app-owned global values, and rejects
other targets before reading the credential:

- `storageApiUrl`: exactly `http://meal-planner-api:3000`, reachable only on the
  private application network.
- `storageTokenFile`: exactly `/run/secrets/meal-planner/storage-token`, mounted
  read-only for the Swamp runtime.

The storage API must authenticate the runtime's bearer token and implement the
meal-planner `/internal/v1` operation-claim/completion and narrow household,
recipe, week, pantry, and grocery endpoints used by the behavior. This API and
its credentials are **required dependencies and are not included in this
package**. Do not expose the internal API or token to browsers, household users,
or general-purpose Swamp inputs. Grant only the needed `run` permission for
`meal-planner-runtime.executeOperation`; do not let untrusted callers set the
behavior's globals.

The runtime also requires `@mgreten/mealie` to be installed and configured as
the `meal-planner-mealie` behavior. It invokes that adapter's
`importRecipeFromUrl`, `createStructuredRecipe`, `updateStructuredRecipe`, and
`getRecipe` methods for canonical recipe operations. The app retains its own
approval snapshots; Mealie remains canonical for recipe content.

The behavior's supported queued operation kinds are:

- `household.restrictions.save`, `household.diners.save`,
  `household.diner-restrictions.save`, `household.planning.save`
- `recipe.import-url`, `recipe.create`, `recipe.update`, `recipe.review`
- `week.save`, `week.approve`, `pantry.save`, `grocery.recalculate`,
  `grocery.manual-item.add`

Only use the behavior as the private app's worker behind its authenticated
gateway. The gateway owns login, household authorization, request validation,
CSRF protection, and operation status. A public package installation alone
provides none of these services.

## Recipe write limits and uncertain outcomes

Structured recipe create/update inputs are normalized and checked against the
shared field limits and a 1,000,000-byte UTF-8 JSON content cap before the
Mealie write. If a Mealie write has been attempted and canonical readback or
app persistence then fails, the operation is recorded as
`OPERATION_OUTCOME_UNKNOWN`; a new household recipe write is fenced until an
operator inspects the canonical Mealie recipe and app operation state. There
is no automatic replay, canonical deletion, or package-provided reconciliation
endpoint.

URL imports are necessarily different: the canonical output is not known until
Mealie has accepted the import. If normalization or app persistence fails
afterward, the result is also uncertain and requires operator-assisted review.
An unresolved outcome blocks household recipe writes and is a household-
readiness limitation until a separately approved recovery procedure is
available. Week, pantry, and grocery operations are not blocked by this fence.

### Mealie v3.30.0 import deployment restriction

Keep URL imports disabled at the hosting application's request and dispatch
boundaries until a verified upstream fix is deployed. Mealie v3.30.0's
recipe-page and image fetch transport disables TLS certificate verification;
some image URLs and URL-bearing exceptions also reach INFO/error logs. Default
INFO logging does not eliminate that exposure. Proxy, FlareSolverr, and hostname
allowlist settings are not certificate-verification fixes. This is separate
from the adapter-to-Mealie API connection, which does not disable TLS checks.

Manual structured recipe creation, edits, review, planning, and groceries do
not require URL imports. The runtime retains its generic import dispatch for
compatible deployments; publishing this package does not make an unsafe
Mealie importer safe or override an application's disabled-import policy.
See the exact upstream
[fetch transport](https://github.com/mealie-recipes/mealie/blob/9552df62118224a377d9c9b0a62706a62220ab86/mealie/pkgs/safehttp/fetch.py)
and the `@mgreten/mealie` README for the upstream limitations.

## Approval and response bounds

Approval snapshot JSON is limited to 4,000,000 UTF-8 bytes, measured over the
exact serialized snapshot before it is inserted or the week/operation is
marked successful. The existing v1 response shape is preserved, including its
two snapshot copies. The result budget is derived as two 4,000,000-byte copies,
the app's 1,048,576-byte maximum request (which bounds the saved week meals),
and 65,536 bytes for bounded IDs, revisions, timestamps, and envelope metadata.
Internal HTTP responses are separately counted as streamed bytes and capped at
10,000,000 bytes; `Content-Length` is not trusted. An oversized response is
canceled with a bounded wait. If storage already committed approval before a
response becomes unusable, the committed success remains authoritative.

Exact Mealie invocation receipts are limited to 8 MiB before UTF-8 decoding and
JSON parsing, matching the reusable Mealie client's response ceiling without
importing its implementation. The pinned Swamp `dataRepository.getContent`
contract returns a `Uint8Array`, so this check occurs after that repository has
allocated the bytes; it is not streaming or pre-allocation protection. An
oversized receipt after a canonical write remains an uncertain outcome and
requires operator-assisted review.

## Synthetic example

A synthetic four-serving recipe uses 400 g tomato, 200 g lentils, and
unquantified salt. For seven portions, the plan needs 700 g tomato, 350 g
lentils, and an unresolved salt quantity. With 250 g tomato and 0 g lentils in
pantry, the expected purchases are 450 g tomato and 350 g lentils. This is
arithmetic only; the behavior does not seed or assume these values.

## Integrations and inference

The Mealie adapter is the only recipe-service integration invoked here. This
package does not provide voice, vision, calendar, weather, retailer, or Kroger
connectivity, and it does not configure an inference provider. Host operators
control Swamp telemetry; this package does not enable or disable it.

## Development and publication

The canonical runtime source is `extensions/models/meal_planner_runtime.ts`;
`extensions/domain.ts` is its shared domain dependency. The private app, its
tests, and its Docker build consume generated copies at the same relative paths
under `services/meal-planner/extensions/`. Do not edit those copies directly or
maintain a second implementation. Infrastructure must run staging before app
tests and image builds, verify freshness before packaging, and separately own
the read-only Serve mount activation.

From this extension repository, stage or verify the app copies with:

```sh
node packages/meal-planner/tools/stage-app-sources.mjs stage /path/to/docker-configs/services/meal-planner
node packages/meal-planner/tools/stage-app-sources.mjs verify /path/to/docker-configs/services/meal-planner
```

Both commands fail if a canonical source is missing. `verify` also fails if an
app copy is missing or differs from its canonical source. The generated app
paths use only Node 24 built-ins, are ignored in the app checkout, and must not
be committed as a competing source.

The sibling runtime contract test calls the exported `executeOperation` with
synthetic storage responses and an injected in-memory HTTP fixture; it does not
connect to Mealie or the household API. Run it against the canonical package
source:

```sh
cd packages/meal-planner
deno test extensions/models/meal_planner_runtime_test.ts
deno test extensions/domain_test.ts
```

The private app's Node tests and final Docker image must use the generated copy
only after `stage` followed by `verify`. The package alone cannot service the
PWA: authenticated storage, the protected token file, the Mealie adapter, Swamp
Serve, and infrastructure-owned mounts/configuration are required.

Swamp's quality heuristic may flag `storageTokenFile` as a credential because of
its field name. It is only a fixed path reference to the protected runtime file,
not the credential value. The fixed-path guard remains enforced, and this
finding is documented rather than suppressed or disguised as a secret input.

```sh
swamp extension fmt manifest.yaml --check --json
swamp extension quality manifest.yaml --isolated --json
swamp extension push manifest.yaml --dry-run --json
```

The dry run is a preview only. It does not authorize registry publication.
