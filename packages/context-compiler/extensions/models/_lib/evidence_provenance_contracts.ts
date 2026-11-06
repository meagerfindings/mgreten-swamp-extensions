import { z } from "npm:zod@4";

export const EVIDENCE_PROVENANCE_SCHEMA_VERSION = "1.0" as const;

const identifier = z.string().trim().min(1);
const timestamp = z.iso.datetime({ offset: true });
const sha256 = z.string().regex(
  /^[0-9a-f]{64}$/,
  "contentHash must be a lowercase 64-character SHA-256 hash",
);

export const evidenceProvenanceSchema = z.strictObject({
  schemaVersion: z.literal(EVIDENCE_PROVENANCE_SCHEMA_VERSION),
  evidenceId: identifier,
  source: z.strictObject({
    sourceId: identifier,
    system: identifier,
    resourceType: identifier,
    resourceId: identifier,
    resourceVersion: identifier,
    contentHash: sha256,
    resourcePath: identifier,
    sourceClass: z.enum([
      "current_snapshot",
      "immutable_history",
      "immutable_ledger",
      "versioned_record",
    ]),
    volatility: z.enum(["volatile", "immutable"]),
  }),
  provenance: z.strictObject({
    collector: identifier,
    collectorVersion: identifier,
    method: identifier,
    collectedAt: timestamp,
  }),
  observedAt: timestamp,
  asOf: timestamp,
  expiresAt: timestamp,
  evaluationTime: timestamp,
  confidence: z.number().finite().min(0).max(1),
  freshnessPolicy: z.strictObject({
    maxAgeSeconds: z.number().int().nonnegative(),
  }),
  authoritativePurpose: z.enum([
    "current_estimate",
    "billing_history",
    "general_fact",
  ]),
}).superRefine((evidence, context) => {
  const observed = Date.parse(evidence.observedAt);
  const collected = Date.parse(evidence.provenance.collectedAt);
  const asOf = Date.parse(evidence.asOf);
  const expires = Date.parse(evidence.expiresAt);
  const evaluated = Date.parse(evidence.evaluationTime);
  const issue = (path: PropertyKey[], message: string) =>
    context.addIssue({ code: "custom", path, message });

  if (collected < observed) {
    issue(
      ["provenance", "collectedAt"],
      "collectedAt must be at or after observedAt",
    );
  }
  if (collected > asOf) {
    issue(
      ["provenance", "collectedAt"],
      "collectedAt must be at or before asOf",
    );
  }
  if (collected > evaluated) {
    issue(
      ["provenance", "collectedAt"],
      "collectedAt must not be in the future at evaluationTime",
    );
  }
  if (asOf < observed) issue(["asOf"], "asOf must be at or after observedAt");
  if (expires < asOf) {
    issue(["expiresAt"], "expiresAt must be at or after asOf");
  }
  if (evaluated < asOf) {
    issue(["evaluationTime"], "evaluationTime must be at or after asOf");
  }
  if (observed > evaluated) {
    issue(
      ["observedAt"],
      "observedAt must not be in the future at evaluationTime",
    );
  }
  if (evaluated > expires) {
    issue(["evaluationTime"], "evidence is expired at evaluationTime");
  }
  if (evaluated - asOf > evidence.freshnessPolicy.maxAgeSeconds * 1000) {
    issue(
      ["freshnessPolicy", "maxAgeSeconds"],
      "evidence exceeds maxAgeSeconds at evaluationTime",
    );
  }

  if (
    evidence.source.volatility === "volatile" &&
    (!evidence.source.resourceVersion.trim() ||
      !evidence.source.contentHash.trim())
  ) {
    issue(
      ["source"],
      "volatile evidence requires an exact resourceVersion and contentHash",
    );
  }
  if (
    evidence.source.sourceClass === "current_snapshot" &&
    evidence.source.volatility !== "volatile"
  ) {
    issue(
      ["source", "volatility"],
      "current_snapshot sources must be volatile",
    );
  }
  if (
    ["immutable_history", "immutable_ledger"].includes(
      evidence.source.sourceClass,
    ) && evidence.source.volatility !== "immutable"
  ) {
    issue(
      ["source", "volatility"],
      "historical and ledger sources must be immutable",
    );
  }
  if (
    evidence.authoritativePurpose === "billing_history" &&
    !["immutable_history", "immutable_ledger"].includes(
      evidence.source.sourceClass,
    )
  ) {
    issue(
      ["authoritativePurpose"],
      "billing_history requires an immutable historical or ledger source; metrics/current is never authoritative billing history",
    );
  }
  if (
    evidence.authoritativePurpose === "billing_history" &&
    evidence.source.resourcePath === "metrics/current"
  ) {
    issue(
      ["source", "resourcePath"],
      "metrics/current is never authoritative billing history",
    );
  }
});

export type EvidenceProvenance = z.infer<typeof evidenceProvenanceSchema>;
export interface EvidenceProvenanceDiagnostic {
  path: string;
  code: string;
  message: string;
}
export type EvidenceProvenanceValidation =
  | { success: true; data: EvidenceProvenance; diagnostics: [] }
  | { success: false; diagnostics: EvidenceProvenanceDiagnostic[] };

export function validateEvidenceProvenance(
  input: unknown,
): EvidenceProvenanceValidation {
  const result = evidenceProvenanceSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data, diagnostics: [] };
  }
  const diagnostics = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
    message: issue.message,
  })).sort((a, b) =>
    a.path.localeCompare(b.path) || a.code.localeCompare(b.code) ||
    a.message.localeCompare(b.message)
  );
  return { success: false, diagnostics };
}
