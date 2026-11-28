import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import {
  buildCheckpointFingerprint,
  buildDigest,
  classifyRisk,
  model,
  routeOverallRisk,
} from "./model.ts";

Deno.test("classifyRisk escalates snow and severe alerts", () => {
  assertEquals(classifyRisk([], ["snow"], 10, 20), "High");
  assertEquals(
    classifyRisk(
      [
        { severity: "severe" },
      ],
      [],
      5,
      10,
    ),
    "High",
  );
});

Deno.test("classifyRisk stays moderate for thunderstorms and precipitation", () => {
  assertEquals(
    classifyRisk([], ["thunderstorm"], 8, 49),
    "Moderate",
  );
});

Deno.test("buildCheckpointFingerprint rounds coordinates and sorts hazards", () => {
  const fingerprint = buildCheckpointFingerprint({
    name: "Test Point",
    role: "check",
    lat: 40.123456,
    lon: -104.987654,
    risk: "Moderate",
    alerts: [
      {
        event: "Heat Advisory",
        severity: "moderate",
        urgency: "Expected",
        certainty: "Likely",
        headline: "Heat Advisory",
      },
    ],
    hourlyHazards: ["fog", "thunderstorm", "fog"],
    windPeakMph: 12,
    precipPeakPct: 33,
    forecastUrl: "https://example.com/forecast",
    hourlyUrl: "https://example.com/hourly",
    alertUrl: "https://example.com/alerts",
    error: null,
  });

  assertEquals(fingerprint.lat, 40.1235);
  assertEquals(fingerprint.lon, -104.9877);
  assertEquals(fingerprint.hourly_hazards, ["fog", "thunderstorm"]);
});

Deno.test("routeOverallRisk returns the highest observed level", () => {
  assertEquals(
    routeOverallRisk([
      {
        name: "A",
        role: "start",
        lat: 0,
        lon: 0,
        risk: "Low",
        alerts: [],
        hourlyHazards: [],
        windPeakMph: 0,
        precipPeakPct: 0,
        forecastUrl: "",
        hourlyUrl: "",
        alertUrl: "",
        error: null,
      },
      {
        name: "B",
        role: "destination",
        lat: 1,
        lon: 1,
        risk: "High",
        alerts: [],
        hourlyHazards: [],
        windPeakMph: 0,
        precipPeakPct: 0,
        forecastUrl: "",
        hourlyUrl: "",
        alertUrl: "",
        error: null,
      },
    ]),
    "High",
  );
});

Deno.test("buildDigest includes key summary lines", () => {
  const digest = buildDigest({
    tripLabel: "Test Trip",
    checkedAt: "2026-07-10T12:00:00.000Z",
    fingerprint: "abc123",
    overallRisk: "Moderate",
    changed: true,
    checkpoints: [
      {
        name: "Test Checkpoint",
        role: "start",
        lat: 39.0,
        lon: -95.0,
        risk: "Moderate",
        alerts: [],
        hourlyHazards: ["thunderstorm"],
        windPeakMph: 5,
        precipPeakPct: 49,
        forecastUrl: "https://example.com/forecast",
        hourlyUrl: "https://example.com/hourly",
        alertUrl: "https://example.com/alerts",
        error: null,
      },
    ],
  });

  assertStringIncludes(digest, "Road-trip risk watch — Test Trip");
  assertStringIncludes(digest, "Overall risk: **Moderate**");
  assertStringIncludes(digest, "Test Checkpoint [start]: Moderate");
});

Deno.test("collect retries failed output, excludes overlapping writers and preserves settings", async () => {
  const directory = await Deno.makeTempDir();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (!url.startsWith("https://api.weather.gov/")) {
      throw new Error(`Unexpected request: ${url}`);
    }
    return Promise.resolve(
      new Response(JSON.stringify(
        url.includes("/points/")
          ? { properties: { forecastHourly: "https://api.weather.gov/hourly" } }
          : url.includes("/alerts/")
          ? { features: [] }
          : {
            properties: {
              periods: [{
                shortForecast: "Snow",
                windSpeed: "17 mph",
                probabilityOfPrecipitation: { value: 63 },
              }],
            },
          },
      )),
    );
  };
  try {
    for (const failure of ["summary", "digest"]) {
      const globalArgs = model.globalArguments.parse({
        tripLabel: "PRIVATE LABEL",
        statePath: `${directory}/${failure}/state.json`,
        liveOriginStatePath: `${directory}/absent-origin.json`,
        checkpointsJson: JSON.stringify([{
          name: "Example checkpoint",
          role: "start",
          lat: 40,
          lon: -105,
        }]),
        userAgent: "custom-agent/7",
      });
      const settings = JSON.stringify(globalArgs);
      const logs: unknown[] = [];
      const context = {
        globalArgs,
        logger: { info: (_message: string, data?: unknown) => logs.push(data) },
        writeResource: (_spec: string, _name: string, data: unknown) => {
          if (failure === "summary") throw new Error("Injected write failure");
          return Promise.resolve(data);
        },
        createFileWriter: () => ({
          writeText: () => Promise.reject(new Error("Injected write failure")),
        }),
      };
      await assertRejects(
        () => model.methods.collect.execute({}, context),
        Error,
        "Injected write failure",
      );
      await assertRejects(
        () => Deno.stat(globalArgs.statePath),
        Deno.errors.NotFound,
      );

      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const successful = {
        ...context,
        writeResource: async (_spec: string, _name: string, data: unknown) => {
          started.resolve();
          await finish.promise;
          return data;
        },
        createFileWriter: () => ({
          writeText: (text: string) => Promise.resolve(text),
        }),
      };
      const retry = model.methods.collect.execute({}, successful);
      await started.promise;
      try {
        await assertRejects(
          () => model.methods.collect.execute({}, successful),
          Error,
          "already running",
        );
      } finally {
        finish.resolve();
      }
      const result = await retry;
      assertEquals(result.dataHandles.length, 2);
      const summary = model.resources.summary.schema.parse(
        result.dataHandles[0],
      );
      assertEquals(summary.changed, true);
      assertEquals(summary.checkpoints[0].hourlyHazards, ["snow"]);
      assertEquals(summary.checkpoints[0].precipPeakPct, 63);
      assertEquals(
        (await model.methods.collect.execute({}, successful)).dataHandles,
        [],
      );
      assertEquals(JSON.stringify(globalArgs), settings);
      assertEquals(JSON.stringify(logs).includes("PRIVATE LABEL"), false);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await Deno.remove(directory, { recursive: true });
  }
});
