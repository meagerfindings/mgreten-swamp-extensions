import { z } from "npm:zod@4";
import {
  type BetterStackTriageRecord,
  type BetterStackTriageSnapshot,
  betterStackTriageSnapshotSchema,
  validateBetterStackTriageSnapshot,
} from "./_lib/better_stack_triage_contracts.ts";
import {
  type FeedbackTriageOutput,
  feedbackTriageOutputSchema,
  validateFeedbackTriageOutput,
} from "./_lib/feedback_triage_contracts.ts";
import { sourceReferenceSchema } from "./_lib/signal_contracts.ts";
import { feedbackBatchSchema } from "./_lib/feedback_batch_contract.ts";
import {
  evaluateRailwayEvidence,
  railwayScopeSchema,
} from "./_lib/railway_read_contracts.ts";

export const DAILY_OPERATIONAL_DIGEST_MODEL_VERSION = "2026.08.22.1" as const;
/** Fixed limits retained by the Moment Savor compatibility digest. */
export const DIGEST_LIMITS = {
  itemsPerSection: 5,
  totalItems: 24,
  bytes: 16_384,
  tokens: 8_192,
} as const;
/** Historical Moment Savor digest sections in canonical order. */
export const DIGEST_SECTIONS = [
  "new-signals",
  "active-incidents",
  "worsening-errors",
  "factory-attention",
  "economic-anomalies",
  "requires-mat",
] as const;

const text = z.string().trim().min(1).max(500);
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/);
const timestamp = z.iso.datetime({ offset: true });
const severity = z.enum(["info", "low", "medium", "high", "critical"]);
const source = sourceReferenceSchema.extend({
  registrySourceId: z.string().regex(/^moment-savor:[a-z0-9-]+$/),
});
const item = z.strictObject({
  itemId: text.max(120),
  dedupeKey: text.max(160),
  severity,
  observedAt: timestamp,
  summary: text,
  recommendation: text,
  sourceIds: z.array(z.string().min(1)).min(1).max(5),
});
const section = z.discriminatedUnion("availability", [
  z.strictObject({
    section: z.enum(DIGEST_SECTIONS),
    availability: z.literal("available"),
    missingReason: z.null(),
    sourceReferences: z.array(source).min(1).max(5),
    items: z.array(item).max(10),
  }),
  z.strictObject({
    section: z.enum(DIGEST_SECTIONS),
    availability: z.literal("missing"),
    missingReason: text,
    sourceReferences: z.array(z.never()).length(0),
    items: z.array(z.never()).length(0),
  }),
]);

/** Historical explicit-input digest arguments retained for persisted data. */
export const buildDigestArgumentsSchema = z.object({
  digestId: safeId,
  generatedAt: timestamp,
  sections: z.array(section).length(DIGEST_SECTIONS.length),
});

/** Arguments accepted by the Better Stack compatibility adapter. */
export const buildFromBetterStackTriageArgumentsSchema = z.strictObject({
  digestId: safeId,
  snapshot: betterStackTriageSnapshotSchema,
});

const unavailablePulseSource = z.strictObject({
  status: z.literal("unavailable"),
  reason: text,
});
const zeroRecordPulseSource = z.strictObject({
  status: z.literal("zero-records"),
  reason: text,
});
/** Arguments accepted by the deterministic Phase 1 pulse adapter. */
export const buildPhaseOnePulseArgumentsSchema = z.strictObject({
  pulseId: safeId,
  generatedAt: timestamp,
  betterStack: z.union([
    z.strictObject({
      status: z.literal("available"),
      snapshot: betterStackTriageSnapshotSchema,
    }),
    unavailablePulseSource,
  ]),
  feedback: z.union([
    z.strictObject({
      status: z.literal("available"),
      triage: feedbackTriageOutputSchema,
    }),
    z.strictObject({
      status: z.literal("available"),
      feedbackBatch: feedbackBatchSchema,
    }),
    zeroRecordPulseSource,
    unavailablePulseSource,
  ]),
  railway: z.strictObject({
    scope: railwayScopeSchema,
    asOf: timestamp,
    snapshot: z.unknown(),
  }),
});

const pulseSourceState = z.strictObject({
  source: z.enum([
    "better-stack",
    "feedback-triage",
    "feedback-batch",
    "railway",
  ]),
  status: z.enum(["available", "zero-records", "unavailable"]),
  reason: text.nullable(),
  recordCount: z.number().int().nonnegative().nullable(),
});
const pulseFinding = z.strictObject({
  findingId: text.max(200),
  dedupeKey: text.max(200),
  kind: z.enum(["issue", "anomaly", "feedback"]),
  severity,
  summary: text,
  sentiment: z.enum(["not-applicable", "not-assessed"]),
  specifics: z.strictObject({
    affectedFeedbackCount: z.number().int().nonnegative().nullable(),
    duplicateCount: z.number().int().nonnegative().nullable(),
  }),
  confidence: z.number().finite().min(0).max(1),
  uncertainty: text,
  evidenceReferences: z.array(z.strictObject({
    source: z.enum([
      "better-stack",
      "feedback-triage",
      "feedback-batch",
      "railway",
    ]),
    recordId: text.max(200),
    evidenceId: text.max(200),
  })).min(1).max(100),
  recommendation: text,
});
/** Persisted schema consumed by the Moment Savor founder-pulse report. */
export const phaseOnePulseSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  pulseId: text.max(120),
  generatedAt: timestamp,
  purpose: z.literal("phase-one-daily-pulse"),
  authority: z.strictObject({
    mode: z.literal("recommendation-only"),
    sideEffects: z.literal("none"),
    agentInvocation: z.literal("none"),
  }),
  handling: z.strictObject({
    redactedEvidenceOnly: z.literal(true),
    privateFamilyContentIncluded: z.literal(false),
  }),
  sources: z.array(pulseSourceState).length(3),
  findings: z.array(pulseFinding).max(24),
});

/** Historical digest schema accepted alongside the primary generic schema. */
export const dailyOperationalDigestSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  digestId: text.max(120),
  generatedAt: timestamp,
  purpose: z.literal("decision-oriented-daily-operational-digest"),
  authority: z.strictObject({
    mode: z.literal("recommendation-only"),
    sideEffects: z.literal("none"),
    agentInvocation: z.literal("none"),
  }),
  sections: z.array(section).length(DIGEST_SECTIONS.length),
  limits: z.strictObject({
    maxItemsPerSection: z.literal(5),
    maxTotalItems: z.literal(24),
    maxBytes: z.literal(16_384),
    maxTokens: z.literal(8_192),
    bytes: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    tokenMeasurement: z.literal("unicode-code-points-upper-bound"),
  }),
});

const rank: Record<z.infer<typeof severity>, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
    ? `{${
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b)
      ).map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
        .join(",")
    }}`
    : JSON.stringify(value);
const itemOrder = (a: z.infer<typeof item>, b: z.infer<typeof item>) =>
  rank[b.severity] - rank[a.severity] ||
  a.observedAt.localeCompare(b.observedAt) || a.itemId.localeCompare(b.itemId);

/** Pure, deterministic boundary. It accepts normalized references and recommendations; it performs no collection or action. */
export function buildDailyOperationalDigest(input: unknown) {
  const args = buildDigestArgumentsSchema.parse(input);
  const bySection = new Map(
    args.sections.map((value) => [value.section, value]),
  );
  if (
    bySection.size !== DIGEST_SECTIONS.length ||
    DIGEST_SECTIONS.some((name) => !bySection.has(name))
  ) {
    throw new TypeError(
      "each required digest section must appear exactly once",
    );
  }

  let remaining = DIGEST_LIMITS.totalItems;
  const sections = DIGEST_SECTIONS.map((name) => {
    const value = bySection.get(name)!;
    if (value.availability === "missing") return value;
    const references = [...value.sourceReferences].sort((a, b) =>
      a.sourceId.localeCompare(b.sourceId)
    );
    references.forEach((reference) => {
      if (Date.parse(reference.freshness.asOf) > Date.parse(args.generatedAt)) {
        throw new TypeError(
          `source ${reference.sourceId} is not available by generatedAt`,
        );
      }
      if (
        Date.parse(reference.freshness.expiresAt) < Date.parse(args.generatedAt)
      ) {
        throw new TypeError(
          `source ${reference.sourceId} is stale at generatedAt`,
        );
      }
    });
    const sourceIds = new Set(
      references.map((reference) => reference.sourceId),
    );
    const unique = new Map<string, z.infer<typeof item>>();
    for (const candidate of value.items) {
      if (Date.parse(candidate.observedAt) > Date.parse(args.generatedAt)) {
        throw new TypeError(`future item ${candidate.itemId}`);
      }
      if (candidate.sourceIds.some((id) => !sourceIds.has(id))) {
        throw new TypeError(
          `item ${candidate.itemId} references an unavailable section source`,
        );
      }
      const prior = unique.get(candidate.dedupeKey);
      if (!prior || itemOrder(candidate, prior) < 0) {
        unique.set(candidate.dedupeKey, candidate);
      }
    }
    const items = [...unique.values()].sort(itemOrder).slice(
      0,
      Math.min(DIGEST_LIMITS.itemsPerSection, remaining),
    );
    remaining -= items.length;
    return { ...value, sourceReferences: references, items };
  });
  const base = {
    schemaVersion: "1.0" as const,
    digestId: args.digestId,
    generatedAt: args.generatedAt,
    purpose: "decision-oriented-daily-operational-digest" as const,
    authority: {
      mode: "recommendation-only" as const,
      sideEffects: "none" as const,
      agentInvocation: "none" as const,
    },
    sections,
  };
  const encoded = canonical(base),
    bytes = new TextEncoder().encode(encoded).byteLength,
    tokens = [...encoded].length;
  if (bytes > DIGEST_LIMITS.bytes || tokens > DIGEST_LIMITS.tokens) {
    throw new TypeError(
      `digest exceeds output budget: ${bytes} bytes, ${tokens} tokens`,
    );
  }
  return dailyOperationalDigestSchema.parse({
    ...base,
    limits: {
      maxItemsPerSection: 5,
      maxTotalItems: 24,
      maxBytes: 16_384,
      maxTokens: 8_192,
      bytes,
      tokens,
      tokenMeasurement: "unicode-code-points-upper-bound",
    },
  });
}

const unavailableSection = (
  name: typeof DIGEST_SECTIONS[number],
  missingReason: string,
) => ({
  section: name,
  availability: "missing" as const,
  missingReason,
  sourceReferences: [],
  items: [],
});

const statusSeverity = (record: BetterStackTriageRecord) =>
  record.status === "confirmed_failure"
    ? "critical" as const
    : record.status === "suspected_anomaly"
    ? "high" as const
    : "medium" as const;
const boundedText = (value: string, maximum: number) =>
  [...value].slice(0, maximum).join("");

/**
 * Pure adapter from strict, read-only Better Stack triage evidence. Summaries and
 * escalation rationale remain untrusted evidence; only fixed recommendations
 * authored here enter the digest's recommendation fields.
 */
export function buildFromBetterStackTriage(input: unknown) {
  const args = buildFromBetterStackTriageArgumentsSchema.parse(input);
  const validated = validateBetterStackTriageSnapshot(args.snapshot);
  if (!validated.success) {
    throw new TypeError(
      `unsafe Better Stack evidence: ${canonical(validated.diagnostics)}`,
    );
  }
  const snapshot: BetterStackTriageSnapshot = validated.data;
  const records = [...snapshot.records].sort((a, b) =>
    a.recordId.localeCompare(b.recordId)
  );
  const withRegistrySource = (record: BetterStackTriageRecord) => ({
    ...record.sourceReference,
    registrySourceId: "moment-savor:better-stack" as const,
  });
  const availableSection = (
    name: typeof DIGEST_SECTIONS[number],
    selected: BetterStackTriageRecord[],
    recommendation: string,
    itemLimit: number = DIGEST_LIMITS.itemsPerSection,
  ) => {
    if (selected.length === 0) {
      return unavailableSection(
        name,
        "The Better Stack triage snapshot contains no qualifying evidence for this section.",
      );
    }
    const prioritized = [...selected].sort((a, b) => {
      const aSeverity = a.kind === "incident"
        ? a.incident.severity
        : statusSeverity(a);
      const bSeverity = b.kind === "incident"
        ? b.incident.severity
        : statusSeverity(b);
      return rank[bSeverity] - rank[aSeverity] ||
        a.sourceReference.observedAt.localeCompare(
          b.sourceReference.observedAt,
        ) || a.recordId.localeCompare(b.recordId);
    }).slice(0, itemLimit);
    const references = new Map<string, ReturnType<typeof withRegistrySource>>();
    prioritized.forEach((record) => {
      if (!references.has(record.sourceReference.sourceId)) {
        references.set(
          record.sourceReference.sourceId,
          withRegistrySource(record),
        );
      }
    });
    return {
      section: name,
      availability: "available" as const,
      missingReason: null,
      sourceReferences: [...references.values()],
      items: prioritized.map((record) => ({
        itemId: boundedText(record.recordId, 120),
        dedupeKey: boundedText(
          record.kind === "error"
            ? `error:${record.error.fingerprint}`
            : `${record.kind}:${record.recordId}`,
          160,
        ),
        severity: record.kind === "incident"
          ? record.incident.severity
          : statusSeverity(record),
        observedAt: record.sourceReference.observedAt,
        summary: boundedText(record.summary, 240),
        recommendation,
        sourceIds: [record.sourceReference.sourceId],
      })),
    };
  };

  const activeIncidents = records.filter((record) =>
    record.kind === "incident" && record.incident.state !== "resolved"
  );
  const errors = records.filter((record) => record.kind === "error");
  const unhealthySignals = records.filter((record) =>
    (record.kind === "monitor" || record.kind === "heartbeat") &&
    record.status !== "healthy"
  );
  const escalationEvidence = new Set(snapshot.escalation.evidenceIds);
  const escalationRecords = snapshot.escalation.disposition === "none"
    ? []
    : records.filter((record) =>
      record.evidenceIds.some((evidenceId) =>
        escalationEvidence.has(evidenceId)
      )
    );

  return buildDailyOperationalDigest({
    digestId: args.digestId,
    generatedAt: snapshot.generatedAt,
    sections: [
      availableSection(
        "new-signals",
        unhealthySignals,
        "Review the cited unhealthy monitor or heartbeat evidence.",
      ),
      availableSection(
        "active-incidents",
        activeIncidents,
        "Review the cited active incident and decide whether human coordination is needed.",
      ),
      availableSection(
        "worsening-errors",
        errors,
        "Review the cited grouped error evidence and determine whether investigation is warranted.",
        2,
      ),
      unavailableSection(
        "factory-attention",
        "Better Stack triage cannot establish software factory attention state.",
      ),
      unavailableSection(
        "economic-anomalies",
        "Better Stack triage cannot establish economic anomalies.",
      ),
      availableSection(
        "requires-mat",
        escalationRecords,
        "Mat should review the cited escalation evidence; no action is taken automatically.",
        1,
      ),
    ],
  });
}

const pulseFindingOrder = (
  a: z.infer<typeof pulseFinding>,
  b: z.infer<typeof pulseFinding>,
) =>
  rank[b.severity] - rank[a.severity] || a.kind.localeCompare(b.kind) ||
  a.findingId.localeCompare(b.findingId);

/** Pure Phase 1 boundary: combines only contract-valid, redacted evidence and never invokes an agent or effect. */
export function buildPhaseOnePulse(input: unknown) {
  const args = buildPhaseOnePulseArgumentsSchema.parse(input);
  const findings: z.infer<typeof pulseFinding>[] = [];
  const sources: z.infer<typeof pulseSourceState>[] = [];
  let generatedAt = args.generatedAt;

  const admitEvidenceTimestamp = (timestamp: string) => {
    if (Date.parse(timestamp) > Date.parse(generatedAt)) {
      generatedAt = timestamp;
    }
  };

  if (args.betterStack.status === "unavailable") {
    sources.push({
      source: "better-stack",
      status: "unavailable",
      reason: args.betterStack.reason,
      recordCount: null,
    });
  } else {
    const validated = validateBetterStackTriageSnapshot(
      args.betterStack.snapshot,
    );
    if (!validated.success) {
      throw new TypeError(
        `unsafe Better Stack evidence: ${canonical(validated.diagnostics)}`,
      );
    }
    admitEvidenceTimestamp(validated.data.generatedAt);
    if (
      Date.parse(validated.data.limits.windowEndedAt) -
          Date.parse(validated.data.limits.windowStartedAt) >
        86_400_000
    ) {
      throw new TypeError("Better Stack reader window exceeds 24 hours");
    }
    const records = validated.data.records.filter((record) =>
      record.status === "confirmed_failure" ||
      record.status === "suspected_anomaly"
    );
    sources.push({
      source: "better-stack",
      status: validated.data.records.length === 0
        ? "zero-records"
        : "available",
      reason: validated.data.records.length === 0
        ? "The approved Better Stack snapshot contains zero records."
        : null,
      recordCount: validated.data.records.length,
    });
    records.forEach((record) => {
      const kind = record.status === "suspected_anomaly" ? "anomaly" : "issue";
      findings.push({
        findingId: `better-stack:${record.recordId}`,
        dedupeKey: record.kind === "error"
          ? `better-stack:error:${record.error.fingerprint}`
          : `better-stack:${record.kind}:${record.recordId}`,
        kind,
        severity: record.kind === "incident"
          ? record.incident.severity
          : statusSeverity(record),
        summary: kind === "anomaly"
          ? "Approved Better Stack evidence indicates a suspected anomaly."
          : "Approved Better Stack evidence indicates a confirmed issue.",
        sentiment: "not-applicable",
        specifics: { affectedFeedbackCount: null, duplicateCount: null },
        confidence: record.status === "confirmed_failure" ? 1 : 0.7,
        uncertainty: record.status === "confirmed_failure"
          ? "Impact and remediation remain unverified by this read-only pulse."
          : "The evidence is anomalous but does not establish a confirmed failure.",
        evidenceReferences: [...record.evidenceIds].sort().map((
          evidenceId,
        ) => ({
          source: "better-stack" as const,
          recordId: record.recordId,
          evidenceId,
        })),
        recommendation:
          "Review the cited evidence and decide whether a human-led investigation is warranted.",
      });
    });
  }

  if (args.feedback.status !== "available") {
    sources.push({
      source: "feedback-triage",
      status: args.feedback.status,
      reason: args.feedback.reason,
      recordCount: args.feedback.status === "zero-records" ? 0 : null,
    });
  } else if ("triage" in args.feedback) {
    const validated = validateFeedbackTriageOutput(args.feedback.triage);
    if (!validated.success) {
      throw new TypeError(
        `unsafe feedback evidence: ${canonical(validated.diagnostics)}`,
      );
    }
    const triage: FeedbackTriageOutput = validated.data;
    admitEvidenceTimestamp(triage.generatedAt);
    sources.push({
      source: "feedback-triage",
      status: "available",
      reason: null,
      recordCount: triage.sourceFeedbackIds.length,
    });
    const duplicateIds = new Set(
      triage.duplicateLinks.flatMap((link) => [
        link.feedbackId,
        link.duplicateOfFeedbackId,
      ]),
    );
    triage.themes.forEach((theme) => {
      const references = new Map<
        string,
        { source: "feedback-triage"; recordId: string; evidenceId: string }
      >();
      theme.evidence.forEach((evidence) => {
        references.set(evidence.feedbackId, {
          source: "feedback-triage",
          recordId: theme.themeId,
          evidenceId: evidence.feedbackId,
        });
      });
      findings.push({
        findingId: `feedback:${theme.themeId}`,
        dedupeKey: `feedback:${theme.themeId}`,
        kind: "feedback",
        severity: theme.confidence >= 0.8 ? "medium" : "low",
        summary:
          "Validated feedback triage identified a redacted feedback theme.",
        sentiment: "not-assessed",
        specifics: {
          affectedFeedbackCount: theme.feedbackIds.length,
          duplicateCount: theme.feedbackIds.filter((id) =>
            duplicateIds.has(id)
          ).length,
        },
        confidence: theme.confidence,
        uncertainty:
          "Sentiment is not assessed; the pulse exposes only counts and evidence identifiers, not private feedback content.",
        evidenceReferences: [...references.values()].sort((a, b) =>
          a.evidenceId.localeCompare(b.evidenceId)
        ),
        recommendation:
          "Review the cited redacted feedback evidence before making a product decision.",
      });
    });
  } else {
    const batch = args.feedback.feedbackBatch;
    admitEvidenceTimestamp(batch.collectedAt);
    sources.push({
      source: "feedback-batch",
      status: batch.artifacts.length === 0 ? "zero-records" : "available",
      reason: batch.artifacts.length === 0
        ? "The bounded feedback reader window contains zero records."
        : null,
      recordCount: batch.artifacts.length,
    });
    [...batch.artifacts].sort((a, b) =>
      a.feedbackId.localeCompare(b.feedbackId)
    ).forEach((artifact) => {
      findings.push({
        findingId: `feedback:${artifact.feedbackId}`,
        dedupeKey: `feedback:${artifact.feedbackId}`,
        kind: "feedback",
        severity: "info",
        summary:
          "A deterministically redacted in-app feedback record was observed.",
        sentiment: "not-assessed",
        specifics: { affectedFeedbackCount: 1, duplicateCount: 0 },
        confidence: 1,
        uncertainty:
          "Sentiment and thematic meaning were not assessed because this deterministic pulse invokes no language model.",
        evidenceReferences: [{
          source: "feedback-batch",
          recordId: artifact.feedbackId,
          evidenceId: artifact.provenance.inputEnvelopeId,
        }],
        recommendation:
          "Review the cited redacted feedback record before making a product decision.",
      });
    });
  }

  {
    const evidence = evaluateRailwayEvidence(
      args.railway.snapshot,
      args.railway.scope,
      args.railway.asOf,
    );
    if (evidence.state === "unavailable") {
      sources.push({
        source: "railway",
        status: "unavailable",
        reason: evidence.reason,
        recordCount: null,
      });
    } else {
      admitEvidenceTimestamp(evidence.collectedAt);
      const failing = [...evidence.services].filter((service) =>
        service.status === "FAILED" || service.status === "CRASHED"
      ).sort((a, b) => a.serviceId.localeCompare(b.serviceId));
      sources.push({
        source: "railway",
        status: failing.length === 0 ? "zero-records" : "available",
        reason: failing.length === 0
          ? "The approved Railway deployment snapshot contains no current FAILED or CRASHED latest deployments."
          : null,
        recordCount: failing.length,
      });
      failing.forEach((service) => {
        findings.push({
          findingId: `railway:${service.serviceId}:${service.deploymentId}`,
          dedupeKey: `railway:${service.serviceId}:${service.deploymentId}`,
          kind: "issue",
          severity: "critical",
          summary:
            "Approved Railway evidence indicates the latest deployment for a configured service failed.",
          sentiment: "not-applicable",
          specifics: { affectedFeedbackCount: null, duplicateCount: null },
          confidence: 1,
          uncertainty:
            "Impact and remediation remain unverified by this read-only pulse.",
          evidenceReferences: [{
            source: "railway",
            recordId: service.serviceId,
            evidenceId: service.deploymentId,
          }],
          recommendation:
            "Review the cited Railway deployment and decide whether a human-led investigation is warranted.",
        });
      });
    }
  }

  const unique = new Map<string, z.infer<typeof pulseFinding>>();
  findings.sort(pulseFindingOrder).forEach((finding) => {
    if (!unique.has(finding.dedupeKey)) unique.set(finding.dedupeKey, finding);
  });
  return phaseOnePulseSchema.parse({
    schemaVersion: "1.0",
    pulseId: args.pulseId,
    generatedAt,
    purpose: "phase-one-daily-pulse",
    authority: {
      mode: "recommendation-only",
      sideEffects: "none",
      agentInvocation: "none",
    },
    handling: {
      redactedEvidenceOnly: true,
      privateFamilyContentIncluded: false,
    },
    sources,
    findings: [...unique.values()].slice(0, 24),
  });
}
