import { z } from "npm:zod@4";

/** Version of the operational digest model and persisted resource contract. */
export const OPERATIONAL_DIGEST_MODEL_VERSION = "2026.08.23.1" as const;
/** Hard output budgets that keep every generated digest bounded. */
export const DIGEST_LIMITS = {
  itemsPerSection: 5,
  totalItems: 24,
  bytes: 16_384,
  tokens: 8_192,
} as const;
/** Required sections in the canonical order used by persisted digests. */
export const DIGEST_SECTIONS = [
  "new-signals",
  "active-incidents",
  "worsening-errors",
  "operational-attention",
  "anomalies",
  "requires-attention",
] as const;

const text = z.string().trim().min(1).max(500);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/);
const timestamp = z.iso.datetime({ offset: true });
const severity = z.enum(["info", "low", "medium", "high", "critical"]);

/**
 * Validates a redacted evidence citation, including source identity,
 * provenance timestamps, freshness, and sensitivity classification.
 */
export const normalizedEvidenceReferenceSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  sourceId: identifier,
  source: z.strictObject({
    system: text.max(120),
    resourceType: text.max(120),
    resourceId: text.max(200),
  }),
  provenance: z.strictObject({
    collector: text.max(120),
    collectorVersion: text.max(120),
    method: text.max(120),
    collectedAt: timestamp,
  }),
  observedAt: timestamp,
  freshness: z.strictObject({ asOf: timestamp, expiresAt: timestamp }),
  sensitivity: z.enum(["public", "internal", "confidential", "restricted"]),
  redacted: z.literal(true),
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

const itemSchema = z.strictObject({
  itemId: text.max(120),
  dedupeKey: text.max(160),
  severity,
  observedAt: timestamp,
  summary: text,
  recommendation: text,
  sourceIds: z.array(identifier).min(1).max(5),
});
const sectionSchema = z.discriminatedUnion("availability", [
  z.strictObject({
    section: z.enum(DIGEST_SECTIONS),
    availability: z.literal("available"),
    missingReason: z.null(),
    sourceReferences: z.array(normalizedEvidenceReferenceSchema).min(1).max(5),
    items: z.array(itemSchema).max(10),
  }),
  z.strictObject({
    section: z.enum(DIGEST_SECTIONS),
    availability: z.literal("missing"),
    missingReason: text,
    sourceReferences: z.array(z.never()).length(0),
    items: z.array(z.never()).length(0),
  }),
]);

/** Validates the complete caller input required to build one daily digest. */
export const buildOperationalDigestArgumentsSchema = z.strictObject({
  digestId: identifier,
  generatedAt: timestamp,
  sections: z.array(sectionSchema).length(DIGEST_SECTIONS.length),
});

/** Validates the bounded, recommendation-only digest persisted by the model. */
export const operationalDigestSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  digestId: identifier,
  generatedAt: timestamp,
  purpose: z.literal("decision-oriented-operational-digest"),
  authority: z.strictObject({
    mode: z.literal("recommendation-only"),
    sideEffects: z.literal("none"),
    agentInvocation: z.literal("none"),
  }),
  truncated: z.boolean(),
  sections: z.array(sectionSchema).length(DIGEST_SECTIONS.length),
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
const itemOrder = (
  a: z.infer<typeof itemSchema>,
  b: z.infer<typeof itemSchema>,
) =>
  rank[b.severity] - rank[a.severity] ||
  a.observedAt.localeCompare(b.observedAt) || a.itemId.localeCompare(b.itemId);

/** Builds a deterministic digest from caller-supplied normalized evidence only. */
export function buildOperationalDigest(input: unknown) {
  const args = buildOperationalDigestArgumentsSchema.parse(input);
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
  let truncated = false;
  const sections = DIGEST_SECTIONS.map((name) => {
    const value = bySection.get(name)!;
    if (value.availability === "missing") return value;
    const sourceReferences = [...value.sourceReferences].sort((a, b) =>
      a.sourceId.localeCompare(b.sourceId)
    );
    sourceReferences.forEach((reference) => {
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
      sourceReferences.map((reference) => reference.sourceId),
    );
    const unique = new Map<string, z.infer<typeof itemSchema>>();
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
    const candidates = [...unique.values()].sort(itemOrder);
    const items = candidates.slice(
      0,
      Math.min(DIGEST_LIMITS.itemsPerSection, remaining),
    );
    if (items.length < candidates.length) truncated = true;
    remaining -= items.length;
    return { ...value, sourceReferences, items };
  });
  const limitsBase = {
    maxItemsPerSection: 5 as const,
    maxTotalItems: 24 as const,
    maxBytes: 16_384 as const,
    maxTokens: 8_192 as const,
    tokenMeasurement: "unicode-code-points-upper-bound" as const,
  };
  let bytes = 0, tokens = 0;
  let base;
  while (true) {
    base = {
      schemaVersion: "1.0" as const,
      digestId: args.digestId,
      generatedAt: args.generatedAt,
      purpose: "decision-oriented-operational-digest" as const,
      authority: {
        mode: "recommendation-only" as const,
        sideEffects: "none" as const,
        agentInvocation: "none" as const,
      },
      truncated,
      sections,
    };
    bytes = 0;
    tokens = 0;
    for (let iteration = 0; iteration < 10; iteration++) {
      const encoded = canonical({
        ...base,
        limits: { ...limitsBase, bytes, tokens },
      });
      const nextBytes = new TextEncoder().encode(encoded).byteLength;
      const nextTokens = [...encoded].length;
      if (nextBytes === bytes && nextTokens === tokens) break;
      bytes = nextBytes;
      tokens = nextTokens;
    }
    if (bytes <= DIGEST_LIMITS.bytes && tokens <= DIGEST_LIMITS.tokens) break;
    const section = [...sections].reverse().find((value) =>
      value.availability === "available" && value.items.length > 0
    );
    if (!section || section.availability !== "available") {
      throw new TypeError(
        `digest metadata exceeds output budget: ${bytes} bytes, ${tokens} tokens`,
      );
    }
    section.items.pop();
    truncated = true;
  }
  return operationalDigestSchema.parse({
    ...base,
    limits: {
      ...limitsBase,
      bytes,
      tokens,
    },
  });
}

/**
 * Swamp model definition that persists a digest built only from the caller's
 * normalized evidence, without network calls or operational side effects.
 */
export const model = {
  type: "@mgreten/daily-operational-digest",
  version: OPERATIONAL_DIGEST_MODEL_VERSION,
  globalArguments: z.strictObject({}),
  resources: {
    digest: {
      description:
        "Bounded, source-cited, recommendation-only operational digest",
      schema: operationalDigestSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    build: {
      description:
        "Build a digest from normalized explicit inputs without external calls or side effects",
      arguments: buildOperationalDigestArgumentsSchema,
      execute: async (
        args: z.infer<typeof buildOperationalDigestArgumentsSchema>,
        context: {
          writeResource: (
            spec: string,
            name: string,
            data: z.infer<typeof operationalDigestSchema>,
          ) => Promise<unknown>;
        },
      ) => {
        const handle = await context.writeResource(
          "digest",
          args.digestId,
          buildOperationalDigest(args),
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
