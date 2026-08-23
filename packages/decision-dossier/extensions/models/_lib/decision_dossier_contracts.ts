import { z } from "npm:zod@4";

export const DECISION_DOSSIER_SCHEMA_VERSION = "1.0" as const;

const MAX_ID_LENGTH = 512;
const MAX_TEXT_LENGTH = 10_000;
const MAX_ITEMS = 100;
const id = z.string().trim().min(1).max(MAX_ID_LENGTH);
const text = z.string().trim().min(1).max(MAX_TEXT_LENGTH);
const timestamp = z.iso.datetime({ offset: true });
const list = <T extends z.ZodType>(item: T) => z.array(item).max(MAX_ITEMS);

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

function duplicateIssues(
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

/** Generic provenance supplied by the caller; this extension performs no collection. */
export const SourceReference = z.strictObject({
  schemaVersion: z.literal("1.0"),
  sourceId: id,
  source: z.strictObject({
    system: id,
    accountId: id.optional(),
    resourceType: id,
    resourceId: id,
  }),
  provenance: z.strictObject({
    collector: id,
    collectorVersion: id,
    method: id,
    collectedAt: timestamp,
  }),
  observedAt: timestamp,
  freshness: z.strictObject({ asOf: timestamp, expiresAt: timestamp }),
  sensitivity: z.enum(["public", "internal", "confidential", "restricted"]),
}).superRefine((value, context) => {
  if (Date.parse(value.observedAt) > Date.parse(value.freshness.asOf)) {
    context.addIssue({
      code: "custom",
      path: ["freshness", "asOf"],
      message: "asOf must be at or after observedAt",
    });
  }
  if (
    Date.parse(value.freshness.asOf) > Date.parse(value.freshness.expiresAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["freshness", "expiresAt"],
      message: "expiresAt must be at or after asOf",
    });
  }
  if (Date.parse(value.provenance.collectedAt) < Date.parse(value.observedAt)) {
    context.addIssue({
      code: "custom",
      path: ["provenance", "collectedAt"],
      message: "collectedAt must be at or after observedAt",
    });
  }
});

/** Immutable identity of the artifact this dossier describes. */
export const ArtifactSubject = z.strictObject({
  kind: text,
  id,
  version: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const evidenceIds = list(id).superRefine(unique("duplicate evidenceId"));
const Evidence = z.strictObject({
  evidenceId: id,
  claim: text,
  sourceReference: SourceReference,
});
const Option = z.strictObject({
  optionId: id,
  kind: z.enum(["action", "do_nothing"]),
  title: text,
  description: text,
  evidenceIds,
});
const Effort = z.strictObject({
  size: z.enum(["extra_small", "small", "medium", "large", "extra_large"]),
  status: z.enum(["observed", "hypothetical"]),
  estimate: z.number().finite().nonnegative(),
  unit: text,
  rationale: text,
  evidenceIds,
  assumptions: list(text),
}).superRefine((value, context) => {
  if (value.status === "observed" && value.evidenceIds.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["evidenceIds"],
      message: "observed effort requires evidence",
    });
  }
  if (value.status === "hypothetical" && value.assumptions.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["assumptions"],
      message: "hypothetical effort requires at least one assumption",
    });
  }
});
const EstimateBase = z.strictObject({
  estimateId: id,
  optionId: id,
  label: text,
  direction: z.enum(["cost", "benefit"]),
  status: z.enum(["observed", "hypothetical"]),
  asOf: timestamp,
  evidenceIds,
  assumptions: list(text),
  sourceReference: SourceReference.optional(),
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
    unit: text,
  }),
]).superRefine((value, context) => {
  if (value.status === "observed" && value.sourceReference === undefined) {
    context.addIssue({
      code: "custom",
      path: ["sourceReference"],
      message:
        "observed estimates require sourceReference provenance and freshness",
    });
  }
  if (value.status === "hypothetical" && value.assumptions.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["assumptions"],
      message: "hypothetical estimates require at least one assumption",
    });
  }
});
const Window = z.strictObject({ startsAt: timestamp, endsAt: timestamp })
  .superRefine((value, context) => {
    if (Date.parse(value.endsAt) <= Date.parse(value.startsAt)) {
      context.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "endsAt must be later than startsAt",
      });
    }
  });
const Metric = z.strictObject({
  metricId: id,
  name: text,
  unit: text,
  desiredDirection: z.enum(["increase", "decrease", "maintain"]),
  target: z.number().finite(),
});

export const DecisionDossier = z.strictObject({
  schemaVersion: z.literal(DECISION_DOSSIER_SCHEMA_VERSION),
  dossierId: id,
  subject: ArtifactSubject,
  version: z.number().int().positive(),
  createdAt: timestamp,
  problem: z.strictObject({ statement: text, scope: text, evidenceIds }),
  affectedSegment: z.strictObject({
    segmentId: id,
    label: text,
    definition: text,
    evidenceIds,
  }),
  confidence: z.strictObject({
    level: z.enum(["low", "medium", "high"]),
    rationale: text,
    evidenceIds,
  }),
  strategicFit: z.strictObject({
    alignment: z.enum(["aligned", "neutral", "conflict"]),
    rationale: text,
    principleIds: list(id).min(1).superRefine(
      unique("duplicate principleId"),
    ),
    evidenceIds,
  }),
  evidence: list(Evidence).min(1),
  options: list(Option).min(2),
  recommendation: z.strictObject({
    optionId: id,
    rationale: text,
    evidenceIds,
  }),
  effort: Effort,
  economics: z.strictObject({
    estimates: list(EconomicEstimate),
    summary: text,
  }),
  risks: list(
    z.strictObject({
      riskId: id,
      description: text,
      likelihood: z.enum(["low", "medium", "high"]),
      impact: z.enum(["low", "medium", "high"]),
      mitigation: text,
      ownerId: id,
      evidenceIds,
    }),
  ),
  authority: z.strictObject({
    decisionMaker: z.strictObject({ id, role: text }),
    authorityBasis: text,
    decisionDueAt: timestamp,
  }),
  expectedOutcomes: list(
    z.strictObject({
      outcomeId: id,
      statement: text,
      metricIds: list(id).min(1).superRefine(unique("duplicate metricId")),
    }),
  ).min(1),
  measurementPlan: z.strictObject({
    metrics: list(Metric).min(1),
    windows: list(
      z.strictObject({ windowId: id, purpose: text, window: Window }),
    ).min(1),
    ownerId: id,
    reviewAt: timestamp,
  }),
}).superRefine((dossier, context) => {
  const evidence = new Set(dossier.evidence.map((item) => item.evidenceId));
  const options = new Set(dossier.options.map((item) => item.optionId));
  const metrics = new Set(
    dossier.measurementPlan.metrics.map((item) => item.metricId),
  );
  const duplicates: Array<[string[], PropertyKey[], string]> = [
    [
      dossier.evidence.map((x) => x.evidenceId),
      ["evidence"],
      "duplicate evidenceId",
    ],
    [dossier.options.map((x) => x.optionId), ["options"], "duplicate optionId"],
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
  ];
  duplicates.forEach(([values, path, message]) =>
    duplicateIssues(values, context, path, message)
  );
  const checkEvidence = (values: string[], path: PropertyKey[]) =>
    values.forEach((value, index) => {
      if (!evidence.has(value)) {
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
  dossier.options.forEach((x, index) =>
    checkEvidence(x.evidenceIds, ["options", index, "evidenceIds"])
  );
  checkEvidence(dossier.recommendation.evidenceIds, [
    "recommendation",
    "evidenceIds",
  ]);
  checkEvidence(dossier.effort.evidenceIds, ["effort", "evidenceIds"]);
  dossier.economics.estimates.forEach((x, index) => {
    checkEvidence(x.evidenceIds, [
      "economics",
      "estimates",
      index,
      "evidenceIds",
    ]);
    if (!options.has(x.optionId)) {
      context.addIssue({
        code: "custom",
        path: ["economics", "estimates", index, "optionId"],
        message: "optionId must reference an option",
      });
    }
  });
  dossier.risks.forEach((x, index) =>
    checkEvidence(x.evidenceIds, ["risks", index, "evidenceIds"])
  );
  if (dossier.options.filter((x) => x.kind === "do_nothing").length !== 1) {
    context.addIssue({
      code: "custom",
      path: ["options"],
      message: "exactly one do_nothing option is required",
    });
  }
  if (!options.has(dossier.recommendation.optionId)) {
    context.addIssue({
      code: "custom",
      path: ["recommendation", "optionId"],
      message: "recommendation must reference an option",
    });
  }
  dossier.expectedOutcomes.forEach((outcome, i) =>
    outcome.metricIds.forEach((metricId, j) => {
      if (!metrics.has(metricId)) {
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
