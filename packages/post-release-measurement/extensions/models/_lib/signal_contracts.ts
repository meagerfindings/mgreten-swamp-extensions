import { z } from "npm:zod@4";

export const SIGNAL_SCHEMA_VERSION = "1.0" as const;

const timestampSchema = z.iso.datetime({ offset: true });
const identifierSchema = z.string().trim().min(1).max(200);

/** Identifies the measurement source and its provenance and freshness bounds. */
export const sourceReferenceSchema = z.strictObject({
  schemaVersion: z.literal(SIGNAL_SCHEMA_VERSION),
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

export type SourceReference = z.infer<typeof sourceReferenceSchema>;
