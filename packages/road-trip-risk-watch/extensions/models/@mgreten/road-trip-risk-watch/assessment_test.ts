import { collect, render } from "./assessment.ts";
import { model } from "./model.ts";

Deno.test("assessment completion marker identifies matching output and never advances on write failure", async () => {
  const stored = new Map<string, string>();
  let status: { assessmentId: string } | undefined;
  let failAt = "";
  const args = model.methods.assess.arguments.parse({
    tripDate: "2026-01-02",
    etaKind: "estimated",
    routes: [{
      name: "Example",
      checkpoints: [{ name: "No ETA", lat: 40, lon: -105 }],
    }],
  });
  const context = {
    createFileWriter: (spec: string) => ({
      writeText: (text: string) => {
        if (spec === failAt) throw new Error("Injected write failure");
        stored.set(spec, text);
        return Promise.resolve({});
      },
    }),
    writeResource: (spec: string, _name: string, value: unknown) => {
      if (spec === failAt) throw new Error("Injected write failure");
      status = model.resources.assessmentStatus.schema.parse(value);
      return Promise.resolve({ attributes: value });
    },
  };
  const complete = async () => {
    failAt = "";
    const previous = status?.assessmentId;
    await model.methods.assess.execute(args, context);
    const data = JSON.parse(stored.get("assessmentData")!);
    const htmlId = stored.get("assessment")!.match(
      /name="assessment-id" content="([^"]+)"/,
    )?.[1];
    if (
      !status || status.assessmentId === previous ||
      status.assessmentId !== data.assessmentId ||
      htmlId !== status.assessmentId
    ) {
      throw new Error("Completion marker does not identify this report pair");
    }
  };
  await complete();
  for (const spec of ["assessmentData", "assessment", "assessmentStatus"]) {
    const previous = status!.assessmentId;
    failAt = spec;
    try {
      await model.methods.assess.execute(args, context);
      throw new Error("Write failure did not reject the assessment");
    } catch (error) {
      if (
        !(error instanceof Error) || error.message !== "Injected write failure"
      ) throw error;
    }
    if (status!.assessmentId !== previous) {
      throw new Error("Failed run advanced completion marker");
    }
    if (
      spec !== "assessmentData" &&
      JSON.parse(stored.get("assessmentData")!).assessmentId === previous
    ) {
      throw new Error(
        "Partial new report cannot be distinguished from completed report",
      );
    }
    await complete();
  }
});

Deno.test("arbitrary routes select their own remaining checkpoints and match ETA", async () => {
  let calls = 0;
  const fake: typeof fetch = (url) => {
    calls++;
    const data = String(url).includes("/points/")
      ? {
        properties: { forecastHourly: "https://api.weather.gov/grid/hourly" },
      }
      : {
        properties: {
          updateTime: "2026-01-01T10:00:00Z",
          periods: [{
            startTime: "2026-01-02T12:00:00Z",
            endTime: "2026-01-02T13:00:00Z",
            temperature: 30,
            temperatureUnit: "F",
            windSpeed: "5 mph",
            shortForecast: "Snow",
          }],
        },
      };
    return Promise.resolve(new Response(JSON.stringify(data)));
  };
  const result = await collect(
    {
      tripDate: "2026-01-02",
      anchorTime: "2026-01-02T11:00:00Z",
      etaKind: "estimated",
      routes: [
        {
          name: "East",
          remainingFrom: "Boston",
          checkpoints: [{ name: "Old", lat: 42, lon: -72 }, {
            name: "Boston",
            lat: 42.36,
            lon: -71.06,
            offsetMinutes: 60,
          }],
        },
        {
          name: "West",
          remainingFrom: "Albany",
          checkpoints: [{ name: "Earlier", lat: 40, lon: -74 }, {
            name: "Albany",
            lat: 42.65,
            lon: -73.75,
            offsetMinutes: 60,
          }],
        },
      ],
    },
    fake,
    () => new Date("2026-01-01T11:00:00Z"),
  );
  if (
    calls !== 3 || result.routes[0].checkpoints.length !== 1 ||
    result.routes[1].checkpoints[0].name !== "Albany"
  ) throw new Error("filter or call bound failed");
  if (result.routes[0].checkpoints[0].forecast?.shortForecast !== "Snow") {
    throw new Error("ETA hour not selected");
  }
  if (!render(result).includes("not a safety clearance")) {
    throw new Error("safety disclaimer missing");
  }
});

Deno.test("untrusted forecast links and absent ETA fail closed", async () => {
  let calls = 0;
  const fake: typeof fetch = () => {
    calls++;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          properties: { forecastHourly: "https://example.com/" },
        }),
      ),
    );
  };
  const result = await collect({
    tripDate: "2026-01-02",
    etaKind: "caller-supplied",
    routes: [{
      name: "Global input",
      checkpoints: [{
        name: "Outside NWS",
        lat: 51.5,
        lon: -0.1,
        eta: "2026-01-02T12:00:00Z",
      }, { name: "No ETA", lat: 0, lon: 0 }],
    }],
  }, fake);
  if (
    calls !== 1 ||
    result.routes[0].checkpoints.some((p) => p.status !== "unknown")
  ) throw new Error("unsafe request or status");
});

Deno.test("total checkpoint bound is enforced before requests", async () => {
  let calls = 0;
  const checkpoints = Array.from(
    { length: 16 },
    (_, i) => ({ name: `P${i}`, lat: 0, lon: 0 }),
  );
  try {
    await collect({
      tripDate: "2026-01-02",
      etaKind: "routed",
      routes: [{ name: "A", checkpoints }, { name: "B", checkpoints }],
    }, () => {
      calls++;
      throw new Error("unexpected");
    });
    throw new Error("limit not enforced");
  } catch (error) {
    if (
      calls ||
      (error instanceof Error && error.message === "limit not enforced")
    ) throw error;
  }
});

Deno.test("hour boundary, stale update, and HTML escaping", async () => {
  const fake: typeof fetch = (url) =>
    Promise.resolve(
      new Response(JSON.stringify(
        String(url).includes("/points/")
          ? { properties: { forecastHourly: "https://api.weather.gov/hourly" } }
          : {
            properties: {
              updateTime: "2026-01-01T00:00:00Z",
              periods: [
                {
                  startTime: "2026-01-02T11:00:00Z",
                  endTime: "2026-01-02T12:00:00Z",
                  temperature: 10,
                  temperatureUnit: "F",
                  windSpeed: "1 mph",
                  shortForecast: "Old",
                },
                {
                  startTime: "2026-01-02T12:00:00Z",
                  endTime: "2026-01-02T13:00:00Z",
                  temperature: 20,
                  temperatureUnit: "F",
                  windSpeed: "2 mph",
                  shortForecast: "New",
                },
              ],
            },
          },
      )),
    );
  const result = await collect(
    {
      tripDate: "2026-01-02",
      etaKind: "routed",
      routes: [{
        name: "<script>alert(1)</script>",
        checkpoints: [{
          name: "<img>",
          lat: 40,
          lon: -70,
          eta: "2026-01-02T12:00:00Z",
        }],
      }],
    },
    fake,
    () => new Date("2026-01-02T00:00:00Z"),
  );
  if (
    result.routes[0].checkpoints[0].forecast?.shortForecast !== "New" ||
    result.routes[0].checkpoints[0].status !== "stale"
  ) throw new Error("boundary or staleness incorrect");
  const html = render(result);
  if (html.includes("<script>") || html.includes("<img>")) {
    throw new Error("HTML injection");
  }
});

Deno.test("public assess honors merged globals, route progress, boundary hours and escaped output", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (url) => {
    calls++;
    const data = String(url).includes("/points/")
      ? { properties: { forecastHourly: "https://api.weather.gov/hourly" } }
      : {
        properties: {
          updateTime: "2020-01-01T00:00:00Z",
          periods: [
            {
              startTime: "2026-01-02T11:00:00Z",
              endTime: "2026-01-02T12:00:00Z",
              temperature: 10,
              temperatureUnit: "F",
              windSpeed: "1 mph",
              shortForecast: "Before",
            },
            {
              startTime: "2026-01-02T12:00:00Z",
              endTime: "2026-01-02T13:00:00Z",
              temperature: 20,
              temperatureUnit: "F",
              windSpeed: "2 mph",
              shortForecast: "After",
            },
          ],
        },
      };
    return Promise.resolve(new Response(JSON.stringify(data)));
  };
  try {
    let html = "";
    let status: unknown;
    const args = model.methods.assess.arguments.parse({
      tripLabel: "global",
      statePath: "ignored",
      etaNote: "PRIVATE LOCATION NOTE",
      tripDate: "2026-01-02",
      etaKind: "estimated",
      routes: [
        {
          name: "<script>bad</script>",
          remainingFrom: "Start",
          checkpoints: [{ name: "Skipped", lat: 40, lon: -70 }, {
            name: "Start",
            lat: 41,
            lon: -71,
            eta: "2026-01-02T12:00:00Z",
          }],
        },
        {
          name: "Alternate",
          remainingFrom: "Finish",
          checkpoints: [{ name: "Skipped too", lat: 40, lon: -70 }, {
            name: "Finish",
            lat: 41,
            lon: -71,
            eta: "2026-01-02T13:00:00Z",
          }],
        },
      ],
    });
    const output = await model.methods.assess.execute(args, {
      writeResource: (_spec, _name, value) => {
        status = value;
        return Promise.resolve({ attributes: value });
      },
      createFileWriter: () => ({
        writeText: (text) => {
          html = text;
          return Promise.resolve({});
        },
      }),
    });
    if (
      calls !== 2 || html.includes("Skipped") || html.includes("<script>") ||
      !html.includes("After") || !html.includes("stale") ||
      !html.includes("forecast unknown")
    ) throw new Error("public contract failed");
    const parsed = model.resources.assessmentStatus.schema.parse(status);
    if (
      parsed.ok !== 0 || parsed.stale !== 1 || parsed.unknown !== 1 ||
      parsed.hazardCount !== 0 || parsed.summary.includes("Start:") ||
      parsed.summary.includes("Finish:") ||
      !parsed.summary.includes("not a safety clearance") ||
      parsed.summary.includes("PRIVATE LOCATION NOTE") ||
      parsed.summary.includes("-71") || parsed.summary.includes("Skipped") ||
      !output.dataHandles.some((handle) =>
        (handle as { attributes?: unknown }).attributes === status
      )
    ) {
      throw new Error(
        "notification status is unrelated, incomplete or exposes raw location",
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("time window stops new requests at exclusive end", async () => {
  let clock = Date.parse("2026-01-01T00:00:00Z");
  let calls = 0;
  const fake: typeof fetch = () => {
    calls++;
    clock += 1000;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          properties: { forecastHourly: "https://api.weather.gov/hourly" },
        }),
      ),
    );
  };
  try {
    await collect(
      {
        tripDate: "2026-01-02",
        etaKind: "estimated",
        windowStart: "2026-01-01T00:00:00Z",
        windowEnd: "2026-01-01T00:00:01Z",
        routes: [{
          name: "R",
          checkpoints: [{
            name: "P",
            lat: 40,
            lon: -70,
            eta: "2026-01-02T12:00:00Z",
          }],
        }],
      },
      fake,
      () => new Date(clock),
    );
    throw new Error("window did not close");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "Assessment window closed" || calls !== 1
    ) throw error;
  }
});

Deno.test("public assessment rejects automated road sources and reports road coverage unknown", async () => {
  const args = {
    tripDate: "2026-01-02",
    etaKind: "estimated" as const,
    routes: [{ name: "R", checkpoints: [{ name: "P", lat: 40, lon: -105 }] }],
  };
  for (const source of ["cotrip", "here"]) {
    if (
      model.methods.assess.arguments.safeParse({
        ...args,
        roadSources: [source],
      }).success
    ) throw new Error("unsupported provider was accepted");
  }
  const result = await collect({ ...args, roadSources: [] }, () => {
    throw new Error("no ETA must make no provider request");
  });
  if (
    result.roadConditions !== null ||
    !render(result).includes("No automated road conditions collected.")
  ) {
    throw new Error("missing road coverage must remain explicit");
  }
});

Deno.test("manual check-in uses freshly relative offsets, not original cumulative offsets", async () => {
  const report = await collect({
    tripDate: "2026-01-02",
    anchorTime: "2026-01-02T10:00:00Z",
    etaKind: "estimated",
    routes: [{
      name: "R",
      remainingFrom: "Check-in",
      checkpoints: [
        { name: "Origin", lat: 40, lon: -70, offsetMinutes: 0 },
        { name: "Check-in", lat: 41, lon: -71, offsetMinutes: 0 },
        { name: "Next", lat: 42, lon: -72, offsetMinutes: 120 },
      ],
    }],
  }, () => Promise.resolve(new Response("", { status: 503 })));
  if (report.routes[0].checkpoints[1].eta !== "2026-01-02T12:00:00.000Z") {
    throw new Error("incorrect manual re-anchor");
  }
});

Deno.test("public assess rejects an expired window before requests and output", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  let writes = 0;
  globalThis.fetch = () => {
    calls++;
    throw new Error("unexpected request");
  };
  try {
    const args = model.methods.assess.arguments.parse({
      tripDate: "2026-01-02",
      etaKind: "estimated",
      windowStart: "2020-01-01T00:00:00Z",
      windowEnd: "2020-01-02T00:00:00Z",
      routes: [{
        name: "R",
        checkpoints: [{
          name: "P",
          lat: 40,
          lon: -70,
          eta: "2026-01-02T12:00:00Z",
        }],
      }],
    });
    try {
      await model.methods.assess.execute(args, {
        writeResource: () => {
          writes++;
          return Promise.resolve({});
        },
        createFileWriter: () => ({
          writeText: () => {
            writes++;
            return Promise.resolve({});
          },
        }),
      });
      throw new Error("expected closed window");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "Assessment window closed"
      ) throw error;
    }
    if (calls || writes) {
      throw new Error("expired window made a request or wrote output");
    }
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("public assess manual check-in uses caller's relative offsets", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response("", { status: 503 }));
  try {
    let html = "";
    const args = model.methods.assess.arguments.parse({
      tripDate: "2026-01-02",
      etaKind: "estimated",
      anchorTime: "2026-01-02T10:00:00Z",
      routes: [{
        name: "R",
        remainingFrom: "Check-in",
        checkpoints: [
          { name: "Origin", lat: 40, lon: -70, offsetMinutes: 0 },
          { name: "Check-in", lat: 41, lon: -71, offsetMinutes: 0 },
          { name: "Next", lat: 42, lon: -72, offsetMinutes: 120 },
        ],
      }],
    });
    await model.methods.assess.execute(args, {
      writeResource: () => Promise.resolve({}),
      createFileWriter: () => ({
        writeText: (text) => {
          html = text;
          return Promise.resolve({});
        },
      }),
    });
    if (
      !html.includes("2026-01-02T12:00:00.000Z") ||
      html.includes("2026-01-02T13:00:00.000Z")
    ) throw new Error("manual check-in ETA incorrect");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("manual progress rebases alternatives and selects new arrival hours", async () => {
  const fake: typeof fetch = (url) =>
    Promise.resolve(
      new Response(JSON.stringify(
        String(url).includes("/points/")
          ? { properties: { forecastHourly: "https://api.weather.gov/hourly" } }
          : {
            properties: {
              updateTime: "2026-01-02T12:00:00Z",
              periods: [12, 13, 14].map((hour) => ({
                startTime: `2026-01-02T${hour}:00:00Z`,
                endTime: `2026-01-02T${hour + 1}:00:00Z`,
                temperature: hour + 10,
                temperatureUnit: "F",
                windSpeed: "15 mph",
                shortForecast: hour === 13 ? "Snow" : "Cloudy",
              })),
            },
          },
      )),
    );
  const result = await collect(
    {
      tripDate: "2026-01-02",
      displayTimeZone: "America/Denver",
      etaKind: "routed",
      manualCheckIn: {
        checkpoint: "Branch",
        observedAt: "2026-01-02T12:00:00Z",
        delayMinutes: 20,
      },
      routes: [175, 235].map((end, i) => ({
        name: `Route ${i}`,
        checkpoints: [
          { name: "Behind", lat: 38, lon: -113, offsetMinutes: 0 },
          { name: "Branch", lat: 39, lon: -112, offsetMinutes: 95 },
          { name: `Pass ${i}`, lat: 40 + i, lon: -110, offsetMinutes: end },
        ],
      })),
    },
    fake,
    () => new Date("2026-01-02T12:05:00Z"),
  );
  if (
    result.etaKind !== "estimated" ||
    result.routes.some((r) => r.checkpoints.length !== 2) ||
    result.routes[0].checkpoints[1].eta !== "2026-01-02T13:40:00.000Z" ||
    result.routes[1].checkpoints[1].eta !== "2026-01-02T14:40:00.000Z" ||
    result.routes[0].checkpoints[1].forecast?.temperature !== 23 ||
    result.routes[1].checkpoints[1].forecast?.temperature !== 24
  ) {
    throw new Error(
      "manual progress retained cumulative offsets or selected wrong hour",
    );
  }
  const html = render(result);
  if (
    html.includes("Behind") || !html.includes("6:40 AM MST") ||
    !html.includes("7:40 AM MST")
  ) {
    throw new Error("remaining report or display zone incorrect");
  }
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const match of html.matchAll(/href="#([^"]+)"/g)) {
    if (!ids.has(match[1])) throw new Error("map marker has no detail target");
  }
});

Deno.test("road observations retain provenance, expire and never imply clear pavement", async () => {
  let calls = 0;
  const args = {
    tripDate: "2026-01-02",
    etaKind: "estimated" as const,
    routes: [{
      name: "A",
      remainingFrom: "Next",
      checkpoints: [
        { name: "Behind", lat: 39, lon: -111 },
        { name: "Next", lat: 40, lon: -110 },
      ],
    }],
    roadObservations: [
      {
        route: "A",
        checkpoint: "Behind",
        condition: "Old segment",
        observedAt: "2026-01-02T12:00:00Z",
        source: "UDOT" as const,
        sourceUrl: "https://udottraffic.utah.gov/",
      },
      {
        route: "A",
        checkpoint: "Next",
        condition: "Slick & <snow>",
        observedAt: "2026-01-02T11:30:00Z",
        sourceUpdatedAt: "2026-01-02T11:25:00Z",
        source: "WYDOT" as const,
        sourceUrl: "https://www.wyoroad.info/",
      },
      {
        route: "A",
        checkpoint: "Next",
        condition: "Earlier report",
        observedAt: "2026-01-02T10:00:00Z",
        source: "WYDOT" as const,
        sourceUrl: "https://www.wyoroad.info/",
      },
      {
        route: "A",
        checkpoint: "Next",
        condition: "Future report",
        observedAt: "2026-01-02T13:00:00Z",
        source: "WYDOT" as const,
        sourceUrl: "https://www.wyoroad.info/",
      },
    ],
  };
  const fake: typeof fetch = () => {
    calls++;
    throw new Error("no ETA should mean no request");
  };
  const result = await collect(
    args,
    fake,
    () => new Date("2026-01-02T12:05:00Z"),
  );
  if (
    calls || result.roadObservations.length !== 3 ||
    result.roadObservations.map((o) => o.status).join() !==
      "recent,stale or unknown,stale or unknown"
  ) {
    throw new Error("road observation progress/freshness incorrect");
  }
  const html = render(result);
  if (
    html.includes("<snow>") || html.includes("Old segment") ||
    !html.includes("Slick &amp; &lt;snow&gt;") ||
    !html.includes("manually supplied, not an arrival forecast")
  ) throw new Error("unsafe road display");
  for (
    const sourceUrl of [
      "https://www.wyoroad.info/?key=private",
      "javascript:alert(1)",
      "https://evil.example/",
    ]
  ) {
    try {
      await collect({
        ...args,
        roadObservations: [{ ...args.roadObservations[1], sourceUrl }],
      }, fake);
      throw new Error("unsafe source accepted");
    } catch (error) {
      if (
        error instanceof Error && error.message === "unsafe source accepted"
      ) throw error;
    }
  }
});

Deno.test("public notification status counts hazards and bounds long checkpoint lists", async () => {
  const original = globalThis.fetch;
  const start = "2026-01-02T12:00:00Z";
  globalThis.fetch = (url) =>
    Promise.resolve(
      new Response(JSON.stringify(
        String(url).includes("/points/")
          ? { properties: { forecastHourly: "https://api.weather.gov/hourly" } }
          : {
            properties: {
              updateTime: new Date().toISOString(),
              periods: [{
                startTime: start,
                endTime: "2026-01-02T13:00:00Z",
                temperature: 17,
                temperatureUnit: "F",
                windSpeed: "22 mph",
                shortForecast: "Snow Showers And Blowing Snow",
              }],
            },
          },
      )),
    );
  try {
    let status: unknown;
    await model.methods.assess.execute({
      tripDate: "2026-01-02",
      etaKind: "estimated",
      routes: [{
        name: "Mountain alternative",
        checkpoints: Array.from({ length: 30 }, (_, i) => ({
          name: `${i} ${"Long checkpoint label ".repeat(4)}`,
          lat: 40,
          lon: -105,
          eta: start,
        })),
      }],
    }, {
      createFileWriter: () => ({ writeText: () => Promise.resolve({}) }),
      writeResource: (_spec, _name, value) => {
        status = value;
        return Promise.resolve({ attributes: value });
      },
    });
    const result = model.resources.assessmentStatus.schema.parse(status);
    if (
      result.ok !== 30 || result.stale !== 0 || result.unknown !== 0 ||
      result.hazardCount !== 30 ||
      !result.summary.includes(
        "Snow Showers And Blowing Snow 17°F, wind 22 mph",
      ) ||
      !result.summary.endsWith(
        "[Truncated; more checkpoints in stored report.]",
      )
    ) {
      throw new Error(
        "hazard summary count, conditions or truncation incorrect",
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});
