/**
 * Strict schemas and deterministic validation for source-preserving feedback
 * lineage records.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Current wire-schema version. */
export const FEEDBACK_LINEAGE_SCHEMA_VERSION = "1.0" as const;

/** Hard limits that bound validation work and diagnostics. */
export const FEEDBACK_LINEAGE_LIMITS = {
  links: 100,
  diagnostics: 100,
} as const;

const Id = z.string().trim().min(1).max(200);
const Version = z.string().trim().min(1).max(100);
const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Timestamp = z.iso.datetime({ offset: true });
const Kind = z.enum([
  "feedback",
  "signal",
  "triage",
  "dossier",
  "decision",
  "work_order",
  "product_lineage",
]);

/** An immutable artifact identity, including source identity for feedback. */
export const FeedbackLineageArtifactReference = z.strictObject({
  kind: Kind,
  artifactId: Id,
  version: Version,
  sha256: Hash,
  sourceIdentity: z.strictObject({ sourceId: Id, sourceRecordId: Id })
    .optional(),
}).superRefine((reference, context) => {
  if (reference.kind === "feedback" && reference.sourceIdentity === undefined) {
    context.addIssue({
      code: "custom",
      path: ["sourceIdentity"],
      message: "feedback references require immutable source identity",
    });
  }
  if (reference.kind !== "feedback" && reference.sourceIdentity !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["sourceIdentity"],
      message: "sourceIdentity is only valid for feedback references",
    });
  }
});

/** A typed, time-bounded relationship between immutable artifacts. */
export const FeedbackLineageLink = z.strictObject({
  linkId: Id,
  linkVersion: Version,
  linkSha256: Hash,
  relationship: z.enum([
    "duplicate_of",
    "related_signal",
    "evidence_for_dossier",
    "informed_decision",
    "motivates_work_order",
    "represented_in_lineage",
  ]),
  from: FeedbackLineageArtifactReference,
  to: FeedbackLineageArtifactReference,
  observedAt: Timestamp,
  linkedAt: Timestamp,
  provenance: z.strictObject({
    producer: Id,
    producerVersion: Version,
    method: Id,
    inputArtifactIds: z.array(Id).min(1).max(20),
  }),
  freshness: z.strictObject({ asOf: Timestamp, expiresAt: Timestamp }),
  confidence: z.number().finite().min(0).max(1),
  rationale: z.string().trim().min(1).max(2_000),
  disposition: z.literal("recommendation-only"),
}).superRefine((link, context) => {
  const pairs: Record<
    typeof link.relationship,
    [typeof link.from.kind, typeof link.to.kind][]
  > = {
    duplicate_of: [["feedback", "feedback"]],
    related_signal: [["feedback", "signal"]],
    evidence_for_dossier: [["feedback", "dossier"], ["signal", "dossier"], [
      "triage",
      "dossier",
    ]],
    informed_decision: [["feedback", "decision"], ["signal", "decision"], [
      "triage",
      "decision",
    ], ["dossier", "decision"]],
    motivates_work_order: [
      ["feedback", "work_order"],
      ["signal", "work_order"],
      ["decision", "work_order"],
    ],
    represented_in_lineage: [["feedback", "product_lineage"], [
      "signal",
      "product_lineage",
    ], ["work_order", "product_lineage"]],
  };
  if (
    !pairs[link.relationship].some(([from, to]) =>
      from === link.from.kind && to === link.to.kind
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["relationship"],
      message: "relationship does not permit these artifact kinds",
    });
  }
  if (
    link.from.kind === link.to.kind &&
    link.from.artifactId === link.to.artifactId &&
    link.from.version === link.to.version && link.from.sha256 === link.to.sha256
  ) {
    context.addIssue({
      code: "custom",
      path: ["to"],
      message: "a relationship cannot target the same immutable artifact",
    });
  }
  if (Date.parse(link.observedAt) > Date.parse(link.linkedAt)) {
    context.addIssue({
      code: "custom",
      path: ["linkedAt"],
      message: "linkedAt must be at or after observedAt",
    });
  }
  if (Date.parse(link.linkedAt) > Date.parse(link.freshness.asOf)) {
    context.addIssue({
      code: "custom",
      path: ["freshness", "asOf"],
      message: "freshness asOf must be at or after linkedAt",
    });
  }
  if (Date.parse(link.freshness.asOf) > Date.parse(link.freshness.expiresAt)) {
    context.addIssue({
      code: "custom",
      path: ["freshness", "expiresAt"],
      message: "expiresAt must be at or after asOf",
    });
  }
  const endpointIds = new Set([link.from.artifactId, link.to.artifactId]);
  link.provenance.inputArtifactIds.forEach((id, index) => {
    if (!endpointIds.has(id)) {
      context.addIssue({
        code: "custom",
        path: ["provenance", "inputArtifactIds", index],
        message: "provenance inputs must name a relationship endpoint",
      });
    }
  });
});

/** Immutable record containing fresh, source-preserving lineage links. */
export const FeedbackLineageRecord = z.strictObject({
  schemaVersion: z.literal(FEEDBACK_LINEAGE_SCHEMA_VERSION),
  recordId: Id,
  recordVersion: Version,
  recordSha256: Hash,
  generatedAt: Timestamp,
  links: z.array(FeedbackLineageLink).min(1).max(FEEDBACK_LINEAGE_LIMITS.links),
  authority: z.strictObject({
    sideEffects: z.literal("none"),
    mayCloseSources: z.literal(false),
    mayMergeIdentities: z.literal(false),
    recommendationOnly: z.literal(true),
  }),
}).superRefine((record, context) => {
  const ids = new Set<string>();
  const semantic = new Set<string>();
  record.links.forEach((link, index) => {
    if (Date.parse(link.linkedAt) > Date.parse(record.generatedAt)) {
      context.addIssue({
        code: "custom",
        path: ["links", index, "linkedAt"],
        message: "links cannot postdate record generation",
      });
    }
    if (
      Date.parse(link.freshness.asOf) > Date.parse(record.generatedAt) ||
      Date.parse(link.freshness.expiresAt) < Date.parse(record.generatedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["links", index, "freshness"],
        message:
          "link evidence must be available and fresh at record generation",
      });
    }
    if (ids.has(link.linkId)) {
      context.addIssue({
        code: "custom",
        path: ["links", index, "linkId"],
        message: "duplicate linkId",
      });
    }
    ids.add(link.linkId);
    const key = [
      link.relationship,
      link.from.kind,
      link.from.artifactId,
      link.from.version,
      link.from.sha256,
      link.to.kind,
      link.to.artifactId,
      link.to.version,
      link.to.sha256,
    ].join("\u0000");
    if (semantic.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["links", index],
        message: "duplicate immutable relationship; identities remain separate",
      });
    }
    semantic.add(key);
  });
});

/** A validated feedback-lineage record. */
export type FeedbackLineageRecord = z.infer<typeof FeedbackLineageRecord>;

/** One stable validation diagnostic. */
export type FeedbackLineageDiagnostic = {
  path: string;
  code: string;
  message: string;
};

/** Result returned by deterministic lineage validation. */
export type FeedbackLineageEvaluation = {
  valid: true;
  value: FeedbackLineageRecord;
  diagnostics: [];
} | { valid: false; diagnostics: FeedbackLineageDiagnostic[] };

/** Validate a candidate record and return every diagnostic in stable order. */
export function evaluateFeedbackLineage(
  input: unknown,
): FeedbackLineageEvaluation {
  const result = FeedbackLineageRecord.safeParse(input);
  if (result.success) {
    return { valid: true, value: result.data, diagnostics: [] };
  }
  const diagnostics = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
    message: issue.message,
  }))
    .sort((a, b) =>
      a.path.localeCompare(b.path) || a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message)
    );
  return { valid: false, diagnostics };
}
