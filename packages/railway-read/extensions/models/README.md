# @mgreten/railway-read

`@mgreten/railway-read` retains bounded, typed Railway deployment snapshots in Swamp. It uses only Railway GraphQL queries and exposes no deployment, restart, rollback, variable, or settings mutations. Each snapshot records deployment status, timestamps, URLs, pagination state, and normalized Git source metadata so operations workflows can correlate a merged commit with the version actually running on Railway.

## Installation

```bash
swamp extension pull @mgreten/railway-read
```

## Setup

Create a project token from **Railway project → Settings → Tokens**, store it in a Swamp vault, and configure one or more services. Project tokens are scoped to one project environment and are the recommended least-privilege option. Account and workspace bearer tokens are also supported when explicit project and environment IDs are configured.

```bash
swamp model create @mgreten/railway-read production-railway \
  --global-arg 'token=${{ vault.get(production-secrets, railway_project_token) }}' \
  --global-arg 'services:json=[{"id":"11111111-1111-4111-8111-111111111111","name":"web"}]'
```

## Usage

Synchronize the latest ten deployments per configured service:

```bash
swamp model method run production-railway syncDeployments
```

Choose a different bounded limit, from 1 through 50:

```bash
swamp model method run production-railway syncDeployments --input limitPerService=25
```

Read the retained snapshot through Swamp:

```bash
swamp data get production-railway deployments-current --json
```

## Global Arguments

| Argument | Type | Default | Description |
|---|---|---|---|
| `token` | string | required | Sensitive Railway token. Use a vault expression. |
| `authenticationMode` | enum | `project-token` | `project-token` or `bearer`; bearer mode requires explicit project and environment IDs. |
| `projectId` | UUID | discovered | Optional project ID. Supply with `environmentId` to skip token-scope discovery. |
| `environmentId` | UUID | discovered | Optional environment ID. Supply with `projectId` to skip token-scope discovery. |
| `services` | array | required | One to twenty `{id, name}` service records from the token's project environment. |
| `apiUrl` | URL | `https://backboard.railway.com/graphql/v2` | Railway GraphQL endpoint. |

## Method: syncDeployments

| Argument | Type | Default | Description |
|---|---|---|---|
| `limitPerService` | integer | `10` | Maximum deployments retained per service, from 1 through 50. |

The method writes `deployments-current`. Every run creates a new retained version under the same resource identity, so changes remain auditable through Swamp's data history.

## How It Works

The model first uses Railway's documented `projectToken` query to discover the project and environment IDs bound to the token. It then runs paced, bounded deployment-list queries for all configured services while holding one Swamp model lock. Responses are validated before persistence. The model keeps only explicit deployment fields and normalized `repo`, `branch`, `commitHash`, and `commitMessage` values from Railway metadata. `truncated` is derived from GraphQL `pageInfo.hasNextPage`; no hidden continuation or completeness claim is made.

Railway does not currently issue verb-scoped read-only API tokens. This extension establishes a narrower integration boundary by containing only query documents and exposing no mutation methods. Users should still prefer a project token over broader account or workspace credentials.

## License

MIT — see LICENSE.txt for details.
