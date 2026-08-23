/** Contracts and validation for non-authoritative, cross-source evidence. @module */
import { z } from "npm:zod@4";
import { sourceReferenceSchema } from "./source_reference_contracts.ts";

/** The version of the cross-source cluster contract. */
export const CROSS_SOURCE_EVIDENCE_SCHEMA_VERSION = "1.0" as const;
/** Supported, general-purpose source categories. Kept stable for compatibility. */
export const CROSS_SOURCE_EVIDENCE_DOMAINS = [
  "feedback",
  "telemetry",
  "product_behavior",
  "economics",
  "support",
  "factory_findings",
] as const;

const identifier = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(4_000);
const timestamp = z.iso.datetime({ offset: true });
const domain = z.enum(CROSS_SOURCE_EVIDENCE_DOMAINS);

/** One caller-supplied observation with its retained source provenance. */
export const crossSourceEvidenceItemSchema = z.strictObject({
  evidenceId: identifier,
  domain,
  sourceReference: sourceReferenceSchema,
  observation: text,
});
/** A non-causal hypothesis relating preserved observations. */
export const crossSourceRelationshipSchema = z.strictObject({
  relationshipId: identifier,
  evidenceIds: z.array(identifier).min(2).max(100),
  type: z.enum([
    "corroborates",
    "contradicts",
    "co_occurs",
    "may_explain",
    "contextualizes",
  ]),
  confidence: z.number().finite().min(0).max(1),
  rationale: text,
  semantics: z.literal("hypothesis_not_causation"),
});

/** A canonical, recommendation-only cluster of evidence from multiple domains. */
export const crossSourceEvidenceClusterSchema = z.strictObject({
  schemaVersion: z.literal(CROSS_SOURCE_EVIDENCE_SCHEMA_VERSION),
  clusterId: text,
  evaluatedAt: timestamp,
  hypothesis: text,
  claimSemantics: z.literal("hypothesis_not_causation"),
  evidence: z.array(crossSourceEvidenceItemSchema).min(2).max(100),
  relationships: z.array(crossSourceRelationshipSchema).min(1).max(200),
  missingDomains: z.array(domain).max(CROSS_SOURCE_EVIDENCE_DOMAINS.length),
  recommendation: z.strictObject({
    action: text,
    rationale: text,
    authority: z.literal("recommendation_only"),
  }),
  sideEffectAuthority: z.literal("none"),
}).superRefine((cluster, context) => {
  const add = (path: PropertyKey[], message: string): void =>
    context.addIssue({ code: "custom", path, message });
  const evidenceIds = new Map<string, number>();
  const sourceIds = new Map<string, number>();
  const relationshipIds = new Map<string, number>();
  const presentDomains = new Set(cluster.evidence.map((item) => item.domain));
  cluster.evidence.forEach((item, index) => {
    const priorEvidence = evidenceIds.get(item.evidenceId);
    if (priorEvidence === undefined) evidenceIds.set(item.evidenceId, index);
    else {add(
        ["evidence", index, "evidenceId"],
        `duplicate evidenceId (first at index ${priorEvidence})`,
      );}
    const priorSource = sourceIds.get(item.sourceReference.sourceId);
    if (priorSource === undefined) {
      sourceIds.set(item.sourceReference.sourceId, index);
    } else {add(
        ["evidence", index, "sourceReference", "sourceId"],
        `duplicate sourceId (first at index ${priorSource}); sources must not be flattened or duplicated`,
      );}
    if (
      Date.parse(item.sourceReference.freshness.asOf) >
        Date.parse(cluster.evaluatedAt)
    ) {
      add(
        ["evidence", index, "sourceReference", "freshness", "asOf"],
        "source freshness asOf must not be after evaluatedAt",
      );
    }
    if (
      Date.parse(item.sourceReference.freshness.expiresAt) <=
        Date.parse(cluster.evaluatedAt)
    ) {
      add(
        ["evidence", index, "sourceReference", "freshness", "expiresAt"],
        "source must be fresh at evaluatedAt",
      );
    }
  });
  if (presentDomains.size < 2) {
    add(
      ["evidence"],
      "a cross-source cluster requires at least two source domains",
    );
  }
  cluster.relationships.forEach((relationship, index) => {
    const prior = relationshipIds.get(relationship.relationshipId);
    if (prior === undefined) {
      relationshipIds.set(relationship.relationshipId, index);
    } else {add(
        ["relationships", index, "relationshipId"],
        `duplicate relationshipId (first at index ${prior})`,
      );}
    const members = new Set<string>();
    relationship.evidenceIds.forEach((id, memberIndex) => {
      if (members.has(id)) {
        add(
          ["relationships", index, "evidenceIds", memberIndex],
          "duplicate evidenceId in relationship",
        );
      }
      members.add(id);
      if (!evidenceIds.has(id)) {
        add(
          ["relationships", index, "evidenceIds", memberIndex],
          "evidenceId must reference preserved cluster evidence",
        );
      }
    });
    const relationshipDomains = new Set(
      relationship.evidenceIds.map((id) =>
        cluster.evidence.find((item) => item.evidenceId === id)?.domain
      ).filter(Boolean),
    );
    if (relationshipDomains.size < 2) {
      add(
        ["relationships", index, "evidenceIds"],
        "relationship must connect at least two source domains",
      );
    }
  });
  const expectedMissing = CROSS_SOURCE_EVIDENCE_DOMAINS.filter((candidate) =>
    !presentDomains.has(candidate)
  );
  const suppliedMissing = [...cluster.missingDomains].sort(compareText);
  if (new Set(cluster.missingDomains).size !== cluster.missingDomains.length) {
    add(["missingDomains"], "missingDomains must not contain duplicates");
  }
  if (
    JSON.stringify(suppliedMissing) !==
      JSON.stringify([...expectedMissing].sort(compareText))
  ) {
    add(
      ["missingDomains"],
      "missingDomains must disclose exactly every source domain absent from evidence",
    );
  }
}).transform((cluster) => ({
  ...cluster,
  evidence: [...cluster.evidence].sort((a, b) =>
    compareText(a.evidenceId, b.evidenceId)
  ),
  relationships: [...cluster.relationships].map((relationship) => ({
    ...relationship,
    evidenceIds: [...relationship.evidenceIds].sort(compareText),
  })).sort((a, b) => compareText(a.relationshipId, b.relationshipId)),
  missingDomains: [...cluster.missingDomains].sort(compareText),
}));

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A successfully normalized cluster. */
export type CrossSourceEvidenceCluster = z.output<
  typeof crossSourceEvidenceClusterSchema
>;
/** A deterministic validation diagnostic. */
export type CrossSourceEvidenceDiagnostic = {
  path: string;
  code: string;
  message: string;
};
/** The result of contract validation. */
export type CrossSourceEvidenceEvaluation = {
  success: true;
  value: CrossSourceEvidenceCluster;
  diagnostics: [];
} | { success: false; diagnostics: CrossSourceEvidenceDiagnostic[] };

/** Validate and canonically order a candidate cross-source evidence cluster. */
export function evaluateCrossSourceEvidence(
  input: unknown,
): CrossSourceEvidenceEvaluation {
  const result = crossSourceEvidenceClusterSchema.safeParse(input);
  if (result.success) {
    return { success: true, value: result.data, diagnostics: [] };
  }
  const diagnostics = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
    message: issue.message,
  })).sort((a, b) =>
    compareText(a.path, b.path) || compareText(a.code, b.code) ||
    compareText(a.message, b.message)
  );
  return { success: false, diagnostics };
}

/** Backward-compatible alias for evaluateCrossSourceEvidence. */
export const validateCrossSourceEvidenceCluster = evaluateCrossSourceEvidence;
