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
| `timezone` | string | (unused) | **Not yet supported.** The day window is always resolved in the swamp process's local timezone. Passing a non-empty `timezone` throws rather than silently using the wrong zone — omit it to use the process's local zone. |

A bare `date` of the form `YYYY-MM-DD` is validated as a real calendar day
(e.g. `2026-02-30` or `2026-13-01` throw `invalid date`, rather than silently
rolling over to a different, plausible-looking date).

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
  "truncated": false,
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

`events.list` returns results one page at a time, and `singleEvents=true`
expands recurring series into individual instances — so a busy day can span
more than one page. `list_events` follows `nextPageToken` and accumulates
every page automatically, deduping events by `id` across pages as cheap
insurance (Google shouldn't return the same event id twice, but the dedup
costs nothing). `truncated: true` means pagination was cut short before
`events.list` ran out of pages — either an internal max-pages guard (50
pages) was hit, or Google returned a repeated/stuck `nextPageToken` (pagination
breaks immediately rather than burning the remaining page budget re-fetching
the same page) — `count`/`items` may be incomplete in that case (a warning is
also logged either way). In practice a single day's events should never come
close to the page limit.

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
   RFC3339 timestamps (defaulting to today). A bare `YYYY-MM-DD` date is
   validated as a real calendar day — an out-of-range component (e.g. month
   13, day 45) throws `invalid date` instead of silently rolling over to a
   different day.
4. `GET https://www.googleapis.com/calendar/v3/calendars/<calendarId>/events`
   is called with `singleEvents=true` and `orderBy=startTime` — required
   together, since `orderBy=startTime` is only valid when recurring events are
   expanded via `singleEvents=true` — and `Authorization: Bearer <token>`.
   `nextPageToken` is followed until Google stops returning one (or an
   internal 50-page guard is hit, in which case the result is marked
   `truncated: true`).
5. The response is flattened into `{id, title, start, end, allDay}` rows:
   all-day events (`start.date`/`end.date`) get `allDay: true`; timed events
   (`start.dateTime`/`end.dateTime`) get `allDay: false`.

Uses plain `fetch` (via an injectable `FetchLike` type), not the `googleapis`
SDK, keeping the dependency surface minimal.

### Error handling

Network-level failures (DNS/TCP/TLS, or a response body read failing
mid-stream) are caught and rethrown with stage context (`token refresh
failed (network error): ...` vs `events.list failed (network error): ...`)
rather than propagating as a bare `fetch failed` `TypeError`. Any response
body text echoed into an error message has known in-scope secrets
(`clientSecret`, `refreshToken`, the freshly-issued access token) redacted
to `[redacted]` first.

## Known limitations

- **No per-page item cap.** `MAX_EVENTS_PAGES` bounds the number of
  `events.list` *pages* followed (with a repeated-pageToken guard on top —
  see above), but there's no cap on the total number of *items* accumulated
  across those pages. In practice a single calendar day's event count is
  bounded by what a human calendar can plausibly hold, so this hasn't been a
  problem — but it means a sufficiently adversarial or buggy upstream
  response could in principle accumulate an unbounded amount of memory before
  the page-count guard kicks in. Not fixed here as an intentional scope call;
  revisit only if this model is ever pointed at something other than a single
  day's events for one calendar.
- **Not designed for high-frequency polling.** This model fits a once-daily
  (or few-times-daily) "what's on my calendar" read. It does not de-duplicate
  or track state across separate `list_events` calls, so a poller invoking it
  every few minutes will write a fresh `events` resource each time with no
  idempotency against previous calls — fine for occasional/manual use or a
  daily brief, but a high-frequency poller built on top of this model should
  do its own dedup (e.g. by day, or by hashing the returned `items`) rather
  than assuming this model does it.

## License

MIT — see LICENSE for details.
