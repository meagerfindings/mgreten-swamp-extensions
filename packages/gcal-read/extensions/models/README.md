# @mgreten/gcal-read

A read-only Google Calendar reader for [swamp](https://swamp.club). It has
exactly one method — `list_events` — which lists a single day's events
(default: today) for a configured calendar, flattening both timed and
all-day events into a simple `{id, title, start, end, allDay}` shape. It
never writes, updates, or deletes calendar data.

## Installation

```bash
swamp extension pull @mgreten/gcal-read
```

## Setup

Google Calendar's read-only API needs an OAuth2 "Desktop app" credential set:
a client ID + client secret identifying the OAuth app, and a long-lived
refresh token scoped to `https://www.googleapis.com/auth/calendar.readonly`.
Store all three in a swamp vault and wire them into the instance via CEL
expressions — never hardcode secrets in the instance YAML:

```bash
swamp vault put-secret gcal gcal-client-id
swamp vault put-secret gcal gcal-client-secret
swamp vault put-secret gcal gcal-refresh-token

swamp model create @mgreten/gcal-read my-calendar \
  --global-arg 'clientId=${{ vault.get(gcal, gcal-client-id) }}' \
  --global-arg 'clientSecret=${{ vault.get(gcal, gcal-client-secret) }}' \
  --global-arg 'refreshToken=${{ vault.get(gcal, gcal-refresh-token) }}' \
  --global-arg 'calendarId=primary'
```

If any of the three credentials are blank when a method runs, `list_events`
throws an error naming the exact missing vault key(s) and the wiring command
above, rather than letting the call fail with a cryptic 401 from Google.

## Usage

### Method: list_events

List today's events for the instance's default calendar:

```bash
swamp model method run my-calendar list_events --json
```

Override the calendar or target a specific day:

```bash
swamp model method run my-calendar list_events \
  --arg calendarId=someone@example.com \
  --arg date=2026-07-04 \
  --json
```

| Argument | Type | Default | Description |
|---|---|---|---|
| `calendarId` | string | instance's `calendarId` | Override the calendar for this call. |
| `date` | string (ISO date) | today | Target day. Only the date portion is used. |
| `timezone` | string | (unused) | Reserved for future timezone-aware window resolution. |

The result is written as an `events` resource with this shape:

```json
{
  "ok": true,
  "ts": "2026-07-20T18:32:01.000Z",
  "calendarId": "primary",
  "date": "2026-07-20",
  "timeMin": "2026-07-20T06:00:00.000Z",
  "timeMax": "2026-07-21T05:59:59.999Z",
  "count": 2,
  "items": [
    {
      "id": "abc123",
      "title": "1:1 with Sam",
      "start": "2026-07-20T10:00:00-06:00",
      "end": "2026-07-20T10:30:00-06:00",
      "allDay": false
    },
    {
      "id": "def456",
      "title": "Company Holiday",
      "start": "2026-07-20",
      "end": "2026-07-21",
      "allDay": true
    }
  ]
}
```

## Global Arguments

| Argument | Type | Default | Sensitive | Description |
|---|---|---|---|---|
| `clientId` | string | `""` | no | Google OAuth client ID (Desktop app). |
| `clientSecret` | string | `""` | yes | Google OAuth client secret (Desktop app). |
| `refreshToken` | string | `""` | yes | Long-lived refresh token scoped to `calendar.readonly`. |
| `calendarId` | string | `"primary"` | no | Default calendar to read; overridable per-call. |

## How It Works

1. `requireAuth()` validates all three OAuth credentials are present, else
   throws a clear, actionable error naming the vault keys and instance wiring.
2. The refresh token is exchanged for a short-lived access token via
   `POST https://oauth2.googleapis.com/token` (`application/x-www-form-urlencoded`,
   `grant_type=refresh_token`).
3. The target day's local `[00:00:00, 23:59:59]` window is resolved as
   RFC3339 timestamps (defaulting to today).
4. `GET https://www.googleapis.com/calendar/v3/calendars/<calendarId>/events`
   is called with `singleEvents=true` and `orderBy=startTime` — required
   together, since `orderBy=startTime` is only valid when recurring events are
   expanded via `singleEvents=true` — and `Authorization: Bearer <token>`.
5. The response is flattened into `{id, title, start, end, allDay}` rows:
   all-day events (`start.date`/`end.date`) get `allDay: true`; timed events
   (`start.dateTime`/`end.dateTime`) get `allDay: false`.

Uses plain `fetch` (via an injectable `FetchLike` type), not the `googleapis`
SDK, keeping the dependency surface minimal.

## License

MIT — see LICENSE for details.
