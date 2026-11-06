/**
 * Tests for frigate-footage-export. The model talks to Frigate only through
 * globalThis.fetch, so each method test swaps fetch for a recording fake and
 * restores it in a finally block. No network access happens. All hosts are
 * synthetic (example.com) and tokens are fake.
 */

// deno-lint-ignore no-import-prefix
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  buildExportName,
  buildExportPlan,
  model,
  normalizeApiBase,
  toEvent,
} from "./model.ts";

type FetchCall = {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
};
type Responder = (call: FetchCall, init?: RequestInit) => Promise<Response>;
type Write = { spec: string; name: string; data: Record<string, unknown> };
type Log = { level: string; message: string; props?: Record<string, unknown> };

const API = "https://frigate.example.com/api";

async function withFakeFetch<T>(
  respond: Responder,
  fn: (calls: FetchCall[]) => Promise<T>,
): Promise<T> {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    return respond(call, init);
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function json(value: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function makeContext(
  globalArgs: Record<string, unknown> = { apiBaseUrl: API },
  signal: AbortSignal = new AbortController().signal,
) {
  const writes: Write[] = [];
  const logs: Log[] = [];
  const context = {
    globalArgs: model.globalArguments.parse(globalArgs),
    signal,
    logger: {
      info: (message: string, props?: Record<string, unknown>) =>
        logs.push({ level: "info", message, props }),
      warning: (message: string, props?: Record<string, unknown>) =>
        logs.push({ level: "warning", message, props }),
    },
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ name: `${spec}-${name}` });
    },
  };
  return { context, writes, logs };
}

// 2026-01-02T03:04:05.000Z
const T0 = 1767323045;

Deno.test("normalizeApiBase strips every trailing slash and keeps the path", () => {
  assertEquals(normalizeApiBase(`${API}///`), API);
  assertEquals(normalizeApiBase(API), API);
  assertEquals(
    normalizeApiBase("https://example.com/frigate/api/"),
    "https://example.com/frigate/api",
  );
});

Deno.test("buildExportName sanitises topic and camera and stamps UTC time", () => {
  assertEquals(
    buildExportName("  Porch / delivery:  check ", "front door!", T0),
    "Porch - delivery- check - front-door- - 2026-01-02T03-04-05-000Z",
  );
  // Empty (after trim) topic falls back to a fixed default.
  assertEquals(
    buildExportName("   ", "cam_a.1", 0),
    "frigate-export - cam_a.1 - 1970-01-01T00-00-00-000Z",
  );
});

Deno.test("buildExportName truncates to exactly 256 characters", () => {
  const name = buildExportName("x".repeat(300), "cam", T0);
  assertEquals(name.length, 256);
  assertEquals(name, "x".repeat(256));
  const short = buildExportName("x".repeat(200), "cam", T0);
  assertEquals(short.length, 200 + " - cam - 2026-01-02T03-04-05-000Z".length);
});

Deno.test("buildExportPlan dedupes trimmed cameras and copies options", () => {
  const plan = buildExportPlan({
    topic: "  Gate check ",
    cameras: [" cam_b ", "cam_a", "cam_b", "  "],
    startTime: T0,
    endTime: T0 + 60,
    playback: "timelapse_25x",
    source: "preview",
    chapters: null,
  });
  assertEquals(plan.topic, "Gate check");
  assertEquals(plan.items, [
    {
      camera: "cam_b",
      startTime: T0,
      endTime: T0 + 60,
      name: "Gate check - cam_b - 2026-01-02T03-04-05-000Z",
      playback: "timelapse_25x",
      source: "preview",
      chapters: null,
    },
    {
      camera: "cam_a",
      startTime: T0,
      endTime: T0 + 60,
      name: "Gate check - cam_a - 2026-01-02T03-04-05-000Z",
      playback: "timelapse_25x",
      source: "preview",
      chapters: null,
    },
  ]);
  assertEquals(Number.isNaN(Date.parse(plan.plannedAt)), false);
});

Deno.test("buildExportPlan rejects empty windows and missing cameras", () => {
  const base = {
    topic: "t",
    cameras: ["cam_a"],
    startTime: T0,
    endTime: T0 + 1,
    playback: "realtime" as const,
    source: "recordings" as const,
    chapters: "none" as const,
  };
  // endTime one second after start is the smallest valid window.
  assertEquals(buildExportPlan(base).items.length, 1);
  assertThrows(
    () => buildExportPlan({ ...base, endTime: T0 }),
    Error,
    "endTime must be later than startTime.",
  );
  assertThrows(
    () => buildExportPlan({ ...base, cameras: [" ", ""] }),
    Error,
    "At least one camera is required.",
  );
  assertEquals(
    buildExportPlan({ ...base, topic: "  " }).topic,
    "Frigate export",
  );
});

Deno.test("toEvent maps Frigate payload fields and defaults missing ones", () => {
  assertEquals(
    toEvent({
      id: 42,
      camera: "cam_a",
      label: "person",
      start_time: T0,
      end_time: T0 + 5.5,
      has_clip: 1,
      has_snapshot: 0,
      zones: ["yard", 7],
      data: { max_severity: "alert" },
    }),
    {
      id: "42",
      camera: "cam_a",
      label: "person",
      startTime: T0,
      endTime: T0 + 5.5,
      hasClip: true,
      hasSnapshot: false,
      zones: ["yard", "7"],
      severity: "alert",
    },
  );
  assertEquals(
    toEvent({ id: "e1", start_time: T0, end_time: "later", zones: "yard" }),
    {
      id: "e1",
      camera: "",
      label: "",
      startTime: T0,
      endTime: null,
      hasClip: false,
      hasSnapshot: false,
      zones: [],
      severity: null,
    },
  );
  // A missing start_time becomes NaN, which the schema rejects.
  assertThrows(() => toEvent({ id: "e2" }));
});

Deno.test("global and method argument schemas accept valid and reject invalid input", () => {
  const g = model.globalArguments.parse({ apiBaseUrl: API });
  assertEquals(g, { apiBaseUrl: API, apiToken: "", requestTimeoutMs: 30_000 });
  assertEquals(
    model.globalArguments.safeParse({ apiBaseUrl: "not a url" }).success,
    false,
  );
  assertEquals(
    model.globalArguments.safeParse({ apiBaseUrl: API, requestTimeoutMs: 999 })
      .success,
    false,
  );
  assertEquals(
    model.globalArguments.safeParse({
      apiBaseUrl: API,
      requestTimeoutMs: 120_001,
    }).success,
    false,
  );
  assertEquals(
    model.globalArguments.safeParse({
      apiBaseUrl: API,
      requestTimeoutMs: 1_000,
    }).success,
    true,
  );

  const list = model.methods.listEvents.arguments;
  assertEquals(list.parse({ after: 1, before: 2 }), {
    after: 1,
    before: 2,
    cameras: [],
    labels: [],
    requireClip: false,
    limit: 100,
  });
  assertEquals(
    list.safeParse({ after: 1, before: 2, limit: 500 }).success,
    true,
  );
  assertEquals(
    list.safeParse({ after: 1, before: 2, limit: 501 }).success,
    false,
  );
  assertEquals(
    list.safeParse({ after: 1, before: 2, limit: 0 }).success,
    false,
  );
  assertEquals(
    list.safeParse({ after: 1, before: 2, cameras: [""] }).success,
    false,
  );

  const plan = model.methods.planExports.arguments.parse({
    topic: "t",
    cameras: ["cam_a"],
    startTime: 1,
    endTime: 2,
  });
  assertEquals(plan.playback, "realtime");
  assertEquals(plan.source, "recordings");
  assertEquals(plan.chapters, "recording_segments");
  assertEquals(
    model.methods.planExports.arguments.safeParse({
      topic: "t".repeat(161),
      cameras: ["cam_a"],
      startTime: 1,
      endTime: 2,
    }).success,
    false,
  );
  assertEquals(
    model.methods.planExports.arguments.safeParse({
      topic: "t",
      cameras: [],
      startTime: 1,
      endTime: 2,
    }).success,
    false,
  );

  const create = model.methods.createExports.arguments;
  assertEquals(
    create.safeParse({ plan: { plannedAt: "x", topic: "t", items: [] } })
      .success,
    false,
  );
});

Deno.test("listEvents sends filtered query with auth and records results", async () => {
  const { context, writes, logs } = makeContext({
    apiBaseUrl: `${API}/`,
    apiToken: "fake-token-123",
  });
  await withFakeFetch(
    () =>
      json([
        {
          id: "a",
          camera: "cam_a",
          label: "car",
          start_time: T0,
          end_time: null,
        },
        { id: "b", camera: "cam_b", label: "dog", start_time: T0 + 1 },
      ]),
    async (calls) => {
      const out = await model.methods.listEvents.execute(
        {
          after: T0,
          before: T0 + 3600,
          cameras: ["cam_a", "cam_b"],
          labels: ["car"],
          requireClip: true,
          limit: 2,
        },
        context,
      );
      assertEquals(out, { dataHandles: [{ name: "eventQuery-latest" }] });
      assertEquals(calls.length, 1);
      assertEquals(
        calls[0].url,
        `${API}/events?after=${T0}&before=${
          T0 + 3600
        }&limit=2&include_thumbnails=0&timezone=utc&cameras=cam_a%2Ccam_b&labels=car&has_clip=1`,
      );
      assertEquals(calls[0].method, "GET");
      assertEquals(
        calls[0].headers.get("Authorization"),
        "Bearer fake-token-123",
      );
      assertEquals(calls[0].headers.get("Accept"), "application/json");
    },
  );
  assertEquals(writes.length, 1);
  assertEquals(writes[0].spec, "eventQuery");
  assertEquals(writes[0].name, "latest");
  const { queriedAt, ...rest } = writes[0].data;
  assertEquals(typeof queriedAt, "string");
  assertEquals(rest.count, 2);
  // count === limit is flagged as possibly truncated.
  assertEquals(rest.possiblyTruncated, true);
  assertEquals((rest.events as { id: string }[]).map((e) => e.id), ["a", "b"]);
  assertEquals(rest.cameras, ["cam_a", "cam_b"]);
  assertEquals(logs.at(-1), {
    level: "info",
    message: "Found {count} Frigate events",
    props: { count: 2 },
  });
});

Deno.test("listEvents omits empty filters and auth, and below-limit is not truncated", async () => {
  const { context, writes } = makeContext();
  await withFakeFetch(
    () => json([{ id: "a", start_time: T0 }]),
    async (calls) => {
      await model.methods.listEvents.execute(
        {
          after: T0,
          before: T0 + 1,
          cameras: [],
          labels: [],
          requireClip: false,
          limit: 2,
        },
        context,
      );
      assertEquals(
        calls[0].url,
        `${API}/events?after=${T0}&before=${
          T0 + 1
        }&limit=2&include_thumbnails=0&timezone=utc`,
      );
      assertEquals(calls[0].headers.has("Authorization"), false);
    },
  );
  assertEquals(writes[0].data.count, 1);
  assertEquals(writes[0].data.possiblyTruncated, false);
});

Deno.test("listEvents rejects an inverted window before any request", async () => {
  const { context, writes } = makeContext();
  await withFakeFetch(() => json([]), async (calls) => {
    await assertRejects(
      () =>
        model.methods.listEvents.execute(
          {
            after: T0,
            before: T0,
            cameras: [],
            labels: [],
            requireClip: false,
            limit: 1,
          },
          context,
        ),
      Error,
      "before must be later than after.",
    );
    assertEquals(calls.length, 0);
  });
  assertEquals(writes.length, 0);
});

Deno.test("listEvents surfaces HTTP errors and invalid JSON without writing", async () => {
  const args = {
    after: T0,
    before: T0 + 1,
    cameras: [],
    labels: [],
    requireClip: false,
    limit: 1,
  };
  const { context, writes } = makeContext();
  const path = `/events?after=${T0}&before=${
    T0 + 1
  }&limit=1&include_thumbnails=0&timezone=utc`;
  await withFakeFetch(
    () => Promise.resolve(new Response("x".repeat(600), { status: 503 })),
    async () => {
      const err = await assertRejects(
        () => model.methods.listEvents.execute(args, context),
        Error,
      );
      assertEquals(
        err.message,
        `Frigate GET ${path} failed with HTTP 503: ${"x".repeat(500)}`,
      );
    },
  );
  await withFakeFetch(
    () => Promise.resolve(new Response("<html>", { status: 200 })),
    async () => {
      await assertRejects(
        () => model.methods.listEvents.execute(args, context),
        Error,
        `Frigate GET ${path} returned invalid JSON.`,
      );
    },
  );
  assertEquals(writes.length, 0);
});

Deno.test("context abort signal cancels the in-flight Frigate request", async () => {
  const controller = new AbortController();
  const { context, writes } = makeContext(
    { apiBaseUrl: API },
    controller.signal,
  );
  await withFakeFetch(
    (_call, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")));
        controller.abort();
      }),
    async () => {
      await assertRejects(
        () =>
          model.methods.listEvents.execute(
            {
              after: T0,
              before: T0 + 1,
              cameras: [],
              labels: [],
              requireClip: false,
              limit: 1,
            },
            context,
          ),
        DOMException,
        "aborted",
      );
    },
  );
  assertEquals(writes.length, 0);
});

Deno.test("inspectRecordings encodes camera path and counts segments", async () => {
  const { context, writes } = makeContext();
  const segments = [{ start_time: T0, end_time: T0 + 10 }, {
    start_time: T0 + 10,
    end_time: T0 + 20,
  }];
  await withFakeFetch(() => json(segments), async (calls) => {
    const out = await model.methods.inspectRecordings.execute(
      { camera: "cam a/b", after: T0, before: T0 + 20 },
      context,
    );
    assertEquals(out, { dataHandles: [{ name: "recordingWindow-latest" }] });
    assertEquals(
      calls[0].url,
      `${API}/cam%20a%2Fb/recordings?after=${T0}&before=${T0 + 20}`,
    );
  });
  assertEquals(writes[0].spec, "recordingWindow");
  assertEquals(writes[0].data.segmentCount, 2);
  assertEquals(writes[0].data.segments, segments);
  assertEquals(writes[0].data.camera, "cam a/b");

  // A non-array payload is recorded as zero segments.
  const second = makeContext();
  await withFakeFetch(() => json({ error: "none" }), async () => {
    await model.methods.inspectRecordings.execute(
      { camera: "cam_a", after: T0, before: T0 + 20 },
      second.context,
    );
  });
  assertEquals(second.writes[0].data.segmentCount, 0);
  assertEquals(second.writes[0].data.segments, []);
});

Deno.test("planExports writes a plan resource and never calls Frigate", async () => {
  const { context, writes, logs } = makeContext();
  await withFakeFetch(() => json({}), async (calls) => {
    const out = await model.methods.planExports.execute(
      {
        topic: "Yard",
        cameras: ["cam_a", "cam_b"],
        startTime: T0,
        endTime: T0 + 30,
        playback: "realtime",
        source: "recordings",
        chapters: "recording_segments",
      },
      context,
    );
    assertEquals(out, { dataHandles: [{ name: "exportPlan-latest" }] });
    assertEquals(calls.length, 0);
  });
  assertEquals(writes[0].spec, "exportPlan");
  const items = writes[0].data.items as { camera: string; name: string }[];
  assertEquals(items.map((i) => i.camera), ["cam_a", "cam_b"]);
  assertEquals(items[1].name, "Yard - cam_b - 2026-01-02T03-04-05-000Z");
  assertEquals(logs[0].props, { count: 2, topic: "Yard" });
});

function samplePlan() {
  return buildExportPlan({
    topic: "Yard",
    cameras: ["cam_a", "cam b"],
    startTime: T0,
    endTime: T0 + 30,
    playback: "timelapse_25x",
    source: "recordings",
    chapters: "none",
  });
}

Deno.test("createExports dry run plans every item without any request", async () => {
  const { context, writes } = makeContext();
  const plan = samplePlan();
  await withFakeFetch(() => json({}), async (calls) => {
    await model.methods.createExports.execute(
      { plan, dryRun: true, confirm: false },
      context,
    );
    assertEquals(calls.length, 0);
  });
  assertEquals(writes[0].spec, "exportResult");
  const { attemptedAt: _a, ...rest } = writes[0].data;
  assertEquals(rest, {
    dryRun: true,
    topic: "Yard",
    planned: 2,
    created: 0,
    failed: 0,
    results: [
      { camera: "cam_a", name: plan.items[0].name, status: "planned" },
      { camera: "cam b", name: plan.items[1].name, status: "planned" },
    ],
  });
});

Deno.test("createExports refuses live creation without confirm", async () => {
  const { context, writes } = makeContext();
  await withFakeFetch(() => json({}), async (calls) => {
    await assertRejects(
      () =>
        model.methods.createExports.execute(
          { plan: samplePlan(), dryRun: false, confirm: false },
          context,
        ),
      Error,
      "Set confirm=true before creating server-side Frigate exports.",
    );
    assertEquals(calls.length, 0);
  });
  assertEquals(writes.length, 0);
});

Deno.test("createExports POSTs each item and records created and failed outcomes", async () => {
  const { context, writes, logs } = makeContext({
    apiBaseUrl: API,
    apiToken: "fake-token-xyz",
  });
  const plan = samplePlan();
  await withFakeFetch(
    (call) =>
      call.url.includes("/export/cam_a/")
        ? json({ id: "exp-1", in_progress: true })
        : Promise.resolve(new Response("disk full", { status: 500 })),
    async (calls) => {
      await model.methods.createExports.execute(
        { plan, dryRun: false, confirm: true },
        context,
      );
      assertEquals(calls.length, 2);
      const byUrl = Object.fromEntries(calls.map((c) => [c.url, c]));
      const a = byUrl[`${API}/export/cam_a/start/${T0}/end/${T0 + 30}`];
      const b = byUrl[`${API}/export/cam%20b/start/${T0}/end/${T0 + 30}`];
      assertEquals(a.method, "POST");
      assertEquals(a.headers.get("Content-Type"), "application/json");
      assertEquals(a.headers.get("Authorization"), "Bearer fake-token-xyz");
      assertEquals(JSON.parse(a.body!), {
        name: plan.items[0].name,
        playback: "timelapse_25x",
        source: "recordings",
        chapters: "none",
      });
      assertEquals(JSON.parse(b.body!).name, plan.items[1].name);
    },
  );
  const { attemptedAt: _a, ...rest } = writes[0].data;
  assertEquals(rest, {
    dryRun: false,
    topic: "Yard",
    planned: 2,
    created: 1,
    failed: 1,
    results: [
      {
        camera: "cam_a",
        name: plan.items[0].name,
        status: "created",
        exportId: "exp-1",
        inProgress: true,
      },
      {
        camera: "cam b",
        name: plan.items[1].name,
        status: "failed",
        error: `Frigate POST /export/cam%20b/start/${T0}/end/${
          T0 + 30
        } failed with HTTP 500: disk full`,
      },
    ],
  });
  assertEquals(
    logs.filter((l) => l.level === "warning").map((l) => l.props),
    [{ camera: "cam b" }],
  );
  assertEquals(logs.at(-1)?.props, { created: 1, failed: 1 });
});

Deno.test("createExports ignores non-string id and non-boolean in_progress", async () => {
  const { context, writes } = makeContext();
  await withFakeFetch(
    () => json({ id: 7, in_progress: "yes" }),
    async () => {
      await model.methods.createExports.execute(
        { plan: samplePlan(), dryRun: false, confirm: true },
        context,
      );
    },
  );
  const results = writes[0].data.results as Record<string, unknown>[];
  assertEquals(results[0].status, "created");
  assertEquals(results[0].exportId, undefined);
  assertEquals(results[0].inProgress, undefined);
  assertEquals(writes[0].data.created, 2);
});
