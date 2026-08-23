import { z } from "npm:zod@4";

/** Published CalVer for the decision-only intake model. */
export const WORK_ORDER_INTAKE_MODEL_VERSION = "2026.08.23.1" as const;
/** The sole decision action that an active acceptance may authorize. */
export const WORK_ORDER_INTAKE_ACTION = "accept_bounded_proposal" as const;
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
const Target = z.string().trim().min(1).superRefine((value, context) => {
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
});

function unique(
  values: string[],
  context: z.RefinementCtx,
  path: string,
  label: string,
) {
  const seen = new Map<string, number>();
  values.forEach((value, index) => {
    const first = seen.get(value);
    if (first === undefined) seen.set(value, index);
    else {context.addIssue({
        code: "custom",
        path: [path, index],
        message: `duplicate ${label} (first at index ${first})`,
      });}
  });
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
/** Strict, fail-closed result contract persisted by `intake`. */
export const WorkOrderIntakeResult = z.discriminatedUnion("accepted", [
  z.strictObject({
    accepted: z.literal(true),
    acceptedProposal: AcceptedProposal,
    diagnostics: z.tuple([]),
    authority: Authority,
  }),
  z.strictObject({
    accepted: z.literal(false),
    disposition: z.enum(["invalid", "unapproved", "split_required"]),
    diagnostics: z.array(Diagnostic).min(1),
    authority: Authority,
  }),
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
});
type WriteContext = {
  readResource?(name: string): Promise<Record<string, unknown> | null>;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
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
      schema: WorkOrderIntakeResult,
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
      ) => ({
        dataHandles: [
          await context.writeResource(
            "result",
            `intake-${args.intakeId}`,
            WorkOrderIntakeResult.parse(evaluateWorkOrderIntake(args.proposal)),
          ),
        ],
      }),
    },
    assertAccepted: {
      description:
        "Read a persisted intake by stable ID and fail unless it was accepted; grants no execution authority.",
      arguments: assertAcceptedArgumentsSchema,
      execute: async (
        args: z.infer<typeof assertAcceptedArgumentsSchema>,
        context: WriteContext,
      ) => {
        if (!context.readResource) {
          throw new TypeError("Resource reading is unavailable");
        }
        const result = WorkOrderIntakeResult.safeParse(
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
        return { dataHandles: [] };
      },
    },
  },
};
