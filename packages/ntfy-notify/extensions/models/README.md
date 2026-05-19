# @mgreten/ntfy-notify

Send push notifications via [ntfy.sh](https://ntfy.sh) from any swamp model or
workflow. Works with the public ntfy.sh service or any self-hosted ntfy instance.
One method, one purpose: fire a notification with a title, message, priority, and
optional tags.

## Installation

```sh
swamp extension pull @mgreten/ntfy-notify
```

## Setup

Create a model instance with your ntfy server URL and default topic:

```sh
swamp model create ntfy-notify --type @mgreten/ntfy-notify \
  --global-args '{"ntfyUrl": "https://ntfy.sh", "defaultTopic": "my-alerts"}'
```

If you self-host ntfy, point `ntfyUrl` at your instance instead.

## Usage

Send a notification:

```sh
swamp model method run ntfy-notify send \
  --input '{"title": "Build passed", "message": "main branch is green", "priority": 3}'
```

Override the topic per-call:

```sh
swamp model method run ntfy-notify send \
  --input '{"topic": "urgent", "title": "Deploy failed", "message": "Rollback in progress", "priority": 5, "tags": ["rotating_light"]}'
```

## Global Arguments

| Argument       | Type   | Default          | Description                         |
| -------------- | ------ | ---------------- | ----------------------------------- |
| `ntfyUrl`      | string | `https://ntfy.sh`| Base URL of your ntfy server        |
| `defaultTopic` | string | *(required)*     | Default topic for notifications     |

## Method: `send`

| Argument   | Type     | Required | Description                              |
| ---------- | -------- | -------- | ---------------------------------------- |
| `topic`    | string   | no       | Override the default topic               |
| `title`    | string   | yes      | Notification title                       |
| `message`  | string   | yes      | Notification body                        |
| `priority` | number   | no       | 1 (min) to 5 (max), default 3           |
| `tags`     | string[] | no       | Emoji/tag strings (e.g. `["checkmark"]`) |

## How It Works

The model sends an HTTP POST to `{ntfyUrl}/{topic}` with a JSON body containing
the title, message, priority, and tags. Each notification is recorded as a
`notification` resource with the HTTP status, success flag, and timestamp — useful
for auditing delivery in workflows or debugging connectivity to self-hosted
instances.

No authentication is built in. If your ntfy server requires auth, configure it at
the server level or use an access token in the URL (ntfy supports query-param
tokens). The model uses the standard `fetch` API — no external dependencies beyond
Zod.

## License

MIT — see LICENSE for details.
