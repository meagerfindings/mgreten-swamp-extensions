# @mgreten/granola-mcp

`@mgreten/granola-mcp` is a read-only swamp data source for Granola meeting notes. This initial release supports **Amp only** and delegates retrieval to an existing `@mgreten/cli-agent` model whose Amp CLI already has access to Granola through MCP OAuth. No Granola API key is required. The extension returns validated resources and normalized Markdown strings, paths, and daily-note links; it never creates or edits Obsidian files.

## Installation

```sh
swamp extension pull @mgreten/granola-mcp
```

This extension depends on `@mgreten/cli-agent` **2026.08.07.1 or newer**, the first version with Amp `model: "low"` support and an exact `toolAllowlist` invocation argument. Swamp's manifest dependency schema records extension names rather than version constraints, so verify the installed cli-agent version separately.

## Setup

Create the model in the same swamp repository as a compatible cli-agent instance. Amp is fixed as the provider and the default agent model is `low`.

```sh
swamp model create granola --type @mgreten/granola-mcp --global-args '{"cliAgentModel":"cli-agent","agentModel":"low"}'
```

Amp must already be authenticated and configured with the Granola MCP server. Every delegated invocation uses `readonly`, sandboxing off, network access allowed, and exactly these tools—no account lookup or other MCP tools are exposed:

- `mcp__granola__list_meetings`
- `mcp__granola__get_meetings`
- `mcp__granola__get_meeting_transcript`

## Usage

```sh
swamp model method run granola listMeetings --input '{"timeRange":"this_week","involvement":{"capturedByMe":true}}'
swamp model method run granola getMeetings --input '{"meetingIds":["123e4567-e89b-42d3-a456-426614174000"]}'
swamp model method run granola getTranscript --input '{"meetingId":"123e4567-e89b-42d3-a456-426614174000"}'
swamp model method run granola syncMeetings --input '{"timeRange":"last_30_days","existingFiles":["Granola/2026-08-01 Example 123e4567-e89b-42d3-a456-426614174000.md"]}'
```

## Global Arguments

| Argument | Type | Default | Description |
| --- | --- | --- | --- |
| `cliAgentModel` | string | `cli-agent` | Existing `@mgreten/cli-agent` instance. |
| `agentModel` | string | `low` | Amp model override. |
| `cwd` | string | provider default | Optional working directory for the CLI. |
| `wallTimeoutMs` | integer, `1000..3600000` | `600000` | Maximum total invocation time. |
| `idleTimeoutMs` | integer, `1000..3600000` | `120000` | Maximum time without output. |

## Method: listMeetings

Lists meeting metadata. Results are retained for seven days.

| Argument | Type | Default |
| --- | --- | --- |
| `timeRange` | `this_week`, `last_week`, `last_30_days` | `last_30_days` |
| `workspaceOnly` | `true` | omitted |
| `involvement.capturedByMe` | boolean | omitted |
| `involvement.listedAsParticipant` | boolean | omitted |

## Method: getMeetings

Retrieves private notes, summaries, participants, and timestamps—but not transcripts—for one to ten unique UUIDs. Pass `meetingIds:string[]`. Results are retained for 30 days.

## Method: getTranscript

Retrieves one meeting and its complete verbatim transcript. Pass `meetingId:string`. Results are retained for 30 days.

## Method: syncMeetings

Accepts the list filters, `existingFiles:string[]`, and optional `maxMeetings` (default 10, hard maximum 10). Stage one lists metadata. Extension code then extracts UUIDs from `existingFiles`, subtracts those IDs, and deterministically selects the first `maxMeetings` missing meetings. When none are missing, no retrieval invocation occurs. Otherwise stage two makes one child invocation that performs one batched `get_meetings` call and exactly one transcript call per selected ID. Missing, duplicate, excluded, or unexpected IDs are rejected before any resource is written. The resulting note records include `meetingId`, `title`, `date`, `time`, `participants`, `privateNotes`, `summary`, `transcript`, `markdown`, `suggestedFile`, and `dailyLink`. Results are retained for 30 days.

## How It Works

Every public method calls `cli-agent.invokeAndParse` through swamp's `context.runModel`. It reads the resulting invocation with `context.readModelData`, validates separate strict metadata, detail, and transcript schemas with pinned Zod 4, and only then writes a model resource. Agent calls are read-only and do not expose filesystem write tools. `syncMeetings` produces Markdown as data so a separate consumer can decide whether and where to write it.

## Privacy and retention

Meeting notes and transcripts are private data. This extension intentionally avoids logging meeting content and does not duplicate child transcripts into logs. The normalized sync resource necessarily contains the selected content. Both cli-agent and Granola retain private meeting output according to their own retention policies, and Amp may retain the execute threads used for these invocations. Review all three systems' retention and access settings before use.

## License

MIT — see LICENSE.txt for details.
