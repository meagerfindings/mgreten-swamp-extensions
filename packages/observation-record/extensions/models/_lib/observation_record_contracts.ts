import { z } from "npm:zod@4";

export const OBSERVATION_RECORD_SCHEMA_VERSION = "1.0" as const;

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const timestamp = z.iso.datetime({ offset: true });
const text = z.string().trim().min(1).max(2_000);

export const observationRecordInputSchema = z.strictObject({
  schemaVersion: z.literal(OBSERVATION_RECORD_SCHEMA_VERSION),
  observationId: id,
  observedAt: timestamp,
  sourceKind: z.enum([
    "direct_observer",
    "affected_person",
    "customer",
    "prospect",
    "system",
    "other",
  ]),
  evidenceKind: z.enum(["verbatim_quote", "summary", "event", "other"]),
  evidence: text,
  sourceNote: text.nullable(),
  recommendationDisposition: z.enum([
    "retain_only",
    "consider_as_hypothesis",
    "do_not_pursue",
  ]),
});
export type ObservationRecordInput = z.infer<
  typeof observationRecordInputSchema
>;

export const observationRecordSchema = observationRecordInputSchema.extend({
  evidenceStatus: z.literal("unvalidated_qualitative_signal"),
  sampleSize: z.literal(1),
  attribution: z.strictObject({
    identityStored: z.literal(false),
    privateSource: z.literal(true),
  }),
  authority: z.strictObject({
    disposition: z.literal("persistence_only"),
    validatedClaim: z.literal(false),
    decisionAuthority: z.literal(false),
    execution: z.literal(false),
    providerInvocation: z.literal(false),
    network: z.literal(false),
    publish: z.literal(false),
    externalCommunication: z.literal(false),
    spend: z.literal(false),
  }),
});
export type ObservationRecord = z.infer<typeof observationRecordSchema>;

/** Parses source evidence and adds invariants that make this record non-authorizing. */
export function retainObservationRecord(raw: unknown): ObservationRecord {
  const input = observationRecordInputSchema.parse(raw);
  return observationRecordSchema.parse({
    ...input,
    evidenceStatus: "unvalidated_qualitative_signal",
    sampleSize: 1,
    attribution: { identityStored: false, privateSource: true },
    authority: {
      disposition: "persistence_only",
      validatedClaim: false,
      decisionAuthority: false,
      execution: false,
      providerInvocation: false,
      network: false,
      publish: false,
      externalCommunication: false,
      spend: false,
    },
  });
}
