/**
 * Strict, versioned contract for a three-lens decision review.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Schema version shared by prepared requests and validated review outputs. */
export const DECISION_REVIEW_LENS_SCHEMA_VERSION = "1.0" as const;

const Id = z.string().trim().min(1);
const Text = z.string().trim().min(1);
const Timestamp = z.iso.datetime({ offset: true });
const Confidence = z.number().finite().min(0).max(1);

const Evidence = z.strictObject({
  evidenceId: Id,
  claim: Text,
  provenance: z.strictObject({
    sourceId: Id,
    sourceType: z.enum([
      "research",
      "product-metric",
      "family-feedback",
      "decision-artifact",
      "experiment",
    ]),
    collectedBy: Id,
    collectedAt: Timestamp,
    method: Text,
  }),
});

const Finding = <T extends [string, ...string[]]>(categories: T) =>
  z.strictObject({
    category: z.enum(categories),
    assessment: Text,
    evidenceIds: z.array(Id).min(1),
    confidence: Confidence,
  });

const CustomerFinding = Finding([
  "target-family-capture",
  "preservation",
  "trust",
  "habit",
  "retention",
]);
const SkepticFinding = Finding([
  "weak-evidence",
  "selection-bias",
  "loud-request-bias",
  "confounding",
  "unnecessary-implementation",
  "causal-claim",
]);

const Authority = z.strictObject({
  disposition: z.literal("recommendation-only"),
  sideEffects: z.literal("none"),
  mayExecute: z.literal(false),
  mayApprove: z.literal(false),
  mayBypassGates: z.literal(false),
});

/** Strict public schema for an evidence-grounded, recommendation-only review. */
export const decisionReviewLensContractSchema = z.strictObject({
  schemaVersion: z.literal(DECISION_REVIEW_LENS_SCHEMA_VERSION),
  input: z.strictObject({
    reviewId: Id,
    decisionArtifactId: Id,
    decisionArtifactVersion: z.number().int().positive(),
    targetFamily: Text,
    question: Text,
    constraints: z.array(Text).min(1),
    requiredGates: z.array(Text).min(1),
    evidence: z.array(Evidence).min(1),
  }),
  output: z.strictObject({
    reviewId: Id,
    generatedAt: Timestamp,
    authority: Authority,
    lenses: z.strictObject({
      customerAdvocate: z.strictObject({
        lens: z.literal("customer-advocate"),
        findings: z.array(CustomerFinding).length(5),
        recommendation: Text,
        confidence: Confidence,
      }),
      skeptic: z.strictObject({
        lens: z.literal("skeptic"),
        findings: z.array(SkepticFinding).length(6),
        recommendation: Text,
        confidence: Confidence,
      }),
      dreamer: z.strictObject({
        lens: z.literal("dreamer"),
        findings: z.array(z.strictObject({
          alternativeId: Id,
          proposal: Text,
          leverage: z.enum(["higher-leverage", "10x"]),
          evidenceIds: z.array(Id).min(1),
          assumptions: z.array(Text).min(1),
          constraintsHonored: z.array(Text).min(1),
          gatesRequired: z.array(Text).min(1),
          authorityRequired: Text,
          confidence: Confidence,
        })).min(1),
        recommendation: Text,
        confidence: Confidence,
      }),
    }),
  }),
}).superRefine((contract, context) => {
  if (contract.output.reviewId !== contract.input.reviewId) {
    context.addIssue({
      code: "custom",
      path: ["output", "reviewId"],
      message: "output reviewId must match input reviewId",
    });
  }

  const evidenceIds = new Set<string>();
  contract.input.evidence.forEach((evidence, index) => {
    if (evidenceIds.has(evidence.evidenceId)) {
      context.addIssue({
        code: "custom",
        path: ["input", "evidence", index, "evidenceId"],
        message: "duplicate evidenceId",
      });
    }
    evidenceIds.add(evidence.evidenceId);
    if (
      Date.parse(evidence.provenance.collectedAt) >
        Date.parse(contract.output.generatedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["input", "evidence", index, "provenance", "collectedAt"],
        message: "evidence cannot be collected after the review",
      });
    }
  });

  const checkEvidence = (ids: string[], path: PropertyKey[]) =>
    ids.forEach((id, index) => {
      if (!evidenceIds.has(id)) {
        context.addIssue({
          code: "custom",
          path: [...path, index],
          message: "evidenceId must reference input evidence",
        });
      }
    });
  const requiredCategories = {
    customerAdvocate: [
      "target-family-capture",
      "preservation",
      "trust",
      "habit",
      "retention",
    ],
    skeptic: [
      "weak-evidence",
      "selection-bias",
      "loud-request-bias",
      "confounding",
      "unnecessary-implementation",
      "causal-claim",
    ],
  } as const;

  for (const lens of ["customerAdvocate", "skeptic"] as const) {
    contract.output.lenses[lens].findings.forEach((finding, index) => {
      if (finding.category !== requiredCategories[lens][index]) {
        context.addIssue({
          code: "custom",
          path: ["output", "lenses", lens, "findings", index, "category"],
          message: `required category at index ${index} is ${
            requiredCategories[lens][index]
          }`,
        });
      }
      checkEvidence(finding.evidenceIds, [
        "output",
        "lenses",
        lens,
        "findings",
        index,
        "evidenceIds",
      ]);
    });
  }

  contract.output.lenses.dreamer.findings.forEach((finding, index) => {
    checkEvidence(finding.evidenceIds, [
      "output",
      "lenses",
      "dreamer",
      "findings",
      index,
      "evidenceIds",
    ]);
    for (const constraint of finding.constraintsHonored) {
      if (!contract.input.constraints.includes(constraint)) {
        context.addIssue({
          code: "custom",
          path: [
            "output",
            "lenses",
            "dreamer",
            "findings",
            index,
            "constraintsHonored",
          ],
          message: "constraintsHonored must reference input constraints",
        });
      }
    }
    for (const gate of finding.gatesRequired) {
      if (!contract.input.requiredGates.includes(gate)) {
        context.addIssue({
          code: "custom",
          path: [
            "output",
            "lenses",
            "dreamer",
            "findings",
            index,
            "gatesRequired",
          ],
          message: "gatesRequired must reference input requiredGates",
        });
      }
    }
    if (
      new Set(finding.constraintsHonored).size !==
        finding.constraintsHonored.length ||
      !contract.input.constraints.every((constraint) =>
        finding.constraintsHonored.includes(constraint)
      )
    ) {
      context.addIssue({
        code: "custom",
        path: [
          "output",
          "lenses",
          "dreamer",
          "findings",
          index,
          "constraintsHonored",
        ],
        message: "every input constraint must be honored exactly once",
      });
    }
    if (
      new Set(finding.gatesRequired).size !== finding.gatesRequired.length ||
      !contract.input.requiredGates.every((gate) =>
        finding.gatesRequired.includes(gate)
      )
    ) {
      context.addIssue({
        code: "custom",
        path: [
          "output",
          "lenses",
          "dreamer",
          "findings",
          index,
          "gatesRequired",
        ],
        message: "every required input gate must remain required exactly once",
      });
    }
  });
});

/** Inferred TypeScript representation of the public review contract. */
export type DecisionReviewLensContract = z.infer<
  typeof decisionReviewLensContractSchema
>;

/** A deterministic, path-addressed contract validation diagnostic. */
export type DecisionReviewLensDiagnostic = {
  path: string;
  code: string;
  message: string;
};

/** Successful or failed result of contract validation. */
export type DecisionReviewLensValidation =
  | { success: true; data: DecisionReviewLensContract; diagnostics: [] }
  | { success: false; diagnostics: DecisionReviewLensDiagnostic[] };

/** Validate unknown input without throwing and return sorted diagnostics on failure. */
export function validateDecisionReviewLensContract(
  input: unknown,
): DecisionReviewLensValidation {
  const result = decisionReviewLensContractSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data, diagnostics: [] };
  }
  const diagnostics = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
    message: issue.message,
  }))
    .sort((a, b) =>
      a.path.localeCompare(b.path) || a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message)
    );
  return { success: false, diagnostics };
}
