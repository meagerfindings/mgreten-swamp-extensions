# @mgreten/slack-blocks

Post Block Kit messages to Slack from any swamp model or workflow, with
optional file attachments. The model wraps the Slack Web API so consumers don't
have to re-implement bot-token auth or the three-step
`files.getUploadURLExternal` → upload → `files.completeUploadExternal` upload
dance themselves.

Three methods, one purpose each:

- `send` — post a message with Block Kit blocks (and optional thread reply).
- `sendWithFiles` — post a Block Kit message, then upload local files and
  share them as a thread reply directly under that message. Result: one
  thread containing the alert + the file attachments, with no separate
  top-level channel post.
- `verifyAuth` — call `auth.test` to confirm the bot token is wired up
  correctly. Run this once after setup.

## Installation

```sh
swamp extension pull @mgreten/slack-blocks
```

## Setup

Create a Slack app at <https://api.slack.com/apps>, add a bot user, grant the
scopes `chat:write` and `files:write`, then install the app to your workspace.
Copy the **Bot User OAuth Token** (starts with `xoxb-`).

Create a model instance with the bot token and (optionally) a default channel:

```sh
swamp model create @mgreten/slack-blocks slack-alerts \
  --global-arg 'botToken=xoxb-...' \
  --global-arg 'defaultChannel=C0123456789'
```

If your bot token lives in a swamp vault, reference it with a vault expression
instead of a literal value:

```sh
swamp model create @mgreten/slack-blocks slack-alerts \
  --global-arg 'botToken=${{ vault.get(my-vault, slack-bot-token) }}' \
  --global-arg 'defaultChannel=${{ vault.get(my-vault, slack-channel-id) }}'
```

Verify the token works:

```sh
swamp model method run slack-alerts verifyAuth --json
```

A successful run returns `ok: true` and the resolved team/user/bot IDs.

## Usage

Send a structured alert:

```sh
swamp model method run slack-alerts send --input '{
  "text": "Deploy failed on production",
  "blocks": [
    {"type": "header", "text": {"type": "plain_text", "text": "🚨 Deploy failed"}},
    {"type": "section", "fields": [
      {"type": "mrkdwn", "text": "*Env:*\nproduction"},
      {"type": "mrkdwn", "text": "*SHA:*\n`abc1234`"}
    ]}
  ]
}'
```

Reply in a thread:

```sh
swamp model method run slack-alerts send --input '{
  "text": "Rollback complete",
  "blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": "Rolled back to `def5678`."}}],
  "threadTs": "1700000000.123456"
}'
```

Post with file attachments (e.g. screenshots from a smoke test):

```sh
swamp model method run slack-alerts sendWithFiles --input "$(cat <<'EOF'
{
  "text": "Smoke test failed",
  "blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": "*Failed page:* `/dashboard`"}}],
  "files": [
    {"path": "/tmp/screenshots/01_dashboard.png", "title": "Dashboard render"},
    {"path": "/tmp/screenshots/02_console.png", "title": "Console errors"}
  ]
}
EOF
)"
```

The Block Kit message lands first, then the files share into its thread —
producing one thread per alert (no double-posting at the channel top level).

## Global Arguments

| Argument         | Type   | Required | Description                                       |
| ---------------- | ------ | -------- | ------------------------------------------------- |
| `botToken`       | string | yes      | Slack bot token (`xoxb-...`). Marked sensitive.   |
| `defaultChannel` | string | no       | Channel ID or name used when `channel` is omitted |

## Method: `send`

| Argument   | Type     | Required | Description                                           |
| ---------- | -------- | -------- | ----------------------------------------------------- |
| `channel`  | string   | no       | Channel ID or name (defaults to `defaultChannel`)     |
| `text`     | string   | yes      | Plain-text fallback for notifications / a11y          |
| `blocks`   | object[] | yes      | Block Kit blocks (see Slack Block Kit docs)           |
| `threadTs` | string   | no       | Parent message `ts` to reply in a thread              |

## Method: `sendWithFiles`

| Argument   | Type     | Required | Description                                                                                          |
| ---------- | -------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `channel`  | string   | no       | Channel ID or name (defaults to `defaultChannel`)                                                    |
| `text`     | string   | yes      | Plain-text fallback for notifications                                                                |
| `blocks`   | object[] | yes      | Block Kit blocks for the message body                                                                |
| `files`    | object[] | yes      | Files to upload and share as a thread reply under the posted message. At least one.                  |
| `threadTs` | string   | no       | Optional outer thread `ts`. When set, both the message and the file reply land inside that thread.   |

Each file object:

| Field      | Type   | Required | Description                                          |
| ---------- | ------ | -------- | ---------------------------------------------------- |
| `path`     | string | yes      | Absolute or cwd-relative path to the file            |
| `filename` | string | no       | Override the on-disk filename when uploading         |
| `title`    | string | no       | Display title in Slack (defaults to filename)        |
| `altText`  | string | no       | Reserved for future image-block wiring; unused today |

## Method: `verifyAuth`

No arguments. Calls Slack `auth.test` with the configured bot token and writes
an `authCheck` data artifact summarising the response.

## How It Works

The model uses the standard `fetch` API to call Slack's Web API directly. No
third-party dependencies beyond Zod (which swamp already provides).

`send` is a single `chat.postMessage` POST with the blocks, text, and optional
`thread_ts` set in the JSON body.

`sendWithFiles` posts the Block Kit message *first*, captures the resulting
message `ts`, and *then* walks each file through Slack's three-step upload:

1. `GET files.getUploadURLExternal?filename=...&length=...` — Slack returns a
   one-time upload URL and a file ID.
2. `POST` the bytes to that URL (Slack provisions an S3-backed endpoint).
3. `POST files.completeUploadExternal` with the file ID, `channel_id`, and
   `thread_ts: <ts of the just-posted message>` — this finalizes the upload
   AND shares it into that thread.

Why post-then-share rather than share-then-post: `completeUploadExternal` can
only be called once per file and *must* be given its share target at
finalization time (there is no separate "share a finalized file" API). To
land the files inside the alert message's thread, the alert message must
exist first so its `ts` can be passed as `thread_ts`. The result is one
thread per alert: the Block Kit message, followed by the file attachments as
a sibling reply. Neither lands as a top-level channel post.

Every successful or failed post writes a `slackMessage` resource for audit:
channel, message ts, file count, HTTP status, success flag, and Slack error
code (if any). The message body itself is recorded as `text` so a workflow can
reconstruct what was sent; Block Kit blocks are summarised by count, not stored
verbatim, to keep the data artifact small.

Token security: the bot token is declared `sensitive` in the Zod schema so
swamp's logging and CLI output mask it automatically.

## License

MIT — see LICENSE for details.
