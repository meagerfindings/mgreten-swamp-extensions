/** Versioned, domain-neutral source provenance contracts. @module */
import { z } from "npm:zod@4";

/** The schema version used by source references. */
export const SOURCE_REFERENCE_SCHEMA_VERSION = "1.0" as const;

const timestampSchema = z.iso.datetime({ offset: true });
const identifierSchema = z.string().trim().min(1);

/** A provenance envelope that identifies, dates, and classifies one source. */
export const sourceReferenceSchema = z.strictObject({
  schemaVersion: z.literal(SOURCE_REFERENCE_SCHEMA_VERSION),
  sourceId: identifierSchema,
  source: z.strictObject({
    system: identifierSchema,
    accountId: identifierSchema.optional(),
    resourceType: identifierSchema,
    resourceId: identifierSchema,
  }),
  provenance: z.strictObject({
    collector: identifierSchema,
    collectorVersion: identifierSchema,
    method: identifierSchema,
    collectedAt: timestampSchema,
  }),
  observedAt: timestampSchema,
  freshness: z.strictObject({
    asOf: timestampSchema,
    expiresAt: timestampSchema,
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

/** Parsed source-reference value. */
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
