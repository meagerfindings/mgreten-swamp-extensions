# Granola API extension

`@mgreten/granola-api` reads the
[official Granola REST API](https://docs.granola.ai/api-reference/list-notes)
using a personal API key. It has no dependency on Amp, MCP, an OAuth session, or
an AI model. The extension returns data only; it never writes Obsidian files.

The implementation and manifest are under `extensions/models/`.

## Configuration

Create a definition of type `@mgreten/granola-api` with these global arguments:

```yaml
globalArguments:
  apiKey: '${{ vault.get("your-vault", "GRANOLA_API_KEY") }}'
  timeZone: America/Denver
  wallTimeoutMs: 600000
```

Store the key using your vault's secure input prompt, not in a definition file.
The key needs permission to read personal notes. `apiKey` is marked sensitive.

## syncApiMeetings

Arguments:

- `createdAfter`: ISO timestamp with a timezone; sent to Granola as UTC.
- `existingFiles`: existing export paths. UUIDs (case-insensitive) and legacy
  date-title filenames suppress already-exported meetings.
- `maxMeetings`: maximum new meetings (1–10, default 10).

Output: `syncedNotes` with a `notes` array. Each record has the meeting UUID,
title, local date/time, participants, private notes, enhanced summary,
transcript, Markdown, a suggested `Granola/<date> <title> <uuid>.md` path, and
daily link. Preserves Markdown rather than using a model to summarize it. List
and transcript cursors are followed to completion; repeated cursors and identity
mismatches fail without writing partial data. Transcripts use speaker names or
anonymous labels. 429 responses retry with a bounded Retry-After wait. Responses
and key values are never logged; outputs contain meeting content and should be
treated as private. Data lifetime is 30 days, with up to 20 retained artifacts.

## Granola API limitations

- Lists only notes that have both a generated summary and a transcript.
- Private notes are returned only to the user who created the note. Null means
  unavailable to this key; empty strings mean the creator typed nothing.
- Public `not_` IDs are opaque. Existing meeting UUIDs are taken only from the
  documented `web_url`, never invented or decoded from an API ID.

## Development

```sh
deno check extensions/models/granola_api.ts
deno test -A extensions/models/granola_api_test.ts
deno fmt --check extensions/models
```

Tests use synthetic fixtures and an injected HTTP client; no real key or network
requests are needed. No registry publication is needed to use the local source.
