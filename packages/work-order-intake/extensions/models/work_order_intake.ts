import { z } from "npm:zod@4";
import { createHash } from "node:crypto";

/** Published CalVer for the decision-only intake model. */
export const WORK_ORDER_INTAKE_MODEL_VERSION = "2026.08.23.1" as const;
/** The sole decision action that an active acceptance may authorize. */
export const WORK_ORDER_INTAKE_ACTION = "accept_bounded_proposal" as const;
/** Action used by the retained dossier-derived intake contract. */
export const LEGACY_WORK_ORDER_INTAKE_ACTION = "create_work_order" as const;
/** Hard limits that require callers to split an otherwise valid proposal. */
export const WORK_ORDER_LIMITS = {
  targets: 12,
  files: 12,
  changedLines: 600,
  checks: 12,
} as const;

const Id = z.string().trim().min(1).max(200);
const Text = z.string().trim().min(1).max(10_000);
const Timestamp = z.iso.datetime({ offset: true });
const Subject = z.strictObject({
  kind: Text,
  id: Id,
  version: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const Actor = z.strictObject({ id: Id, role: Text });
const Decision = z.strictObject({
  decisionId: Id,
  subject: Subject,
  actor: Actor,
  decision: z.enum(["approved", "rejected", "changes_requested", "deferred"]),
  rationale: Text,
  scope: z.strictObject({
    resource: Id,
    allowedActions: z.array(Id).min(1).max(20),
  }),
  decidedAt: Timestamp,
  expiresAt: Timestamp,
  allowedNextAction: Id.optional(),
}).superRefine((decision, context) => {
  if (Date.parse(decision.expiresAt) <= Date.parse(decision.decidedAt)) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "expiresAt must be later than decidedAt",
    });
  }
  if (decision.decision === "approved") {
    if (
      decision.allowedNextAction === undefined ||
      !decision.scope.allowedActions.includes(decision.allowedNextAction)
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowedNextAction"],
        message: "approved decisions require an in-scope allowedNextAction",
      });
    }
  } else if (decision.allowedNextAction !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["allowedNextAction"],
      message: "non-approved decisions forbid allowedNextAction",
    });
  }
});
const Criterion = z.strictObject({ criterionId: Id, statement: Text });
const Check = z.strictObject({
  checkId: Id,
  command: Text,
  expectedExitCode: z.literal(0),
});
const Target = z.string().trim().min(1).max(500).superRefine(
  (value, context) => {
    if (
      value.startsWith("/") || value.includes("\\") || value.includes("\0") ||
      value.split("/").some((part) => part === "" || part === "..") ||
      /^[A-Za-z]:/.test(value)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "target must be a canonical relative path and may not traverse parents",
      });
    }
  },
);

// Retain the original dossier field contracts exactly; generic proposal bounds
// are intentionally separate and must not narrow compatibility inputs.
const LegacyId = z.string().trim().min(1).max(512);
const LegacyText = z.string().trim().min(1).max(10_000);
const LegacyList = <T extends z.ZodType>(item: T) => z.array(item).max(100);
const LegacyEvidenceIds = LegacyList(LegacyId).superRefine((values, context) =>
  unique(values, context, [], "duplicate evidenceId")
);
const LegacySourceReference = z.strictObject({
  schemaVersion: z.literal("1.0"),
  sourceId: LegacyId,
  source: z.strictObject({
    system: LegacyId,
    accountId: LegacyId.optional(),
    resourceType: LegacyId,
    resourceId: LegacyId,
  }),
  provenance: z.strictObject({
    collector: LegacyId,
    collectorVersion: LegacyId,
    method: LegacyId,
    collectedAt: Timestamp,
  }),
  observedAt: Timestamp,
  freshness: z.strictObject({ asOf: Timestamp, expiresAt: Timestamp }),
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
const LegacySubject = z.strictObject({
  kind: LegacyText,
  id: LegacyId,
  version: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const LegacyEvidence = z.strictObject({
  evidenceId: LegacyId,
  claim: LegacyText,
  sourceReference: LegacySourceReference,
});
const LegacyOption = z.strictObject({
  optionId: LegacyId,
  kind: z.enum(["action", "do_nothing"]),
  title: LegacyText,
  description: LegacyText,
  evidenceIds: LegacyEvidenceIds,
});
const LegacyEffort = z.strictObject({
  size: z.enum(["extra_small", "small", "medium", "large", "extra_large"]),
  status: z.enum(["observed", "hypothetical"]),
  estimate: z.number().finite().nonnegative(),
  unit: LegacyText,
  rationale: LegacyText,
  evidenceIds: LegacyEvidenceIds,
  assumptions: LegacyList(LegacyText),
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
const LegacyEstimateBase = z.strictObject({
  estimateId: LegacyId,
  optionId: LegacyId,
  label: LegacyText,
  direction: z.enum(["cost", "benefit"]),
  status: z.enum(["observed", "hypothetical"]),
  asOf: Timestamp,
  evidenceIds: LegacyEvidenceIds,
  assumptions: LegacyList(LegacyText),
  sourceReference: LegacySourceReference.optional(),
});
const LegacyEconomicEstimate = z.discriminatedUnion("valueType", [
  LegacyEstimateBase.extend({
    valueType: z.literal("monetary"),
    value: z.number().finite(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    unit: z.literal("currency"),
  }),
  LegacyEstimateBase.extend({
    valueType: z.literal("quantity"),
    value: z.number().finite(),
    unit: LegacyText,
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
const LegacyMetric = z.strictObject({
  metricId: LegacyId,
  name: LegacyText,
  unit: LegacyText,
  desiredDirection: z.enum(["increase", "decrease", "maintain"]),
  target: z.number().finite(),
});
const LegacyDossier = z.strictObject({
  schemaVersion: z.literal("1.0"),
  dossierId: LegacyId,
  subject: LegacySubject,
  version: z.number().int().positive(),
  createdAt: Timestamp,
  problem: z.strictObject({
    statement: LegacyText,
    scope: LegacyText,
    evidenceIds: LegacyEvidenceIds,
  }),
  affectedSegment: z.strictObject({
    segmentId: LegacyId,
    label: LegacyText,
    definition: LegacyText,
    evidenceIds: LegacyEvidenceIds,
  }),
  confidence: z.strictObject({
    level: z.enum(["low", "medium", "high"]),
    rationale: LegacyText,
    evidenceIds: LegacyEvidenceIds,
  }),
  strategicFit: z.strictObject({
    alignment: z.enum(["aligned", "neutral", "conflict"]),
    rationale: LegacyText,
    principleIds: LegacyList(LegacyId).min(1).superRefine((values, context) =>
      unique(values, context, [], "duplicate principleId")
    ),
    evidenceIds: LegacyEvidenceIds,
  }),
  evidence: LegacyList(LegacyEvidence).min(1),
  options: LegacyList(LegacyOption).min(2),
  recommendation: z.strictObject({
    optionId: LegacyId,
    rationale: LegacyText,
    evidenceIds: LegacyEvidenceIds,
  }),
  effort: LegacyEffort,
  economics: z.strictObject({
    estimates: LegacyList(LegacyEconomicEstimate),
    summary: LegacyText,
  }),
  risks: LegacyList(z.strictObject({
    riskId: LegacyId,
    description: LegacyText,
    likelihood: z.enum(["low", "medium", "high"]),
    impact: z.enum(["low", "medium", "high"]),
    mitigation: LegacyText,
    ownerId: LegacyId,
    evidenceIds: LegacyEvidenceIds,
  })),
  authority: z.strictObject({
    decisionMaker: z.strictObject({ id: LegacyId, role: LegacyText }),
    authorityBasis: LegacyText,
    decisionDueAt: Timestamp,
  }),
  expectedOutcomes: LegacyList(z.strictObject({
    outcomeId: LegacyId,
    statement: LegacyText,
    metricIds: LegacyList(LegacyId).min(1).superRefine((values, context) =>
      unique(values, context, [], "duplicate metricId")
    ),
  })).min(1),
  measurementPlan: z.strictObject({
    metrics: LegacyList(LegacyMetric).min(1),
    windows: LegacyList(z.strictObject({
      windowId: LegacyId,
      purpose: LegacyText,
      window: z.strictObject({ startsAt: Timestamp, endsAt: Timestamp })
        .superRefine((value, context) => {
          if (Date.parse(value.endsAt) <= Date.parse(value.startsAt)) {
            context.addIssue({
              code: "custom",
              path: ["endsAt"],
              message: "endsAt must be later than startsAt",
            });
          }
        }),
    })).min(1),
    ownerId: LegacyId,
    reviewAt: Timestamp,
  }),
}).superRefine((dossier, context) => {
  const evidence = new Set(dossier.evidence.map((x) => x.evidenceId));
  const options = new Set(dossier.options.map((x) => x.optionId));
  const metrics = new Set(
    dossier.measurementPlan.metrics.map((x) => x.metricId),
  );
  const duplicateGroups: Array<[string[], PropertyKey[], string]> = [
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
  duplicateGroups.forEach(([values, path, message]) =>
    unique(values, context, path, message)
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
    if (!options.has(x.optionId)) {
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
const LegacyDecision = z.strictObject({
  schemaVersion: z.literal("1.0"),
  decisionId: LegacyId,
  subject: LegacySubject,
  actor: z.strictObject({ id: LegacyId, role: LegacyText }),
  decision: z.enum(["approved", "rejected", "changes_requested", "deferred"]),
  rationale: LegacyText,
  scope: z.strictObject({
    resource: LegacyText,
    allowedActions: z.array(LegacyText).min(1),
  }),
  decidedAt: Timestamp,
  expiresAt: Timestamp,
  allowedNextAction: LegacyText.optional(),
}).superRefine((decision, context) => {
  if (Date.parse(decision.expiresAt) <= Date.parse(decision.decidedAt)) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "expiresAt must be later than decidedAt",
    });
  }
  if (
    decision.decision === "approved" &&
    (decision.allowedNextAction === undefined ||
      !decision.scope.allowedActions.includes(decision.allowedNextAction))
  ) {
    context.addIssue({
      code: "custom",
      path: ["allowedNextAction"],
      message: "approved decisions require an in-scope allowedNextAction",
    });
  } else if (
    decision.decision !== "approved" && decision.allowedNextAction !== undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["allowedNextAction"],
      message: "non-approved decisions forbid allowedNextAction",
    });
  }
});
const LegacyRisk = z.strictObject({
  level: z.enum(["low", "medium", "high"]),
  rationale: Text,
});
const LegacyEvidenceLink = z.strictObject({ evidenceId: Id, purpose: Text });
/** Strict top-level shape of the retained dossier-derived proposal contract. */
export const LegacyProposal = z.strictObject({
  workOrderId: Id,
  dossier: LegacyDossier,
  approval: LegacyDecision,
  evaluatedAt: Timestamp,
  acceptanceCriteria: z.array(Criterion).min(1),
  allowedPaths: z.array(Target).min(1),
  changeBudget: z.strictObject({
    maxFiles: z.number().int().positive(),
    maxChangedLines: z.number().int().positive(),
  }),
  riskClassification: LegacyRisk,
  deterministicChecks: z.array(Check).min(1),
  evidenceLinks: z.array(LegacyEvidenceLink).min(1),
}).superRefine((proposal, context) => {
  unique(proposal.acceptanceCriteria.map((x) => x.criterionId), context, [
    "acceptanceCriteria",
  ], "duplicate criterionId");
  unique(
    proposal.allowedPaths,
    context,
    ["allowedPaths"],
    "duplicate allowedPath",
  );
  unique(proposal.deterministicChecks.map((x) => x.checkId), context, [
    "deterministicChecks",
  ], "duplicate checkId");
  unique(proposal.evidenceLinks.map((x) => x.evidenceId), context, [
    "evidenceLinks",
  ], "duplicate evidenceId");
});

function unique(
  values: string[],
  context: z.RefinementCtx,
  path: PropertyKey[] | string,
  label: string,
) {
  const seen = new Map<string, number>();
  values.forEach((value, index) => {
    const first = seen.get(value);
    if (first === undefined) seen.set(value, index);
    else {
      context.addIssue({
        code: "custom",
        path: [...(Array.isArray(path) ? path : [path]), index],
        message: `${
          label.startsWith("duplicate ") ? label : `duplicate ${label}`
        } (first at index ${first})`,
      });
    }
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hash of all proposal content authorized by the decision subject. */
export function proposalSha256(
  proposal: { subject: z.infer<typeof Subject>; [key: string]: unknown },
): string {
  const {
    approval: _approval,
    evaluatedAt: _evaluatedAt,
    subject: completeSubject,
    ...content
  } = proposal;
  const { sha256: _sha256, ...subject } = completeSubject;
  return createHash("sha256").update(canonicalJson({ ...content, subject }))
    .digest("hex");
}

/** Strict input contract for one bounded work proposal. */
export const Proposal = z.strictObject({
  proposalId: Id,
  subject: Subject,
  title: Text,
  context: Text,
  approval: Decision,
  evaluatedAt: Timestamp,
  acceptanceCriteria: z.array(Criterion).min(1).max(100),
  allowedTargets: z.array(Target).min(1).max(100),
  changeBudget: z.strictObject({
    maxFiles: z.number().int().positive(),
    maxChangedLines: z.number().int().positive(),
  }),
  deterministicChecks: z.array(Check).min(1).max(100),
}).superRefine((proposal, context) => {
  unique(
    proposal.acceptanceCriteria.map((item) => item.criterionId),
    context,
    "acceptanceCriteria",
    "criterionId",
  );
  unique(proposal.allowedTargets, context, "allowedTargets", "allowedTarget");
  unique(
    proposal.deterministicChecks.map((item) => item.checkId),
    context,
    "deterministicChecks",
    "checkId",
  );
  if (proposal.subject.id !== proposal.proposalId) {
    context.addIssue({
      code: "custom",
      path: ["subject", "id"],
      message: "subject id must equal proposalId",
    });
  }
  const { approval: _approval, evaluatedAt: _evaluatedAt, ...authorized } =
    proposal;
  if (proposal.subject.sha256 !== proposalSha256(authorized)) {
    context.addIssue({
      code: "custom",
      path: ["subject", "sha256"],
      message: "subject sha256 must bind the complete proposal content",
    });
  }
});

const Authority = z.strictObject({
  implementationApprovalGate: z.literal("plan-approval"),
  mayApproveImplementation: z.literal(false),
  sideEffects: z.literal("none"),
  mayExecute: z.literal(false),
});
const Diagnostic = z.strictObject({
  path: z.string(),
  code: Id,
  message: Text,
});
const AcceptedProposal = z.strictObject({
  schemaVersion: z.literal("1.0"),
  proposalId: Id,
  title: Text,
  context: Text,
  subject: Subject,
  decisionId: Id,
  approval: Decision,
  evaluatedAt: Timestamp,
  acceptanceCriteria: z.array(Criterion).min(1),
  allowedTargets: z.array(Target).min(1).max(WORK_ORDER_LIMITS.targets),
  changeBudget: z.strictObject({
    maxFiles: z.number().int().positive().max(WORK_ORDER_LIMITS.files),
    maxChangedLines: z.number().int().positive().max(
      WORK_ORDER_LIMITS.changedLines,
    ),
  }),
  deterministicChecks: z.array(Check).min(1).max(WORK_ORDER_LIMITS.checks),
  authority: Authority.extend({ humanAcceptancePreserved: z.literal(true) }),
});
const LegacyWorkOrder = z.strictObject({
  schemaVersion: z.literal("1.0"),
  workOrderId: Id,
  title: Text,
  context: Text,
  source: z.strictObject({
    dossierId: Id,
    dossierVersion: z.number().int().positive(),
    subject: Subject,
    decisionId: Id,
  }),
  acceptanceCriteria: z.array(Criterion).min(1),
  allowedPaths: z.array(Target).min(1).max(WORK_ORDER_LIMITS.targets),
  changeBudget: z.strictObject({
    maxFiles: z.number().int().positive().max(WORK_ORDER_LIMITS.files),
    maxChangedLines: z.number().int().positive().max(
      WORK_ORDER_LIMITS.changedLines,
    ),
  }),
  riskClassification: LegacyRisk,
  deterministicChecks: z.array(Check).min(1).max(WORK_ORDER_LIMITS.checks),
  evidenceLinks: z.array(LegacyEvidenceLink).min(1),
  authority: Authority.extend({
    humanApprovalPreserved: z.literal(true),
    mayMutateTodoist: z.literal(false),
  }),
});
const LegacyAcceptedResult = z.strictObject({
  accepted: z.literal(true),
  workOrder: LegacyWorkOrder,
  diagnostics: z.tuple([]),
  authority: Authority,
});
const RejectedResult = z.strictObject({
  accepted: z.literal(false),
  disposition: z.enum(["invalid", "unapproved", "split_required"]),
  diagnostics: z.array(Diagnostic).min(1),
  authority: Authority,
});
/** Strict, fail-closed result contract persisted by `intake`. */
export const WorkOrderIntakeResult = z.discriminatedUnion("accepted", [
  z.strictObject({
    accepted: z.literal(true),
    acceptedProposal: AcceptedProposal,
    diagnostics: z.tuple([]),
    authority: Authority,
  }),
  RejectedResult,
]);
const RetainedWorkOrderIntakeResult = z.discriminatedUnion("accepted", [
  LegacyAcceptedResult,
  RejectedResult,
]);
/** Persisted records accepted by either explicit contract generation. */
export const CompatibleWorkOrderIntakeResult = z.union([
  WorkOrderIntakeResult,
  LegacyAcceptedResult,
]);

/** TypeScript representation of an intake disposition. */
export type WorkOrderIntake = z.infer<typeof WorkOrderIntakeResult>;
const ZERO_AUTHORITY = {
  implementationApprovalGate: "plan-approval",
  mayApproveImplementation: false,
  sideEffects: "none",
  mayExecute: false,
} as const;
const diagnostic = (path: string, code: string, message: string) => ({
  path,
  code,
  message,
});
const sorted = (diagnostics: Array<z.infer<typeof Diagnostic>>) =>
  diagnostics.sort((left, right) =>
    left.path.localeCompare(right.path) ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  );

/**
 * Deterministically accepts a currently authorized bounded proposal, or
 * returns a stable zero-authority disposition without performing an action.
 */
export function evaluateWorkOrderIntake(input: unknown): WorkOrderIntake {
  const parsed = Proposal.safeParse(input);
  if (!parsed.success) {
    return {
      accepted: false,
      disposition: "invalid",
      diagnostics: sorted(
        parsed.error.issues.map((issue) =>
          diagnostic(
            issue.path.map(String).join("."),
            issue.code,
            issue.message,
          )
        ),
      ),
      authority: ZERO_AUTHORITY,
    };
  }

  const proposal = parsed.data;
  const approvalErrors = [] as Array<z.infer<typeof Diagnostic>>;
  if (proposal.approval.decision !== "approved") {
    approvalErrors.push(
      diagnostic(
        "approval.decision",
        "unapproved",
        "decision must be approved",
      ),
    );
  }
  if (proposal.approval.allowedNextAction !== WORK_ORDER_INTAKE_ACTION) {
    approvalErrors.push(
      diagnostic(
        "approval.allowedNextAction",
        "unapproved",
        `allowedNextAction must be ${WORK_ORDER_INTAKE_ACTION}`,
      ),
    );
  }
  if (proposal.approval.scope.resource !== proposal.proposalId) {
    approvalErrors.push(
      diagnostic(
        "approval.scope.resource",
        "unapproved",
        "approval must name the proposalId",
      ),
    );
  }
  if (
    JSON.stringify(proposal.approval.subject) !==
      JSON.stringify(proposal.subject)
  ) {
    approvalErrors.push(
      diagnostic(
        "approval.subject",
        "unapproved",
        "approval must bind the proposal subject exactly",
      ),
    );
  }
  const evaluatedAt = Date.parse(proposal.evaluatedAt);
  if (
    evaluatedAt < Date.parse(proposal.approval.decidedAt) ||
    evaluatedAt >= Date.parse(proposal.approval.expiresAt)
  ) {
    approvalErrors.push(
      diagnostic(
        "evaluatedAt",
        "unapproved",
        "approval must be active at intake",
      ),
    );
  }
  if (approvalErrors.length) {
    return {
      accepted: false,
      disposition: "unapproved",
      diagnostics: sorted(approvalErrors),
      authority: ZERO_AUTHORITY,
    };
  }

  const splitErrors = [] as Array<z.infer<typeof Diagnostic>>;
  if (proposal.allowedTargets.length > WORK_ORDER_LIMITS.targets) {
    splitErrors.push(
      diagnostic(
        "allowedTargets",
        "split_required",
        `proposal exceeds ${WORK_ORDER_LIMITS.targets} allowed targets`,
      ),
    );
  }
  if (proposal.changeBudget.maxFiles > WORK_ORDER_LIMITS.files) {
    splitErrors.push(
      diagnostic(
        "changeBudget.maxFiles",
        "split_required",
        `proposal exceeds ${WORK_ORDER_LIMITS.files} files`,
      ),
    );
  }
  if (proposal.changeBudget.maxChangedLines > WORK_ORDER_LIMITS.changedLines) {
    splitErrors.push(
      diagnostic(
        "changeBudget.maxChangedLines",
        "split_required",
        `proposal exceeds ${WORK_ORDER_LIMITS.changedLines} changed lines`,
      ),
    );
  }
  if (proposal.deterministicChecks.length > WORK_ORDER_LIMITS.checks) {
    splitErrors.push(
      diagnostic(
        "deterministicChecks",
        "split_required",
        `proposal exceeds ${WORK_ORDER_LIMITS.checks} checks`,
      ),
    );
  }
  if (splitErrors.length) {
    return {
      accepted: false,
      disposition: "split_required",
      diagnostics: sorted(splitErrors),
      authority: ZERO_AUTHORITY,
    };
  }

  return {
    accepted: true,
    acceptedProposal: {
      schemaVersion: "1.0",
      proposalId: proposal.proposalId,
      title: proposal.title,
      context: proposal.context,
      subject: proposal.subject,
      decisionId: proposal.approval.decisionId,
      approval: proposal.approval,
      evaluatedAt: proposal.evaluatedAt,
      acceptanceCriteria: proposal.acceptanceCriteria,
      allowedTargets: proposal.allowedTargets,
      changeBudget: proposal.changeBudget,
      deterministicChecks: proposal.deterministicChecks,
      authority: { ...ZERO_AUTHORITY, humanAcceptancePreserved: true },
    },
    diagnostics: [],
    authority: ZERO_AUTHORITY,
  };
}

function evaluateLegacyWorkOrderIntake(
  input: unknown,
): z.infer<typeof CompatibleWorkOrderIntakeResult> {
  const parsed = LegacyProposal.safeParse(input);
  if (!parsed.success) return evaluateWorkOrderIntake(input);
  const proposal = parsed.data;
  const errors: Array<z.infer<typeof Diagnostic>> = [];
  if (proposal.approval.decision !== "approved") {
    errors.push(
      diagnostic(
        "approval.decision",
        "unapproved",
        "decision must be approved",
      ),
    );
  }
  if (proposal.approval.allowedNextAction !== LEGACY_WORK_ORDER_INTAKE_ACTION) {
    errors.push(
      diagnostic(
        "approval.allowedNextAction",
        "unapproved",
        `allowedNextAction must be ${LEGACY_WORK_ORDER_INTAKE_ACTION}`,
      ),
    );
  }
  if (proposal.approval.scope.resource !== proposal.dossier.dossierId) {
    errors.push(
      diagnostic(
        "approval.scope.resource",
        "unapproved",
        "approval must name the dossierId",
      ),
    );
  }
  if (
    canonicalJson(proposal.approval.subject) !==
      canonicalJson(proposal.dossier.subject)
  ) {
    errors.push(
      diagnostic(
        "approval.subject",
        "unapproved",
        "approval must bind the dossier subject exactly",
      ),
    );
  }
  const at = Date.parse(proposal.evaluatedAt);
  if (
    at < Date.parse(proposal.approval.decidedAt) ||
    at >= Date.parse(proposal.approval.expiresAt)
  ) {
    errors.push(
      diagnostic(
        "evaluatedAt",
        "unapproved",
        "approval must be active at intake",
      ),
    );
  }
  if (errors.length) {
    return {
      accepted: false,
      disposition: "unapproved",
      diagnostics: sorted(errors),
      authority: ZERO_AUTHORITY,
    };
  }
  const split = [] as Array<z.infer<typeof Diagnostic>>;
  if (proposal.allowedPaths.length > WORK_ORDER_LIMITS.targets) {
    split.push(
      diagnostic(
        "allowedPaths",
        "split_required",
        `proposal exceeds ${WORK_ORDER_LIMITS.targets} allowed paths`,
      ),
    );
  }
  if (proposal.changeBudget.maxFiles > WORK_ORDER_LIMITS.files) {
    split.push(
      diagnostic(
        "changeBudget.maxFiles",
        "split_required",
        `proposal exceeds ${WORK_ORDER_LIMITS.files} files`,
      ),
    );
  }
  if (proposal.changeBudget.maxChangedLines > WORK_ORDER_LIMITS.changedLines) {
    split.push(
      diagnostic(
        "changeBudget.maxChangedLines",
        "split_required",
        `proposal exceeds ${WORK_ORDER_LIMITS.changedLines} changed lines`,
      ),
    );
  }
  if (proposal.deterministicChecks.length > WORK_ORDER_LIMITS.checks) {
    split.push(
      diagnostic(
        "deterministicChecks",
        "split_required",
        `proposal exceeds ${WORK_ORDER_LIMITS.checks} checks`,
      ),
    );
  }
  if (split.length) {
    return {
      accepted: false,
      disposition: "split_required",
      diagnostics: sorted(split),
      authority: ZERO_AUTHORITY,
    };
  }
  const evidence = new Set(
    proposal.dossier.evidence.map((item) => item.evidenceId),
  );
  const missing = proposal.evidenceLinks.flatMap((link, index) =>
    evidence.has(link.evidenceId) ? [] : [
      diagnostic(
        `evidenceLinks.${index}.evidenceId`,
        "invalid_reference",
        "evidenceId must reference dossier evidence",
      ),
    ]
  );
  if (missing.length) {
    return {
      accepted: false,
      disposition: "invalid",
      diagnostics: missing,
      authority: ZERO_AUTHORITY,
    };
  }
  return LegacyAcceptedResult.parse({
    accepted: true,
    workOrder: {
      schemaVersion: "1.0",
      workOrderId: proposal.workOrderId,
      title: proposal.dossier.problem.statement,
      context: proposal.dossier.recommendation.rationale,
      source: {
        dossierId: proposal.dossier.dossierId,
        dossierVersion: proposal.dossier.version,
        subject: proposal.dossier.subject,
        decisionId: proposal.approval.decisionId,
      },
      acceptanceCriteria: proposal.acceptanceCriteria,
      allowedPaths: proposal.allowedPaths,
      changeBudget: proposal.changeBudget,
      riskClassification: proposal.riskClassification,
      deterministicChecks: proposal.deterministicChecks,
      evidenceLinks: proposal.evidenceLinks,
      authority: {
        ...ZERO_AUTHORITY,
        humanApprovalPreserved: true,
        mayMutateTodoist: false,
      },
    },
    diagnostics: [],
    authority: ZERO_AUTHORITY,
  });
}

/** Explicitly dispatches only complete generic or complete legacy proposals. */
export function evaluateCompatibleWorkOrderIntake(input: unknown) {
  if (Proposal.safeParse(input).success) return evaluateWorkOrderIntake(input);
  if (LegacyProposal.safeParse(input).success) {
    return evaluateLegacyWorkOrderIntake(input);
  }
  return evaluateWorkOrderIntake(input);
}

/** This model has no instance-wide configuration or authority. */
export const globalArgumentsSchema = z.strictObject({});
const SafeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
/** Arguments for persisting one deterministic intake result. */
export const intakeArgumentsSchema = z.strictObject({
  intakeId: SafeId,
  proposal: z.unknown(),
});
/** Arguments for the decision-only workflow assertion. */
export const assertAcceptedArgumentsSchema = z.strictObject({
  intakeId: SafeId,
  subject: Subject,
});
export const legacyAssertAcceptedArgumentsSchema = z.strictObject({
  result: RetainedWorkOrderIntakeResult,
});
export const compatibleAssertAcceptedArgumentsSchema = z.union([
  assertAcceptedArgumentsSchema,
  legacyAssertAcceptedArgumentsSchema,
]);
type WriteContext = {
  readResource?(name: string): Promise<Record<string, unknown> | null>;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
  logger?: {
    info(message: string, properties?: Record<string, unknown>): void;
  };
};

/** Swamp model exposing only persistence and a no-authority assertion. */
export const model = {
  type: "@mgreten/work-order-intake",
  version: WORK_ORDER_INTAKE_MODEL_VERSION,
  globalArguments: globalArgumentsSchema,
  resources: {
    result: {
      description:
        "Persisted decision-only proposal disposition with no execution authority",
      schema: CompatibleWorkOrderIntakeResult,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    intake: {
      description:
        "Validate and persist a bounded proposal disposition without external action.",
      arguments: intakeArgumentsSchema,
      execute: async (
        args: z.infer<typeof intakeArgumentsSchema>,
        context: WriteContext,
      ) => {
        context.logger?.info("Evaluating work-order intake {intakeId}", {
          intakeId: args.intakeId,
        });
        const name = `intake-${args.intakeId}`;
        const result = CompatibleWorkOrderIntakeResult.parse(
          evaluateCompatibleWorkOrderIntake(args.proposal),
        );
        const existing = context.readResource
          ? CompatibleWorkOrderIntakeResult.safeParse(
            await context.readResource(name),
          )
          : undefined;
        if (existing?.success) {
          if (canonicalJson(existing.data) !== canonicalJson(result)) {
            throw new TypeError(
              `Work-order intake ${args.intakeId} already exists with different content`,
            );
          }
          context.logger?.info("Reused work-order intake {intakeId}", {
            intakeId: args.intakeId,
          });
          return { dataHandles: [] };
        }
        const handle = await context.writeResource("result", name, result);
        context.logger?.info("Persisted work-order intake {intakeId}", {
          intakeId: args.intakeId,
        });
        return { dataHandles: [handle] };
      },
    },
    assertAccepted: {
      description:
        "Read a persisted intake by stable ID and fail unless it was accepted; grants no execution authority.",
      arguments: compatibleAssertAcceptedArgumentsSchema,
      execute: async (
        args: z.infer<typeof compatibleAssertAcceptedArgumentsSchema>,
        context: WriteContext,
      ) => {
        if ("result" in args) {
          context.logger?.info("Asserting retained work-order intake result");
          if (!args.result.accepted) {
            throw new TypeError(
              `Work-order intake ${args.result.disposition}: ${
                JSON.stringify(args.result.diagnostics)
              }`,
            );
          }
          context.logger?.info("Confirmed retained work-order intake result");
          return { dataHandles: [] };
        }
        context.logger?.info("Asserting work-order intake {intakeId}", {
          intakeId: args.intakeId,
        });
        if (!context.readResource) {
          throw new TypeError("Resource reading is unavailable");
        }
        const result = CompatibleWorkOrderIntakeResult.safeParse(
          await context.readResource(`intake-${args.intakeId}`),
        );
        if (!result.success) {
          throw new TypeError(
            `Work-order intake ${args.intakeId} is missing or invalid`,
          );
        }
        if (!result.data.accepted) {
          throw new TypeError(
            `Work-order intake ${result.data.disposition}: ${
              JSON.stringify(result.data.diagnostics)
            }`,
          );
        }
        if (
          !("acceptedProposal" in result.data) ||
          canonicalJson(result.data.acceptedProposal.subject) !==
            canonicalJson(args.subject)
        ) {
          throw new TypeError(
            `Work-order intake ${args.intakeId} does not match the expected subject`,
          );
        }
        context.logger?.info("Confirmed work-order intake {intakeId}", {
          intakeId: args.intakeId,
        });
        return { dataHandles: [] };
      },
    },
  },
};
