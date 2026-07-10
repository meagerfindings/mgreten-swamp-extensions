import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  buildCheckpointFingerprint,
  buildDigest,
  classifyRisk,
  routeOverallRisk,
} from "./model.ts";

Deno.test("classifyRisk escalates snow and severe alerts", () => {
  assertEquals(classifyRisk([], ["snow"], 10, 20), "High");
  assertEquals(
    classifyRisk([
      { severity: "severe" },
    ], [], 5, 10),
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
