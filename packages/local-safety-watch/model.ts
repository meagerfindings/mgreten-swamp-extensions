/**
 * Generic, privacy-preserving local safety watcher.
 *
 * Sensitive coordinates are method inputs only. State and output retain only
 * controlled anchor labels and coarse distance buckets.
 * @module
 */
import { z } from "npm:zod@4";

const SOURCE_NAMES = ["nws", "cotrip", "inciweb"] as const;
type SourceName = typeof SOURCE_NAMES[number];
type ChangeAction = "new" | "updated" | "escalated" | "cleared";
type Severity = "info" | "minor" | "moderate" | "major" | "extreme";

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  minor: 1,
  moderate: 2,
  major: 3,
  extreme: 4,
};
const SAFE_ANCHOR_LABEL = /^(home|phone-[1-9][0-9]*|local-area-[1-9][0-9]*)$/;
const CheckpointSchema = z.object({
  label: z.string().regex(SAFE_ANCHOR_LABEL),
  lat: z.number().finite().gte(-90).lte(90),
  lon: z.number().finite().gte(-180).lte(180),
  radiusMiles: z.number().finite().positive().max(100),
}).strict();
type Checkpoint = z.infer<typeof CheckpointSchema>;

const SourceStateSchema = z.object({
  lastSuccessfulAt: z.string().datetime().nullable(),
  lastAttemptAt: z.string().datetime().nullable(),
  errorCode: z.string().nullable(),
}).strict();
const StoredEventSchema = z.object({
  contentKey: z.string(),
  category: z.string(),
  severity: z.enum(["info", "minor", "moderate", "major", "extreme"]),
  headline: z.string(),
  anchorLabels: z.array(z.string().regex(SAFE_ANCHOR_LABEL)),
  distanceBucket: z.string().nullable(),
  source: z.enum(SOURCE_NAMES),
  identityHash: z.string(),
  missingAuthoritativePolls: z.number().int().nonnegative(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
}).strict();
const StoredChangeSchema = z.object({
  action: z.enum(["new", "updated", "escalated", "cleared"]),
  event: z.object({
    source: z.enum(SOURCE_NAMES),
    category: z.string(),
    severity: z.enum(["info", "minor", "moderate", "major", "extreme"]),
    headline: z.string(),
    anchorLabels: z.array(z.string().regex(SAFE_ANCHOR_LABEL)),
    distanceBucket: z.string().nullable(),
  }).strict(),
}).strict();
const WatchStateSchema = z.object({
  events: z.record(z.string(), StoredEventSchema),
  sources: z.partialRecord(z.enum(SOURCE_NAMES), SourceStateSchema),
  pending: z.array(StoredChangeSchema).nullable(),
}).strict();
/** Persisted, redacted lifecycle state for a local safety watcher. */
export type WatchState = z.infer<typeof WatchStateSchema>;

/** A normalized provider event; raw locations must not be persisted. */
export type NormalizedSafetyEvent = {
  /** Official provider that supplied the observation. */
  source: SourceName;
  sourceEventId: string | null;
  sourceRevision: string | null;
  category: string;
  severity: Severity;
  status: "active";
  headline: string;
  effectiveAt: string | null;
  expiresAt: string | null;
  anchorLabels: string[];
  distanceBucket: string | null;
};
/** A lifecycle transition to notify or retain in the outbox. */
export type WatchChange = {
  action: ChangeAction;
  event: NormalizedSafetyEvent;
};
/** Reconciled persisted state plus the material transitions from one poll. */
export type Reconciliation = { state: WatchState; changes: WatchChange[] };

const GlobalArgsSchema = z.object({
  userAgent: z.string().min(1).max(160).default("local-safety-watch/1.0"),
  enabledSourcesJson: z.string().default(JSON.stringify(SOURCE_NAMES)),
  cotripMinimumPollSeconds: z.number().int().min(120).default(120),
  inciwebMinimumPollSeconds: z.number().int().min(300).default(600),
}).strict();
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
const CollectArgsSchema = z.object({
  checkpointsJson: z.string().min(2),
  statePath: z.string().min(1).max(4096),
  forcePoll: z.boolean().default(false),
});
type CollectArgs = z.infer<typeof CollectArgsSchema>;

const SummarySchema = z.object({
  checkedAt: z.string().datetime(),
  changed: z.boolean(),
  changes: z.array(StoredChangeSchema),
  staleSources: z.array(z.enum(SOURCE_NAMES)),
}).strict();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function optionalText(value: unknown): string | null {
  const valueText = text(value);
  return valueText || null;
}
function nowIso(): string {
  return new Date().toISOString();
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`;
  if (isRecord(value)) {
    return `{${
      Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${canonical(value[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}
async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(value)),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
function redactHeadline(value: string): string {
  return value
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(
      /[-+]?\d{1,2}\.\d{3,}\s*,\s*[-+]?\d{1,3}\.\d{3,}/g,
      "[coordinates]",
    )
    .replace(/\s+/g, " ").trim().slice(0, 240) || "Official safety event";
}
/** Convert uncontrolled provider text into a location-free display category. */
export function safeDisplayHeadline(
  _source: SourceName,
  category: string,
  _providerText: string,
): string {
  switch (category) {
    case "road-closure":
      return "Official road closure";
    case "traffic-crash":
      return "Official traffic incident";
    case "wildfire":
      return "Official wildfire incident";
    case "flash-flood":
      return "Official flash-flood alert";
    case "air-quality":
      return "Official air-quality alert";
    default:
      return "Official weather alert";
  }
}
function severityFromNws(value: string): Severity {
  switch (value.toLowerCase()) {
    case "extreme":
      return "extreme";
    case "severe":
      return "major";
    case "moderate":
      return "moderate";
    case "minor":
      return "minor";
    default:
      return "moderate";
  }
}
function severityFromText(value: string): Severity {
  if (/closed|fatal|extreme|emergency|evacuat/i.test(value)) return "major";
  if (/crash|collision|incident|fire|flood|warning|restriction/i.test(value)) {
    return "moderate";
  }
  return "minor";
}
function categoryFromText(value: string): string {
  if (/closure|closed/i.test(value)) return "road-closure";
  if (/crash|collision|incident/i.test(value)) return "traffic-crash";
  if (/wildfire|fire/i.test(value)) return "wildfire";
  if (/flood/i.test(value)) return "flash-flood";
  if (/smoke|air quality/i.test(value)) return "air-quality";
  return "weather";
}
function haversineMiles(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(a));
}
function distanceBucket(miles: number): string {
  if (miles < 1) return "under 1 mi";
  if (miles < 5) return "1-5 mi";
  if (miles < 10) return "5-10 mi";
  return "nearby";
}
function geometryPoints(value: unknown): Array<[number, number]> {
  if (!isRecord(value)) return [];
  const result: Array<[number, number]> = [];
  const visit = (node: unknown, depth = 0): void => {
    if (depth > 8 || result.length >= 500) return;
    if (
      Array.isArray(node) && node.length >= 2 && typeof node[0] === "number" &&
      typeof node[1] === "number"
    ) {
      result.push([node[0], node[1]]);
      return;
    }
    if (Array.isArray(node)) node.forEach((item) => visit(item, depth + 1));
  };
  visit(value.coordinates);
  return result;
}
function matchGeometry(
  checkpoints: Checkpoint[],
  geometries: unknown[],
): { labels: string[]; bucket: string | null } {
  const points = geometries.flatMap(geometryPoints);
  if (!points.length) return { labels: [], bucket: null };
  const matches = checkpoints.flatMap((checkpoint) => {
    const nearest = Math.min(
      ...points.map(([lon, lat]) =>
        haversineMiles(checkpoint.lat, checkpoint.lon, lat, lon)
      ),
    );
    return nearest <= checkpoint.radiusMiles
      ? [{ label: checkpoint.label, distance: nearest }]
      : [];
  });
  return {
    labels: matches.map((match) => match.label).sort(),
    bucket: matches.length
      ? distanceBucket(Math.min(...matches.map((match) => match.distance)))
      : null,
  };
}
function bucketRank(value: string | null): number {
  return value === "under 1 mi"
    ? 0
    : value === "1-5 mi"
    ? 1
    : value === "5-10 mi"
    ? 2
    : 3;
}
async function identityFor(event: NormalizedSafetyEvent): Promise<string> {
  // NWS can revise presentation text, effective/expiry timestamps, and alert
  // ordering without withdrawing the official alert. Reconcile only by its
  // canonical ID, so clearance requires authoritative omission of that ID.
  if (event.source === "nws") {
    if (!event.sourceEventId) {
      throw new Error("nws-alert-missing-canonical-id");
    }
    return await hash({ source: event.source, id: event.sourceEventId });
  }
  const id = event.sourceEventId ??
    `${event.category}:${redactHeadline(event.headline)}`;
  return await hash({ source: event.source, id });
}
async function contentKeyFor(event: NormalizedSafetyEvent): Promise<string> {
  return await hash({
    category: event.category,
    severity: event.severity,
    headline: redactHeadline(event.headline),
    effectiveAt: event.effectiveAt,
    expiresAt: event.expiresAt,
    anchorLabels: [...event.anchorLabels].sort(),
    distanceBucket: event.distanceBucket,
  });
}
function safeEvent(event: NormalizedSafetyEvent) {
  return {
    source: event.source,
    category: event.category,
    severity: event.severity,
    headline: safeDisplayHeadline(event.source, event.category, event.headline),
    anchorLabels: [...new Set(event.anchorLabels)].sort(),
    distanceBucket: event.distanceBucket,
  };
}

/** Merge duplicate provider records while preserving logical anchors only. */
export async function mergeEvents(
  events: NormalizedSafetyEvent[],
): Promise<NormalizedSafetyEvent[]> {
  const merged = new Map<string, NormalizedSafetyEvent>();
  for (const event of events) {
    const key = await identityFor(event);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...event,
        headline: redactHeadline(event.headline),
        anchorLabels: [...new Set(event.anchorLabels)].sort(),
      });
      continue;
    }
    const nearest =
      bucketRank(event.distanceBucket) < bucketRank(existing.distanceBucket)
        ? event.distanceBucket
        : existing.distanceBucket;
    merged.set(key, {
      ...existing,
      severity: SEVERITY_RANK[event.severity] > SEVERITY_RANK[existing.severity]
        ? event.severity
        : existing.severity,
      anchorLabels: [
        ...new Set([...existing.anchorLabels, ...event.anchorLabels]),
      ].sort(),
      distanceBucket: nearest,
    });
  }
  return [...merged.values()];
}

/** Reconcile active official events. Only successful authoritative polls can clear state. */
export async function reconcileEvents(
  previous: WatchState,
  rawEvents: NormalizedSafetyEvent[],
  options: { authoritativeSources?: SourceName[]; now?: string } = {},
): Promise<Reconciliation> {
  const checkedAt = options.now ?? nowIso();
  const state = structuredClone(previous);
  const changes: WatchChange[] = [];
  const events = await mergeEvents(rawEvents);
  const authoritative = new Set(options.authoritativeSources ?? SOURCE_NAMES);
  const seen = new Map<SourceName, Set<string>>();
  for (const event of events) {
    const identity = await identityFor(event);
    const contentKey = await contentKeyFor(event);
    const sourceSeen = seen.get(event.source) ?? new Set<string>();
    sourceSeen.add(identity);
    seen.set(event.source, sourceSeen);
    const existing = state.events[identity];
    if (!existing) {
      state.events[identity] = {
        contentKey,
        category: event.category,
        severity: event.severity,
        headline: safeDisplayHeadline(
          event.source,
          event.category,
          event.headline,
        ),
        anchorLabels: [...new Set(event.anchorLabels)].sort(),
        distanceBucket: event.distanceBucket,
        source: event.source,
        identityHash: identity,
        missingAuthoritativePolls: 0,
        firstSeenAt: checkedAt,
        lastSeenAt: checkedAt,
      };
      changes.push({ action: "new", event });
      continue;
    }
    const escalated =
      SEVERITY_RANK[event.severity] > SEVERITY_RANK[existing.severity];
    if (existing.contentKey !== contentKey) {
      changes.push({ action: escalated ? "escalated" : "updated", event });
    }
    state.events[identity] = {
      ...existing,
      contentKey,
      category: event.category,
      severity: event.severity,
      headline: safeDisplayHeadline(
        event.source,
        event.category,
        event.headline,
      ),
      anchorLabels: [...new Set(event.anchorLabels)].sort(),
      distanceBucket: event.distanceBucket,
      missingAuthoritativePolls: 0,
      lastSeenAt: checkedAt,
    };
  }
  for (const [identity, stored] of Object.entries(state.events)) {
    if (
      !authoritative.has(stored.source) ||
      seen.get(stored.source)?.has(identity)
    ) continue;
    const misses = stored.missingAuthoritativePolls + 1;
    if (misses < 2) {
      state.events[identity] = { ...stored, missingAuthoritativePolls: misses };
      continue;
    }
    changes.push({
      action: "cleared",
      event: {
        source: stored.source,
        sourceEventId: null,
        sourceRevision: null,
        category: stored.category,
        severity: stored.severity,
        status: "active",
        headline: stored.headline,
        effectiveAt: null,
        expiresAt: null,
        anchorLabels: stored.anchorLabels,
        distanceBucket: stored.distanceBucket,
      },
    });
    delete state.events[identity];
  }
  return { state, changes };
}
/** Render no coordinates, URLs, raw IDs, or caller-supplied labels. */
export function renderDigest(changes: WatchChange[]): string {
  return `${
    [
      "# Local safety watch",
      "",
      ...changes.map((change) =>
        `- **${change.action.toUpperCase()}** — ${
          safeDisplayHeadline(
            change.event.source,
            change.event.category,
            change.event.headline,
          )
        }${
          change.event.anchorLabels.length
            ? ` near ${change.event.anchorLabels.join(" and ")}`
            : ""
        }${
          change.event.distanceBucket ? ` (${change.event.distanceBucket})` : ""
        }; ${change.event.source}`
      ),
    ].join("\n")
  }\n`;
}
function errorCode(error: unknown): string {
  return error instanceof Error && /^HTTP (429|5\d\d)$/.test(error.message)
    ? "transient-http"
    : "source-failed";
}
async function fetchJson(
  url: string,
  userAgent: string,
  init: RequestInit = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent": userAgent,
        Accept: "application/geo+json, application/json;q=0.9",
        ...(init.headers ?? {}),
      },
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (body.length > 2_000_000) throw new Error("response-too-large");
    return body ? JSON.parse(body) : {};
  } finally {
    clearTimeout(timer);
  }
}
async function collectNws(
  checkpoints: Checkpoint[],
  userAgent: string,
): Promise<NormalizedSafetyEvent[]> {
  const output: NormalizedSafetyEvent[] = [];
  for (const checkpoint of checkpoints.slice(0, 5)) {
    const document = await fetchJson(
      `https://api.weather.gov/alerts/active?point=${checkpoint.lat},${checkpoint.lon}`,
      userAgent,
    );
    const features = isRecord(document) && Array.isArray(document.features)
      ? document.features.slice(0, 100)
      : null;
    if (!features) throw new Error("invalid-nws-response");
    for (const feature of features) {
      const properties = isRecord(feature) && isRecord(feature.properties)
        ? feature.properties
        : null;
      if (!properties) continue;
      const headline = text(properties.headline) || text(properties.event) ||
        "Official weather alert";
      output.push({
        source: "nws",
        sourceEventId: optionalText(properties.id),
        sourceRevision: optionalText(properties.sent),
        category: categoryFromText(`${text(properties.event)} ${headline}`),
        severity: severityFromNws(text(properties.severity)),
        status: "active",
        headline,
        effectiveAt: optionalText(properties.effective),
        expiresAt: optionalText(properties.expires),
        anchorLabels: [checkpoint.label],
        distanceBucket: null,
      });
    }
  }
  return output;
}
async function collectCotrip(
  checkpoints: Checkpoint[],
  userAgent: string,
): Promise<NormalizedSafetyEvent[]> {
  const payload = {
    query:
      "query CriticalEvents($layerSlugs: [String!]!, $maxPriority: Int) { dashboardQuery { collections(layerSlugs: $layerSlugs, maxPriority: $maxPriority) { ... on Event { uri title description icon lastUpdated { timestamp timezone } features { id geometry properties } } } } }",
    variables: { layerSlugs: ["roadClosures", "roadReports"], maxPriority: 1 },
  };
  const document = await fetchJson(
    "https://maps.cotrip.org/api/graphql",
    userAgent,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (
    !isRecord(document) || Array.isArray(document.errors) ||
    !isRecord(document.data) || !isRecord(document.data.dashboardQuery) ||
    !Array.isArray(document.data.dashboardQuery.collections)
  ) throw new Error("invalid-cotrip-response");
  return document.data.dashboardQuery.collections.slice(0, 200).flatMap(
    (item): NormalizedSafetyEvent[] => {
      if (!isRecord(item)) return [];
      const features = Array.isArray(item.features)
        ? item.features.filter(isRecord)
        : [];
      const match = matchGeometry(
        checkpoints,
        features.map((feature) => feature.geometry),
      );
      if (!match.labels.length) return [];
      const title = text(item.title) || "Official roadway event";
      const description = text(item.description);
      return [{
        source: "cotrip",
        sourceEventId: optionalText(item.uri),
        sourceRevision: isRecord(item.lastUpdated)
          ? optionalText(item.lastUpdated.timestamp)
          : null,
        category: categoryFromText(
          `${title} ${description} ${text(item.icon)}`,
        ),
        severity: severityFromText(`${title} ${description}`),
        status: "active",
        headline: title,
        effectiveAt: null,
        expiresAt: null,
        anchorLabels: match.labels,
        distanceBucket: match.bucket,
      }];
    },
  );
}
async function collectInciweb(
  checkpoints: Checkpoint[],
  userAgent: string,
): Promise<NormalizedSafetyEvent[]> {
  const document = await fetchJson(
    "https://inciweb.wildfire.gov/api/map_data",
    userAgent,
  );
  const records = Array.isArray(document)
    ? document
    : isRecord(document) && Array.isArray(document.incidents)
    ? document.incidents
    : null;
  if (!records) throw new Error("invalid-inciweb-response");
  return records.slice(0, 500).flatMap((item): NormalizedSafetyEvent[] => {
    if (
      !isRecord(item) || item.field_active === false ||
      typeof item.lat_deg !== "number" || typeof item.long_deg !== "number"
    ) return [];
    const match = matchGeometry(checkpoints, [{
      coordinates: [item.long_deg, item.lat_deg],
    }]);
    if (!match.labels.length) return [];
    const headline = text(item.title) || "Active wildfire incident";
    return [{
      source: "inciweb",
      sourceEventId: optionalText(item.id),
      sourceRevision: optionalText(item.changed),
      category: "wildfire",
      severity: severityFromText(`${headline} ${text(item.type)}`),
      status: "active",
      headline,
      effectiveAt: optionalText(item.created),
      expiresAt: null,
      anchorLabels: match.labels,
      distanceBucket: match.bucket,
    }];
  });
}
async function readState(path: string): Promise<WatchState> {
  try {
    return WatchStateSchema.parse(JSON.parse(await Deno.readTextFile(path)));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { events: {}, sources: {}, pending: null };
    }
    throw new Error("Unable to read validated local safety-watch state");
  }
}
async function writeState(path: string, state: WatchState): Promise<void> {
  const directory = path.slice(0, Math.max(0, path.lastIndexOf("/")));
  if (directory) await Deno.mkdir(directory, { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeTextFile(
      temporary,
      `${JSON.stringify(WatchStateSchema.parse(state), null, 2)}\n`,
    );
    await Deno.rename(temporary, path);
  } finally {
    try {
      await Deno.remove(temporary);
    } catch (_error) { /* already atomically moved */ }
  }
}
function sourceDue(
  state: WatchState,
  source: SourceName,
  seconds: number,
  force: boolean,
): boolean {
  if (force) return true;
  const previous = state.sources[source]?.lastSuccessfulAt;
  return !previous || !Number.isFinite(new Date(previous).getTime()) ||
    Date.now() - new Date(previous).getTime() >= seconds * 1000;
}

/** Swamp model for generic, private-runtime local safety monitoring. */
export const model = {
  type: "@mgreten/local-safety-watch",
  version: "2026.07.24.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    summary: {
      description: "Redacted material local-safety changes",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
  },
  files: {
    digest: {
      description: "Redacted markdown digest for material local-safety changes",
      contentType: "text/markdown",
      lifetime: "infinite",
      garbageCollection: 30,
    },
  },
  methods: {
    collect: {
      description:
        "Poll enabled official sources and emit redacted changes only",
      arguments: CollectArgsSchema,
      execute: async (
        args: CollectArgs,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            spec: string,
            name: string,
            data: unknown,
          ) => Promise<unknown>;
          createFileWriter: (
            spec: string,
            name: string,
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
        const checkpoints = z.array(CheckpointSchema).min(1).max(5).parse(
          JSON.parse(args.checkpointsJson),
        );
        const enabled = z.array(z.enum(SOURCE_NAMES)).parse(
          JSON.parse(cfg.enabledSourcesJson),
        );
        let state = await readState(args.statePath);
        context.logger.info("Starting local safety watch", {
          checkpointCount: checkpoints.length,
          enabledSourceCount: enabled.length,
        });
        const pending = state.pending;
        if (pending?.length) {
          const handles = await Promise.all([
            context.writeResource(
              "summary",
              "latestSummary",
              SummarySchema.parse({
                checkedAt: nowIso(),
                changed: true,
                changes: pending,
                staleSources: [],
              }),
            ),
            context.createFileWriter("digest", "latestDigest").writeText(
              renderDigest(
                pending.map((change) => ({
                  action: change.action,
                  event: {
                    ...change.event,
                    sourceEventId: null,
                    sourceRevision: null,
                    status: "active",
                    effectiveAt: null,
                    expiresAt: null,
                  },
                })),
              ),
            ),
          ]);
          state = { ...state, pending: null };
          await writeState(args.statePath, state);
          return { dataHandles: handles };
        }
        const collectors: Array<
          [SourceName, number, () => Promise<NormalizedSafetyEvent[]>]
        > = [["nws", 120, () => collectNws(checkpoints, cfg.userAgent)], [
          "cotrip",
          cfg.cotripMinimumPollSeconds,
          () => collectCotrip(checkpoints, cfg.userAgent),
        ], [
          "inciweb",
          cfg.inciwebMinimumPollSeconds,
          () => collectInciweb(checkpoints, cfg.userAgent),
        ]];
        const events: NormalizedSafetyEvent[] = [];
        const successful: SourceName[] = [];
        for (const [source, minimum, collect] of collectors) {
          if (
            !enabled.includes(source) ||
            !sourceDue(state, source, minimum, args.forcePoll)
          ) {
            continue;
          }
          try {
            events.push(...await collect());
            successful.push(source);
            state.sources[source] = {
              lastSuccessfulAt: nowIso(),
              lastAttemptAt: nowIso(),
              errorCode: null,
            };
          } catch (error) {
            state.sources[source] = {
              lastSuccessfulAt: state.sources[source]?.lastSuccessfulAt ?? null,
              lastAttemptAt: nowIso(),
              errorCode: errorCode(error),
            };
          }
        }
        const reconciliation = await reconcileEvents(state, events, {
          authoritativeSources: successful,
        });
        state = reconciliation.state;
        const safeChanges = reconciliation.changes.map((change) => ({
          action: change.action,
          event: safeEvent(change.event),
        }));
        const staleSources = SOURCE_NAMES.filter((source) =>
          Boolean(state.sources[source]?.errorCode)
        );
        if (!safeChanges.length) {
          await writeState(args.statePath, state);
          context.logger.info("Local safety watch unchanged", {
            successfulSourceCount: successful.length,
            staleSourceCount: staleSources.length,
          });
          return { dataHandles: [] };
        }
        state.pending = safeChanges;
        await writeState(args.statePath, state);
        const summary = SummarySchema.parse({
          checkedAt: nowIso(),
          changed: true,
          changes: safeChanges,
          staleSources,
        });
        const handles = await Promise.all([
          context.writeResource("summary", "latestSummary", summary),
          context.createFileWriter("digest", "latestDigest").writeText(
            renderDigest(reconciliation.changes),
          ),
        ]);
        state.pending = null;
        await writeState(args.statePath, state);
        context.logger.info("Local safety watch changed", {
          changeCount: safeChanges.length,
          staleSourceCount: staleSources.length,
        });
        return { dataHandles: handles };
      },
    },
  },
};
