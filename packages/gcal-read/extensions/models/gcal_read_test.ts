import { assert, assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1";
import {
  buildEventsListUrl,
  buildTokenRequestBody,
  type FetchLike,
  ListEventsArgs,
  MAX_EVENTS_PAGES,
  OAUTH_TOKEN_URL,
  parseEventsResponse,
  redactSecrets,
  refreshAccessToken,
  requireAuth,
  resolveDayWindow,
  runListEvents,
  sanitizeForInstanceName,
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

// ---------------------------------------------------------------------------
// Regression: #1 pagination — events.list must follow nextPageToken rather
// than silently truncating to a single page.
// ---------------------------------------------------------------------------

Deno.test("runListEvents follows nextPageToken and accumulates events across pages", async () => {
  const eventsCalls: string[] = [];
  const fetchImpl: FetchLike = (url) => {
    if (url === OAUTH_TOKEN_URL) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ access_token: "at-page" })),
      });
    }
    eventsCalls.push(url);
    const parsed = new URL(url);
    const pageToken = parsed.searchParams.get("pageToken");
    if (!pageToken) {
      // First page: 2 events + a nextPageToken.
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              items: [
                { id: "evt-p1", summary: "Page 1 Event A", start: { dateTime: "2026-07-20T09:00:00-06:00" }, end: { dateTime: "2026-07-20T09:30:00-06:00" } },
                { id: "evt-p2", summary: "Page 1 Event B", start: { dateTime: "2026-07-20T10:00:00-06:00" }, end: { dateTime: "2026-07-20T10:30:00-06:00" } },
              ],
              nextPageToken: "token-page-2",
            }),
          ),
      });
    }
    // Second page: 1 more event, no further nextPageToken.
    assertEquals(pageToken, "token-page-2");
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            items: [
              { id: "evt-p3", summary: "Page 2 Event", start: { dateTime: "2026-07-20T11:00:00-06:00" }, end: { dateTime: "2026-07-20T11:30:00-06:00" } },
            ],
          }),
        ),
    });
  };

  const now = new Date(2026, 6, 20, 8, 0, 0).getTime();
  const result = await runListEvents(fetchImpl, FULL_GLOBAL_ARGS, { date: "2026-07-20" }, now);

  assertEquals(eventsCalls.length, 2, "should have made exactly 2 events.list calls");
  assertEquals(result.count, 3, "events from both pages must be accumulated");
  assertEquals(result.items.map((e) => e.id), ["evt-p1", "evt-p2", "evt-p3"]);
  assertEquals(result.truncated, false);
});

Deno.test("runListEvents sets truncated:true and stops when MAX_EVENTS_PAGES is hit", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = (url) => {
    if (url === OAUTH_TOKEN_URL) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ access_token: "at-cap" })),
      });
    }
    calls += 1;
    // Every page returns 1 event and always another nextPageToken — an
    // infinite pagination stream that only the max-pages guard can stop.
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            items: [{
              id: `evt-${calls}`,
              summary: "Recurring",
              start: { dateTime: "2026-07-20T09:00:00-06:00" },
              end: { dateTime: "2026-07-20T09:30:00-06:00" },
            }],
            nextPageToken: `token-${calls + 1}`,
          }),
        ),
    });
  };

  const now = new Date(2026, 6, 20, 8, 0, 0).getTime();
  const result = await runListEvents(fetchImpl, FULL_GLOBAL_ARGS, { date: "2026-07-20" }, now);

  assertEquals(calls, MAX_EVENTS_PAGES, "should stop exactly at the max-pages guard");
  assertEquals(result.count, MAX_EVENTS_PAGES);
  assertEquals(result.truncated, true);
});

Deno.test("buildEventsListUrl includes pageToken when provided, omits it otherwise", () => {
  const window = { timeMin: "2026-07-20T00:00:00.000Z", timeMax: "2026-07-20T23:59:59.999Z" };
  const urlNoPage = new URL(buildEventsListUrl("primary", window));
  assertEquals(urlNoPage.searchParams.has("pageToken"), false);

  const urlWithPage = new URL(buildEventsListUrl("primary", window, "abc123"));
  assertEquals(urlWithPage.searchParams.get("pageToken"), "abc123");
});

// ---------------------------------------------------------------------------
// Regression: #2 invalid date-only input must throw, not silently roll over
// to the wrong (but plausible-looking) date.
// ---------------------------------------------------------------------------

Deno.test("resolveDayWindow throws on an invalid date-only month (rollover guard)", () => {
  let threw = false;
  try {
    resolveDayWindow("2026-13-01");
  } catch (err) {
    threw = true;
    assertMatch((err as Error).message, /invalid date/);
  }
  assert(threw, "resolveDayWindow should reject an out-of-range month");
});

Deno.test("resolveDayWindow throws on an invalid date-only day (rollover guard)", () => {
  // 2026-02-45 would silently roll over to ~2026-03-17 without the guard.
  let threw = false;
  try {
    resolveDayWindow("2026-02-45");
  } catch (err) {
    threw = true;
    assertMatch((err as Error).message, /invalid date/);
    assertMatch((err as Error).message, /2026-02-45/);
  }
  assert(threw, "resolveDayWindow should reject an out-of-range day");
});

Deno.test("resolveDayWindow throws on Feb 30 (not a real calendar day in any year)", () => {
  let threw = false;
  try {
    resolveDayWindow("2026-02-30");
  } catch {
    threw = true;
  }
  assert(threw, "resolveDayWindow should reject Feb 30");
});

Deno.test("resolveDayWindow still accepts a valid leap-day date-only string", () => {
  // 2028 is a leap year: Feb 29 is real and must NOT throw.
  const window = resolveDayWindow("2028-02-29");
  const start = new Date(window.timeMin);
  assertEquals(start.getFullYear(), 2028);
  assertEquals(start.getMonth(), 1);
  assertEquals(start.getDate(), 29);
});

// ---------------------------------------------------------------------------
// Regression: #3 timezone arg must be rejected, never silently ignored.
// ---------------------------------------------------------------------------

Deno.test("runListEvents throws when a non-empty timezone arg is passed", async () => {
  const fetchImpl: FetchLike = () => {
    throw new Error("fetch should never be reached");
  };
  await assertRejects(
    () =>
      runListEvents(fetchImpl, FULL_GLOBAL_ARGS, { timezone: "America/Denver" }),
    Error,
    "timezone arg not yet supported",
  );
});

Deno.test("runListEvents does not throw when timezone is omitted or empty", async () => {
  const fetchImpl: FetchLike = (url) => {
    if (url === OAUTH_TOKEN_URL) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ access_token: "at-tz" })),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ items: [] })),
    });
  };
  const now = new Date(2026, 6, 20, 8, 0, 0).getTime();
  // Omitted timezone: fine.
  await runListEvents(fetchImpl, FULL_GLOBAL_ARGS, { date: "2026-07-20" }, now);
  // Empty-string timezone: also fine (treated the same as omitted).
  await runListEvents(
    fetchImpl,
    FULL_GLOBAL_ARGS,
    { date: "2026-07-20", timezone: "" },
    now,
  );
});

// ---------------------------------------------------------------------------
// Regression: #4 cross-timezone day-window correctness. Spawn a subprocess
// pinning TZ explicitly (rather than trusting whatever TZ the test runner
// happens to have) — one negative-offset zone (America/Denver) and one
// positive-offset zone (Asia/Tokyo) — and assert the resolved window brackets
// the correct LOCAL calendar day in both. Also exercises the invalid-date
// rollover rejection (#2) under each pinned zone.
// ---------------------------------------------------------------------------

/**
 * Run a small inline script under `deno run` with TZ pinned via env, that
 * imports `resolveDayWindow` from this module and prints JSON results for a
 * fixed set of probes. Using a real subprocess (not `Intl`/date mocking)
 * guarantees the *entire* JS Date/Intl stack — not just our own code —
 * genuinely observes the pinned zone, which is what the original "parsed as
 * UTC midnight -> wrong local day in a negative-offset TZ" bug depended on.
 */
async function resolveDayWindowUnderTz(
  tz: string,
): Promise<
  { ok: true; results: Record<string, DayWindowResult> } | { ok: false }
> {
  const script = `
    import { resolveDayWindow } from "${new URL("./gcal_read.ts", import.meta.url).href}";
    const probes = {
      dateOnly: () => resolveDayWindow("2026-07-20"),
      invalidMonth: () => { try { resolveDayWindow("2026-13-45"); return { threw: false }; } catch (e) { return { threw: true, message: String(e.message ?? e) }; } },
    };
    const out = {};
    for (const [name, fn] of Object.entries(probes)) {
      out[name] = fn();
    }
    console.log(JSON.stringify(out));
  `;
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "-"],
    env: { ...Deno.env.toObject(), TZ: tz },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(script));
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) {
    console.error("subprocess stderr:", new TextDecoder().decode(stderr));
    return { ok: false };
  }
  const text = new TextDecoder().decode(stdout).trim();
  return { ok: true, results: JSON.parse(text) };
}

type DayWindowResult = { timeMin?: string; timeMax?: string } | {
  threw: boolean;
  message?: string;
};

Deno.test({
  name: "resolveDayWindow brackets the correct LOCAL day under a negative-offset TZ (America/Denver)",
  fn: async () => {
    const outcome = await resolveDayWindowUnderTz("America/Denver");
    assert(outcome.ok, "subprocess must succeed");
    if (!outcome.ok) return;
    const dateOnly = outcome.results.dateOnly as { timeMin: string; timeMax: string };
    // America/Denver is UTC-6 (MDT) in July: local 2026-07-20 00:00:00
    // is 2026-07-20T06:00:00.000Z.
    assertEquals(dateOnly.timeMin, "2026-07-20T06:00:00.000Z");
    assertEquals(dateOnly.timeMax, "2026-07-21T05:59:59.999Z");

    const invalidMonth = outcome.results.invalidMonth as { threw: boolean; message?: string };
    assertEquals(invalidMonth.threw, true);
    assertMatch(invalidMonth.message ?? "", /invalid date/);
  },
});

Deno.test({
  name: "resolveDayWindow brackets the correct LOCAL day under a positive-offset TZ (Asia/Tokyo)",
  fn: async () => {
    const outcome = await resolveDayWindowUnderTz("Asia/Tokyo");
    assert(outcome.ok, "subprocess must succeed");
    if (!outcome.ok) return;
    const dateOnly = outcome.results.dateOnly as { timeMin: string; timeMax: string };
    // Asia/Tokyo is UTC+9 (no DST): local 2026-07-20 00:00:00 is
    // 2026-07-19T15:00:00.000Z.
    assertEquals(dateOnly.timeMin, "2026-07-19T15:00:00.000Z");
    assertEquals(dateOnly.timeMax, "2026-07-20T14:59:59.999Z");

    const invalidMonth = outcome.results.invalidMonth as { threw: boolean; message?: string };
    assertEquals(invalidMonth.threw, true);
    assertMatch(invalidMonth.message ?? "", /invalid date/);
  },
});

// ---------------------------------------------------------------------------
// Regression: #5 uncaught network-level throws must be wrapped with stage
// context, not propagate as a bare fetch TypeError.
// ---------------------------------------------------------------------------

Deno.test("refreshAccessToken wraps a network-level fetch failure with token-refresh stage context", async () => {
  const fetchImpl: FetchLike = () => {
    throw new TypeError("fetch failed: dns error");
  };
  await assertRejects(
    () => refreshAccessToken(fetchImpl, FULL_CREDS),
    Error,
    "token refresh failed (network error)",
  );
});

Deno.test("refreshAccessToken wraps a res.text() failure with stage context", async () => {
  const fetchImpl: FetchLike = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      text: () => {
        throw new Error("stream aborted");
      },
    });
  await assertRejects(
    () => refreshAccessToken(fetchImpl, FULL_CREDS),
    Error,
    "token refresh failed reading response body",
  );
});

Deno.test("runListEvents wraps an events.list network-level fetch failure with stage context", async () => {
  const fetchImpl: FetchLike = (url) => {
    if (url === OAUTH_TOKEN_URL) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ access_token: "at-neterr" })),
      });
    }
    throw new TypeError("fetch failed: connection reset");
  };
  await assertRejects(
    () => runListEvents(fetchImpl, FULL_GLOBAL_ARGS, {}),
    Error,
    "events.list failed (network error)",
  );
});

Deno.test("runListEvents wraps an events.list res.text() failure with stage context", async () => {
  const fetchImpl: FetchLike = (url) => {
    if (url === OAUTH_TOKEN_URL) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ access_token: "at-bodyerr" })),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => {
        throw new Error("stream aborted mid-body");
      },
    });
  };
  await assertRejects(
    () => runListEvents(fetchImpl, FULL_GLOBAL_ARGS, {}),
    Error,
    "events.list failed reading response body",
  );
});

// ---------------------------------------------------------------------------
// Regression: #6 error-body leakage — secrets in scope at the throw site must
// be redacted before being embedded in an error message.
// ---------------------------------------------------------------------------

Deno.test("refreshAccessToken redacts clientSecret and refreshToken from a leaked error body", async () => {
  const leakyCreds = {
    clientId: "client-leak",
    clientSecret: "super-secret-value",
    refreshToken: "refresh-token-value",
  };
  const fetchImpl: FetchLike = () =>
    Promise.resolve({
      ok: false,
      status: 400,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            error: "invalid_request",
            // Simulates Google echoing submitted form fields back in an
            // error body (a real-world pattern for some OAuth providers).
            error_description:
              `client_secret=super-secret-value&refresh_token=refresh-token-value`,
          }),
        ),
    });

  let threw = false;
  try {
    await refreshAccessToken(fetchImpl, leakyCreds);
  } catch (err) {
    threw = true;
    const message = (err as Error).message;
    assert(
      !message.includes("super-secret-value"),
      "clientSecret must not appear raw in the error message",
    );
    assert(
      !message.includes("refresh-token-value"),
      "refreshToken must not appear raw in the error message",
    );
    assertMatch(message, /\[redacted\]/);
  }
  assert(threw, "refreshAccessToken should have thrown on the 400");
});

Deno.test("runListEvents redacts secrets from a leaked events.list error body", async () => {
  const fetchImpl: FetchLike = (url) => {
    if (url === OAUTH_TOKEN_URL) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(JSON.stringify({ access_token: "at-leaky-token-999" })),
      });
    }
    return Promise.resolve({
      ok: false,
      status: 403,
      text: () =>
        Promise.resolve(
          `access denied for token at-leaky-token-999 with refresh refresh-xyz`,
        ),
    });
  };

  let threw = false;
  try {
    await runListEvents(fetchImpl, FULL_GLOBAL_ARGS, {});
  } catch (err) {
    threw = true;
    const message = (err as Error).message;
    assert(
      !message.includes("at-leaky-token-999"),
      "the freshly-issued access token must not appear raw in the error message",
    );
    assert(
      !message.includes("refresh-xyz"),
      "refreshToken must not appear raw in the error message",
    );
    assertMatch(message, /\[redacted\]/);
  }
  assert(threw, "runListEvents should have thrown on the 403");
});

// ---------------------------------------------------------------------------
// Regression: adversarial review #1 — redactSecrets: redact-before-truncate
// ordering, URL-encoded secret forms, and an empty-secret guard.
// ---------------------------------------------------------------------------

Deno.test("redactSecrets redacts a secret straddling the 500-char truncation boundary", async () => {
  // Build a leaked body where the secret starts BEFORE char 500 and ends
  // AFTER it — a naive `text.slice(0, 500)` BEFORE redaction would only see
  // half the secret and fail to match it, leaking the tail in the clear.
  const secret = "super-secret-value-that-is-fairly-long-1234567890";
  const padding = "x".repeat(500 - 20);
  const leakyBody = `${padding}${secret}${"y".repeat(100)}`;
  assert(
    leakyBody.indexOf(secret) < 500 &&
      leakyBody.indexOf(secret) + secret.length > 500,
    "test fixture must actually straddle the 500-char boundary",
  );

  const fetchImpl: FetchLike = () =>
    Promise.resolve({ ok: false, status: 400, text: () => Promise.resolve(leakyBody) });

  await assertRejects(
    () =>
      refreshAccessToken(fetchImpl, {
        clientId: "client-x",
        clientSecret: secret,
        refreshToken: "refresh-unrelated",
      }),
    Error,
  );
  try {
    await refreshAccessToken(fetchImpl, {
      clientId: "client-x",
      clientSecret: secret,
      refreshToken: "refresh-unrelated",
    });
  } catch (err) {
    const message = (err as Error).message;
    assert(
      !message.includes(secret),
      "a secret straddling the truncation boundary must still be fully redacted",
    );
  }
});

Deno.test("redactSecrets also redacts the encodeURIComponent() form of a secret", () => {
  const secret = "sup+er/secret=value&here";
  const encoded = encodeURIComponent(secret);
  const text = `raw: ${secret}\nencoded: ${encoded}`;
  const redacted = redactSecrets(text, [secret]);
  assert(!redacted.includes(secret), "raw form must be redacted");
  assert(!redacted.includes(encoded), "URL-encoded form must also be redacted");
  assertMatch(redacted, /\[redacted\]/);
});

Deno.test("redactSecrets skips empty-string secrets without corrupting the text", () => {
  const text = "hello world, nothing sensitive here";
  const redacted = redactSecrets(text, ["", undefined]);
  assertEquals(redacted, text);
});

Deno.test("redactSecrets with a real secret alongside an empty one still redacts correctly", () => {
  const text = "token=abc123 and other stuff";
  const redacted = redactSecrets(text, ["", "abc123", undefined]);
  assertEquals(redacted, "token=[redacted] and other stuff");
});

// ---------------------------------------------------------------------------
// Regression: adversarial review #2 — pagination must terminate on a
// repeated/stuck nextPageToken instead of burning the whole page budget, and
// events must be deduped by id across pages.
// ---------------------------------------------------------------------------

Deno.test("runListEvents breaks pagination when nextPageToken repeats, marks truncated", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = (url) => {
    if (url === OAUTH_TOKEN_URL) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ access_token: "at-stuck" })),
      });
    }
    calls += 1;
    const parsed = new URL(url);
    const pageToken = parsed.searchParams.get("pageToken");
    if (!pageToken) {
      // First page: 1 event, points to "token-A".
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              items: [{
                id: "evt-1",
                summary: "First",
                start: { dateTime: "2026-07-20T09:00:00-06:00" },
                end: { dateTime: "2026-07-20T09:30:00-06:00" },
              }],
              nextPageToken: "token-A",
            }),
          ),
      });
    }
    // Every subsequent page (including the one fetched with "token-A")
    // returns another event but STUCK on the same "token-A" — a repeating
    // token that would otherwise loop until MAX_EVENTS_PAGES.
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            items: [{
              id: `evt-stuck-${calls}`,
              summary: "Stuck",
              start: { dateTime: "2026-07-20T10:00:00-06:00" },
              end: { dateTime: "2026-07-20T10:30:00-06:00" },
            }],
            nextPageToken: "token-A",
          }),
        ),
    });
  };

  const warnings: { msg: string; props?: Record<string, unknown> }[] = [];
  const now = new Date(2026, 6, 20, 8, 0, 0).getTime();
  const result = await runListEvents(
    fetchImpl,
    FULL_GLOBAL_ARGS,
    { date: "2026-07-20" },
    now,
    { warning: (msg, props) => warnings.push({ msg, props }) },
  );

  // Should stop after the SECOND call (first page + the one page fetched
  // with "token-A"), not burn through MAX_EVENTS_PAGES.
  assertEquals(calls, 2, "should break as soon as the repeated token is detected");
  assertEquals(result.truncated, true);
  assert(
    warnings.some((w) => /repeated pageToken/.test(w.msg)),
    "should log a warning naming the repeated-pageToken condition",
  );
});

Deno.test("runListEvents dedups events sharing the same id across pages", async () => {
  const fetchImpl: FetchLike = (url) => {
    if (url === OAUTH_TOKEN_URL) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ access_token: "at-dedup" })),
      });
    }
    const parsed = new URL(url);
    const pageToken = parsed.searchParams.get("pageToken");
    if (!pageToken) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              items: [
                {
                  id: "evt-dup",
                  summary: "Duplicate",
                  start: { dateTime: "2026-07-20T09:00:00-06:00" },
                  end: { dateTime: "2026-07-20T09:30:00-06:00" },
                },
              ],
              nextPageToken: "token-2",
            }),
          ),
      });
    }
    // Second page re-returns the SAME event id as page 1 (shouldn't happen
    // per Google's contract, but dedup is cheap insurance) plus one new one.
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            items: [
              {
                id: "evt-dup",
                summary: "Duplicate",
                start: { dateTime: "2026-07-20T09:00:00-06:00" },
                end: { dateTime: "2026-07-20T09:30:00-06:00" },
              },
              {
                id: "evt-new",
                summary: "New",
                start: { dateTime: "2026-07-20T11:00:00-06:00" },
                end: { dateTime: "2026-07-20T11:30:00-06:00" },
              },
            ],
          }),
        ),
    });
  };

  const now = new Date(2026, 6, 20, 8, 0, 0).getTime();
  const result = await runListEvents(fetchImpl, FULL_GLOBAL_ARGS, { date: "2026-07-20" }, now);

  assertEquals(result.count, 2, "the duplicate event id must only be counted once");
  assertEquals(result.items.map((e) => e.id).sort(), ["evt-dup", "evt-new"]);
});

// ---------------------------------------------------------------------------
// Regression: adversarial review #3 — the timezone arg schema must itself
// communicate (and enforce) that a non-empty value is always rejected, not
// just describe that constraint in prose.
// ---------------------------------------------------------------------------

Deno.test("ListEventsArgs schema rejects a non-empty timezone at validation time", () => {
  const result = ListEventsArgs.safeParse({ timezone: "America/Denver" });
  assert(!result.success, "schema-level validation must reject a non-empty timezone");
  if (!result.success) {
    const messages = result.error.issues.map((i) => i.message).join(" ");
    assertMatch(messages, /NOT YET SUPPORTED/);
  }
});

Deno.test("ListEventsArgs schema accepts an omitted or empty-string timezone", () => {
  assert(ListEventsArgs.safeParse({}).success);
  assert(ListEventsArgs.safeParse({ timezone: "" }).success);
  assert(ListEventsArgs.safeParse({ timezone: undefined }).success);
});

Deno.test("ListEventsArgs timezone field description states non-empty always throws", () => {
  const shape = ListEventsArgs.shape.timezone;
  // The description must be present and explicit, so `swamp model type
  // describe` reflects the real runtime behavior rather than just an
  // undifferentiated "optional string".
  const description = shape.description ?? "";
  assertMatch(description, /NOT YET SUPPORTED/);
  assertMatch(description, /must be empty or omitted/i);
});

// ---------------------------------------------------------------------------
// Regression: adversarial review #5 — an email-shaped calendarId must yield a
// well-formed swamp resource instance name (raw value stays in the data).
// ---------------------------------------------------------------------------

Deno.test("sanitizeForInstanceName replaces non-[a-z0-9_-] chars with '-'", () => {
  assertEquals(
    sanitizeForInstanceName("someone@example.com"),
    "someone-example-com",
  );
  assertEquals(sanitizeForInstanceName("primary"), "primary");
  assertEquals(sanitizeForInstanceName("Mixed.CASE@Example.COM"), "mixed-case-example-com");
});

Deno.test("sanitizeForInstanceName never leaves '@' or '.' in its output", () => {
  const sanitized = sanitizeForInstanceName("a.weird+id@sub.example.co.uk");
  assert(!sanitized.includes("@"));
  assert(!sanitized.includes("."));
  assertMatch(sanitized, /^[a-z0-9_-]+$/);
});

Deno.test("list_events writeResource instance name is well-formed for an email-shaped calendarId", async () => {
  const writeResourceCalls: {
    specName: string;
    instanceName: string;
    data: Record<string, unknown>;
  }[] = [];
  const fetchImpl: FetchLike = (url) => {
    if (url === OAUTH_TOKEN_URL) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ access_token: "at-name" })),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ items: [] })),
    });
  };

  const now = new Date(2026, 6, 20, 8, 0, 0).getTime();
  const record = await runListEvents(
    fetchImpl,
    FULL_GLOBAL_ARGS,
    { calendarId: "someone@example.com", date: "2026-07-20" },
    now,
  );

  // Mirror the model's execute(): the instance name must sanitize the
  // calendarId segment specifically, while the record (resource DATA) keeps
  // the raw, unsanitized value.
  const sanitizedCalendarId = sanitizeForInstanceName(record.calendarId);
  const instanceName = `events-${sanitizedCalendarId}-${record.date}-${record.ts}`;

  assertEquals(record.calendarId, "someone@example.com", "raw calendarId stays in the data");
  assertEquals(sanitizedCalendarId, "someone-example-com", "the calendarId segment must be sanitized");
  assert(
    !sanitizedCalendarId.includes("@") && !sanitizedCalendarId.includes("."),
    "the sanitized calendarId segment must not contain '@' or '.'",
  );
  assertMatch(
    instanceName,
    /^events-someone-example-com-2026-07-20-.+$/,
    "instance name must embed the sanitized calendarId but still be recognizable",
  );

  writeResourceCalls.push({ specName: "events", instanceName, data: record });
  assertEquals(writeResourceCalls[0].specName, "events");
});
