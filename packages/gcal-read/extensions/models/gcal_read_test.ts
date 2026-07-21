import { assert, assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1";
import {
  buildEventsListUrl,
  buildTokenRequestBody,
  type FetchLike,
  OAUTH_TOKEN_URL,
  parseEventsResponse,
  refreshAccessToken,
  requireAuth,
  resolveDayWindow,
  runListEvents,
} from "./gcal_read.ts";

const FULL_CREDS = {
  clientId: "client-123",
  clientSecret: "secret-abc",
  refreshToken: "refresh-xyz",
};

const FULL_GLOBAL_ARGS = { ...FULL_CREDS, calendarId: "primary" };

/** Build a minimal FetchLike mock that returns a fixed ok JSON response. */
function jsonFetch(body: unknown, status = 200): FetchLike {
  return () =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(body)),
    });
}

Deno.test("requireAuth throws helpfully when all creds are blank", () => {
  let threw = false;
  try {
    requireAuth({ clientId: "", clientSecret: "", refreshToken: "" });
  } catch (err) {
    threw = true;
    const message = (err as Error).message;
    assertMatch(message, /gcal-client-id/);
    assertMatch(message, /gcal-client-secret/);
    assertMatch(message, /gcal-refresh-token/);
    assertMatch(message, /swamp vault put-secret gcal/);
    assertMatch(message, /swamp model create @mgreten\/gcal-read/);
    assertMatch(message, /vault\.get\(gcal, gcal-refresh-token\)/);
  }
  assert(threw, "requireAuth should have thrown with blank credentials");
});

Deno.test("requireAuth throws naming only the missing credential(s)", () => {
  let threw = false;
  try {
    requireAuth({
      clientId: "client-123",
      clientSecret: "",
      refreshToken: "refresh-xyz",
    });
  } catch (err) {
    threw = true;
    const message = (err as Error).message;
    assertMatch(message, /gcal-client-secret/);
    assert(
      !message.includes("gcal-client-id,") &&
        !message.includes("gcal-refresh-token,"),
      "should not list credentials that were present",
    );
  }
  assert(threw, "requireAuth should have thrown with one missing credential");
});

Deno.test("requireAuth passes through and returns creds when all are set", () => {
  const result = requireAuth(FULL_CREDS);
  assertEquals(result, FULL_CREDS);
});

Deno.test("buildTokenRequestBody is well-formed with grant_type=refresh_token", () => {
  const body = buildTokenRequestBody(FULL_CREDS);
  const params = new URLSearchParams(body);
  assertEquals(params.get("grant_type"), "refresh_token");
  assertEquals(params.get("client_id"), "client-123");
  assertEquals(params.get("client_secret"), "secret-abc");
  assertEquals(params.get("refresh_token"), "refresh-xyz");
});

Deno.test("refreshAccessToken posts to the token endpoint and parses access_token", async () => {
  let capturedUrl = "";
  let capturedInit: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } | undefined;
  const fetchImpl: FetchLike = (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({ access_token: "at-456", expires_in: 3599 }),
        ),
    });
  };

  const token = await refreshAccessToken(fetchImpl, FULL_CREDS);

  assertEquals(token, "at-456");
  assertEquals(capturedUrl, OAUTH_TOKEN_URL);
  assertEquals(capturedInit?.method, "POST");
  assertEquals(
    capturedInit?.headers?.["Content-Type"],
    "application/x-www-form-urlencoded",
  );
  const params = new URLSearchParams(capturedInit?.body ?? "");
  assertEquals(params.get("grant_type"), "refresh_token");
  assertEquals(params.get("client_id"), "client-123");
  assertEquals(params.get("client_secret"), "secret-abc");
  assertEquals(params.get("refresh_token"), "refresh-xyz");
});

Deno.test("refreshAccessToken throws when token response is missing access_token", async () => {
  const fetchImpl = jsonFetch({ error: "invalid_grant" });
  await assertRejects(
    () => refreshAccessToken(fetchImpl, FULL_CREDS),
    Error,
    "missing access_token",
  );
});

Deno.test("refreshAccessToken throws on non-2xx response", async () => {
  const fetchImpl = jsonFetch({ error: "invalid_client" }, 401);
  await assertRejects(
    () => refreshAccessToken(fetchImpl, FULL_CREDS),
    Error,
    "401",
  );
});

Deno.test("resolveDayWindow brackets a target day 00:00:00 to 23:59:59", () => {
  const window = resolveDayWindow("2026-07-20");
  const start = new Date(window.timeMin);
  const end = new Date(window.timeMax);
  assertEquals(start.getFullYear(), 2026);
  assertEquals(start.getMonth(), 6); // July == month 6
  assertEquals(start.getDate(), 20);
  assertEquals(start.getHours(), 0);
  assertEquals(start.getMinutes(), 0);
  assertEquals(start.getSeconds(), 0);
  assertEquals(end.getDate(), 20);
  assertEquals(end.getHours(), 23);
  assertEquals(end.getMinutes(), 59);
  assertEquals(end.getSeconds(), 59);
  assert(start.getTime() < end.getTime());
});

Deno.test("resolveDayWindow defaults to today when date is omitted", () => {
  const now = new Date(2026, 6, 20, 15, 30, 0).getTime();
  const window = resolveDayWindow(undefined, now);
  const start = new Date(window.timeMin);
  assertEquals(start.getFullYear(), 2026);
  assertEquals(start.getMonth(), 6);
  assertEquals(start.getDate(), 20);
  assertEquals(start.getHours(), 0);
});

Deno.test("buildEventsListUrl sets singleEvents=true, orderBy=startTime, and encodes calendarId", () => {
  const window = { timeMin: "2026-07-20T00:00:00.000Z", timeMax: "2026-07-20T23:59:59.999Z" };
  const url = buildEventsListUrl("someone@example.com", window);
  const parsed = new URL(url);
  assertEquals(parsed.pathname, "/calendar/v3/calendars/someone%40example.com/events");
  assertEquals(parsed.searchParams.get("singleEvents"), "true");
  assertEquals(parsed.searchParams.get("orderBy"), "startTime");
  assertEquals(parsed.searchParams.get("timeMin"), window.timeMin);
  assertEquals(parsed.searchParams.get("timeMax"), window.timeMax);
});

Deno.test("parseEventsResponse maps a timed event: summary->title, start.dateTime->start, allDay=false", () => {
  const events = parseEventsResponse({
    items: [
      {
        id: "evt-1",
        summary: "Standup",
        start: { dateTime: "2026-07-20T09:00:00-06:00" },
        end: { dateTime: "2026-07-20T09:15:00-06:00" },
      },
    ],
  });
  assertEquals(events.length, 1);
  assertEquals(events[0], {
    id: "evt-1",
    title: "Standup",
    start: "2026-07-20T09:00:00-06:00",
    end: "2026-07-20T09:15:00-06:00",
    allDay: false,
  });
});

Deno.test("parseEventsResponse maps an all-day event: start.date->start, allDay=true", () => {
  const events = parseEventsResponse({
    items: [
      {
        id: "evt-2",
        summary: "Company Holiday",
        start: { date: "2026-07-20" },
        end: { date: "2026-07-21" },
      },
    ],
  });
  assertEquals(events.length, 1);
  assertEquals(events[0], {
    id: "evt-2",
    title: "Company Holiday",
    start: "2026-07-20",
    end: "2026-07-21",
    allDay: true,
  });
});

Deno.test("parseEventsResponse returns an empty array for an empty day", () => {
  const events = parseEventsResponse({ items: [] });
  assertEquals(events.length, 0);
});

Deno.test("parseEventsResponse returns an empty array when items is absent", () => {
  const events = parseEventsResponse({});
  assertEquals(events.length, 0);
});

Deno.test("runListEvents: empty day yields count 0, items []", async () => {
  let requestedUrl = "";
  const fetchImpl: FetchLike = (url, init) => {
    if (url === OAUTH_TOKEN_URL) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ access_token: "at-1" })),
      });
    }
    requestedUrl = url;
    void init;
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ items: [] })),
    });
  };

  const now = new Date(2026, 6, 20, 12, 0, 0).getTime();
  const result = await runListEvents(fetchImpl, FULL_GLOBAL_ARGS, {}, now);

  assertEquals(result.count, 0);
  assertEquals(result.items, []);
  assertEquals(result.calendarId, "primary");
  assertMatch(requestedUrl, /singleEvents=true/);
  assertMatch(requestedUrl, /orderBy=startTime/);
});

Deno.test("runListEvents: end-to-end with a mixed timed + all-day day, calendarId override", async () => {
  const calls: string[] = [];
  const fetchImpl: FetchLike = (url) => {
    calls.push(url);
    if (url === OAUTH_TOKEN_URL) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ access_token: "at-2" })),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            items: [
              {
                id: "evt-a",
                summary: "1:1",
                start: { dateTime: "2026-07-20T10:00:00-06:00" },
                end: { dateTime: "2026-07-20T10:30:00-06:00" },
              },
              {
                id: "evt-b",
                summary: "Vacation",
                start: { date: "2026-07-20" },
                end: { date: "2026-07-22" },
              },
            ],
          }),
        ),
    });
  };

  const now = new Date(2026, 6, 20, 8, 0, 0).getTime();
  const result = await runListEvents(
    fetchImpl,
    FULL_GLOBAL_ARGS,
    { calendarId: "someone@example.com", date: "2026-07-20" },
    now,
  );

  assertEquals(result.count, 2);
  assertEquals(result.calendarId, "someone@example.com");
  assertEquals(result.items[0].allDay, false);
  assertEquals(result.items[1].allDay, true);

  const eventsCall = calls.find((c) => c !== OAUTH_TOKEN_URL) ?? "";
  assertMatch(eventsCall, /someone%40example\.com/);
});

Deno.test("runListEvents throws requireAuth error when creds are blank (no fetch reached)", async () => {
  let fetchCalled = false;
  const fetchImpl: FetchLike = () => {
    fetchCalled = true;
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve("{}"),
    });
  };

  await assertRejects(
    () =>
      runListEvents(
        fetchImpl,
        { clientId: "", clientSecret: "", refreshToken: "", calendarId: "primary" },
        {},
      ),
    Error,
    "missing Google Calendar credential",
  );
  assertEquals(fetchCalled, false);
});
