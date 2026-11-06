import { z } from "npm:zod@4";

export const OBSERVATION_RECORD_SCHEMA_VERSION = "1.0" as const;

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime({ offset: true });
const text = z.string().trim().min(1).max(2_000);

export const observationRecordInputSchema = z.strictObject({
  schemaVersion: z.literal(OBSERVATION_RECORD_SCHEMA_VERSION),
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
  provenance: z.strictObject({
    collectionMethod: z.enum(["direct", "import", "system_event", "other"]),
    collectedAt: timestamp,
    sourceLocatorHash: hash,
  }),
  freshness: z.strictObject({
    expiresAt: timestamp.nullable(),
  }),
  privacy: z.strictObject({
    classification: z.enum(["private", "restricted"]),
    identityStored: z.literal(false),
    personalDataStored: z.literal(false),
  }),
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
  observationId: hash,
  contentHash: hash,
  evidenceStatus: z.literal("unvalidated_qualitative_signal"),
  sampleSize: z.literal(1),
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

function canonicalContent(input: ObservationRecordInput): string {
  return JSON.stringify({
    schemaVersion: input.schemaVersion,
    observedAt: input.observedAt,
    sourceKind: input.sourceKind,
    evidenceKind: input.evidenceKind,
    evidence: input.evidence,
    sourceNote: input.sourceNote,
    provenance: input.provenance,
    freshness: input.freshness,
    privacy: input.privacy,
    recommendationDisposition: input.recommendationDisposition,
  });
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hexBytes = [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  );
  return hexBytes.join("");
}

/** Parses source evidence and adds invariants that make this record non-authorizing. */
export async function retainObservationRecord(
  raw: unknown,
): Promise<ObservationRecord> {
  const input = observationRecordInputSchema.parse(raw);
  const observedAt = Date.parse(input.observedAt);
  const collectedAt = Date.parse(input.provenance.collectedAt);
  const expiresAt = input.freshness.expiresAt === null
    ? null
    : Date.parse(input.freshness.expiresAt);
  if (observedAt > collectedAt) {
    throw new TypeError("observedAt must not be after provenance.collectedAt");
  }
  if (expiresAt !== null && expiresAt < collectedAt) {
    throw new TypeError("freshness.expiresAt must not be before collectedAt");
  }
  const contentHash = await sha256(canonicalContent(input));
  return observationRecordSchema.parse({
    ...input,
    observationId: contentHash,
    contentHash,
    evidenceStatus: "unvalidated_qualitative_signal",
    sampleSize: 1,
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
