/**
 * @module @mgreten/gcal-read
 *
 * Read-only Google Calendar reader. One method — `list_events` — lists a
 * single day's events (default: today) for a configured calendar.
 *
 * ## Auth
 *
 * Google Calendar's read-only API needs an OAuth2 refresh token exchanged for
 * a short-lived access token on every call (the classic "Desktop app" OAuth
 * flow: a client id + client secret identify the OAuth app, and a long-lived
 * refresh token — scoped to `https://www.googleapis.com/auth/calendar.readonly`
 * — is exchanged at `https://oauth2.googleapis.com/token` for an access token
 * good for about an hour). Supply all three via the sensitive `clientId` /
 * `clientSecret` / `refreshToken` globalArguments — the intended pattern is to
 * wire them from a swamp VAULT using a CEL `${{ vault.get(<vault>,
 * <key>) }}` reference on the model instance. This model does NOT read the
 * vault itself: swamp resolves the CEL at instance-YAML load time and hands
 * the resolved strings in via globalArgs. When the secrets are
 * missing/unresolved the args arrive empty-string; `requireAuth()` catches
 * that up front and throws a clear, actionable error rather than letting the
 * call reach Google and come back as a cryptic 401.
 *
 * `calendarId` defaults to `"primary"` (the authenticated user's default
 * calendar) and can be overridden globally or per-call.
 *
 * ## Scope
 *
 * This model is deliberately read-only: it has exactly one method
 * (`list_events`) and never writes, updates, or deletes calendar data. It
 * uses plain `fetch` (via an injectable {@link FetchLike}), not the
 * `googleapis` SDK, keeping the dependency surface minimal and the HTTP calls
 * easy to unit test with a mock.
 */

import { z } from "npm:zod@4";

/**
 * Global arguments for the gcal-read model. `clientId` / `clientSecret` /
 * `refreshToken` are the OAuth2 Desktop-app credential set (sensitive; wire
 * from a vault). `calendarId` selects which calendar `list_events` reads by
 * default.
 */
const GlobalArgsSchema: z.ZodObject<{
  clientId: z.ZodDefault<z.ZodString>;
  clientSecret: z.ZodDefault<z.ZodString>;
  refreshToken: z.ZodDefault<z.ZodString>;
  calendarId: z.ZodDefault<z.ZodString>;
}> = z.object({
  clientId: z
    .string()
    .default("")
    .describe(
      "Google OAuth client ID (Desktop app). Wire from a vault, e.g. " +
        "${{ vault.get(gcal, gcal-client-id) }}.",
    ),
  clientSecret: z
    .string()
    .default("")
    .describe(
      "Google OAuth client secret (Desktop app). Wire from a vault, e.g. " +
        "${{ vault.get(gcal, gcal-client-secret) }}.",
    )
    .meta({ sensitive: true }),
  refreshToken: z
    .string()
    .default("")
    .describe(
      "Long-lived OAuth2 refresh token scoped to " +
        "https://www.googleapis.com/auth/calendar.readonly. Wire from a " +
        "vault, e.g. ${{ vault.get(gcal, gcal-refresh-token) }}.",
    )
    .meta({ sensitive: true }),
  calendarId: z
    .string()
    .default("primary")
    .describe(
      "Which calendar to read by default (Google Calendar ID, or 'primary' " +
        "for the authenticated user's default calendar). Overridable per-call.",
    ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Method execution context (mirrors the shape swamp injects into `execute`). */
type MethodContext = {
  globalArgs: GlobalArgs;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
    options?: { tags?: Record<string, string> },
  ) => Promise<Record<string, unknown>>;
  modelType: string;
  modelId: string;
};

/** Minimal fetch signature the HTTP methods depend on (injectable in tests). */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

/** The real `fetch`, adapted to the injectable {@link FetchLike} shape. */
export const realFetch: FetchLike = (url, init) =>
  fetch(url, init) as unknown as ReturnType<FetchLike>;

/**
 * Validate that all three OAuth credentials are present. Throws a clear,
 * actionable error (naming the vault commands and the instance wiring) when
 * any are missing/blank so a misconfigured instance fails fast instead of
 * returning a 401 from Google.
 */
export function requireAuth(
  g: Pick<GlobalArgs, "clientId" | "clientSecret" | "refreshToken">,
): { clientId: string; clientSecret: string; refreshToken: string } {
  const missing: string[] = [];
  if (!g.clientId || g.clientId.trim() === "") missing.push("gcal-client-id");
  if (!g.clientSecret || g.clientSecret.trim() === "") {
    missing.push("gcal-client-secret");
  }
  if (!g.refreshToken || g.refreshToken.trim() === "") {
    missing.push("gcal-refresh-token");
  }
  if (missing.length > 0) {
    throw new Error(
      `@mgreten/gcal-read: missing Google Calendar credential(s): ${
        missing.join(", ")
      }. ` +
        `Add them to a vault and wire them into the instance globalArguments:\n` +
        missing.map((k) => `  swamp vault put-secret gcal ${k}`).join("\n") +
        `\nthen create (or update) the instance with:\n` +
        `  swamp model create @mgreten/gcal-read <name> ` +
        `--global-arg 'clientId=\${{ vault.get(gcal, gcal-client-id) }}' ` +
        `--global-arg 'clientSecret=\${{ vault.get(gcal, gcal-client-secret) }}' ` +
        `--global-arg 'refreshToken=\${{ vault.get(gcal, gcal-refresh-token) }}'`,
    );
  }
  return {
    clientId: g.clientId,
    clientSecret: g.clientSecret,
    refreshToken: g.refreshToken,
  };
}

/** Response shape from `POST https://oauth2.googleapis.com/token`. */
type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

/**
 * Build the `application/x-www-form-urlencoded` body for a refresh-token
 * grant against Google's OAuth2 token endpoint.
 */
export function buildTokenRequestBody(
  g: Pick<GlobalArgs, "clientId" | "clientSecret" | "refreshToken">,
): string {
  const params = new URLSearchParams();
  params.set("grant_type", "refresh_token");
  params.set("client_id", g.clientId);
  params.set("client_secret", g.clientSecret);
  params.set("refresh_token", g.refreshToken);
  return params.toString();
}

/** The Google OAuth2 token endpoint. */
export const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Redact known secret values from a string before it's embedded in an error
 * message. Error paths echo raw response-body text for diagnosability, but
 * that text must never leak a secret that happens to be in scope at the
 * throw site (e.g. Google echoing the client secret back in a 400 body).
 *
 * Redacts both the raw secret value and its `encodeURIComponent()` form (a
 * secret containing characters like `+`, `/`, `=`, or `&` — plausible for an
 * OAuth client secret or token — can appear URL-encoded in a response body,
 * e.g. an echoed `application/x-www-form-urlencoded` request). Empty-string
 * secrets (an unconfigured credential arriving as `""`) are skipped: a
 * `"".split("").join(...)` would otherwise insert `[redacted]` between every
 * character of `text`, corrupting rather than protecting it.
 *
 * IMPORTANT: callers must redact BEFORE truncating any response text (e.g.
 * `text.slice(0, 500)`), not after. Truncating first can cut a secret in half
 * at the slice boundary, so the un-truncated remainder no longer matches this
 * function's substring search and leaks in the clear.
 */
export function redactSecrets(
  text: string,
  secrets: (string | undefined)[],
): string {
  let redacted = text;
  for (const secret of secrets) {
    if (!secret || secret.length === 0) continue;
    redacted = redacted.split(secret).join("[redacted]");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) {
      redacted = redacted.split(encoded).join("[redacted]");
    }
  }
  return redacted;
}

/**
 * Exchange the configured refresh token for a short-lived access token.
 * Throws a clear, actionable error on a non-2xx response or malformed body.
 * Network-level failures (DNS/TCP/TLS) are caught and rethrown with
 * "token refresh" stage context rather than propagating as a bare fetch
 * `TypeError`. Any echoed response body has the in-scope credentials
 * (clientSecret, refreshToken, and the freshly-issued access_token once
 * known) redacted before being embedded in an error message.
 */
export async function refreshAccessToken(
  fetchImpl: FetchLike,
  g: Pick<GlobalArgs, "clientId" | "clientSecret" | "refreshToken">,
): Promise<string> {
  const creds = requireAuth(g);
  const secrets = [creds.clientSecret, creds.refreshToken];
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: buildTokenRequestBody(creds),
    });
  } catch (err) {
    throw new Error(
      `@mgreten/gcal-read: token refresh failed (network error): ${
        (err as Error).message ?? String(err)
      }`,
    );
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new Error(
      `@mgreten/gcal-read: token refresh failed reading response body: ${
        (err as Error).message ?? String(err)
      }`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `@mgreten/gcal-read: token refresh failed with ${res.status}: ${
        redactSecrets(text, secrets).slice(0, 500)
      }`,
    );
  }
  let body: TokenResponse;
  try {
    body = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(
      `@mgreten/gcal-read: token refresh returned non-JSON: ${
        redactSecrets(text, secrets).slice(0, 200)
      }`,
    );
  }
  if (!body.access_token) {
    throw new Error(
      `@mgreten/gcal-read: token refresh response missing access_token: ${
        redactSecrets(text, secrets).slice(0, 500)
      }`,
    );
  }
  return body.access_token;
}

/** A resolved [00:00:00, 23:59:59] day window as RFC3339 timestamps. */
export type DayWindow = { timeMin: string; timeMax: string };

/**
 * Resolve the RFC3339 `timeMin`/`timeMax` bracket for a single calendar day.
 *
 * `date` is an ISO date (`YYYY-MM-DD`) or datetime string (only the date
 * portion is used); defaults to `now`'s local date when omitted. The window
 * spans local 00:00:00 to 23:59:59 of that date. `now` is injectable for
 * deterministic tests.
 *
 * A bare `YYYY-MM-DD` string is parsed as calendar-date components (year,
 * month, day) rather than handed to `new Date(string)` directly: the native
 * parser treats a date-only ISO string as UTC midnight, which shifts the
 * resolved date backward by a day in any negative-UTC-offset local timezone
 * (e.g. US Mountain) — the classic "off by one day" bug for date-only input.
 *
 * The date-only branch validates the parsed components round-trip: building
 * `new Date(year, month, day)` from an out-of-range component (e.g. month 13
 * or day 45) silently ROLLS OVER to a different, plausible-looking date
 * instead of producing `Invalid Date` (unlike the datetime branch, where
 * `new Date(string)` on garbage input yields `NaN` and is caught below). So
 * after constructing the local Date, its year/month/day are read back and
 * compared to the input components; a mismatch means a rollover happened and
 * the input is rejected outright rather than silently answering for the
 * wrong day.
 */
export function resolveDayWindow(
  date: string | undefined,
  now: number = Date.now(),
): DayWindow {
  let year: number;
  let month: number;
  let day: number;

  const dateOnlyMatch = date?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    year = Number(dateOnlyMatch[1]);
    month = Number(dateOnlyMatch[2]) - 1;
    day = Number(dateOnlyMatch[3]);

    const probe = new Date(year, month, day);
    if (
      Number.isNaN(probe.getTime()) ||
      probe.getFullYear() !== year ||
      probe.getMonth() !== month ||
      probe.getDate() !== day
    ) {
      throw new Error(
        `@mgreten/gcal-read: invalid date: ${date} (not a real calendar day)`,
      );
    }
  } else {
    const base = date ? new Date(date) : new Date(now);
    if (Number.isNaN(base.getTime())) {
      throw new Error(`@mgreten/gcal-read: invalid date: ${date}`);
    }
    year = base.getFullYear();
    month = base.getMonth();
    day = base.getDate();
  }

  const start = new Date(year, month, day, 0, 0, 0, 0);
  const end = new Date(year, month, day, 23, 59, 59, 999);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

/** One flattened calendar event as returned by `list_events`. */
export type CalendarEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
};

/**
 * One generic "summarize this" item, derived from a {@link CalendarEvent}.
 * `kind`/`title`/`body` mirrors the same convention the gmail-read reader
 * uses for its own `briefItems` — a downstream summarizer consumes a uniform
 * `{kind, title, body}` shape regardless of which reader produced it, so it
 * never has to special-case calendar events vs. emails vs. any other source.
 */
export type BriefItem = {
  kind: string;
  title: string;
  body: string;
};

/**
 * Build the one-line `body` for a {@link BriefItem} from a flattened
 * {@link CalendarEvent}. All-day events read "All day - <title>"; timed
 * events read "<start> to <end> - <title>". Every part is coerced to a
 * string and missing/undefined fields fall back to "" rather than throwing
 * or embedding the literal string "undefined" — deterministic and
 * null-safe by construction, since `CalendarEvent`'s own fields are already
 * defaulted to "" in {@link parseEventsResponse}.
 */
export function buildBriefItemBody(event: Partial<CalendarEvent>): string {
  const title = String(event.title ?? "");
  if (event.allDay === true) {
    return `All day - ${title}`;
  }
  const start = String(event.start ?? "");
  const end = String(event.end ?? "");
  return `${start} to ${end} - ${title}`;
}

/**
 * Derive the generic `briefItems` array from a day's flattened
 * {@link CalendarEvent}s — one entry per event, same length and order as
 * `items`. `kind` is always the literal `"event"`.
 */
export function buildBriefItems(events: CalendarEvent[]): BriefItem[] {
  return events.map((event) => ({
    kind: "event",
    title: String(event.title ?? ""),
    body: buildBriefItemBody(event),
  }));
}

/** A raw event row as returned by the Google Calendar v3 `events.list` API. */
type GCalEventRow = {
  id?: string;
  summary?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
};

/**
 * Flatten a raw `events.list` response body into {@link CalendarEvent} rows.
 *
 * All-day events carry `start.date`/`end.date` (a bare date, no time) and are
 * mapped with `allDay: true`; timed events carry `start.dateTime`/
 * `end.dateTime` and are mapped with `allDay: false`. `summary` becomes
 * `title` (empty string when absent, e.g. an untitled event).
 */
export function parseEventsResponse(body: unknown): CalendarEvent[] {
  const items = (body as { items?: GCalEventRow[] })?.items ?? [];
  return items.map((row) => {
    const allDay = typeof row.start?.date === "string";
    return {
      id: row.id ?? "",
      title: row.summary ?? "",
      start: allDay ? (row.start?.date ?? "") : (row.start?.dateTime ?? ""),
      end: allDay ? (row.end?.date ?? "") : (row.end?.dateTime ?? ""),
      allDay,
    };
  });
}

/**
 * Build the `events.list` URL for a calendar and day window. `singleEvents`
 * is fixed to `true` — REQUIRED both to expand recurring events into
 * individual instances and because `orderBy=startTime` is only valid when
 * `singleEvents=true` (the Calendar API rejects the combination otherwise).
 * `calendarId` is URL-encoded (it may contain `@`/`.`/etc., e.g. an email-
 * style calendar id). `pageToken`, when set, requests the next page of a
 * paginated result (see `events.list`'s `nextPageToken`).
 */
export function buildEventsListUrl(
  calendarId: string,
  window: DayWindow,
  pageToken?: string,
): string {
  const encodedId = encodeURIComponent(calendarId);
  const params = new URLSearchParams();
  params.set("timeMin", window.timeMin);
  params.set("timeMax", window.timeMax);
  params.set("singleEvents", "true");
  params.set("orderBy", "startTime");
  if (pageToken) params.set("pageToken", pageToken);
  return `https://www.googleapis.com/calendar/v3/calendars/${encodedId}/events?${params.toString()}`;
}

/** A raw `events.list` response page: items plus an optional next-page token. */
type GCalEventsPage = {
  items?: GCalEventRow[];
  nextPageToken?: string;
};

/** Fetch a single `events.list` page (one HTTP call). */
async function fetchEventsPage(
  fetchImpl: FetchLike,
  accessToken: string,
  calendarId: string,
  window: DayWindow,
  pageToken: string | undefined,
  secrets: (string | undefined)[],
): Promise<GCalEventsPage> {
  const url = buildEventsListUrl(calendarId, window, pageToken);
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    throw new Error(
      `@mgreten/gcal-read: events.list failed (network error): ${
        (err as Error).message ?? String(err)
      }`,
    );
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new Error(
      `@mgreten/gcal-read: events.list failed reading response body: ${
        (err as Error).message ?? String(err)
      }`,
    );
  }
  if (!res.ok) {
    const hint = res.status === 401
      ? " (401 — the refresh token may be expired or revoked; re-run the OAuth consent flow)"
      : res.status === 404
      ? " (404 — check the calendarId; 'primary' is always valid for the authenticated account)"
      : "";
    throw new Error(
      `@mgreten/gcal-read: GET events.list failed with ${res.status}${hint}: ${
        redactSecrets(text, secrets).slice(0, 500)
      }`,
    );
  }
  try {
    return JSON.parse(text) as GCalEventsPage;
  } catch {
    throw new Error(
      `@mgreten/gcal-read: events.list returned non-JSON: ${
        redactSecrets(text, secrets).slice(0, 200)
      }`,
    );
  }
}

/**
 * Hard ceiling on how many `events.list` pages a single `list_events` call
 * will follow. A single calendar day is bounded in practice (even a
 * pathologically busy day with fully-expanded recurring instances won't
 * realistically exceed this many pages of Google's default page size), so
 * this exists purely as a runaway-loop guard, not a real-world limit. If hit,
 * pagination stops and the result is marked `truncated: true` with a warning
 * logged rather than looping forever or throwing.
 */
export const MAX_EVENTS_PAGES = 50;

/**
 * Fetch every page of `events.list` for a calendar/day window, following
 * `nextPageToken` until exhausted (or until {@link MAX_EVENTS_PAGES} is hit).
 * `events.list` returns at most one page of results per call — capped by
 * Google's default page size — and `singleEvents=true` expands recurring
 * series into individual instances, so a single busy day can legitimately
 * span multiple pages. Returns the accumulated raw event rows (deduped by
 * event `id`) plus whether pagination was cut short (`truncated`) — either
 * because {@link MAX_EVENTS_PAGES} was hit, or because Google returned a
 * `nextPageToken` that repeats a token already seen this call (a stuck/looping
 * token would otherwise silently burn the entire page budget re-fetching the
 * same page over and over instead of surfacing the problem).
 *
 * Event ids are deduped via a `Set` across pages as cheap insurance — Google
 * shouldn't return the same event id on two different pages of one
 * `events.list` call, but the cost of guarding against it is negligible.
 */
async function fetchAllEventsPages(
  fetchImpl: FetchLike,
  accessToken: string,
  calendarId: string,
  window: DayWindow,
  secrets: (string | undefined)[],
  logger?: { warning: (msg: string, props?: Record<string, unknown>) => void },
): Promise<{ items: GCalEventRow[]; truncated: boolean }> {
  const items: GCalEventRow[] = [];
  const seenEventIds = new Set<string>();
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined = undefined;
  let pageCount = 0;
  let truncated = false;

  do {
    const page = await fetchEventsPage(
      fetchImpl,
      accessToken,
      calendarId,
      window,
      pageToken,
      secrets,
    );
    for (const row of page.items ?? []) {
      if (row.id !== undefined && seenEventIds.has(row.id)) continue;
      if (row.id !== undefined) seenEventIds.add(row.id);
      items.push(row);
    }
    pageCount += 1;
    if (pageToken !== undefined) seenPageTokens.add(pageToken);
    pageToken = page.nextPageToken;

    if (pageToken && seenPageTokens.has(pageToken)) {
      truncated = true;
      logger?.warning(
        "events.list pagination truncated: repeated pageToken (stuck pagination)",
        { calendarId, pageCount, repeatedToken: pageToken },
      );
      break;
    }
    if (pageToken && pageCount >= MAX_EVENTS_PAGES) {
      truncated = true;
      logger?.warning(
        "events.list pagination truncated: max-pages guard hit",
        { calendarId, pageCount, maxPages: MAX_EVENTS_PAGES },
      );
      break;
    }
  } while (pageToken);

  return { items, truncated };
}

/** Result schema for `list_events`. */
const ListEventsResultSchema = z.object({
  ok: z.boolean(),
  ts: z.string(),
  calendarId: z.string(),
  date: z.string(),
  timeMin: z.string(),
  timeMax: z.string(),
  count: z.number().int(),
  truncated: z.boolean().describe(
    "true if pagination was cut short before events.list ran out of pages " +
      "— either the MAX_EVENTS_PAGES guard was hit, or Google returned a " +
      "repeated/stuck nextPageToken — count/items may be incomplete.",
  ),
  items: z.array(z.object({
    id: z.string(),
    title: z.string(),
    start: z.string(),
    end: z.string(),
    allDay: z.boolean(),
  })),
  briefItems: z.array(z.object({
    kind: z.string(),
    title: z.string(),
    body: z.string(),
  })).describe(
    "Generic {kind,title,body} shape derived from `items`, one entry per " +
      'event (kind is always "event") — for a downstream summarizer that ' +
      "wants a uniform shape across readers (e.g. a daily-brief pipeline) " +
      "without CEL-in-YAML reshaping (map literals break YAML).",
  ),
});
// Intentionally NOT .passthrough(): `runListEvents` constructs this object's
// fields explicitly (see its return statement) and never attaches extra
// properties, so the result shape is fully known. `.passthrough()` would
// let a future accidental extra field slip through unvalidated instead of
// failing loudly at the schema boundary.

/** Argument schema for `list_events`. */
export const ListEventsArgs = z.object({
  calendarId: z.string().optional().describe(
    "Override the instance's default calendarId for this call.",
  ),
  date: z.string().optional().describe(
    "Target day (ISO date or datetime string). Defaults to today.",
  ),
  timezone: z.string().optional().refine(
    (tz) => tz === undefined || tz.trim() === "",
    {
      message: "timezone is NOT YET SUPPORTED: it must be empty or omitted. " +
        "The day window is always resolved in the swamp process's local " +
        "timezone; a non-empty value always throws rather than silently " +
        "using the wrong zone.",
    },
  ).describe(
    "NOT YET SUPPORTED — must be empty or omitted; any non-empty value " +
      "ALWAYS throws. The day window is always resolved in the swamp " +
      "process's local timezone.",
  ),
});

/**
 * Reject a `timezone` arg outright. Actually honoring an arbitrary IANA zone
 * for day-window math (correct offset resolution, DST transitions) is a
 * meaningfully large addition; silently ignoring the arg — the prior
 * behavior — let a caller believe they got events for their requested zone
 * when the window was actually resolved in the swamp process's local
 * timezone. Throwing a clear, actionable error is the safe default until
 * timezone-aware resolution is implemented.
 *
 * `ListEventsArgs.timezone` already encodes this constraint via a zod
 * `.refine()` (a non-empty value fails argument validation before `execute`
 * is even called), but `runListEvents` is also called directly by tests and
 * other code paths that bypass swamp's schema validation — so this runtime
 * check stays as the actual enforcement point, not just a schema decoration.
 */
function rejectUnsupportedTimezone(timezone: string | undefined): void {
  if (timezone !== undefined && timezone.trim() !== "") {
    throw new Error(
      `@mgreten/gcal-read: timezone arg not yet supported (got "${timezone}"). ` +
        `The day window is always resolved in the swamp process's local ` +
        `timezone; omit the timezone arg to use that.`,
    );
  }
}

/**
 * List a single day's events for a calendar: refresh the access token,
 * resolve the day's RFC3339 window, fetch every `events.list` page
 * (following `nextPageToken` — a busy day with recurring series expanded via
 * `singleEvents=true` can span more than one page), and flatten the
 * accumulated rows into {@link CalendarEvent}s. Rejects a non-empty
 * `timezone` arg (see {@link rejectUnsupportedTimezone}) rather than
 * silently ignoring it.
 */
export async function runListEvents(
  fetchImpl: FetchLike,
  g: GlobalArgs,
  args: z.infer<typeof ListEventsArgs>,
  now: number = Date.now(),
  logger?: { warning: (msg: string, props?: Record<string, unknown>) => void },
): Promise<z.infer<typeof ListEventsResultSchema>> {
  rejectUnsupportedTimezone(args.timezone);
  const accessToken = await refreshAccessToken(fetchImpl, g);
  const calendarId = args.calendarId ?? g.calendarId;
  const window = resolveDayWindow(args.date, now);
  const secrets = [g.clientSecret, g.refreshToken, accessToken];
  const { items: rawItems, truncated } = await fetchAllEventsPages(
    fetchImpl,
    accessToken,
    calendarId,
    window,
    secrets,
    logger,
  );
  const items = parseEventsResponse({ items: rawItems });
  return {
    ok: true,
    ts: new Date(now).toISOString(),
    calendarId,
    date: args.date ?? new Date(now).toISOString().slice(0, 10),
    timeMin: window.timeMin,
    timeMax: window.timeMax,
    count: items.length,
    truncated,
    items,
    briefItems: buildBriefItems(items),
  };
}

/**
 * Sanitize a value for embedding in a swamp resource instance NAME. Instance
 * names get concatenated into filesystem paths / resource identifiers
 * elsewhere in swamp, so they need to be well-formed. `calendarId` is
 * typically email-shaped (e.g. `someone@example.com`) and gets URL-encoded
 * for the HTTP path (see {@link buildEventsListUrl}), but the instance name
 * built here embedded the RAW calendarId — `@`/`.` and other characters can
 * make for a malformed or surprising instance name. Any character outside
 * `[a-z0-9_-]` (case-folded) is replaced with `-`; this is lossy (distinct
 * calendarIds can collide after sanitization) but that's acceptable for a
 * human-readable name component — the resource DATA and tags still carry the
 * raw, uncorrupted `calendarId` for anything that needs the real value.
 */
export function sanitizeForInstanceName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

/**
 * The swamp model: a read-only Google Calendar reader with one method
 * (`list_events`), persisting a typed `events` resource per call.
 */
export const model = {
  type: "@mgreten/gcal-read",
  version: "2026.07.20.4",
  globalArguments: GlobalArgsSchema,
  resources: {
    events: {
      description:
        "One row per list_events call: the resolved day window and its flattened calendar events.",
      schema: ListEventsResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 2000,
    },
  },
  methods: {
    list_events: {
      description:
        "List a single day's events (default: today) for a calendar. Refreshes an OAuth2 access token from the configured refresh token, then calls Google Calendar's events.list with singleEvents=true and orderBy=startTime, following nextPageToken to accumulate every page. Read-only.",
      arguments: ListEventsArgs,
      execute: async (
        args: z.infer<typeof ListEventsArgs>,
        context: MethodContext,
      ) => {
        const record = await runListEvents(
          realFetch,
          context.globalArgs,
          args,
          Date.now(),
          context.logger,
        );
        context.logger.info("list_events", {
          calendarId: record.calendarId,
          date: record.date,
          count: record.count,
          truncated: record.truncated,
        });
        const handle = await context.writeResource(
          "events",
          `events-${
            sanitizeForInstanceName(record.calendarId)
          }-${record.date}-${record.ts}`,
          record,
          {
            tags: {
              calendarId: record.calendarId,
              date: record.date,
              count: String(record.count),
            },
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
