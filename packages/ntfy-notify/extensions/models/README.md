# @mgreten/ntfy-notify

Send push notifications via [ntfy.sh](https://ntfy.sh) from any swamp model or
workflow. Works with the public ntfy.sh service or any self-hosted ntfy
instance. Use the direct `send` method or the explicitly named generic outbox
transport adapter.

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

| Argument       | Type   | Default           | Description                     |
| -------------- | ------ | ----------------- | ------------------------------- |
| `ntfyUrl`      | string | `https://ntfy.sh` | Base URL of your ntfy server    |
| `defaultTopic` | string | _(required)_      | Default topic for notifications |

## Method: `send`

| Argument   | Type     | Required | Description                              |
| ---------- | -------- | -------- | ---------------------------------------- |
| `topic`    | string   | no       | Override the default topic               |
| `title`    | string   | yes      | Notification title                       |
| `message`  | string   | yes      | Notification body                        |
| `priority` | number   | no       | 1 (min) to 5 (max), default 3            |
| `tags`     | string[] | no       | Emoji/tag strings (e.g. `["checkmark"]`) |

## Method: `sendOutboxTransport`

Compatibility adapter for notification outbox workflows. Its strict contract is:

```ts
{
  payload: { title: string; message: string }; // 1..200 and 1..4096 chars
  idempotencyKey: string;                      // 1..256 chars
  options: {
    topic?: string;                            // 1..256 chars
    priority?: 1 | 2 | 3 | 4 | 5;
    tags?: string[];                           // at most 20, 1..64 chars each
    actions?: Array<{                         // at most 3
      action: string;                          // 1..32 chars
      label: string;                           // 1..100 chars
      url: string;                             // valid URL, at most 2048 chars
    }>;
  };
}
```

Unknown fields are rejected. The payload is marked sensitive so workflow tooling
can redact its title and message. The result is the standard model-method shape
`{ dataHandles: [...] }`, pointing to the notification delivery record.
Swamp may inject the instance's `ntfyUrl` and `defaultTopic` configuration into
the runtime argument object; callers should not provide those method fields.

The adapter throws on network errors and non-2xx responses before writing a
delivery record. This lets the calling outbox workflow persist its own failed
attempt and bounded retry state instead of incorrectly marking delivery as
successful. The original `send` method retains its existing audit behavior of
recording both successful and unsuccessful HTTP outcomes.

`idempotencyKey` satisfies the caller contract but is not sent to ntfy, logged,
or persisted. ntfy has no verified server-side deduplication guarantee here, so
a replay calls ntfy again. The outbox/caller must own deduplication; delivery is
at least once and duplicates remain possible after retries or ambiguous
failures.

## How It Works

The model sends an HTTP POST to `{ntfyUrl}/{topic}` with a JSON body containing
the title, message, priority, and tags. Each notification is recorded as a
`notification` resource with the HTTP status, success flag, and timestamp —
useful for auditing delivery in workflows or debugging connectivity to
self-hosted instances.

No authentication is built in. Do not place access tokens in `ntfyUrl`: model
configuration is not marked sensitive. If your ntfy server requires auth,
provide it outside this extension (for example, through a trusted authenticated
proxy). The model uses the standard `fetch` API — no external dependencies
beyond Zod.

## License

MIT — see LICENSE for details.
