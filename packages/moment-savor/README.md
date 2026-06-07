# @mgreten/moment-savor

Swamp extension for the [Moment Savor](https://momentsavor.app) family memory app V1 API.

Syncs memories, API tokens, and family membership to swamp resources for CEL
queries, and provides methods for full CRUD on memories, API token lifecycle,
family member management, and sending invitations.

## Prerequisites

You need an API token from your Moment Savor account:

1. Sign in at [momentsavor.app](https://momentsavor.app)
2. Go to **Settings → API Tokens** (or visit `/api_tokens`)
3. Create a token with the appropriate scope (`read` for read-only, `read_write` for mutations)
4. Copy the token value immediately — it is only shown once

## Installation

```sh
swamp extension pull @mgreten/moment-savor
```

## Configuration

Add a model entry to your `.swamp.yaml`:

```yaml
models:
  - name: moment-savor
    type: "@mgreten/moment-savor"
    args:
      apiToken: "ms1_your_token_here"
      # baseUrl defaults to https://momentsavor.app
      # For local dev, override with your server's URL:
      # baseUrl: "http://localhost:3000"
```

Store your token in a vault rather than in plaintext — see `swamp vault --help`.

## Usage

### Sync all data

```sh
swamp model method run moment-savor sync
```

Stores snapshots to `memories`, `tokens`, and `family-members` resources. Use
optional `query` argument for a filtered memories snapshot:

```sh
swamp model method run moment-savor sync '{"query": "birthday"}'
```

### Query with CEL

After syncing, reference data in workflows:

```
data.latest("moment-savor", "memories").attributes.memories
  .filter(m, m.tags.exists(t, t == "birthday"))
```

### Create a memory

```sh
swamp model method run moment-savor createMemory '{
  "recorded_at": "2026-06-06T18:00:00Z",
  "title": "Summer barbecue",
  "notes": "Great day with the family",
  "tags": ["summer", "food"]
}'
```

### Manage tokens

```sh
# Create a read-only token
swamp model method run moment-savor createToken '{"name": "CI token", "scope": "read"}'

# Read the raw value (only available immediately after creation)
swamp model data get moment-savor issued-token latest

# Rotate an existing token
swamp model method run moment-savor rotateToken '{"id": "uuid-here"}'

# Revoke a token
swamp model method run moment-savor revokeToken '{"id": "uuid-here"}'
```

### Invite a family member

```sh
swamp model method run moment-savor sendInvitation '{"email": "someone@example.com", "role": "member"}'
```

## Resources

| Resource | Description |
|----------|-------------|
| `memories` | Snapshot of all (or filtered) memories for the family |
| `tokens` | Snapshot of active API tokens for the authenticated user |
| `family-members` | Snapshot of current family membership |
| `issued-token` | Most recently created or rotated token, including the raw secret |

## Methods

| Method | Scope required | Description |
|--------|---------------|-------------|
| `sync` | read | Fetch and store all snapshots |
| `createMemory` | read_write | Create a new memory |
| `updateMemory` | read_write | Update title, notes, tags, visibility, etc. |
| `deleteMemory` | read_write | Permanently delete a memory |
| `createToken` | read_write | Create a new API token |
| `revokeToken` | read_write | Permanently revoke a token |
| `rotateToken` | read_write | Rotate a token (generates a new secret) |
| `updateMemberRole` | read_write + owner/admin | Change a member's role |
| `removeMember` | read_write + owner/admin | Remove a member from the family |
| `sendInvitation` | read_write | Send a family invitation email |

## Local development

To point the extension at a local dev server, set `baseUrl` to your local
server URL. The extension is environment-agnostic — it only needs a valid
`apiToken` and a reachable `baseUrl`.

The extension source lives at
[github.com/meagerfindings/swamp-moment-savor](https://github.com/meagerfindings/swamp-moment-savor).
The controllers it covers are noted at the top of `moment_savor_api.ts` —
update the extension when adding new API endpoints.

## License

MIT — see [LICENSE.txt](LICENSE.txt).
