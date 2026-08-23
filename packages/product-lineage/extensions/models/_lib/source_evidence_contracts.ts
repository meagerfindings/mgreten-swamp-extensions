/** Shared source-evidence contracts for product lineage. @module */
import { z } from "npm:zod@4";

const Timestamp = z.iso.datetime({ offset: true });
const Identifier = z.string().trim().min(1);

/** A source observation and the provenance needed to audit it. */
export const sourceEvidenceReferenceSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  sourceId: Identifier,
  source: z.strictObject({
    system: Identifier,
    accountId: Identifier.optional(),
    resourceType: Identifier,
    resourceId: Identifier,
  }),
  provenance: z.strictObject({
    collector: Identifier,
    collectorVersion: Identifier,
    method: Identifier,
    collectedAt: Timestamp,
  }),
  observedAt: Timestamp,
  freshness: z.strictObject({
    asOf: Timestamp,
    expiresAt: Timestamp,
  }),
  sensitivity: z.enum(["public", "internal", "confidential", "restricted"]),
}).superRefine((reference, context) => {
  const observedAt = Date.parse(reference.observedAt);
  const asOf = Date.parse(reference.freshness.asOf);
  const expiresAt = Date.parse(reference.freshness.expiresAt);
  const collectedAt = Date.parse(reference.provenance.collectedAt);

  if (observedAt > asOf) {
    context.addIssue({
      code: "custom",
      path: ["freshness", "asOf"],
      message: "asOf must be at or after observedAt",
    });
  }
  if (asOf > expiresAt) {
    context.addIssue({
      code: "custom",
      path: ["freshness", "expiresAt"],
      message: "expiresAt must be at or after asOf",
    });
  }
  if (collectedAt < observedAt) {
    context.addIssue({
      code: "custom",
      path: ["provenance", "collectedAt"],
      message: "collectedAt must be at or after observedAt",
    });
  }
});

/** The parsed shape of a source evidence reference. */
export type SourceEvidenceReference = z.infer<
  typeof sourceEvidenceReferenceSchema
>;
