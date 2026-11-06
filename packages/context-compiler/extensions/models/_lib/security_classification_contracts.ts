import { z } from "npm:zod@4";

export const SECURITY_CLASSIFICATION_SCHEMA_VERSION = "1.0" as const;

export const securityClassificationSchema = z.enum([
  "public",
  "private-project",
  "company-internal",
  "customer-sensitive",
  "credential",
  "regulated",
  "prohibited-export",
]);

export type SecurityClassification = z.infer<
  typeof securityClassificationSchema
>;

const destinationSchema = z.enum([
  "public-channel",
  "project-members",
  "company-workforce",
  "authorized-customer-team",
  "compliance-boundary",
  "secrets-runtime",
  "internal-model",
  "external-model",
]);

const nonEmpty = z.string().trim().min(1);
const uniqueDestinations = z.array(destinationSchema).superRefine(
  (values, context) => {
    const seen = new Map<string, number>();
    values.forEach((value, index) => {
      const first = seen.get(value);
      if (first === undefined) seen.set(value, index);
      else {context.addIssue({
          code: "custom",
          path: [index],
          message: `duplicate destination (first at index ${first})`,
        });}
    });
  },
);

export const handlingPolicySchema = z.strictObject({
  schemaVersion: z.literal(SECURITY_CLASSIFICATION_SCHEMA_VERSION),
  classification: securityClassificationSchema,
  allowedDestinations: uniqueDestinations,
  processingBoundary: z.enum([
    "unrestricted",
    "project",
    "company",
    "customer-team",
    "regulated",
    "secrets-runtime",
    "export-controlled",
  ]),
  export: z.enum(["external-allowed", "internal-only", "prohibited"]),
  modelAccess: z.enum(["external-allowed", "internal-only", "prohibited"]),
  redaction: z.strictObject({
    required: z.boolean(),
    method: z.enum([
      "none",
      "minimize",
      "remove-identifiers",
      "remove-secrets",
    ]),
  }),
  retention: z.strictObject({
    mode: z.enum([
      "standard",
      "purpose-limited",
      "ephemeral",
      "regulated-schedule",
    ]),
    maxDays: z.number().int().positive().nullable(),
  }),
  logging: z.strictObject({
    content: z.enum(["allowed", "redacted-only", "prohibited"]),
    metadata: z.enum(["allowed", "minimal"]),
  }),
  authority: z.strictObject({
    approvalRequired: z.boolean(),
    approverRole: nonEmpty.nullable(),
    purposeScope: nonEmpty.nullable(),
  }),
}).superRefine((policy, context) => {
  const issue = (path: (string | number)[], message: string) =>
    context.addIssue({ code: "custom", path, message });
  const has = (destination: z.infer<typeof destinationSchema>) =>
    policy.allowedDestinations.includes(destination);

  if (has("external-model") && policy.modelAccess !== "external-allowed") {
    issue(
      ["allowedDestinations"],
      "external-model requires external-allowed modelAccess",
    );
  }
  if (policy.modelAccess === "external-allowed" && !has("external-model")) {
    issue(
      ["modelAccess"],
      "external-allowed modelAccess requires the external-model destination",
    );
  }
  if (policy.redaction.required === (policy.redaction.method === "none")) {
    issue(
      ["redaction", "method"],
      policy.redaction.required
        ? "required redaction needs a method"
        : "a redaction method requires redaction",
    );
  }
  if (
    policy.authority.approvalRequired &&
    (!policy.authority.approverRole || !policy.authority.purposeScope)
  ) {
    issue(
      ["authority"],
      "approval requires an approverRole and narrow purposeScope",
    );
  }
  if (
    !policy.authority.approvalRequired &&
    (policy.authority.approverRole || policy.authority.purposeScope)
  ) {
    issue(
      ["authority"],
      "authority details are forbidden when approval is not required",
    );
  }

  const externalForbidden = policy.classification === "credential" ||
    policy.classification === "prohibited-export";
  if (
    externalForbidden &&
    (has("external-model") || policy.modelAccess === "external-allowed")
  ) {
    issue(
      ["modelAccess"],
      `${policy.classification} content cannot be sent to external models`,
    );
  }
  if (externalForbidden && policy.export !== "prohibited") {
    issue(["export"], `${policy.classification} export must be prohibited`);
  }

  const expectedBoundary: Record<
    SecurityClassification,
    typeof policy.processingBoundary
  > = {
    "public": "unrestricted",
    "private-project": "project",
    "company-internal": "company",
    "customer-sensitive": "customer-team",
    "credential": "secrets-runtime",
    "regulated": "regulated",
    "prohibited-export": "export-controlled",
  };
  if (policy.processingBoundary !== expectedBoundary[policy.classification]) {
    issue(
      ["processingBoundary"],
      `classification requires the ${
        expectedBoundary[policy.classification]
      } boundary`,
    );
  }

  if (
    ["private-project", "company-internal", "customer-sensitive", "regulated"]
      .includes(policy.classification) && policy.export !== "internal-only"
  ) {
    issue(["export"], `${policy.classification} export must be internal-only`);
  }
  if (
    [
      "private-project",
      "company-internal",
      "customer-sensitive",
      "regulated",
      "prohibited-export",
    ].includes(policy.classification) && policy.modelAccess !== "internal-only"
  ) {
    issue(
      ["modelAccess"],
      `${policy.classification} model access must be internal-only`,
    );
  }
  if (
    policy.classification === "credential" &&
    policy.modelAccess !== "prohibited"
  ) {
    issue(["modelAccess"], "credential model access must be prohibited");
  }
  if (["customer-sensitive", "regulated"].includes(policy.classification)) {
    if (!policy.authority.approvalRequired) {
      issue(["authority", "approvalRequired"], "explicit approval is required");
    }
    if (
      policy.retention.mode === "standard" || policy.retention.maxDays === null
    ) issue(["retention"], "retention must be explicitly purpose-limited");
    if (policy.logging.content === "allowed") {
      issue(
        ["logging", "content"],
        "sensitive content cannot be logged unredacted",
      );
    }
  }
  if (policy.classification === "credential") {
    if (
      policy.allowedDestinations.some((value) => value !== "secrets-runtime")
    ) {
      issue(
        ["allowedDestinations"],
        "credentials are restricted to secrets-runtime",
      );
    }
    if (
      !policy.redaction.required || policy.redaction.method !== "remove-secrets"
    ) issue(["redaction"], "credentials require secret removal");
    if (
      policy.retention.mode !== "ephemeral" ||
      policy.logging.content !== "prohibited"
    ) {
      issue(
        ["retention"],
        "credentials require ephemeral retention and no content logging",
      );
    }
  }
});

export type HandlingPolicy = z.infer<typeof handlingPolicySchema>;
export interface ValidationDiagnostic {
  path: string;
  code: string;
  message: string;
}
export type ValidationResult = {
  success: true;
  data: HandlingPolicy;
  diagnostics: [];
} | { success: false; diagnostics: ValidationDiagnostic[] };

export function validateHandlingPolicy(input: unknown): ValidationResult {
  const result = handlingPolicySchema.safeParse(input);
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
