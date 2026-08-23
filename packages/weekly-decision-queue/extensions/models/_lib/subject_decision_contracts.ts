import { z } from "npm:zod@4";

const StableId = z.string().trim().min(1);
const NonEmptyString = z.string().trim().min(1);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const Timestamp = z.iso.datetime({ offset: true });

export const ArtifactSubject = z.strictObject({
  kind: NonEmptyString,
  id: StableId,
  version: z.number().int().positive(),
  sha256: Sha256,
});

export type ArtifactSubject = z.infer<typeof ArtifactSubject>;

const Actor = z.strictObject({
  id: StableId,
  role: NonEmptyString,
});

const Scope = z.strictObject({
  resource: NonEmptyString,
  allowedActions: z.array(NonEmptyString).min(1).superRefine(
    (actions, context) => {
      const firstIndex = new Map<string, number>();

      actions.forEach((action, index) => {
        if (firstIndex.has(action)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate action; first declared at index ${
              firstIndex.get(action)
            }`,
            path: [index],
          });
        } else {
          firstIndex.set(action, index);
        }
      });
    },
  ),
});

export const SubjectBoundDecision = z.strictObject({
  schemaVersion: z.literal("1.0"),
  decisionId: StableId,
  subject: ArtifactSubject,
  actor: Actor,
  decision: z.enum(["approved", "rejected", "changes_requested", "deferred"]),
  rationale: NonEmptyString,
  scope: Scope,
  decidedAt: Timestamp,
  expiresAt: Timestamp,
  allowedNextAction: NonEmptyString.optional(),
}).superRefine((value, context) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.decidedAt)) {
    context.addIssue({
      code: "custom",
      message: "expiresAt must be later than decidedAt",
      path: ["expiresAt"],
    });
  }

  if (value.decision === "approved") {
    if (value.allowedNextAction === undefined) {
      context.addIssue({
        code: "custom",
        message: "Approved decisions require allowedNextAction",
        path: ["allowedNextAction"],
      });
    } else if (!value.scope.allowedActions.includes(value.allowedNextAction)) {
      context.addIssue({
        code: "custom",
        message: "allowedNextAction must be one of scope.allowedActions",
        path: ["allowedNextAction"],
      });
    }
  } else if (value.allowedNextAction !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Non-approved decisions forbid allowedNextAction",
      path: ["allowedNextAction"],
    });
  }
});

export type SubjectBoundDecision = z.infer<typeof SubjectBoundDecision>;

export type ValidationDiagnostic = {
  path: string;
  code: string;
  message: string;
};

export type SubjectBoundDecisionValidation =
  | { success: true; data: SubjectBoundDecision; diagnostics: [] }
  | { success: false; diagnostics: ValidationDiagnostic[] };

function diagnosticPath(path: PropertyKey[]): string {
  return path.map(String).join(".");
}

export function validateSubjectBoundDecision(
  input: unknown,
): SubjectBoundDecisionValidation {
  const result = SubjectBoundDecision.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data, diagnostics: [] };
  }

  const diagnostics = result.error.issues.map((issue) => ({
    path: diagnosticPath(issue.path),
    code: issue.code,
    message: issue.message,
  }));

  diagnostics.sort((left, right) =>
    left.path.localeCompare(right.path) ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  );

  return { success: false, diagnostics };
}
