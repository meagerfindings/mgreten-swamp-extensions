# @mgreten/granola-mcp

`@mgreten/granola-mcp` is a read-only swamp data source for Granola meeting
notes. It calls Granola's MCP endpoint directly using the local user's existing
Amp OAuth login, without an agent turn or a Granola API key. The extension
returns validated resources and normalized Markdown strings, paths, and
daily-note links; it never creates or edits Obsidian files.

## Installation

```sh
swamp extension pull @mgreten/granola-mcp
```

The local Amp CLI must already have a working OAuth login for `granola` at
`https://mcp.granola.ai/mcp`. Check it with `amp mcp doctor granola`.

## Setup

Create the model on the machine with that Amp login.

```sh
swamp model create @mgreten/granola-mcp granola
```

The reader loads only Granola's access-token entry from Amp's local secret
storage into memory. Near expiry it asks `amp mcp doctor granola` to refresh
under Amp's own OAuth lock; it never rotates refresh tokens itself or copies
credentials into Swamp data. This relies on Amp's local secret-storage format. A
format change fails the method rather than falling back to an empty meeting
list. Only these read tools are called:

- `list_meetings`
- `get_meetings`
- `get_meeting_transcript`

## Usage

```sh
swamp model method run granola listMeetings --input '{"timeRange":"this_week","involvement":{"capturedByMe":true}}'
swamp model method run granola getMeetings --input '{"meetingIds":["123e4567-e89b-42d3-a456-426614174000"]}'
swamp model method run granola getTranscript --input '{"meetingId":"123e4567-e89b-42d3-a456-426614174000"}'
swamp model method run granola syncMeetings --input '{"timeRange":"last_30_days","existingFiles":["Granola/2026-08-01 Example 123e4567-e89b-42d3-a456-426614174000.md"]}'
```

## Global Arguments

| Argument                                       | Type                     | Default           | Description                                           |
| ---------------------------------------------- | ------------------------ | ----------------- | ----------------------------------------------------- |
| `ampPath`                                      | string                   | `amp`             | Amp executable used only for OAuth refresh.           |
| `timeZone`                                     | string                   | `America/Denver`  | Calendar date and time used in notes and daily links. |
| `cwd`                                          | string                   | current directory | Optional working directory for OAuth refresh.         |
| `wallTimeoutMs`                                | integer, `1000..3600000` | `600000`          | Timeout for each MCP request and OAuth refresh.       |
| `cliAgentModel`, `agentModel`, `idleTimeoutMs` | legacy                   | unchanged         | Accepted for existing definitions; no longer used.    |

## Method: listMeetings

Lists meeting metadata. Results are retained for seven days.

| Argument                          | Type                                     | Default        |
| --------------------------------- | ---------------------------------------- | -------------- |
| `timeRange`                       | `this_week`, `last_week`, `last_30_days` | `last_30_days` |
| `workspaceOnly`                   | `true`                                   | omitted        |
| `involvement.capturedByMe`        | boolean                                  | omitted        |
| `involvement.listedAsParticipant` | boolean                                  | omitted        |

## Method: getMeetings

Retrieves private notes, summaries, participants, and timestamps—but not
transcripts—for one to ten unique UUIDs. Pass `meetingIds:string[]`. Results are
retained for 30 days.

## Method: getTranscript

Retrieves one meeting and its complete verbatim transcript. Pass
`meetingId:string`. Results are retained for 30 days.

## Method: syncMeetings

Accepts the list filters, `existingFiles:string[]`, and optional `maxMeetings`
(default 10, hard maximum 10). It follows list pagination, excludes existing
UUIDs and legacy date/title filenames, then selects at most `maxMeetings`
missing meetings. It batches details and follows each transcript's `next_offset`
until complete. Explicit `no_transcript` responses are represented as absence,
not a retryable failure. Missing, duplicate, excluded, or unexpected IDs are
rejected before any resource is written. The resulting note records include
`meetingId`, `title`, `date`, `time`, `participants`, `privateNotes`, `summary`,
`transcript`, `markdown`, `suggestedFile`, and `dailyLink`. Results are retained
for 30 days.

## How It Works

Each method opens a read-only MCP client, validates metadata, details, and
transcripts with Zod, and only then writes a model resource. Enhanced-note
Markdown is preserved, not summarized by an LLM. The connection closes on
success or failure. `syncMeetings` produces Markdown as data so a separate
consumer can decide whether and where to write it.

## Privacy and retention

Meeting notes and transcripts are private data. This extension avoids logging
content or credentials. The normalized sync resource necessarily contains the
selected content and follows Swamp's configured retention; Granola retains its
source content. No Amp execute threads are created.

## License

MIT — see LICENSE.txt for details.
