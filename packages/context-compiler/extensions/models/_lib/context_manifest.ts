import { z } from "npm:zod@4";
import {
  type SourceReference,
  sourceReferenceSchema,
} from "./signal_contracts.ts";

export const CONTEXT_MANIFEST_SCHEMA_VERSION = "1.0" as const;

const identifierSchema = z.string().trim().min(1);
const timestampSchema = z.iso.datetime({ offset: true });

const contextSourceSchema = z.strictObject({
  sourceReference: sourceReferenceSchema,
  contentHash: z.string().regex(
    /^[0-9a-f]{64}$/,
    "contentHash must be a lowercase 64-character SHA-256 hash",
  ),
  tokenEstimate: z.number().int().nonnegative(),
});

export const contextManifestSchema = z.strictObject({
  schemaVersion: z.literal(CONTEXT_MANIFEST_SCHEMA_VERSION),
  manifestId: identifierSchema,
  purpose: identifierSchema,
  sources: z.array(contextSourceSchema).min(1),
  observedAt: timestampSchema,
  freshness: z.strictObject({
    asOf: timestampSchema,
    expiresAt: timestampSchema,
  }),
  sensitivity: z.enum(["public", "internal", "confidential", "restricted"]),
  confidence: z.number().finite().min(0).max(1),
  tokenBudget: z.strictObject({
    maxTokens: z.number().int().positive(),
    estimatedTokens: z.number().int().nonnegative(),
  }),
  roleEligibility: z.array(identifierSchema).min(1),
}).superRefine((manifest, context) => {
  const observedAt = Date.parse(manifest.observedAt);
  const asOf = Date.parse(manifest.freshness.asOf);
  const expiresAt = Date.parse(manifest.freshness.expiresAt);

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
  if (manifest.tokenBudget.estimatedTokens > manifest.tokenBudget.maxTokens) {
    context.addIssue({
      code: "custom",
      path: ["tokenBudget", "estimatedTokens"],
      message: "estimatedTokens must not exceed maxTokens",
    });
  }

  const tokenSum = manifest.sources.reduce(
    (sum, source) => sum + source.tokenEstimate,
    0,
  );
  if (tokenSum !== manifest.tokenBudget.estimatedTokens) {
    context.addIssue({
      code: "custom",
      path: ["tokenBudget", "estimatedTokens"],
      message: "estimatedTokens must equal the sum of source token estimates",
    });
  }

  const sourceIds = new Map<string, number>();
  manifest.sources.forEach((source, index) => {
    const id = source.sourceReference.sourceId;
    const firstIndex = sourceIds.get(id);
    if (firstIndex === undefined) sourceIds.set(id, index);
    else {context.addIssue({
        code: "custom",
        path: ["sources", index, "sourceReference", "sourceId"],
        message: `duplicate source ID (first at index ${firstIndex})`,
      });}

    if (observedAt < Date.parse(source.sourceReference.observedAt)) {
      context.addIssue({
        code: "custom",
        path: ["observedAt"],
        message: `observedAt must be at or after source ${index} observedAt`,
      });
    }
    if (expiresAt > Date.parse(source.sourceReference.freshness.expiresAt)) {
      context.addIssue({
        code: "custom",
        path: ["freshness", "expiresAt"],
        message: `expiresAt must not exceed source ${index} expiresAt`,
      });
    }
  });

  const roles = new Map<string, number>();
  manifest.roleEligibility.forEach((role, index) => {
    const firstIndex = roles.get(role);
    if (firstIndex === undefined) roles.set(role, index);
    else {context.addIssue({
        code: "custom",
        path: ["roleEligibility", index],
        message: `duplicate role (first at index ${firstIndex})`,
      });}
  });
});

export type ContextManifestSource = z.infer<typeof contextSourceSchema> & {
  sourceReference: SourceReference;
};
export type ContextManifest = z.infer<typeof contextManifestSchema>;

export interface ContextManifestValidationIssue {
  path: string;
  code: string;
  message: string;
}

export type ContextManifestValidationResult =
  | { valid: true; value: ContextManifest; issues: [] }
  | { valid: false; issues: ContextManifestValidationIssue[] };

export function validateContextManifest(
  input: unknown,
): ContextManifestValidationResult {
  const result = contextManifestSchema.safeParse(input);
  if (result.success) return { valid: true, value: result.data, issues: [] };

  const issues = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
    message: issue.message,
  })).sort((left, right) =>
    left.path.localeCompare(right.path) ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  );
  return { valid: false, issues };
}
