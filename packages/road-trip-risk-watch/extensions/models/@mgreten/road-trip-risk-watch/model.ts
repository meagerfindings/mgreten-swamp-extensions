/**
 * Native route-risk watcher for road trips and other checkpointed routes.
 *
 * The model polls official NWS forecast and active-alert endpoints for each
 * checkpoint, computes a stable risk fingerprint, persists the last fingerprint
 * to a state file, and stays quiet unless the fingerprint changes.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  collect as assessRoutes,
  type Input as AssessmentInput,
  inputSchema as assessmentSchema,
  render as renderAssessment,
  requireWindow,
} from "./assessment.ts";

const DEFAULT_CHECKPOINTS = [
  {
    name: "Indianapolis, IN",
    role: "start",
    lat: 39.7684,
    lon: -86.1581,
  },
  {
    name: "Kansas City, MO",
    role: "overnight-option-a",
    lat: 39.0997,
    lon: -94.5786,
  },
  {
    name: "Salina, KS",
    role: "overnight-option-b",
    lat: 38.8403,
    lon: -97.6114,
  },
  {
    name: "Denver, CO",
    role: "destination",
    lat: 39.7392,
    lon: -104.9903,
  },
] as const;

const HAZARD_KEYWORDS = [
  "snow",
  "ice",
  "icy",
  "freezing rain",
  "sleet",
  "blizzard",
  "whiteout",
  "thunderstorm",
  "tstorm",
  "hail",
  "fog",
  "smoke",
  "dust",
  "blowing snow",
  "high wind",
  "wind",
  "flood",
  "flooding",
] as const;

const RISK_ORDER = {
  Low: 0,
  Moderate: 1,
  High: 2,
} as const;

const SEVERITY_ORDER = {
  minor: 1,
  moderate: 2,
  severe: 3,
  extreme: 4,
} as const;

type RiskLevel = keyof typeof RISK_ORDER;

type Checkpoint = z.infer<typeof CheckpointSchema>;

type CheckpointResult = z.infer<typeof CheckpointResultSchema>;

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const CheckpointSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1).default("checkpoint"),
  lat: z.number(),
  lon: z.number(),
});

const GlobalArgsSchema = z.object({
  tripLabel: z.string().default("Indianapolis IN → Denver CO"),
  statePath: z.string().default(
    "./state/road-trip-risk-watch.json",
  ),
  liveOriginStatePath: z.string().default(
    "./state/road-trip-risk-watch-origin.json",
  ),
  checkpointsJson: z.string().default(
    JSON.stringify(DEFAULT_CHECKPOINTS, null, 2),
  ),
  userAgent: z.string().default("route-risk-watch/1.0"),
});

const AlertSchema = z.object({
  event: z.string(),
  severity: z.string(),
  urgency: z.string(),
  certainty: z.string(),
  headline: z.string(),
});

const CheckpointResultSchema = z.object({
  name: z.string(),
  role: z.string(),
  lat: z.number(),
  lon: z.number(),
  risk: z.enum(["Low", "Moderate", "High"]),
  alerts: z.array(AlertSchema),
  hourlyHazards: z.array(z.string()),
  windPeakMph: z.number().int().nonnegative(),
  precipPeakPct: z.number().int().nonnegative(),
  forecastUrl: z.string(),
  hourlyUrl: z.string(),
  alertUrl: z.string(),
  error: z.string().nullable(),
});

const RouteSummarySchema = z.object({
  tripLabel: z.string(),
  checkedAt: z.string(),
  fingerprint: z.string(),
  overallRisk: z.enum(["Low", "Moderate", "High"]),
  checkpoints: z.array(CheckpointResultSchema),
  changed: z.boolean(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nowIso(): string {
  return new Date().toISOString();
}

function humanTime(isoText: string): string {
  const dt = new Date(isoText);
  return Number.isNaN(dt.getTime())
    ? isoText
    : dt.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as Record<string, unknown>;
  } catch (_error) {
    return {};
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const slash = path.lastIndexOf("/");
  if (slash > 0) {
    await Deno.mkdir(path.slice(0, slash), { recursive: true });
  }
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await Deno.rename(tmp, path);
}

async function fetchJson(
  url: string,
  userAgent: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": userAgent,
      Accept: "application/geo+json, application/json;q=0.9, */*;q=0.1",
      ...headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} for ${url}: ${text.slice(0, 400)}`,
    );
  }
  return text ? JSON.parse(text) : {};
}

async function loadLiveOriginCheckpoint(
  statePath: string,
): Promise<z.infer<typeof CheckpointSchema> | null> {
  const live = await readJsonFile(statePath);
  if (!isRecord(live)) {
    return null;
  }
  const lat = typeof live.lat === "number" && Number.isFinite(live.lat)
    ? live.lat
    : null;
  const lon = typeof live.lon === "number" && Number.isFinite(live.lon)
    ? live.lon
    : null;
  if (lat === null || lon === null) {
    return null;
  }
  const name = typeof live.friendly_name === "string" && live.friendly_name
    ? live.friendly_name
    : typeof live.name === "string" && live.name
    ? live.name
    : "Live origin";
  return CheckpointSchema.parse({
    name,
    role: "start",
    lat,
    lon,
  });
}

async function resolveCheckpoints(
  cfg: z.infer<typeof GlobalArgsSchema>,
): Promise<Array<z.infer<typeof CheckpointSchema>>> {
  const parsedCheckpoints = z.array(CheckpointSchema).safeParse(
    JSON.parse(cfg.checkpointsJson),
  );
  if (!parsedCheckpoints.success) {
    throw new Error(
      `Invalid checkpointsJson: ${parsedCheckpoints.error.message}`,
    );
  }
  const checkpoints = parsedCheckpoints.data;
  if (checkpoints.length === 0) {
    throw new Error("checkpointsJson must contain at least one checkpoint");
  }

  const liveOrigin = await loadLiveOriginCheckpoint(cfg.liveOriginStatePath);
  if (liveOrigin) {
    return [liveOrigin, ...checkpoints.slice(1)];
  }

  return checkpoints;
}

function extractNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value !== "string") {
    return 0;
  }
  const matches = value.match(/\d+/g);
  if (!matches) return 0;
  return Math.max(...matches.map((match) => Number.parseInt(match, 10)));
}

function severityRank(alerts: Array<{ severity: string }>): number {
  let rank = 0;
  for (const alert of alerts) {
    const severity = alert.severity.toLowerCase();
    rank = Math.max(
      rank,
      SEVERITY_ORDER[severity as keyof typeof SEVERITY_ORDER] ?? 0,
    );
  }
  return rank;
}

/** Build a stable fingerprint payload for one checkpoint result. */
export function buildCheckpointFingerprint(
  result: CheckpointResult,
): Record<string, unknown> {
  return {
    name: result.name,
    role: result.role,
    lat: Number(result.lat.toFixed(4)),
    lon: Number(result.lon.toFixed(4)),
    risk: result.risk,
    alerts: result.alerts.map((alert) => ({
      event: alert.event,
      severity: alert.severity,
      urgency: alert.urgency,
      certainty: alert.certainty,
    })),
    hourly_hazards: [...new Set(result.hourlyHazards)].sort(),
    wind_peak_mph: result.windPeakMph,
    precip_peak_pct: result.precipPeakPct,
    error: result.error,
  };
}

/** Return the highest route risk across all checkpoints. */
export function routeOverallRisk(results: CheckpointResult[]): RiskLevel {
  const maxRank = results.reduce((accumulator, result) => {
    return Math.max(accumulator, RISK_ORDER[result.risk]);
  }, 0);
  return (Object.entries(RISK_ORDER).find(([, value]) => value === maxRank)
    ?.[0] ?? "Low") as RiskLevel;
}

/** Classify a checkpoint's risk from alerts, hazards, wind, and precip. */
export function classifyRisk(
  alerts: Array<{ severity: string }>,
  hazards: string[],
  windPeakMph: number,
  precipPeakPct: number,
): RiskLevel {
  let riskScore = 0;
  const alertSeverity = severityRank(alerts);
  if (alertSeverity >= 3) {
    riskScore = 2;
  } else if (alertSeverity >= 2) {
    riskScore = Math.max(riskScore, 1);
  }

  const hazardText = hazards.join(" ");
  if (
    ["snow", "ice", "freezing rain", "sleet", "blizzard"].some((token) =>
      hazardText.includes(token)
    )
  ) {
    riskScore = 2;
  } else if (
    ["thunderstorm", "hail", "fog", "smoke", "dust", "flood"].some((token) =>
      hazardText.includes(token)
    )
  ) {
    riskScore = Math.max(riskScore, 1);
  }

  if (windPeakMph >= 35) {
    riskScore = 2;
  } else if (windPeakMph >= 25) {
    riskScore = Math.max(riskScore, 1);
  }

  if (precipPeakPct >= 70) {
    riskScore = Math.max(riskScore, 1);
  }

  return (Object.entries(RISK_ORDER).find(([, value]) => value === riskScore)
    ?.[0] ?? "Low") as RiskLevel;
}

/** Render the markdown digest for a route-risk summary. */
export function buildDigest(
  summary: z.infer<typeof RouteSummarySchema>,
): string {
  const lines = [
    `# Road-trip risk watch — ${summary.tripLabel}`,
    `Checked at ${humanTime(summary.checkedAt)}`,
    "",
    `Overall risk: **${summary.overallRisk}**`,
    "",
  ];

  const biggest = summary.checkpoints.filter((checkpoint) =>
    checkpoint.risk !== "Low"
  );
  if (biggest.length > 0) {
    lines.push("## Biggest concerns");
    for (const result of biggest) {
      const bits: string[] = [];
      if (result.alerts.length > 0) {
        bits.push(
          result.alerts.slice(0, 3).map((alert) =>
            `${alert.event} (${alert.severity})`
          ).join(", "),
        );
      }
      if (result.hourlyHazards.length > 0) {
        bits.push([...new Set(result.hourlyHazards)].sort().join(", "));
      }
      if (result.windPeakMph > 0) {
        bits.push(`winds peaking near ${result.windPeakMph} mph`);
      }
      if (result.precipPeakPct > 0) {
        bits.push(`precipitation probability up to ${result.precipPeakPct}%`);
      }
      lines.push(
        `- ${result.name}: ${result.risk} — ${
          bits.join("; ") || "risk elevated"
        }`,
      );
    }
    lines.push("");
  } else {
    lines.push(
      "## Biggest concerns",
      "- None right now; sampled checkpoints are quiet.",
      "",
    );
  }

  lines.push("## Checkpoints");
  for (const result of summary.checkpoints) {
    const alertSummary = result.alerts.length > 0
      ? result.alerts.slice(0, 2).map((alert) =>
        `${alert.event} (${alert.severity})`
      ).join(", ")
      : "no active alerts";
    const hazardSummary = result.hourlyHazards.length > 0
      ? [...new Set(result.hourlyHazards)].sort().join(", ")
      : "no notable hourly hazards";
    lines.push(
      `- ${result.name} [${result.role}]: ${result.risk}; ${alertSummary}; ${hazardSummary}; wind ${result.windPeakMph} mph; precip ${result.precipPeakPct}%`,
    );
    if (result.error) {
      lines.push(`  - error: ${result.error}`);
    }
  }

  lines.push(
    "",
    "## Route note",
    "- Tune the checkpoint list if you change your overnight stop or detour plan.",
  );
  return `${lines.join("\n")}\n`;
}

async function analyzeCheckpoint(
  checkpoint: Checkpoint,
  userAgent: string,
): Promise<CheckpointResult> {
  const alertUrl =
    `https://api.weather.gov/alerts/active?point=${checkpoint.lat},${checkpoint.lon}`;
  try {
    const pointDoc = await fetchJson(
      `https://api.weather.gov/points/${checkpoint.lat},${checkpoint.lon}`,
      userAgent,
    );
    const pointProps = isRecord(pointDoc) && isRecord(pointDoc.properties)
      ? pointDoc.properties
      : {};
    const forecastUrl = asString(pointProps.forecast);
    const hourlyUrl = asString(pointProps.forecastHourly);
    const alertsDoc = await fetchJson(alertUrl, userAgent);
    const alertFeatures =
      isRecord(alertsDoc) && Array.isArray(alertsDoc.features)
        ? alertsDoc.features
        : [];
    const alerts = alertFeatures.map((feature) => {
      const props = isRecord(feature) && isRecord(feature.properties)
        ? feature.properties
        : {};
      return {
        event: asString(props.event) || "Unknown",
        severity: asString(props.severity) || "unknown",
        urgency: asString(props.urgency) || "unknown",
        certainty: asString(props.certainty) || "unknown",
        headline: asString(props.headline) || asString(props.instruction) || "",
      };
    });

    const hourlyDoc = await fetchJson(hourlyUrl, userAgent);
    const periods = isRecord(hourlyDoc) && isRecord(hourlyDoc.properties) &&
        Array.isArray(hourlyDoc.properties.periods)
      ? hourlyDoc.properties.periods
      : [];

    const hourlyHazards: string[] = [];
    let windPeakMph = 0;
    let precipPeakPct = 0;
    for (const period of periods.slice(0, 18)) {
      if (!isRecord(period)) continue;
      const periodText = [
        asString(period.shortForecast),
        asString(period.detailedForecast),
      ].join(" ").toLowerCase();
      for (const keyword of HAZARD_KEYWORDS) {
        if (periodText.includes(keyword) && !hourlyHazards.includes(keyword)) {
          hourlyHazards.push(keyword);
        }
      }
      windPeakMph = Math.max(windPeakMph, extractNumber(period.windSpeed));
      const precip = isRecord(period.probabilityOfPrecipitation)
        ? period.probabilityOfPrecipitation
        : {};
      precipPeakPct = Math.max(precipPeakPct, extractNumber(precip.value));
    }

    const risk = classifyRisk(
      alerts,
      hourlyHazards,
      windPeakMph,
      precipPeakPct,
    );
    return {
      name: checkpoint.name,
      role: checkpoint.role,
      lat: checkpoint.lat,
      lon: checkpoint.lon,
      risk,
      alerts,
      hourlyHazards,
      windPeakMph,
      precipPeakPct,
      forecastUrl,
      hourlyUrl,
      alertUrl,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: checkpoint.name,
      role: checkpoint.role,
      lat: checkpoint.lat,
      lon: checkpoint.lon,
      risk: "High",
      alerts: [],
      hourlyHazards: [],
      windPeakMph: 0,
      precipPeakPct: 0,
      forecastUrl: "",
      hourlyUrl: "",
      alertUrl,
      error: message,
    };
  }
}

/** Swamp model for road-trip and route-risk watches. */
export const model = {
  type: "@mgreten/road-trip-risk-watch",
  version: "2026.11.26.1",
  upgrades: [{
    toVersion: "2026.11.26.1",
    description:
      "Add route assessment without changing existing global settings",
    upgradeAttributes: (old: Record<string, unknown>) => old,
  }],
  globalArguments: GlobalArgsSchema,
  resources: {
    assessmentStatus: {
      description:
        "Arrival-hour forecast counts and bounded notification text without coordinates or raw location notes",
      schema: z.object({
        assessmentId: z.uuid(),
        tripDate: z.iso.date(),
        retrievedAt: z.iso.datetime({ offset: true }),
        ok: z.number().int().nonnegative(),
        stale: z.number().int().nonnegative(),
        unknown: z.number().int().nonnegative(),
        hazardCount: z.number().int().nonnegative(),
        summary: z.string().max(3500),
      }),
      lifetime: "7d",
      garbageCollection: 10,
    },
    summary: {
      description: "Structured route-risk summary for changed runs",
      schema: RouteSummarySchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
  },
  files: {
    assessmentData: {
      description:
        "Structured arrival forecasts, manual progress and road-source provenance",
      contentType: "application/json",
      lifetime: "7d",
      garbageCollection: 10,
    },
    assessment: {
      description: "ETA-matched route forecast report",
      contentType: "text/html",
      lifetime: "7d",
      garbageCollection: 10,
    },
    digest: {
      description: "Markdown digest for changed route-risk runs",
      contentType: "text/markdown",
      lifetime: "infinite",
      garbageCollection: 30,
    },
  },
  methods: {
    assess: {
      description:
        "Assess explicitly supplied route checkpoints without changing watcher state",
      arguments: assessmentSchema,
      execute: async (
        args: AssessmentInput,
        context: {
          writeResource: (
            spec: string,
            name: string,
            data: unknown,
          ) => Promise<unknown>;
          createFileWriter: (
            spec: string,
            name: string,
          ) => { writeText: (text: string) => Promise<unknown> };
        },
      ) => {
        const report = await assessRoutes(args);
        requireWindow(args, () => new Date());
        const data = await context.createFileWriter(
          "assessmentData",
          "route-assessment-data",
        )
          .writeText(JSON.stringify(report));
        requireWindow(args, () => new Date());
        const html = await context.createFileWriter(
          "assessment",
          "route-assessment",
        )
          .writeText(renderAssessment(report));
        requireWindow(args, () => new Date());
        const points = report.routes.flatMap((route) => route.checkpoints);
        const time = new Intl.DateTimeFormat("en-US", {
          timeZone: report.displayTimeZone,
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        });
        const hazard =
          /snow|ice|icy|freez|sleet|blizzard|fog|thunder|flood|blowing|wind|dust|smoke/i;
        const lines = report.routes.flatMap((route) => {
          const original = args.routes.find((candidate) =>
            candidate.name === route.name
          )!;
          const excluded = new Set([
            original.checkpoints[0].name,
            original.checkpoints.at(-1)!.name,
            report.manualCheckIn?.checkpoint,
          ]);
          return [
            route.name.replace(/[\r\n\t]/g, " ").slice(0, 60),
            ...route.checkpoints.filter((point) =>
              !excluded.has(point.name) &&
              hazard.test(point.forecast?.shortForecast ?? "")
            ).map((point) =>
              `${point.name.replace(/[\r\n\t]/g, " ").slice(0, 60)}: ${
                point.eta ? time.format(new Date(point.eta)) : "ETA unknown"
              } · ${
                point.forecast
                  ? `${
                    point.forecast.shortForecast.slice(0, 100)
                  } ${point.forecast.temperature}°${point.forecast.temperatureUnit}, wind ${
                    point.forecast.windSpeed.slice(0, 40)
                  }`
                  : "forecast unknown"
              } [${point.status}]`
            ),
          ];
        });
        const summary = [
          "Estimated arrivals, not live routing. Stale forecasts need rechecking. Pavement/restrictions remain incomplete; not a safety clearance.",
          "Hazard-worded interior checkpoints only; omitted points are NOT cleared. Origin, destination and current check-in omitted.",
          ...lines,
        ].join("\n");
        requireWindow(args, () => new Date());
        const status = await context.writeResource(
          "assessmentStatus",
          "route-assessment-status",
          {
            assessmentId: report.assessmentId,
            tripDate: report.tripDate,
            retrievedAt: report.retrievedAt,
            ok: points.filter((point) => point.status === "ok").length,
            stale: points.filter((point) => point.status === "stale").length,
            unknown:
              points.filter((point) => point.status === "unknown").length,
            hazardCount:
              points.filter((point) =>
                hazard.test(point.forecast?.shortForecast ?? "")
              ).length,
            summary: summary.length <= 3500
              ? summary
              : `${
                summary.slice(0, 3450)
              }\n[Truncated; more checkpoints in stored report.]`,
          },
        );
        return {
          dataHandles: [
            data,
            html,
            status,
          ],
        };
      },
    },
    collect: {
      description:
        "Poll NWS route checkpoints, update the fingerprint state file, and emit output only on significant changes",
      arguments: z.object({
        force: z.boolean().default(false),
      }),
      execute: async (
        args: { force?: boolean },
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            spec: string,
            name: string,
            data: unknown,
            overrides?: unknown,
          ) => Promise<unknown>;
          createFileWriter: (
            spec: string,
            name: string,
            overrides?: unknown,
          ) => { writeText: (text: string) => Promise<unknown> };
          logger: {
            info: (
              message: string,
              properties?: Record<string, unknown>,
            ) => void;
          };
        },
      ): Promise<{ dataHandles: unknown[] }> => {
        const cfg = context.globalArgs;
        const slash = cfg.statePath.lastIndexOf("/");
        if (slash > 0) {
          await Deno.mkdir(cfg.statePath.slice(0, slash), { recursive: true });
        }
        // Keep this inode: unlinking a lock file can let two owners lock
        // different files at the same path. Closing releases the OS lock.
        const lock = await Deno.open(`${cfg.statePath}.lock`, {
          create: true,
          write: true,
          mode: 0o600,
        });
        try {
          if (!await lock.tryLock(true)) {
            throw new Error(
              "Route collection already running for this state file",
            );
          }
          const checkpoints = await resolveCheckpoints(cfg);

          const previousState = await readJsonFile(cfg.statePath);
          const previousFingerprint = asString(previousState.fingerprint);
          const checkedAt = nowIso();

          const checkpointResults = await Promise.all(
            checkpoints.map(async (checkpoint) =>
              await analyzeCheckpoint(checkpoint, cfg.userAgent)
            ),
          );
          const overallRisk = routeOverallRisk(checkpointResults);
          const fingerprintPayload = {
            trip_label: cfg.tripLabel,
            overall_risk: overallRisk,
            checkpoints: checkpointResults.map((result) =>
              buildCheckpointFingerprint(result)
            ),
          };
          const fingerprint = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(JSON.stringify(fingerprintPayload)),
          ).then((digest) => {
            return Array.from(
              new Uint8Array(digest),
              (byte) => byte.toString(16).padStart(2, "0"),
            ).join("");
          });
          const changed = args.force ?? false
            ? true
            : fingerprint !== previousFingerprint;

          const statePayload = {
            fingerprint,
            checked_at: checkedAt,
            trip_label: cfg.tripLabel,
            overall_risk: overallRisk,
            checkpoints: checkpointResults.map((result) =>
              buildCheckpointFingerprint(result)
            ),
          };

          if (!changed) {
            await writeJsonFile(cfg.statePath, statePayload);
            context.logger.info("Route risk unchanged", {
              fingerprint,
              overallRisk,
              checkpointCount: checkpointResults.length,
            });
            return { dataHandles: [] };
          }

          const summary = RouteSummarySchema.parse({
            tripLabel: cfg.tripLabel,
            checkedAt,
            fingerprint,
            overallRisk,
            checkpoints: checkpointResults,
            changed,
          });
          const digest = buildDigest(summary);
          context.logger.info("Route risk changed", {
            overallRisk,
            checkpointCount: checkpointResults.length,
          });
          const summaryHandle = await context.writeResource(
            "summary",
            "latestSummary",
            summary,
          );
          const digestHandle = await context.createFileWriter(
            "digest",
            "latestDigest",
          ).writeText(digest);
          await writeJsonFile(cfg.statePath, statePayload);
          return { dataHandles: [summaryHandle, digestHandle] };
        } finally {
          lock.close();
        }
      },
    },
  },
};
