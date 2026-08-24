import { z } from "npm:zod@4";

/** Published model contract version. */
export const CONTEXT_COMPILER_MODEL_VERSION = "2026.08.23.1" as const;
/** Maximum source references accepted in one compilation. */
export const MAX_SOURCES = 100 as const;
/** Maximum operating entries accepted in one packet. */
export const MAX_ENTRIES = 100 as const;
/** Hard upper bound for a caller-supplied token budget. */
export const MAX_TOKENS = 100_000 as const;

const Id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const Role = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
const Text = z.string().trim().min(1).max(2_000);
const Timestamp = z.iso.datetime({ offset: true });
const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const AuthorityAttestation = z.literal("reference-only-advisory-no-authority");
const ReplayPolicy = z.literal("reject-conflicting-replay");

const unique = <T extends z.ZodTypeAny>(schema: T, label: string) =>
  z.array(schema).min(1).max(MAX_SOURCES).superRefine((values, context) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      const key = typeof value === "string" ? value : canonical(value);
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: `duplicate ${label}`,
        });
      }
      seen.add(key);
    });
  });

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b)
      ).map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
        .join(",")
    }}`;
  }
  return JSON.stringify(value);
};

const usageSchema = z.strictObject({
  utf8Bytes: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  measurement: z.literal("ceil-utf8-bytes-divided-by-4"),
});

const usage = (value: unknown) => {
  const utf8Bytes = new TextEncoder().encode(canonical(value)).byteLength;
  return {
    utf8Bytes,
    estimatedTokens: Math.ceil(utf8Bytes / 4),
    measurement: "ceil-utf8-bytes-divided-by-4" as const,
  };
};

const registryProvenanceSchema = z.strictObject({
  collector: Text,
  collectorVersion: Text,
  method: Text,
  collectedAt: Timestamp,
  contentDigest: Digest,
});

const candidateSchema = z.strictObject({
  sourceId: Id,
  sourceVersion: Text,
  tokenEstimate: z.number().int().positive().max(MAX_TOKENS),
  evidence: z.strictObject({
    reference: Text,
    observedAt: Timestamp,
    expiresAt: Timestamp,
    cited: z.literal(true),
    minimized: z.literal(true),
  }),
});

/** Strict input contract used by bounded reference-context workflows. */
export const compileRegisteredArgumentsSchema = z.strictObject({
  manifestId: Id,
  packId: Id,
  purpose: z.string().trim().min(1).max(500),
  role: Role,
  roleTaxonomy: unique(Role, "role"),
  evaluatedAt: Timestamp,
  freshnessMaxAgeSeconds: z.number().int().positive(),
  maxTokens: z.number().int().positive().max(MAX_TOKENS),
  registryRecordName: Id,
  registrySourceIds: unique(Id, "registry source ID"),
  registryGeneratedAt: Timestamp,
  registryProvenance: registryProvenanceSchema,
  candidates: z.array(candidateSchema).min(1).max(MAX_SOURCES),
  replayPolicy: ReplayPolicy,
  authorityAttestation: AuthorityAttestation,
});

const compiledSourceSchema = z.strictObject({
  sourceId: Id,
  sourceVersion: Text,
  reference: Text,
  observedAt: Timestamp,
  expiresAt: Timestamp,
  tokenEstimate: z.number().int().positive(),
  cited: z.literal(true),
  minimized: z.literal(true),
});

/** Stored reference-only context and role-pack contract. */
export const compiledContextSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  manifest: z.strictObject({
    manifestId: Id,
    purpose: z.string().trim().min(1).max(500),
    evaluatedAt: Timestamp,
    expiresAt: Timestamp,
    registry: z.strictObject({
      recordName: Id,
      generatedAt: Timestamp,
      provenance: registryProvenanceSchema,
    }),
    sources: z.array(compiledSourceSchema).min(1).max(MAX_SOURCES),
    tokenBudget: z.strictObject({
      maxTokens: z.number().int().positive(),
      estimatedTokens: z.number().int().nonnegative(),
    }),
  }),
  rolePack: z.strictObject({
    packId: Id,
    role: Role,
    roleTaxonomy: z.array(Role).min(1),
    sourceIds: z.array(Id).min(1),
  }),
  usage: usageSchema,
  replayPolicy: ReplayPolicy,
  sideEffectAuthority: z.literal("none"),
});

/** Deterministically compile fresh registered references without retrieving content. */
export function compileRegistered(input: unknown) {
  const args = compileRegisteredArgumentsSchema.parse(input);
  if (!args.roleTaxonomy.includes(args.role)) {
    throw new TypeError(`role ${args.role} is absent from roleTaxonomy`);
  }
  if (Date.parse(args.registryGeneratedAt) > Date.parse(args.evaluatedAt)) {
    throw new TypeError("registry is from the future");
  }
  if (
    Date.parse(args.registryProvenance.collectedAt) >
      Date.parse(args.evaluatedAt)
  ) throw new TypeError("registry provenance is from the future");
  const registered = new Set(args.registrySourceIds);
  const byId = new Map<string, z.infer<typeof candidateSchema>>();
  for (const candidate of args.candidates) {
    if (!registered.has(candidate.sourceId)) {
      throw new TypeError(`unregistered source ${candidate.sourceId}`);
    }
    const observed = Date.parse(candidate.evidence.observedAt);
    const evaluated = Date.parse(args.evaluatedAt);
    if (observed > evaluated) {
      throw new TypeError(`source ${candidate.sourceId} is from the future`);
    }
    if (evaluated >= Date.parse(candidate.evidence.expiresAt)) {
      throw new TypeError(`source ${candidate.sourceId} is stale`);
    }
    if (evaluated - observed > args.freshnessMaxAgeSeconds * 1_000) {
      throw new TypeError(
        `source ${candidate.sourceId} exceeds freshness bound`,
      );
    }
    const prior = byId.get(candidate.sourceId);
    if (prior && canonical(prior) !== canonical(candidate)) {
      throw new TypeError(`conflicting duplicate source ${candidate.sourceId}`);
    }
    byId.set(candidate.sourceId, candidate);
  }
  const candidates = [...byId.values()].sort((a, b) =>
    a.sourceId.localeCompare(b.sourceId)
  );
  const estimatedTokens = candidates.reduce(
    (sum, candidate) => sum + candidate.tokenEstimate,
    0,
  );
  if (estimatedTokens > args.maxTokens) {
    throw new TypeError(
      `source token total ${estimatedTokens} exceeds budget ${args.maxTokens}`,
    );
  }
  const payload = {
    schemaVersion: "1.0" as const,
    manifest: {
      manifestId: args.manifestId,
      purpose: args.purpose,
      evaluatedAt: args.evaluatedAt,
      expiresAt:
        candidates.map((candidate) => candidate.evidence.expiresAt).sort()[0],
      registry: {
        recordName: args.registryRecordName,
        generatedAt: args.registryGeneratedAt,
        provenance: args.registryProvenance,
      },
      sources: candidates.map((candidate) => ({
        sourceId: candidate.sourceId,
        sourceVersion: candidate.sourceVersion,
        reference: candidate.evidence.reference,
        observedAt: candidate.evidence.observedAt,
        expiresAt: candidate.evidence.expiresAt,
        tokenEstimate: candidate.tokenEstimate,
        cited: true as const,
        minimized: true as const,
      })),
      tokenBudget: { maxTokens: args.maxTokens, estimatedTokens },
    },
    rolePack: {
      packId: args.packId,
      role: args.role,
      roleTaxonomy: [...args.roleTaxonomy],
      sourceIds: candidates.map((candidate) => candidate.sourceId),
    },
    replayPolicy: args.replayPolicy,
    sideEffectAuthority: "none" as const,
  };
  return compiledContextSchema.parse({ ...payload, usage: usage(payload) });
}

const constitutionInputSchema = z.strictObject({
  artifactId: Id,
  version: Text,
  policyRef: Text,
  observedAt: Timestamp,
  contentDigest: Digest,
  cited: z.literal(true),
  minimized: z.literal(true),
});
/** Strict input contract for a minimized durable policy reference. */
export const compileConstitutionArgumentsSchema = z.strictObject({
  constitution: constitutionInputSchema,
  replayPolicy: ReplayPolicy,
  authorityAttestation: AuthorityAttestation,
});
/** Stored authority-free constitution-reference contract. */
export const constitutionSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  constitution: constitutionInputSchema,
  replayPolicy: ReplayPolicy,
  sideEffectAuthority: z.literal("none"),
});
/** Preserve a caller-supplied, content-hash-bound policy reference. */
export function compileConstitution(input: unknown) {
  const args = compileConstitutionArgumentsSchema.parse(input);
  return constitutionSchema.parse({
    schemaVersion: "1.0",
    constitution: args.constitution,
    replayPolicy: args.replayPolicy,
    sideEffectAuthority: "none",
  });
}

const packetEntrySchema = z.strictObject({
  entryId: Id,
  kind: z.string().trim().min(1).max(100),
  summary: Text,
  confidence: z.enum(["low", "medium", "high"]),
  sensitivity: z.enum(["public", "internal", "confidential", "restricted"]),
  observedAt: Timestamp,
  expiresAt: Timestamp,
  sourceRef: Text,
  sourceVersion: Text,
  cited: z.literal(true),
  minimized: z.literal(true),
});
/** Strict input contract used by bounded operating-context workflows. */
export const compileOperatingPacketArgumentsSchema = z.strictObject({
  packetId: Id,
  generatedAt: Timestamp,
  expiresAt: Timestamp,
  entries: z.array(packetEntrySchema).min(1).max(MAX_ENTRIES),
  contentAttestation: z.literal("minimized-no-secrets-no-private-content"),
  replayPolicy: ReplayPolicy,
  authorityAttestation: AuthorityAttestation,
});
/** Stored fresh, minimized operating-packet contract. */
export const operatingPacketSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  packetId: Id,
  generatedAt: Timestamp,
  expiresAt: Timestamp,
  entries: z.array(packetEntrySchema).min(1).max(MAX_ENTRIES),
  usage: usageSchema,
  contentAttestation: z.literal("minimized-no-secrets-no-private-content"),
  replayPolicy: ReplayPolicy,
  sideEffectAuthority: z.literal("none"),
});
/** Deterministically compile and order a bounded operating packet. */
export function compileOperatingPacket(input: unknown) {
  const args = compileOperatingPacketArgumentsSchema.parse(input);
  if (Date.parse(args.generatedAt) >= Date.parse(args.expiresAt)) {
    throw new TypeError("packet expiresAt must follow generatedAt");
  }
  const ids = new Set<string>();
  for (const entry of args.entries) {
    if (ids.has(entry.entryId)) {
      throw new TypeError(`duplicate entryId ${entry.entryId}`);
    }
    ids.add(entry.entryId);
    if (Date.parse(entry.observedAt) > Date.parse(args.generatedAt)) {
      throw new TypeError(`entry ${entry.entryId} is from the future`);
    }
    if (Date.parse(entry.expiresAt) <= Date.parse(args.generatedAt)) {
      throw new TypeError(`entry ${entry.entryId} is stale`);
    }
    if (Date.parse(entry.expiresAt) > Date.parse(args.expiresAt)) {
      throw new TypeError(`entry ${entry.entryId} outlives packet`);
    }
  }
  const entries = [...args.entries].sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.entryId.localeCompare(b.entryId)
  );
  const payload = {
    schemaVersion: "1.0" as const,
    packetId: args.packetId,
    generatedAt: args.generatedAt,
    expiresAt: args.expiresAt,
    entries,
    contentAttestation: args.contentAttestation,
    replayPolicy: args.replayPolicy,
    sideEffectAuthority: "none" as const,
  };
  return operatingPacketSchema.parse({ ...payload, usage: usage(payload) });
}

type ModelContext = {
  logger: { info(message: string, properties?: Record<string, unknown>): void };
  readResource(name: string): Promise<Record<string, unknown> | null>;
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<unknown>;
};
const persist = async (
  spec: string,
  name: string,
  output: Record<string, unknown>,
  schema: z.ZodTypeAny,
  context: ModelContext,
) => {
  const existing = await context.readResource(name);
  if (existing) {
    if (canonical(schema.parse(existing)) !== canonical(output)) {
      throw new TypeError(`conflicting replay for ${name}`);
    }
    context.logger.info(
      "Artifact {name} already exists with identical content",
      { name },
    );
    return { dataHandles: [] };
  }
  const handle = await context.writeResource(spec, name, output);
  context.logger.info("Persisted authority-free artifact {name}", { name });
  return { dataHandles: [handle] };
};

/** Swamp model export with persistence-only, idempotent compiler methods. */
export const model = {
  type: "@mgreten/context-compiler",
  version: CONTEXT_COMPILER_MODEL_VERSION,
  globalArguments: z.strictObject({}),
  resources: {
    context: {
      description: "Fresh reference-only context manifest and role pack",
      schema: compiledContextSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    constitution: {
      description: "Caller-supplied minimized durable policy reference",
      schema: constitutionSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    operatingPacket: {
      description: "Fresh minimized operating context references",
      schema: operatingPacketSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    compileRegistered: {
      description:
        "Compile registered fresh references into bounded role context",
      arguments: compileRegisteredArgumentsSchema,
      execute: async (args: unknown, context: ModelContext) => {
        context.logger.info("Compiling reference context {manifestId}", {
          manifestId: (args as { manifestId: string }).manifestId,
        });
        const output = compileRegistered(args);
        return await persist(
          "context",
          output.manifest.manifestId,
          output,
          compiledContextSchema,
          context,
        );
      },
    },
    compileConstitution: {
      description: "Persist a minimized content-hash-bound policy reference",
      arguments: compileConstitutionArgumentsSchema,
      execute: async (args: unknown, context: ModelContext) => {
        context.logger.info("Compiling constitution reference", {});
        const output = compileConstitution(args);
        return await persist(
          "constitution",
          output.constitution.artifactId,
          output,
          constitutionSchema,
          context,
        );
      },
    },
    compileOperatingPacket: {
      description: "Compile a fresh bounded operating packet",
      arguments: compileOperatingPacketArgumentsSchema,
      execute: async (args: unknown, context: ModelContext) => {
        context.logger.info("Compiling operating packet {packetId}", {
          packetId: (args as { packetId: string }).packetId,
        });
        const output = compileOperatingPacket(args);
        return await persist(
          "operatingPacket",
          output.packetId,
          output,
          operatingPacketSchema,
          context,
        );
      },
    },
  },
};
