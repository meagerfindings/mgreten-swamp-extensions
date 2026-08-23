import { z } from "npm:zod@4";
import { sourceReferenceSchema } from "./signal_contracts.ts";
import { ArtifactSubject } from "./subject_decision_contracts.ts";

export const DECISION_DOSSIER_SCHEMA_VERSION = "1.0" as const;

const Id = z.string().trim().min(1);
const Text = z.string().trim().min(1);
const Timestamp = z.iso.datetime({ offset: true });
const EvidenceIds = z.array(Id).superRefine(unique("duplicate evidenceId"));

function unique(message: string) {
  return (values: string[], context: z.RefinementCtx) => {
    const seen = new Map<string, number>();
    values.forEach((value, index) => {
      const first = seen.get(value);
      if (first === undefined) seen.set(value, index);
      else {context.addIssue({
          code: "custom",
          path: [index],
          message: `${message} (first at index ${first})`,
        });}
    });
  };
}

function addDuplicateIssues(
  values: string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
) {
  const seen = new Map<string, number>();
  values.forEach((value, index) => {
    const first = seen.get(value);
    if (first === undefined) seen.set(value, index);
    else {context.addIssue({
        code: "custom",
        path: [...path, index],
        message: `${message} (first at index ${first})`,
      });}
  });
}

const Evidence = z.strictObject({
  evidenceId: Id,
  claim: Text,
  sourceReference: sourceReferenceSchema,
});

const Option = z.strictObject({
  optionId: Id,
  kind: z.enum(["action", "do_nothing"]),
  title: Text,
  description: Text,
  evidenceIds: EvidenceIds,
});

const Effort = z.strictObject({
  size: z.enum(["extra_small", "small", "medium", "large", "extra_large"]),
  status: z.enum(["observed", "hypothetical"]),
  estimate: z.number().finite().nonnegative(),
  unit: Text,
  rationale: Text,
  evidenceIds: EvidenceIds,
  assumptions: z.array(Text),
}).superRefine((effort, context) => {
  if (effort.status === "observed" && effort.evidenceIds.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["evidenceIds"],
      message: "observed effort requires evidence",
    });
  }
  if (effort.status === "hypothetical" && effort.assumptions.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["assumptions"],
      message: "hypothetical effort requires at least one assumption",
    });
  }
});

const EstimateBase = z.strictObject({
  estimateId: Id,
  optionId: Id,
  label: Text,
  direction: z.enum(["cost", "benefit"]),
  status: z.enum(["observed", "hypothetical"]),
  asOf: Timestamp,
  evidenceIds: EvidenceIds,
  assumptions: z.array(Text),
  sourceReference: sourceReferenceSchema.optional(),
});

const EconomicEstimate = z.discriminatedUnion("valueType", [
  EstimateBase.extend({
    valueType: z.literal("monetary"),
    value: z.number().finite(),
    currency: z.string().regex(
      /^[A-Z]{3}$/,
      "currency must be a three-letter uppercase code",
    ),
    unit: z.literal("currency"),
  }),
  EstimateBase.extend({
    valueType: z.literal("quantity"),
    value: z.number().finite(),
    unit: Text,
  }),
]).superRefine((estimate, context) => {
  if (
    estimate.status === "observed" && estimate.sourceReference === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["sourceReference"],
      message:
        "observed estimates require sourceReference provenance and freshness",
    });
  }
  if (estimate.status === "hypothetical" && estimate.assumptions.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["assumptions"],
      message: "hypothetical estimates require at least one assumption",
    });
  }
});

const Window = z.strictObject({ startsAt: Timestamp, endsAt: Timestamp })
  .superRefine((window, context) => {
    if (Date.parse(window.endsAt) <= Date.parse(window.startsAt)) {
      context.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "endsAt must be later than startsAt",
      });
    }
  });

const Metric = z.strictObject({
  metricId: Id,
  name: Text,
  unit: Text,
  desiredDirection: z.enum(["increase", "decrease", "maintain"]),
  target: z.number().finite(),
});

export const DecisionDossier = z.strictObject({
  schemaVersion: z.literal(DECISION_DOSSIER_SCHEMA_VERSION),
  dossierId: Id,
  subject: ArtifactSubject,
  version: z.number().int().positive(),
  createdAt: Timestamp,
  problem: z.strictObject({
    statement: Text,
    scope: Text,
    evidenceIds: EvidenceIds,
  }),
  affectedSegment: z.strictObject({
    segmentId: Id,
    label: Text,
    definition: Text,
    evidenceIds: EvidenceIds,
  }),
  confidence: z.strictObject({
    level: z.enum(["low", "medium", "high"]),
    rationale: Text,
    evidenceIds: EvidenceIds,
  }),
  strategicFit: z.strictObject({
    alignment: z.enum(["aligned", "neutral", "conflict"]),
    rationale: Text,
    principleIds: z.array(Id).min(1).superRefine(
      unique("duplicate principleId"),
    ),
    evidenceIds: EvidenceIds,
  }),
  evidence: z.array(Evidence).min(1),
  options: z.array(Option).min(2),
  recommendation: z.strictObject({
    optionId: Id,
    rationale: Text,
    evidenceIds: EvidenceIds,
  }),
  effort: Effort,
  economics: z.strictObject({
    estimates: z.array(EconomicEstimate),
    summary: Text,
  }),
  risks: z.array(z.strictObject({
    riskId: Id,
    description: Text,
    likelihood: z.enum(["low", "medium", "high"]),
    impact: z.enum(["low", "medium", "high"]),
    mitigation: Text,
    ownerId: Id,
    evidenceIds: EvidenceIds,
  })),
  authority: z.strictObject({
    decisionMaker: z.strictObject({ id: Id, role: Text }),
    authorityBasis: Text,
    decisionDueAt: Timestamp,
  }),
  expectedOutcomes: z.array(
    z.strictObject({
      outcomeId: Id,
      statement: Text,
      metricIds: z.array(Id).min(1).superRefine(unique("duplicate metricId")),
    }),
  ).min(1),
  measurementPlan: z.strictObject({
    metrics: z.array(Metric).min(1),
    windows: z.array(
      z.strictObject({ windowId: Id, purpose: Text, window: Window }),
    ).min(1),
    ownerId: Id,
    reviewAt: Timestamp,
  }),
}).superRefine((dossier, context) => {
  const evidenceIds = new Set(dossier.evidence.map((item) => item.evidenceId));
  const optionIds = new Set(dossier.options.map((item) => item.optionId));
  const metricIds = new Set(
    dossier.measurementPlan.metrics.map((item) => item.metricId),
  );

  for (
    const [values, path, message] of [
      [
        dossier.evidence.map((x) => x.evidenceId),
        ["evidence"],
        "duplicate evidenceId",
      ],
      [
        dossier.options.map((x) => x.optionId),
        ["options"],
        "duplicate optionId",
      ],
      [dossier.economics.estimates.map((x) => x.estimateId), [
        "economics",
        "estimates",
      ], "duplicate estimateId"],
      [dossier.risks.map((x) => x.riskId), ["risks"], "duplicate riskId"],
      [
        dossier.expectedOutcomes.map((x) => x.outcomeId),
        ["expectedOutcomes"],
        "duplicate outcomeId",
      ],
      [dossier.measurementPlan.metrics.map((x) => x.metricId), [
        "measurementPlan",
        "metrics",
      ], "duplicate metricId"],
      [dossier.measurementPlan.windows.map((x) => x.windowId), [
        "measurementPlan",
        "windows",
      ], "duplicate windowId"],
    ] as const
  ) addDuplicateIssues([...values], context, [...path], message);

  const checkEvidence = (ids: string[], path: PropertyKey[]) =>
    ids.forEach((id, index) => {
      if (!evidenceIds.has(id)) {
        context.addIssue({
          code: "custom",
          path: [...path, index],
          message: "evidenceId must reference top-level evidence",
        });
      }
    });
  checkEvidence(dossier.problem.evidenceIds, ["problem", "evidenceIds"]);
  checkEvidence(dossier.affectedSegment.evidenceIds, [
    "affectedSegment",
    "evidenceIds",
  ]);
  checkEvidence(dossier.confidence.evidenceIds, ["confidence", "evidenceIds"]);
  checkEvidence(dossier.strategicFit.evidenceIds, [
    "strategicFit",
    "evidenceIds",
  ]);
  dossier.options.forEach((x, i) =>
    checkEvidence(x.evidenceIds, ["options", i, "evidenceIds"])
  );
  checkEvidence(dossier.recommendation.evidenceIds, [
    "recommendation",
    "evidenceIds",
  ]);
  checkEvidence(dossier.effort.evidenceIds, ["effort", "evidenceIds"]);
  dossier.economics.estimates.forEach((x, i) => {
    checkEvidence(x.evidenceIds, ["economics", "estimates", i, "evidenceIds"]);
    if (!optionIds.has(x.optionId)) {
      context.addIssue({
        code: "custom",
        path: ["economics", "estimates", i, "optionId"],
        message: "optionId must reference an option",
      });
    }
  });
  dossier.risks.forEach((x, i) =>
    checkEvidence(x.evidenceIds, ["risks", i, "evidenceIds"])
  );

  if (dossier.options.filter((x) => x.kind === "do_nothing").length !== 1) {
    context.addIssue({
      code: "custom",
      path: ["options"],
      message: "exactly one do_nothing option is required",
    });
  }
  if (!optionIds.has(dossier.recommendation.optionId)) {
    context.addIssue({
      code: "custom",
      path: ["recommendation", "optionId"],
      message: "recommendation must reference an option",
    });
  }
  dossier.expectedOutcomes.forEach((outcome, i) =>
    outcome.metricIds.forEach((id, j) => {
      if (!metricIds.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["expectedOutcomes", i, "metricIds", j],
          message: "metricId must reference the measurement plan",
        });
      }
    })
  );
  if (
    Date.parse(dossier.authority.decisionDueAt) < Date.parse(dossier.createdAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["authority", "decisionDueAt"],
      message: "decisionDueAt must be at or after createdAt",
    });
  }
  if (
    Date.parse(dossier.measurementPlan.reviewAt) < Date.parse(dossier.createdAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["measurementPlan", "reviewAt"],
      message: "reviewAt must be at or after createdAt",
    });
  }
});

export type DecisionDossier = z.infer<typeof DecisionDossier>;
export type ValidationDiagnostic = {
  path: string;
  code: string;
  message: string;
};
export type DecisionDossierValidation =
  | { success: true; data: DecisionDossier; diagnostics: [] }
  | { success: false; diagnostics: ValidationDiagnostic[] };

export function validateDecisionDossier(
  input: unknown,
): DecisionDossierValidation {
  const result = DecisionDossier.safeParse(input);
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
