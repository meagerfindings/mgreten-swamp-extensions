import { z } from "npm:zod@4";
import { sourceReferenceSchema } from "./signal_contracts.ts";
import {
  type SecurityClassification,
  securityClassificationSchema,
} from "./security_classification_contracts.ts";

export const ROLE_CONTEXT_PACK_SCHEMA_VERSION = "1.0" as const;
export const ROLE_CONTEXT_PACK_MAX_TOKENS = 2_000 as const;

export const roleContextRoleSchema = z.enum([
  "feedback-triage",
  "operations",
  "product-direction",
  "marketing",
  "factory-planning",
  "implementing",
  "review",
]);
export type RoleContextRole = z.infer<typeof roleContextRoleSchema>;

export const roleContextSourceCategorySchema = z.enum([
  "user-feedback",
  "service-health",
  "incident-record",
  "product-outcome",
  "product-strategy",
  "market-research",
  "campaign-performance",
  "marketing-decision-context",
  "work-item",
  "implementation-evidence",
  "review-artifact",
]);
export type RoleContextSourceCategory = z.infer<
  typeof roleContextSourceCategorySchema
>;

type RolePolicy = {
  purpose: string;
  capabilities: readonly string[];
  categories: readonly RoleContextSourceCategory[];
  sensitivityCeiling: SecurityClassification;
  allowedClasses: readonly SecurityClassification[];
  exclusions: readonly string[];
};

/** Fixed, data-free least-privilege policy. Packs may narrow it, never broaden it. */
export const ROLE_CONTEXT_POLICIES = {
  "feedback-triage": {
    purpose: "Classify and route user feedback",
    capabilities: ["classify-feedback", "route-feedback"],
    categories: ["user-feedback"],
    sensitivityCeiling: "customer-sensitive",
    allowedClasses: ["public", "private-project", "customer-sensitive"],
    exclusions: [
      "campaign-performance",
      "incident-record",
      "product-strategy",
      "work-item",
    ],
  },
  "operations": {
    purpose: "Assess service health and coordinate incidents",
    capabilities: ["assess-service-health", "coordinate-incident"],
    categories: [
      "service-health",
      "incident-record",
      "implementation-evidence",
    ],
    sensitivityCeiling: "company-internal",
    allowedClasses: ["public", "private-project", "company-internal"],
    exclusions: [
      "campaign-performance",
      "product-strategy",
      "user-feedback",
      "work-item",
    ],
  },
  "product-direction": {
    purpose: "Evaluate product outcomes and direction",
    capabilities: ["evaluate-product-outcomes", "propose-product-direction"],
    categories: ["product-outcome", "product-strategy", "user-feedback"],
    sensitivityCeiling: "customer-sensitive",
    allowedClasses: ["public", "private-project", "customer-sensitive"],
    exclusions: [
      "campaign-performance",
      "incident-record",
      "implementation-evidence",
      "work-item",
    ],
  },
  "marketing": {
    purpose: "Plan and evaluate market communication",
    capabilities: ["evaluate-campaign", "plan-market-communication"],
    categories: ["marketing-decision-context"],
    sensitivityCeiling: "private-project",
    allowedClasses: ["public", "private-project"],
    exclusions: [
      "campaign-performance",
      "incident-record",
      "market-research",
      "product-outcome",
      "product-strategy",
      "user-feedback",
      "work-item",
    ],
  },
  "factory-planning": {
    purpose: "Plan bounded implementation work",
    capabilities: ["decompose-work-item", "plan-implementation"],
    categories: ["product-strategy", "work-item"],
    sensitivityCeiling: "private-project",
    allowedClasses: ["public", "private-project"],
    exclusions: ["campaign-performance", "incident-record", "user-feedback"],
  },
  "implementing": {
    purpose: "Execute an already-approved bounded work item",
    capabilities: ["execute-approved-work-item"],
    categories: ["product-strategy", "work-item"],
    sensitivityCeiling: "private-project",
    allowedClasses: ["public", "private-project"],
    exclusions: [
      "campaign-performance",
      "incident-record",
      "user-feedback",
      "service-health",
      "product-outcome",
      "market-research",
      "implementation-evidence",
      "review-artifact",
    ],
  },
  "review": {
    purpose: "Review implementation against its authorized work",
    capabilities: ["assess-implementation-evidence", "verify-work-item"],
    categories: ["implementation-evidence", "review-artifact", "work-item"],
    sensitivityCeiling: "private-project",
    allowedClasses: ["public", "private-project"],
    exclusions: [
      "campaign-performance",
      "incident-record",
      "product-strategy",
      "user-feedback",
    ],
  },
} as const satisfies Record<RoleContextRole, RolePolicy>;

const nonEmpty = z.string().trim().min(1);
const sha256 = z.string().regex(
  /^[0-9a-f]{64}$/,
  "must be a lowercase 64-character SHA-256 hash",
);
const unique = <T extends z.ZodTypeAny>(item: T, label: string) =>
  z.array(item).min(1).superRefine((values, context) => {
    const seen = new Map<unknown, number>();
    values.forEach((value, index) => {
      const first = seen.get(value);
      if (first === undefined) seen.set(value, index);
      else {context.addIssue({
          code: "custom",
          path: [index],
          message: `duplicate ${label} (first at index ${first})`,
        });}
    });
  });

const manifestIdentitySchema = z.strictObject({
  manifestId: nonEmpty,
  contentHash: sha256,
});
const sourceLocatorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("source-reference"),
    sourceReference: sourceReferenceSchema,
  }),
  z.strictObject({
    kind: z.literal("context-manifest"),
    manifest: manifestIdentitySchema,
  }),
]);
const packSourceSchema = z.strictObject({
  category: roleContextSourceCategorySchema,
  classification: securityClassificationSchema,
  locator: sourceLocatorSchema,
  tokenEstimate: z.number().int().positive(),
});

export const roleContextPackSchema = z.strictObject({
  schemaVersion: z.literal(ROLE_CONTEXT_PACK_SCHEMA_VERSION),
  packId: nonEmpty,
  role: roleContextRoleSchema,
  requestedRole: roleContextRoleSchema,
  purpose: nonEmpty,
  capabilities: unique(nonEmpty, "capability"),
  allowedSourceCategories: unique(
    roleContextSourceCategorySchema,
    "source category",
  ),
  sensitivity: z.strictObject({
    ceiling: securityClassificationSchema,
    allowedClasses: unique(securityClassificationSchema, "security class"),
  }),
  explicitExclusions: unique(roleContextSourceCategorySchema, "exclusion"),
  sources: z.array(packSourceSchema),
  tokenBudget: z.strictObject({
    maxTokens: z.number().int().positive().max(ROLE_CONTEXT_PACK_MAX_TOKENS),
    estimatedTokens: z.number().int().nonnegative().max(
      ROLE_CONTEXT_PACK_MAX_TOKENS,
    ),
  }),
}).superRefine((pack, context) => {
  const deny = (path: (string | number)[], message: string) =>
    context.addIssue({ code: "custom", path, message });
  const policy = ROLE_CONTEXT_POLICIES[pack.role];
  const same = (actual: readonly string[], expected: readonly string[]) =>
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);

  if (pack.requestedRole !== pack.role) {
    deny(["requestedRole"], "requestedRole must match role");
  }
  if (pack.purpose !== policy.purpose) {
    deny(["purpose"], "purpose is not authorized for role");
  }
  if (!same(pack.capabilities, policy.capabilities)) {
    deny(
      ["capabilities"],
      "capabilities must exactly match the role's minimal capabilities",
    );
  }
  if (!same(pack.allowedSourceCategories, policy.categories)) {
    deny(
      ["allowedSourceCategories"],
      "source categories must exactly match the role's least-privilege policy",
    );
  }
  if (pack.sensitivity.ceiling !== policy.sensitivityCeiling) {
    deny(
      ["sensitivity", "ceiling"],
      "sensitivity ceiling is not authorized for role",
    );
  }
  if (!same(pack.sensitivity.allowedClasses, policy.allowedClasses)) {
    deny(
      ["sensitivity", "allowedClasses"],
      "security classes must exactly match the role's least-privilege policy",
    );
  }
  if (!same(pack.explicitExclusions, policy.exclusions)) {
    deny(
      ["explicitExclusions"],
      "explicit exclusions must exactly match the role policy",
    );
  }

  const identities = new Map<string, number>();
  const authorizedCategories: readonly RoleContextSourceCategory[] =
    policy.categories;
  const authorizedClasses: readonly SecurityClassification[] =
    policy.allowedClasses;
  pack.sources.forEach((source, index) => {
    if (!authorizedCategories.includes(source.category)) {
      deny(
        ["sources", index, "category"],
        `category ${source.category} is unauthorized or irrelevant for role ${pack.role}`,
      );
    }
    if (!authorizedClasses.includes(source.classification)) {
      deny(
        ["sources", index, "classification"],
        `classification ${source.classification} exceeds role access`,
      );
    }
    const identity = source.locator.kind === "source-reference"
      ? `source:${source.locator.sourceReference.sourceId}`
      : `manifest:${source.locator.manifest.manifestId}:${source.locator.manifest.contentHash}`;
    const first = identities.get(identity);
    if (first === undefined) identities.set(identity, index);
    else {deny(
        ["sources", index, "locator"],
        `duplicate source (first at index ${first})`,
      );}
  });
  const total = pack.sources.reduce(
    (sum, source) => sum + source.tokenEstimate,
    0,
  );
  if (pack.tokenBudget.estimatedTokens !== total) {
    deny(
      ["tokenBudget", "estimatedTokens"],
      "estimatedTokens must equal the source token total",
    );
  }
  if (pack.tokenBudget.estimatedTokens > pack.tokenBudget.maxTokens) {
    deny(
      ["tokenBudget", "estimatedTokens"],
      "estimatedTokens must not exceed maxTokens",
    );
  }
});

export type RoleContextPack = z.infer<typeof roleContextPackSchema>;
export interface RoleContextPackDiagnostic {
  path: string;
  code: string;
  message: string;
}
export type RoleContextPackValidationResult =
  | { success: true; data: RoleContextPack; diagnostics: [] }
  | { success: false; diagnostics: RoleContextPackDiagnostic[] };

export function validateRoleContextPack(
  input: unknown,
): RoleContextPackValidationResult {
  const result = roleContextPackSchema.safeParse(input);
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
