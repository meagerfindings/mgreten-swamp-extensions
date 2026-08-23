import { z } from "npm:zod@4";
import { sourceReferenceSchema } from "./source_reference_contracts.ts";

export const OPERATIONAL_TRIAGE_SCHEMA_VERSION = "1.0" as const;
export const OPERATIONAL_TRIAGE_HARD_LIMITS = {
  rows: 10_000,
  bytes: 5_000_000,
  windowSeconds: 2_592_000,
} as const;

const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(2_000);
const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();
const status = z.enum([
  "confirmed_failure",
  "suspected_anomaly",
  "healthy",
  "missing_signal",
]);

const baseRecord = z.strictObject({
  recordId: id,
  sourceReference: sourceReferenceSchema,
  status,
  summary: text,
  evidenceIds: z.array(id).max(100),
});

const incident = baseRecord.extend({
  kind: z.literal("incident"),
  incident: z.strictObject({
    state: z.enum(["open", "acknowledged", "resolved"]),
    severity: z.enum(["low", "medium", "high", "critical"]),
  }),
});
const error = baseRecord.extend({
  kind: z.literal("error"),
  error: z.strictObject({
    fingerprint: id,
    occurrences: count,
    affectedContexts: count,
  }),
});
const logAggregate = baseRecord.extend({
  kind: z.literal("log_aggregate"),
  logAggregate: z.strictObject({
    queryFingerprint: id,
    matchingRows: count,
    groups: z.array(z.strictObject({ key: id, count })).max(100),
    rawLogsIncluded: z.literal(false),
  }),
});
const heartbeat = baseRecord.extend({
  kind: z.literal("heartbeat"),
  heartbeat: z.strictObject({
    expectedIntervalSeconds: z.number().int().positive(),
    lastReceivedAt: timestamp.nullable(),
    missedIntervals: count,
  }),
});
const monitor = baseRecord.extend({
  kind: z.literal("monitor"),
  monitor: z.strictObject({
    checkState: z.enum(["up", "down", "degraded", "unknown"]),
    responseTimeMs: count.nullable(),
  }),
});
const trend = baseRecord.extend({
  kind: z.literal("trend"),
  trend: z.strictObject({
    metric: id,
    direction: z.enum(["rising", "falling", "stable", "unknown"]),
    sampleCount: count,
    changePercent: z.number().finite().nullable(),
  }),
});

export const operationalTriageRecordSchema = z.discriminatedUnion("kind", [
  incident,
  error,
  logAggregate,
  heartbeat,
  monitor,
  trend,
]).superRefine((record, context) => {
  const issue = (path: PropertyKey[], message: string) =>
    context.addIssue({ code: "custom", path, message });
  if (
    ["confirmed_failure", "suspected_anomaly"].includes(record.status) &&
    record.evidenceIds.length === 0
  ) issue(["evidenceIds"], "failure or anomaly requires evidence");
  if (
    ["healthy", "missing_signal"].includes(record.status) &&
    record.evidenceIds.length !== 0 && record.status === "missing_signal"
  ) issue(["evidenceIds"], "missing signal cannot claim observed evidence");
  if (
    record.kind === "incident" && record.status === "healthy" &&
    record.incident.state !== "resolved"
  ) issue(["incident", "state"], "healthy incident must be resolved");
  if (
    record.kind === "monitor" && record.status === "confirmed_failure" &&
    record.monitor.checkState !== "down"
  ) {
    issue(
      ["monitor", "checkState"],
      "confirmed monitor failure requires down state",
    );
  }
  if (
    record.kind === "heartbeat" && record.status === "missing_signal" &&
    record.heartbeat.missedIntervals === 0
  ) {
    issue(
      ["heartbeat", "missedIntervals"],
      "missing heartbeat requires at least one missed interval",
    );
  }
});

const limits = z.strictObject({
  maxRows: z.number().int().positive().max(OPERATIONAL_TRIAGE_HARD_LIMITS.rows),
  maxBytes: z.number().int().positive().max(
    OPERATIONAL_TRIAGE_HARD_LIMITS.bytes,
  ),
  maxWindowSeconds: z.number().int().positive().max(
    OPERATIONAL_TRIAGE_HARD_LIMITS.windowSeconds,
  ),
  rowsRead: count,
  bytesRead: count,
  windowStartedAt: timestamp,
  windowEndedAt: timestamp,
  truncated: z.boolean(),
});

export const operationalTriageSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(OPERATIONAL_TRIAGE_SCHEMA_VERSION),
  snapshotId: id,
  generatedAt: timestamp,
  records: z.array(operationalTriageRecordSchema).max(
    OPERATIONAL_TRIAGE_HARD_LIMITS.rows,
  ),
  filtering: z.strictObject({
    policy: z.literal("exact-resource-identity-allowlist"),
    includedCount: count,
    excludedCount: count,
    excludedByReason: z.strictObject({
      identityNotAllowed: count,
      missingIdentity: count,
    }),
  }),
  limits,
  redaction: z.strictObject({
    method: z.literal("deterministic-secret-and-identifier-redaction"),
    methodVersion: id,
    applied: z.literal(true),
    rawLogsRetained: z.literal(false),
    replacementCount: count,
  }),
  authority: z.strictObject({
    mode: z.literal("read-only"),
    sideEffects: z.literal("none"),
    remediation: z.literal("prohibited"),
    mayAcknowledgeIncidents: z.literal(false),
    mayModifyMonitors: z.literal(false),
  }),
  escalation: z.strictObject({
    disposition: z.enum(["none", "recommend_review", "urgent_review"]),
    evidenceIds: z.array(id).max(100),
    rationale: text.nullable(),
  }),
}).superRefine((snapshot, context) => {
  const issue = (path: PropertyKey[], message: string) =>
    context.addIssue({ code: "custom", path, message });
  const start = Date.parse(snapshot.limits.windowStartedAt),
    end = Date.parse(snapshot.limits.windowEndedAt),
    generated = Date.parse(snapshot.generatedAt);
  if (start > end) {
    issue(
      ["limits", "windowEndedAt"],
      "windowEndedAt must be at or after windowStartedAt",
    );
  }
  if ((end - start) / 1000 > snapshot.limits.maxWindowSeconds) {
    issue(
      ["limits", "maxWindowSeconds"],
      "requested time window exceeds maxWindowSeconds",
    );
  }
  if (end > generated) {
    issue(["generatedAt"], "generatedAt must be at or after windowEndedAt");
  }
  if (snapshot.limits.rowsRead > snapshot.limits.maxRows) {
    issue(["limits", "rowsRead"], "rowsRead exceeds maxRows");
  }
  if (snapshot.limits.bytesRead > snapshot.limits.maxBytes) {
    issue(["limits", "bytesRead"], "bytesRead exceeds maxBytes");
  }
  if (snapshot.records.length > snapshot.limits.rowsRead) {
    issue(["records"], "record count cannot exceed rowsRead");
  }
  if (
    snapshot.filtering.excludedCount !==
      snapshot.filtering.excludedByReason.identityNotAllowed +
        snapshot.filtering.excludedByReason.missingIdentity
  ) {
    issue(
      ["filtering", "excludedCount"],
      "excludedCount must equal aggregate exclusion diagnostics",
    );
  }
  const recordIds = new Set<string>();
  snapshot.records.forEach((record, index) => {
    if (recordIds.has(record.recordId)) {
      issue(["records", index, "recordId"], "duplicate recordId");
    }
    recordIds.add(record.recordId);
    if (Date.parse(record.sourceReference.freshness.asOf) > generated) {
      issue(
        ["records", index, "sourceReference", "freshness", "asOf"],
        "source freshness cannot be after generatedAt",
      );
    }
    if (Date.parse(record.sourceReference.freshness.expiresAt) < generated) {
      issue(
        ["records", index, "sourceReference", "freshness", "expiresAt"],
        "expired source evidence cannot support a triage snapshot",
      );
    }
  });
  const available = new Set(
    snapshot.records.flatMap((record) => record.evidenceIds),
  );
  if (
    snapshot.escalation.disposition === "none" &&
    (snapshot.escalation.evidenceIds.length ||
      snapshot.escalation.rationale !== null)
  ) issue(["escalation"], "no escalation cannot include evidence or rationale");
  if (
    snapshot.escalation.disposition !== "none" &&
    (!snapshot.escalation.evidenceIds.length ||
      snapshot.escalation.rationale === null)
  ) issue(["escalation"], "escalation requires evidence and rationale");
  snapshot.escalation.evidenceIds.forEach((evidenceId, index) => {
    if (!available.has(evidenceId)) {
      issue(
        ["escalation", "evidenceIds", index],
        "escalation evidence must reference record evidence",
      );
    }
  });
});

export type OperationalTriageSnapshot = z.infer<
  typeof operationalTriageSnapshotSchema
>;
export interface OperationalTriageDiagnostic {
  path: string;
  code: string;
  message: string;
}
export type OperationalTriageValidation = {
  success: true;
  data: OperationalTriageSnapshot;
  diagnostics: [];
} | { success: false; diagnostics: OperationalTriageDiagnostic[] };

const forbiddenKey =
  /^(raw(logs?|message|payload|body)|password|secret|token|authorization|api[_-]?key)$/i;
const forbiddenText = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:\+\d[\d\s().-]{6,}\d|(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4})/,
  /\bBearer\s+\S+/i,
  /\b(?:api[_ -]?key|password|secret|access[_ -]?token)\s*[:=]\s*\S+/i,
  /https?:\/\/\S+/i,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
] as const;

function leakageDiagnostics(input: unknown): OperationalTriageDiagnostic[] {
  const diagnostics: OperationalTriageDiagnostic[] = [];
  const visit = (value: unknown, path: string[]) => {
    if (
      typeof value === "string" &&
      forbiddenText.some((pattern) => pattern.test(value))
    ) {
      diagnostics.push({
        path: path.join("."),
        code: "forbidden_content",
        message: "private or credential content is forbidden after redaction",
      });
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, String(index)]));
    } else if (value && typeof value === "object") {
      Object.entries(value).forEach(([key, item]) => {
        if (forbiddenKey.test(key)) {
          diagnostics.push({
            path: [...path, key].join("."),
            code: "forbidden_field",
            message: "raw logs or sensitive fields are forbidden",
          });
        }
        visit(item, [...path, key]);
      });
    }
  };
  visit(input, []);
  return diagnostics;
}

/** Validates the public contract and reports stable, sorted diagnostics. */
export function validateOperationalTriageSnapshot(
  input: unknown,
): OperationalTriageValidation {
  const parsed = operationalTriageSnapshotSchema.safeParse(input);
  const schema = parsed.success ? [] : parsed.error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
    message: issue.message,
  }));
  const diagnostics = [...schema, ...leakageDiagnostics(input)].sort((a, b) =>
    a.path.localeCompare(b.path) || a.code.localeCompare(b.code) ||
    a.message.localeCompare(b.message)
  );
  return parsed.success && diagnostics.length === 0
    ? { success: true, data: parsed.data, diagnostics: [] }
    : { success: false, diagnostics };
}
