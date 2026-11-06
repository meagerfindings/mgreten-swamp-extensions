# @mgreten/linear-activity

Gather the authenticated Linear viewer's daily activity for EOD reports,
standup summaries, and dashboard widgets. Read-only — no mutations.

## What it does

Runs five GraphQL queries against the Linear API and produces a single
`linear_activity` resource containing:

- **Issues completed** — assigned to the viewer, `completedAt` within the
  queried date.
- **Issues moved to review** — in-flight issues whose state name matches
  `/review/i` and were updated on the queried date.
- **Issues created** — created by the viewer on the queried date.
- **Comments authored** — comments posted by the viewer on the queried date.
  Body is truncated to 500 characters.
- **Issues in flight** — current snapshot of issues in `started` or
  `unstarted` workflow states assigned to the viewer.

## Installation

```bash
swamp extension pull @mgreten/linear-activity
```

## Auth setup

Create a Linear personal API key at <https://linear.app/settings/api>, then
store it in a swamp vault:

```bash
swamp vault create local_encryption linear
swamp vault put linear linear_key   # paste your lin_api_... key
```

## Usage

Create a model instance:

```bash
swamp model create @mgreten/linear-activity --name linear \
  --globalArg apiKey='${{ vault.get(linear, linear_key) }}' \
  --globalArg teamKeys='["ENG"]'
```

Run the `daily_activity` method:

```bash
# Today's activity
swamp model method run linear daily_activity

# Specific date
swamp model method run linear daily_activity --arg date=2026-05-18
```

## Global arguments

| Argument   | Type       | Required | Description |
|------------|------------|----------|-------------|
| `apiKey`   | `string`   | Yes      | Linear personal API key (`lin_api_...`). Marked sensitive. |
| `teamKeys` | `string[]` | No       | Team keys to scope activity to (e.g. `["ENG"]`). Empty array (default) means all teams visible to the viewer. |

## Method: `daily_activity`

| Argument | Type     | Required | Description |
|----------|----------|----------|-------------|
| `date`   | `string` | No       | `YYYY-MM-DD` date to query. Defaults to today. |

Returns one `linear_activity` resource with a 1-day lifetime and 14-day
garbage collection window.

## Output schema

The `linear_activity` resource contains:

- `date` — queried date (`YYYY-MM-DD`)
- `viewerId`, `viewerEmail` — authenticated user identity
- `teamKeys` — team keys used for scoping
- `issuesCompleted` — array of `IssueSummary`
- `issuesMovedToReview` — array of `IssueSummary`
- `issuesCreated` — array of `IssueSummary`
- `commentsByMe` — array of `CommentSummary`
- `issuesInFlight` — array of `IssueSummary`
- `fetchedAt` — ISO timestamp of when the data was fetched

Each `IssueSummary` includes: `id`, `identifier`, `title`, `url`,
`stateName`, `stateType`, `teamKey`, `priority`, `assigneeEmail`,
`updatedAt`, `completedAt`.

Each `CommentSummary` includes: `id`, `createdAt`, `body` (truncated to 500
chars), `issueIdentifier`, `issueTitle`, `issueUrl`, `issueStateName`.

## Complementary extensions

For write operations (creating issues, listing teams/projects/states), see
[`@hivemq/linear`](https://swamp.club/extensions/@hivemq/linear).

## License

MIT — see [LICENSE.txt](LICENSE.txt).
