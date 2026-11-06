import { z } from "npm:zod@4";

export const APPROVAL_GATE_SCHEMA_VERSION = "1.0" as const;

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/);
const Version = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const Timestamp = z.iso.datetime({ offset: true });

export const approvalActionKindSchema = Id;
export type ApprovalActionKind = z.infer<typeof approvalActionKindSchema>;

const subjectSchema = z.strictObject({
  subjectId: Id,
  subjectVersion: Version,
  subjectHash: Digest,
});
const policyProvenanceSchema = z.strictObject({
  policyId: Id,
  policyVersion: Version,
  policyHash: Digest,
  issuedAt: Timestamp,
  expiresAt: Timestamp,
});
const actionSchema = z.strictObject({
  actionKind: approvalActionKindSchema,
  actionScope: Id,
});
const approvalSchema = z.strictObject({
  approvalId: Id,
  actionKind: approvalActionKindSchema,
  actionScope: Id,
  subject: subjectSchema,
  subjectDigest: Digest,
  decision: z.enum(["approved", "rejected"]),
  humanActor: z.strictObject({
    actorType: z.literal("human"),
    actorId: Id,
    actorRole: Id,
  }),
  decidedAt: Timestamp,
  expiresAt: Timestamp,
  policy: policyProvenanceSchema,
});
const gateArtifactSchema = z.strictObject({
  gateId: Id,
  artifactId: Id,
  artifactVersion: Version,
  artifactHash: Digest,
  status: z.enum(["satisfied", "rejected", "pending", "revoked"]),
  subject: subjectSchema,
  subjectDigest: Digest,
  approvedActions: z.array(actionSchema).max(100),
  satisfiedAt: Timestamp.optional(),
  expiresAt: Timestamp,
  policy: policyProvenanceSchema,
});

export const approvalPacketInputSchema = z.strictObject({
  schemaVersion: z.literal(APPROVAL_GATE_SCHEMA_VERSION),
  packetId: Id,
  evaluatedAt: Timestamp,
  subject: subjectSchema,
  subjectDigest: Digest,
  requestedActions: z.array(actionSchema).min(1).max(100),
  gateArtifact: gateArtifactSchema,
  approvals: z.array(approvalSchema).max(100),
});

const diagnosticSchema = z.strictObject({
  code: z.enum([
    "duplicate_action",
    "duplicate_approval",
    "gate_not_satisfied",
    "gate_stale",
    "gate_subject_mismatch",
    "gate_scope_missing",
    "gate_chronology_invalid",
    "policy_stale",
    "policy_chronology_invalid",
    "policy_provenance_mismatch",
    "approval_missing",
    "approval_rejected",
    "approval_stale",
    "approval_subject_mismatch",
    "approval_chronology_invalid",
    "approval_scope_unrequested",
  ]),
  path: z.string(),
  message: z.string(),
});

export const approvalDiagnosticsSchema = z.strictObject({
  schemaVersion: z.literal(APPROVAL_GATE_SCHEMA_VERSION),
  packetId: Id,
  evaluatedAt: Timestamp,
  subject: subjectSchema,
  subjectDigest: Digest,
  requestedActions: z.array(actionSchema).min(1).max(100),
  gateArtifact: z.strictObject({
    gateId: Id,
    artifactId: Id,
    artifactVersion: Version,
    artifactHash: Digest,
    policy: policyProvenanceSchema,
  }),
  recommendation: z.strictObject({
    requirementsSatisfied: z.boolean(),
    disposition: z.literal("diagnostics_only"),
  }),
  diagnostics: z.array(diagnosticSchema),
  authority: z.strictObject({
    execution: z.literal(false),
    approval: z.literal(false),
    network: z.literal(false),
    providerInvocation: z.literal(false),
    productionMutation: z.literal(false),
    separateSideEffectAdapterOrHumanActionRequired: z.literal(true),
  }),
});
export type ApprovalDiagnostics = z.infer<typeof approvalDiagnosticsSchema>;

type Input = z.infer<typeof approvalPacketInputSchema>;
type Diagnostic = z.infer<typeof diagnosticSchema>;
type Action = z.infer<typeof actionSchema>;

const key = (action: Action) =>
  JSON.stringify([action.actionKind, action.actionScope]);
const label = (action: Action) =>
  `${action.actionKind} (${action.actionScope})`;
const sameSubject = (left: Input["subject"], right: Input["subject"]) =>
  left.subjectId === right.subjectId &&
  left.subjectVersion === right.subjectVersion &&
  left.subjectHash === right.subjectHash;
const samePolicy = (
  left: Input["gateArtifact"]["policy"],
  right: Input["gateArtifact"]["policy"],
) =>
  left.policyId === right.policyId &&
  left.policyVersion === right.policyVersion &&
  left.policyHash === right.policyHash;

/** Evaluates retained evidence only. It has no clock, network, provider, or effect dependency. */
export function evaluateApprovalPacket(raw: unknown): ApprovalDiagnostics {
  const input: Input = approvalPacketInputSchema.parse(raw);
  const diagnostics: Diagnostic[] = [];
  const add = (
    code: Diagnostic["code"],
    path: string,
    message: string,
  ): void => {
    diagnostics.push({ code, path, message });
  };
  const evaluatedAt = Date.parse(input.evaluatedAt);
  const gate = input.gateArtifact;
  const actionKeys = input.requestedActions.map(key);

  if (input.subjectDigest !== input.subject.subjectHash) {
    add(
      "gate_subject_mismatch",
      "subjectDigest",
      "subjectDigest must equal the exact subject artifact hash",
    );
  }
  if (new Set(actionKeys).size !== actionKeys.length) {
    add(
      "duplicate_action",
      "requestedActions",
      "requested action kind and scope must be unique",
    );
  }
  if (gate.status !== "satisfied") {
    add(
      "gate_not_satisfied",
      "gateArtifact.status",
      "gate artifact is not satisfied",
    );
  }
  if (Date.parse(gate.expiresAt) <= evaluatedAt) {
    add("gate_stale", "gateArtifact.expiresAt", "gate artifact is expired");
  }
  if (
    !sameSubject(gate.subject, input.subject) ||
    gate.subjectDigest !== input.subjectDigest
  ) {
    add(
      "gate_subject_mismatch",
      "gateArtifact.subject",
      "gate artifact is bound to a different exact subject or digest",
    );
  }

  const gateActionKeys = gate.approvedActions.map(key);
  if (new Set(gateActionKeys).size !== gateActionKeys.length) {
    add(
      "duplicate_action",
      "gateArtifact.approvedActions",
      "gate-approved action kind and scope must be unique",
    );
  }
  for (const requested of input.requestedActions) {
    if (!gateActionKeys.includes(key(requested))) {
      add(
        "gate_scope_missing",
        "gateArtifact.approvedActions",
        `gate artifact does not approve ${label(requested)}`,
      );
    }
  }
  if (
    !gate.satisfiedAt || Date.parse(gate.satisfiedAt) > evaluatedAt ||
    Date.parse(gate.satisfiedAt ?? gate.expiresAt) >=
      Date.parse(gate.expiresAt) ||
    Date.parse(gate.policy.issuedAt) >
      Date.parse(gate.satisfiedAt ?? input.evaluatedAt)
  ) {
    add(
      "gate_chronology_invalid",
      "gateArtifact.satisfiedAt",
      "gate satisfaction must be present and no later than evaluation, under an issued policy",
    );
  }
  checkPolicy(gate.policy, "gateArtifact.policy");

  const approvalIds = input.approvals.map((approval) => approval.approvalId);
  const approvalKeys = input.approvals.map((approval) =>
    key({ actionKind: approval.actionKind, actionScope: approval.actionScope })
  );
  if (
    new Set(approvalIds).size !== approvalIds.length ||
    new Set(approvalKeys).size !== approvalKeys.length
  ) {
    add(
      "duplicate_approval",
      "approvals",
      "approval IDs and action scopes must be distinct",
    );
  }
  input.approvals.forEach((approval, index) => {
    const path = `approvals.${index}`;
    const approvalKey = approvalKeys[index];
    const approvalLabel = label(approval);
    if (!actionKeys.includes(approvalKey)) {
      add(
        "approval_scope_unrequested",
        `${path}.actionScope`,
        "approval is not for an exact requested action scope",
      );
    }
    if (
      !sameSubject(approval.subject, input.subject) ||
      approval.subjectDigest !== input.subjectDigest
    ) {
      add(
        "approval_subject_mismatch",
        `${path}.subject`,
        "approval is bound to a different exact subject or digest",
      );
    }
    if (approval.decision === "rejected") {
      add(
        "approval_rejected",
        `${path}.decision`,
        `human rejected ${approvalLabel}`,
      );
    }
    if (Date.parse(approval.expiresAt) <= evaluatedAt) {
      add(
        "approval_stale",
        `${path}.expiresAt`,
        `approval for ${approvalLabel} is expired`,
      );
    }
    if (
      Date.parse(approval.decidedAt) > evaluatedAt ||
      Date.parse(approval.decidedAt) >= Date.parse(approval.expiresAt) ||
      Date.parse(approval.policy.issuedAt) > Date.parse(approval.decidedAt)
    ) {
      add(
        "approval_chronology_invalid",
        `${path}.decidedAt`,
        "human decision must be no later than evaluation and under an issued policy",
      );
    }
    checkPolicy(approval.policy, `${path}.policy`);
    if (!samePolicy(approval.policy, gate.policy)) {
      add(
        "policy_provenance_mismatch",
        `${path}.policy`,
        "approval policy does not exactly match the gate policy provenance",
      );
    }
  });
  for (const requested of input.requestedActions) {
    if (!approvalKeys.includes(key(requested))) {
      add(
        "approval_missing",
        "approvals",
        `missing distinct human approval for ${label(requested)}`,
      );
    }
  }

  function checkPolicy(
    policy: Input["gateArtifact"]["policy"],
    path: string,
  ): void {
    if (Date.parse(policy.expiresAt) <= evaluatedAt) {
      add("policy_stale", `${path}.expiresAt`, "policy provenance is expired");
    }
    if (
      Date.parse(policy.issuedAt) > evaluatedAt ||
      Date.parse(policy.issuedAt) >= Date.parse(policy.expiresAt)
    ) {
      add(
        "policy_chronology_invalid",
        path,
        "policy issue/expiry chronology is invalid",
      );
    }
  }

  diagnostics.sort((left, right) =>
    left.path.localeCompare(right.path) ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  );
  return approvalDiagnosticsSchema.parse({
    schemaVersion: APPROVAL_GATE_SCHEMA_VERSION,
    packetId: input.packetId,
    evaluatedAt: input.evaluatedAt,
    subject: input.subject,
    subjectDigest: input.subjectDigest,
    requestedActions: input.requestedActions,
    gateArtifact: {
      gateId: gate.gateId,
      artifactId: gate.artifactId,
      artifactVersion: gate.artifactVersion,
      artifactHash: gate.artifactHash,
      policy: gate.policy,
    },
    recommendation: {
      requirementsSatisfied: diagnostics.length === 0,
      disposition: "diagnostics_only",
    },
    diagnostics,
    authority: {
      execution: false,
      approval: false,
      network: false,
      providerInvocation: false,
      productionMutation: false,
      separateSideEffectAdapterOrHumanActionRequired: true,
    },
  });
}
