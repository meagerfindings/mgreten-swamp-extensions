import { z } from "npm:zod@4";

export const SOURCE_REFERENCE_SCHEMA_VERSION = "1.0" as const;

const timestamp = z.iso.datetime({ offset: true });
const identifier = z.string().trim().min(1).max(200);

/** Provider-neutral provenance and bounded freshness metadata for one source. */
export const sourceReferenceSchema = z.strictObject({
  schemaVersion: z.literal(SOURCE_REFERENCE_SCHEMA_VERSION),
  sourceId: identifier,
  source: z.strictObject({
    system: identifier,
    resourceType: identifier,
    resourceId: identifier,
  }),
  provenance: z.strictObject({
    collector: identifier,
    collectorVersion: identifier,
    method: identifier,
    collectedAt: timestamp,
  }),
  observedAt: timestamp,
  freshness: z.strictObject({
    asOf: timestamp,
    expiresAt: timestamp,
  }),
  sensitivity: z.enum(["public", "internal"]),
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
