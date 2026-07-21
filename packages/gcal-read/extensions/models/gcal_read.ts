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
 * Exchange the configured refresh token for a short-lived access token.
 * Throws a clear, actionable error on a non-2xx response or malformed body.
 */
export async function refreshAccessToken(
  fetchImpl: FetchLike,
  g: Pick<GlobalArgs, "clientId" | "clientSecret" | "refreshToken">,
): Promise<string> {
  const creds = requireAuth(g);
  const res = await fetchImpl(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: buildTokenRequestBody(creds),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `@mgreten/gcal-read: token refresh failed with ${res.status}: ${
        text.slice(0, 500)
      }`,
    );
  }
  let body: TokenResponse;
  try {
    body = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(
      `@mgreten/gcal-read: token refresh returned non-JSON: ${
        text.slice(0, 200)
      }`,
    );
  }
  if (!body.access_token) {
    throw new Error(
      `@mgreten/gcal-read: token refresh response missing access_token: ${
        text.slice(0, 500)
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
 * style calendar id).
 */
export function buildEventsListUrl(
  calendarId: string,
  window: DayWindow,
): string {
  const encodedId = encodeURIComponent(calendarId);
  const params = new URLSearchParams();
  params.set("timeMin", window.timeMin);
  params.set("timeMax", window.timeMax);
  params.set("singleEvents", "true");
  params.set("orderBy", "startTime");
  return `https://www.googleapis.com/calendar/v3/calendars/${encodedId}/events?${params.toString()}`;
}

/** Result of a Google Calendar events.list fetch: ok flag, status, parsed body (or error text). */
async function fetchEventsList(
  fetchImpl: FetchLike,
  accessToken: string,
  calendarId: string,
  window: DayWindow,
): Promise<unknown> {
  const url = buildEventsListUrl(calendarId, window);
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 401
      ? " (401 — the refresh token may be expired or revoked; re-run the OAuth consent flow)"
      : res.status === 404
      ? " (404 — check the calendarId; 'primary' is always valid for the authenticated account)"
      : "";
    throw new Error(
      `@mgreten/gcal-read: GET events.list failed with ${res.status}${hint}: ${
        text.slice(0, 500)
      }`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `@mgreten/gcal-read: events.list returned non-JSON: ${
        text.slice(0, 200)
      }`,
    );
  }
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
  items: z.array(z.object({
    id: z.string(),
    title: z.string(),
    start: z.string(),
    end: z.string(),
    allDay: z.boolean(),
  })),
}).passthrough();

/** Argument schema for `list_events`. */
const ListEventsArgs = z.object({
  calendarId: z.string().optional().describe(
    "Override the instance's default calendarId for this call.",
  ),
  date: z.string().optional().describe(
    "Target day (ISO date or datetime string). Defaults to today.",
  ),
  timezone: z.string().optional().describe(
    "Reserved for future timezone-aware window resolution. Currently " +
      "unused: the day window is resolved in the swamp process's local " +
      "timezone.",
  ),
});

/**
 * List a single day's events for a calendar: refresh the access token,
 * resolve the day's RFC3339 window, fetch `events.list`, and flatten the
 * result into {@link CalendarEvent} rows.
 */
export async function runListEvents(
  fetchImpl: FetchLike,
  g: GlobalArgs,
  args: z.infer<typeof ListEventsArgs>,
  now: number = Date.now(),
): Promise<z.infer<typeof ListEventsResultSchema>> {
  const accessToken = await refreshAccessToken(fetchImpl, g);
  const calendarId = args.calendarId ?? g.calendarId;
  const window = resolveDayWindow(args.date, now);
  const body = await fetchEventsList(
    fetchImpl,
    accessToken,
    calendarId,
    window,
  );
  const items = parseEventsResponse(body);
  return {
    ok: true,
    ts: new Date(now).toISOString(),
    calendarId,
    date: args.date ?? new Date(now).toISOString().slice(0, 10),
    timeMin: window.timeMin,
    timeMax: window.timeMax,
    count: items.length,
    items,
  };
}

/**
 * The swamp model: a read-only Google Calendar reader with one method
 * (`list_events`), persisting a typed `events` resource per call.
 */
export const model = {
  type: "@mgreten/gcal-read",
  version: "2026.07.20.1",
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
        "List a single day's events (default: today) for a calendar. Refreshes an OAuth2 access token from the configured refresh token, then calls Google Calendar's events.list with singleEvents=true and orderBy=startTime. Read-only.",
      arguments: ListEventsArgs,
      execute: async (
        args: z.infer<typeof ListEventsArgs>,
        context: MethodContext,
      ) => {
        const record = await runListEvents(realFetch, context.globalArgs, args);
        context.logger.info("list_events", {
          calendarId: record.calendarId,
          date: record.date,
          count: record.count,
        });
        const handle = await context.writeResource(
          "events",
          `events-${record.calendarId}-${record.date}-${record.ts}`,
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
