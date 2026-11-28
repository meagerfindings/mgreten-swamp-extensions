/** Bounded NWS checkpoint forecasts. Weather availability is not road safety. */
import { z } from "npm:zod@4";
import { manualCheckInSchema, reanchorRoutes } from "./progress.ts";

const checkpoint = z.object({
  name: z.string().min(1).max(100),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  eta: z.iso.datetime({ offset: true }).optional(),
  offsetMinutes: z.number().int().min(0).max(10080).optional(),
}).strict();
const route = z.object({
  name: z.string().min(1).max(100),
  remainingFrom: z.string().min(1).max(100).optional(),
  checkpoints: z.array(checkpoint).min(1).max(30),
}).strict();
const roadObservation = z.object({
  route: z.string().min(1).max(100),
  checkpoint: z.string().min(1).max(100),
  condition: z.string().min(1).max(600),
  observedAt: z.iso.datetime({ offset: true }),
  sourceUpdatedAt: z.iso.datetime({ offset: true }).optional(),
  sourceTimeText: z.string().min(1).max(160).optional(),
  source: z.enum(["UDOT", "WYDOT", "COtrip", "traveler"]),
  sourceUrl: z.string().url().max(1000),
}).strict().refine(
  (observation) => {
    const url = new URL(observation.sourceUrl);
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.port && !url.hash &&
      (!url.search ||
        (["www.wyoroad.info", "wyoroad.info"].includes(url.hostname) &&
          /^\?SelectedDistrict=[1-5]$/.test(url.search))) &&
      [
        "udottraffic.utah.gov",
        "www.udottraffic.utah.gov",
        "wyoroad.info",
        "www.wyoroad.info",
        "map.wyoroad.info",
        "cotrip.org",
        "www.cotrip.org",
      ]
        .includes(url.hostname);
  },
  "Use an official traveler-page URL without credentials (WYDOT district selector is allowed)",
);
export const inputSchema = z.object({
  tripDate: z.iso.date(),
  displayTimeZone: z.string().max(100).default("UTC").refine((zone) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, "Invalid display time zone"),
  anchorTime: z.iso.datetime({ offset: true }).optional(),
  etaKind: z.enum(["estimated", "routed", "caller-supplied"]),
  etaNote: z.string().max(500).optional(),
  windowStart: z.iso.datetime({ offset: true }).optional(),
  windowEnd: z.iso.datetime({ offset: true }).optional(),
  roadSources: z.array(z.never()).max(0).optional(),
  roadObservations: z.array(roadObservation).max(60).nullish(),
  manualCheckIn: manualCheckInSchema.nullish(),
  routes: z.array(route).min(1).max(8),
}).superRefine((value, ctx) => {
  if (
    !!value.windowStart !== !!value.windowEnd ||
    (value.windowStart && value.windowEnd &&
      Date.parse(value.windowStart) >= Date.parse(value.windowEnd))
  ) {
    ctx.addIssue({
      code: "custom",
      message:
        "windowStart and windowEnd must both be provided in ascending order",
    });
  }
  if (value.routes.reduce((n, r) => n + r.checkpoints.length, 0) > 30) {
    ctx.addIssue({ code: "custom", message: "At most 30 checkpoints total" });
  }
  if (new Set(value.routes.map((r) => r.name)).size !== value.routes.length) {
    ctx.addIssue({ code: "custom", message: "Route names must be unique" });
  }
  for (const observation of value.roadObservations ?? []) {
    const matching = value.routes.find((r) => r.name === observation.route);
    if (!matching?.checkpoints.some((p) => p.name === observation.checkpoint)) {
      ctx.addIssue({
        code: "custom",
        message: "Road observation checkpoint not found on route",
      });
    }
  }
  for (const r of value.routes) {
    if (
      new Set(r.checkpoints.map((p) => p.name)).size !== r.checkpoints.length
    ) {
      ctx.addIssue({
        code: "custom",
        message: `Duplicate checkpoint in ${r.name}`,
      });
    }
    if (
      r.remainingFrom && !r.checkpoints.some((p) => p.name === r.remainingFrom)
    ) {
      ctx.addIssue({
        code: "custom",
        message: `remainingFrom not found in ${r.name}`,
      });
    }
    if (
      !value.anchorTime && !value.manualCheckIn &&
      r.checkpoints.some((p) => p.offsetMinutes !== undefined && !p.eta)
    ) {
      ctx.addIssue({ code: "custom", message: "Offsets require anchorTime" });
    }
  }
});
export type Input = z.input<typeof inputSchema>;
export class WindowClosed extends Error {}
export function requireWindow(
  input: Pick<Input, "windowStart" | "windowEnd">,
  now: () => Date,
): number {
  if (!input.windowStart || !input.windowEnd) return 12000;
  const time = now().getTime();
  const end = Date.parse(input.windowEnd);
  if (
    !Number.isFinite(time) || time < Date.parse(input.windowStart) ||
    time >= end
  ) throw new WindowClosed("Assessment window closed");
  return Math.min(12000, end - time);
}
type Period = {
  startTime: string;
  endTime: string;
  temperature: number;
  temperatureUnit: string;
  windSpeed: string;
  shortForecast: string;
};
type Sample = {
  name: string;
  lat: number;
  lon: number;
  eta: string | null;
  status: "ok" | "stale" | "unknown";
  retrievedAt: string;
  updatedAt: string | null;
  forecast: Period | null;
  error: string | null;
};

async function getJson(
  url: string,
  fetcher: typeof fetch,
  timeout: number,
): Promise<unknown> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" || parsed.hostname !== "api.weather.gov" ||
    parsed.port || parsed.username || parsed.password
  ) throw new Error("Untrusted NWS URL");
  const response = await fetcher(parsed, {
    headers: {
      "User-Agent": "route-weather/1.0",
      Accept: "application/geo+json",
    },
    signal: AbortSignal.timeout(timeout),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`NWS HTTP ${response.status}`);
  const body = await response.text();
  if (body.length > 2_000_000) throw new Error("NWS response too large");
  return JSON.parse(body);
}
const pointsResponse = z.object({
  properties: z.object({ forecastHourly: z.string().url() }),
});
const hourlyResponse = z.object({
  properties: z.object({
    updateTime: z.string().nullable().optional(),
    periods: z.array(
      z.object({
        startTime: z.string(),
        endTime: z.string(),
        temperature: z.number(),
        temperatureUnit: z.string(),
        windSpeed: z.string(),
        shortForecast: z.string(),
      }),
    ).max(200),
  }),
});

export async function collect(
  input: Input,
  fetcher: typeof fetch = fetch,
  now: () => Date = () => new Date(),
) {
  const args = inputSchema.parse(input);
  requireWindow(args, now);
  const selectedRoutes = args.manualCheckIn
    ? reanchorRoutes(args.routes, args.manualCheckIn, now)
    : args.routes;
  const responseCache = new Map<string, unknown>();
  const boundedJson = async (url: string) => {
    const cached = responseCache.get(url);
    if (cached !== undefined) return cached;
    const result = await getJson(url, fetcher, requireWindow(args, now));
    responseCache.set(url, result);
    return result;
  };
  const cache = new Map<string, Promise<Sample>>();
  async function sample(point: z.infer<typeof checkpoint>): Promise<Sample> {
    const eta = point.eta ??
      (point.offsetMinutes !== undefined && args.anchorTime
        ? new Date(Date.parse(args.anchorTime) + point.offsetMinutes * 60000)
          .toISOString()
        : null);
    const base: Sample = {
      name: point.name,
      lat: point.lat,
      lon: point.lon,
      eta,
      status: "unknown",
      retrievedAt: now().toISOString(),
      updatedAt: null,
      forecast: null,
      error: null,
    };
    if (!eta) return { ...base, error: "ETA not supplied" };
    try {
      const p = pointsResponse.parse(
        await boundedJson(
          `https://api.weather.gov/points/${point.lat.toFixed(4)},${
            point.lon.toFixed(4)
          }`,
        ),
      );
      const hourly = hourlyResponse.parse(
        await boundedJson(p.properties.forecastHourly),
      );
      const updatedAt = hourly.properties.updateTime ?? null;
      const forecast = hourly.properties.periods.find((period) =>
        Date.parse(period.startTime) <= Date.parse(eta) &&
        Date.parse(eta) < Date.parse(period.endTime)
      ) ?? null;
      const age = updatedAt
        ? Date.parse(base.retrievedAt) - Date.parse(updatedAt)
        : NaN;
      const stale = !Number.isFinite(age) || age < -300000 || age > 21600000;
      return {
        ...base,
        updatedAt,
        forecast,
        status: !forecast ? "unknown" : stale ? "stale" : "ok",
        error: !forecast
          ? "No matching forecast hour"
          : stale
          ? "Source update missing, invalid, old, or in the future"
          : null,
      };
    } catch (error) {
      if (error instanceof WindowClosed) throw error;
      return {
        ...base,
        error: error instanceof Error
          ? error.message.slice(0, 160)
          : "NWS request failed",
      };
    }
  }
  const routes: {
    name: string;
    checkpoints: Sample[];
    totalCheckpoints: number;
    reachedCheckpoints: number;
  }[] = [];
  for (const route of selectedRoutes) {
    const start = route.remainingFrom
      ? route.checkpoints.findIndex((p) => p.name === route.remainingFrom)
      : 0;
    const checkpoints: Sample[] = [];
    for (const point of route.checkpoints.slice(start)) {
      const key = JSON.stringify(point);
      if (!cache.has(key)) cache.set(key, sample(point));
      checkpoints.push(await cache.get(key)!);
    }
    const original = args.routes.find((r) => r.name === route.name)!;
    const reachedCheckpoints = route.remainingFrom
      ? original.checkpoints.findIndex((p) => p.name === route.remainingFrom) +
        1
      : 0;
    routes.push({
      name: route.name,
      checkpoints,
      totalCheckpoints: original.checkpoints.length,
      reachedCheckpoints,
    });
  }
  return {
    assessmentId: crypto.randomUUID(),
    tripDate: args.tripDate,
    displayTimeZone: args.displayTimeZone,
    anchorTime: args.manualCheckIn?.observedAt ?? args.anchorTime ?? null,
    etaKind: args.manualCheckIn ? "estimated" : args.etaKind,
    etaNote: args.manualCheckIn
      ? `Manual checkpoint check-in at ${args.manualCheckIn.checkpoint}. Remaining offsets rebased; downstream delay ${
        args.manualCheckIn.delayMinutes ?? 0
      } minutes. No live routing, GPS tracking or winter-delay prediction. ${
        args.etaNote ?? ""
      }`
      : args.etaNote ?? null,
    manualCheckIn: args.manualCheckIn ?? null,
    retrievedAt: now().toISOString(),
    roadConditions: null,
    roadObservations: (args.roadObservations ?? []).filter((observation) =>
      routes.some((r) =>
        r.name === observation.route &&
        r.checkpoints.some((p) => p.name === observation.checkpoint)
      )
    ).map((observation) => {
      const age = now().getTime() - Date.parse(observation.observedAt);
      const sourceAge = observation.sourceUpdatedAt
        ? now().getTime() - Date.parse(observation.sourceUpdatedAt)
        : observation.source === "traveler"
        ? age
        : NaN;
      return {
        ...observation,
        status: Number.isFinite(age) && age >= 0 && age <= 3600000 &&
            Number.isFinite(sourceAge) && sourceAge >= 0 && sourceAge <= 3600000
          ? "recent" as const
          : "stale or unknown" as const,
      };
    }),
    routes,
  };
}

function escape(s: string) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  ).replaceAll('"', "&quot;");
}
export function render(report: Awaited<ReturnType<typeof collect>>) {
  const time = (value: string | null) =>
    value && Number.isFinite(Date.parse(value))
      ? new Intl.DateTimeFormat("en-US", {
        timeZone: report.displayTimeZone,
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date(value))
      : "unknown";
  const weatherColor = (p: Sample) =>
    !p.forecast || p.status !== "ok"
      ? "#a8b4c2"
      : /snow|ice|icy|freez|sleet|blizzard|fog|thunder|flood|blowing|wind|dust|smoke/i
          .test(
            p.forecast.shortForecast,
          )
      ? "#ffba59"
      : "#77c9ff";
  const points = report.routes.flatMap((r) => r.checkpoints);
  const minLon = Math.min(...points.map((p) => p.lon));
  const maxLon = Math.max(...points.map((p) => p.lon));
  const minLat = Math.min(...points.map((p) => p.lat));
  const maxLat = Math.max(...points.map((p) => p.lat));
  const project = (p: Sample) => [
    30 + (p.lon - minLon) / Math.max(maxLon - minLon, 0.01) * 840,
    30 + (maxLat - p.lat) / Math.max(maxLat - minLat, 0.01) * 340,
  ];
  const colors = [
    "#ffba59",
    "#77c9ff",
    "#e7a3ff",
    "#f38d9b",
    "#a4ccff",
    "#ded080",
    "#d4c0ea",
    "#fba68b",
  ];
  const pointKey = (p: Sample) => JSON.stringify([p.name, p.lat, p.lon]);
  const unique = [...new Map(points.map((p) => [pointKey(p), p])).values()];
  const numbers = new Map(unique.map((p, i) => [pointKey(p), i + 1]));
  const paths = report.routes.map((route, i) => {
    const path = route.checkpoints.map((p) => project(p).join(",")).join(" ");
    return `<polyline points="${path}" fill="none" stroke="${
      colors[i]
    }" stroke-width="3"/>`;
  }).join("");
  const markers = unique.map((p) => {
    const [x, y] = project(p);
    const number = numbers.get(pointKey(p));
    const appearances = report.routes.flatMap((r, ri) =>
      r.checkpoints
        .filter((other) => pointKey(other) === pointKey(p)).map((other) => ({
          ...other,
          route: r.name,
          ri,
        }))
    );
    const markerColors = appearances.map(weatherColor);
    const color = markerColors.includes("#ffba59")
      ? "#ffba59"
      : markerColors.includes("#a8b4c2")
      ? "#a8b4c2"
      : "#77c9ff";
    const observed = report.roadObservations.some((o) =>
      o.checkpoint === p.name && o.status === "recent"
    );
    const current = report.manualCheckIn?.checkpoint === p.name;
    return `<a href="#point-${number}-route-${appearances[0].ri}" aria-label="${
      escape(p.name)
    } forecast and road observations"><g>${
      observed
        ? `<circle cx="${x}" cy="${y}" r="16" fill="none" stroke="#f38d9b" stroke-width="3"/>`
        : ""
    }${
      current
        ? `<circle cx="${x}" cy="${y}" r="21" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="3 2"/>`
        : ""
    }<circle cx="${x}" cy="${y}" r="10" fill="${color}" stroke="#172536" stroke-width="2"/><text x="${x}" y="${
      y + 3.5
    }" text-anchor="middle" fill="#172536" font-size="10" font-weight="700">${number}</text><title>${
      escape(p.name)
    } · ${
      escape(
        appearances.map((a) =>
          `${a.route}: ${a.forecast?.shortForecast ?? "forecast unknown"} · ${
            time(a.eta)
          } · ${a.status}`
        ).join(" / "),
      )
    }${
      observed ? " · road observation available" : " · pavement unknown"
    }</title></g></a>`;
  }).join("");
  const legend = report.routes.map((route, i) =>
    `<li><span style="color:${colors[i]}">●</span> ${escape(route.name)}</li>`
  ).join("");
  const rows = report.routes.map((r, ri) =>
    `<section><h2><span style="color:${colors[ri]}">●</span> ${
      escape(r.name)
    }</h2>${
      r.reachedCheckpoints
        ? `<p>Checkpoint progress: ${r.reachedCheckpoints} of ${r.totalCheckpoints} reached · latest ${
          escape(r.checkpoints[0].name)
        }</p><progress value="${r.reachedCheckpoints}" max="${r.totalCheckpoints}" aria-label="${
          escape(r.name)
        } checkpoints reached" style="width:100%;height:1.1rem;accent-color:${
          colors[ri]
        }"></progress><p class="meta">Checkpoint count, not distance or time completed. Latest checkpoint stays in the list for context; estimates start from the check-in time.</p>`
        : `<p class="meta">Planning view · no current position supplied</p>`
    }<div class="cards">${
      r.checkpoints.map((p) =>
        `<article id="point-${
          numbers.get(pointKey(p))
        }-route-${ri}"><header><strong>${numbers.get(pointKey(p))}. ${
          escape(p.name)
        }</strong><span class="badge">${
          escape(time(p.eta))
        }</span></header><p class="forecast" style="border-color:${
          weatherColor(p)
        }">${
          escape(
            p.forecast
              ? `${p.forecast.shortForecast} · ${p.forecast.temperature}°${p.forecast.temperatureUnit} · wind ${p.forecast.windSpeed}`
              : "forecast unknown",
          )
        }</p><p class="meta">NWS ${p.status} · updated ${
          escape(time(p.updatedAt))
        }${
          p.forecast
            ? ` · valid ${escape(time(p.forecast.startTime))}–${
              escape(time(p.forecast.endTime))
            }`
            : ""
        }</p>${
          report.roadObservations.filter((o) =>
            o.route === r.name && o.checkpoint === p.name
          ).map((o) =>
            `<p class="road"><strong>Current road report · ${
              escape(o.status)
            }</strong><br>${escape(o.condition)}<br><a href="${
              escape(o.sourceUrl)
            }" target="_blank" rel="noreferrer">${
              escape(o.source)
            }</a> · inspected ${escape(time(o.observedAt))} · source report ${
              escape(
                o.sourceUpdatedAt
                  ? time(o.sourceUpdatedAt)
                  : o.sourceTimeText ?? (o.source === "traveler"
                    ? "firsthand observation"
                    : "time/zone unknown"),
              )
            } · manually supplied, not an arrival forecast</p>`
          ).join("") ||
          `<p class="meta">Pavement / restrictions: unknown. Check official DOT source.</p>`
        }<details><summary>Source details</summary><p>${
          escape(p.error ?? "NWS hourly forecast; not road-surface data")
        }</p><p>Retrieved ${escape(p.retrievedAt)} · source update ${
          escape(p.updatedAt ?? "unknown")
        } · ETA ${escape(p.eta ?? "unknown")}</p></details></article>`
      ).join("")
    }</div></section>`
  ).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="assessment-id" content="${
    escape(report.assessmentId)
  }"><meta name="viewport" content="width=device-width"><title>Route weather</title><style>*{box-sizing:border-box}body{font:16px system-ui;max-width:72rem;margin:auto;padding:1.2rem;background:#101a29;color:#f1f5f9;line-height:1.5}h1{font-size:2rem;margin-bottom:.4rem}h2{margin-top:2rem}p{overflow-wrap:anywhere}a{color:#9cdaff}li{margin:.5em 0}\
.notice{padding:1rem;border:1px solid #aa8246;border-radius:12px;background:#30291e}.meta,details{font-size:.85rem;color:#c2ccda}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:1rem}article{background:#1c2b3e;border:1px solid #3a4f67;border-radius:12px;padding:1rem;scroll-margin-top:1rem}article:target{outline:3px solid #77c9ff}\
article header{display:flex;gap:.6rem;justify-content:space-between;flex-wrap:wrap}.badge{font-size:.85rem;font-weight:600;color:#d5e7f9}.forecast{border-left:4px solid;padding-left:.7rem;font-weight:600}.road{border-top:1px solid #67778e;padding-top:.7rem}.legend{display:flex;gap:1.2rem;flex-wrap:wrap;list-style:none;padding:0}svg{width:100%;min-height:220px;background:#26394e;border:1px solid #476079;border-radius:12px}\
summary{cursor:pointer;min-height:30px}@media(max-width:500px){body{padding:.8rem}h1{font-size:1.6rem}}</style><h1>Weather ahead · route comparison</h1><p class="meta">Snapshot ${
    escape(time(report.retrievedAt))
  } · ${
    escape(report.retrievedAt)
  }. This saved report does not update itself.</p><p>Trip ${
    escape(report.tripDate)
  } · anchor ${escape(time(report.anchorTime))} · ETA type ${
    escape(report.etaKind)
  } · ${
    escape(report.etaNote ?? "No ETA assumptions supplied")
  }</p><p class="notice">A forecast is not a safety clearance. Unknown or stale road data means you still need an official road check. Forecasts do not predict pavement, plowing or traction restrictions.</p>\
<nav><a href="https://udottraffic.utah.gov/" target="_blank" rel="noreferrer">Utah 511</a> · <a href="https://www.wyoroad.info/" target="_blank" rel="noreferrer">Wyoming 511</a> · <a href="https://www.cotrip.org/" target="_blank" rel="noreferrer">Colorado COtrip</a></nav>\
<details><summary>Automated road-source coverage</summary><p>No automated road conditions collected. Road conditions are unknown unless a separately inspected observation is supplied below. NWS point forecasts can differ from road elevation and conditions. Winter-driving and traction-law layers are not collected.</p></details>${rows}\
<details><summary>Optional checkpoint overview map</summary><p class="meta">Schematic straight-line checkpoint map, not road geometry or navigation. Tap a number for details. Lines identify routes, not road safety. Dot: amber = forecast hazard wording; blue = no flagged wording (not safe); gray = stale/unknown. \
Pink ring = recent manually supplied road observation, not clear-road status. Dashed white ring = manual check-in.</p><ul class="legend">${legend}</ul><svg viewBox="0 0 900 400" role="img" aria-label="Schematic checkpoint map with arrival forecasts and separate road observation rings">${paths}${markers}</svg></details></html>`;
}
