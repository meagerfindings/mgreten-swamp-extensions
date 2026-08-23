import { evaluateApprovalPacket } from "./_lib/approval_gate_contracts.ts";
import { model } from "./approval_gate.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
const hash = (character: string): string => character.repeat(64);
const subject = {
  subjectId: "release-42",
  subjectVersion: "v1",
  subjectHash: hash("a"),
};
const policy = {
  policyId: "CHANGE-17",
  policyVersion: "1.0",
  policyHash: hash("b"),
  issuedAt: "2026-08-23T09:00:00Z",
  expiresAt: "2026-08-24T12:00:00Z",
};
const actions = ["deploy", "notify"].map((actionKind) => ({
  actionKind,
  actionScope: `release-42-${actionKind}`,
}));
const fixture = (): Record<string, unknown> =>
  JSON.parse(JSON.stringify({
    schemaVersion: "1.0",
    packetId: "packet-1",
    evaluatedAt: "2026-08-23T12:00:00Z",
    subject,
    subjectDigest: hash("a"),
    requestedActions: actions,
    gateArtifact: {
      gateId: "CHANGE-17",
      artifactId: "gate-artifact-1",
      artifactVersion: "v1",
      artifactHash: hash("d"),
      status: "satisfied",
      subject,
      subjectDigest: hash("a"),
      approvedActions: actions,
      satisfiedAt: "2026-08-23T10:00:00Z",
      expiresAt: "2026-08-23T13:00:00Z",
      policy,
    },
    approvals: actions.map((action, index) => ({
      approvalId: `human-approval-${index}`,
      actionKind: action.actionKind,
      actionScope: action.actionScope,
      subject,
      subjectDigest: hash("a"),
      decision: "approved",
      humanActor: {
        actorType: "human",
        actorId: `person-${index}`,
        actorRole: "release-owner",
      },
      decidedAt: "2026-08-23T11:00:00Z",
      expiresAt: "2026-08-23T13:00:00Z",
      policy,
    })),
  }));

Deno.test("strict generic packet is deterministic and remains diagnostics-only", () => {
  const first = evaluateApprovalPacket(fixture());
  const second = evaluateApprovalPacket(fixture());
  assert(JSON.stringify(first) === JSON.stringify(second));
  assert(
    first.recommendation.requirementsSatisfied &&
      first.diagnostics.length === 0,
  );
  assert(
    !first.authority.execution && !first.authority.approval &&
      !first.authority.network,
  );
  assert(
    !first.authority.providerInvocation && !first.authority.productionMutation,
  );
  assert(first.authority.separateSideEffectAdapterOrHumanActionRequired);
  assert(first.gateArtifact.gateId === "CHANGE-17");
  assert(first.gateArtifact.policy.policyId === "CHANGE-17");
  assert(first.requestedActions[0].actionKind === "deploy");
});

Deno.test("fails closed for missing, rejected, stale, and cross-subject approvals", () => {
  const cases: Array<[(packet: any) => void, string]> = [
    [(packet) => packet.approvals.pop(), "approval_missing"],
    [
      (packet) => packet.approvals[0].decision = "rejected",
      "approval_rejected",
    ],
    [
      (packet) => packet.approvals[0].expiresAt = packet.evaluatedAt,
      "approval_stale",
    ],
    [
      (packet) => packet.approvals[0].subject.subjectId = "other-release",
      "approval_subject_mismatch",
    ],
  ];
  for (const [mutate, code] of cases) {
    const packet: any = fixture();
    mutate(packet);
    const failed = evaluateApprovalPacket(packet);
    assert(
      !failed.recommendation.requirementsSatisfied &&
        failed.diagnostics.some((item) => item.code === code),
      code,
    );
    assert(!failed.authority.execution && !failed.authority.approval);
  }
});

Deno.test("strictly rejects unknown fields, malformed hashes, and non-human actors", () => {
  const mutations: Array<(packet: any) => void> = [
    (packet) => packet.unexpected = true,
    (packet) => packet.subject.subjectHash = "not-a-hash",
    (packet) => packet.approvals[0].humanActor.actorType = "agent",
  ];
  for (const mutate of mutations) {
    const packet: any = fixture();
    mutate(packet);
    let rejected = false;
    try {
      evaluateApprovalPacket(packet);
    } catch {
      rejected = true;
    }
    assert(rejected);
  }
});

Deno.test("rejects malformed identifiers and avoids ambiguous action-key collisions", () => {
  const malformed: any = fixture();
  malformed.gateArtifact.gateId = " invalid ";
  let rejected = false;
  try {
    evaluateApprovalPacket(malformed);
  } catch {
    rejected = true;
  }
  assert(rejected);

  const packet: any = fixture();
  packet.requestedActions = [
    { actionKind: "a:b", actionScope: "c" },
    { actionKind: "a", actionScope: "b:c" },
  ];
  packet.gateArtifact.approvedActions = packet.requestedActions;
  packet.approvals = packet.requestedActions.map((action: any, index: number) => ({
    ...packet.approvals[index],
    approvalId: `collision-proof-${index}`,
    ...action,
  }));
  const result = evaluateApprovalPacket(packet);
  assert(result.recommendation.requirementsSatisfied);
  assert(!result.diagnostics.some((item) => item.code === "duplicate_action"));
});

Deno.test("fails closed for duplicated gate actions and tampered nested digests", () => {
  const duplicate: any = fixture();
  duplicate.gateArtifact.approvedActions.push(
    duplicate.gateArtifact.approvedActions[0],
  );
  const duplicateResult = evaluateApprovalPacket(duplicate);
  assert(!duplicateResult.recommendation.requirementsSatisfied);
  assert(duplicateResult.diagnostics.some((item) =>
    item.code === "duplicate_action" &&
    item.path === "gateArtifact.approvedActions"
  ));

  const tampered: any = fixture();
  tampered.gateArtifact.subjectDigest = hash("c");
  const tamperedResult = evaluateApprovalPacket(tampered);
  assert(!tamperedResult.recommendation.requirementsSatisfied);
  assert(tamperedResult.diagnostics.some((item) =>
    item.code === "gate_subject_mismatch"
  ));
});

Deno.test("reports compact gate, policy, chronology, and scope contract branches", () => {
  const cases: Array<[(packet: any) => void, string]> = [
    [(packet) => packet.gateArtifact.status = "pending", "gate_not_satisfied"],
    [
      (packet) => packet.gateArtifact.expiresAt = packet.evaluatedAt,
      "gate_stale",
    ],
    [
      (packet) => packet.gateArtifact.approvedActions.pop(),
      "gate_scope_missing",
    ],
    [
      (packet) => packet.gateArtifact.satisfiedAt = "2026-08-23T12:00:01Z",
      "gate_chronology_invalid",
    ],
    [
      (packet) => packet.gateArtifact.policy.expiresAt = packet.evaluatedAt,
      "policy_stale",
    ],
    [
      (packet) => packet.approvals[0].policy.policyHash = hash("c"),
      "policy_provenance_mismatch",
    ],
    [
      (packet) => packet.approvals[0].actionScope = "unrequested",
      "approval_scope_unrequested",
    ],
  ];
  for (const [mutate, code] of cases) {
    const packet: any = fixture();
    mutate(packet);
    assert(
      evaluateApprovalPacket(packet).diagnostics.some((item) =>
        item.code === code
      ),
      code,
    );
  }
});

Deno.test("model writes one diagnostic resource and accepts no unexpected arguments", async () => {
  const writes: unknown[][] = [];
  const logs: Array<[string, Record<string, unknown>?]> = [];
  const result = await model.methods.evaluate.execute({
    requestId: "req-1",
    packet: fixture(),
  }, {
    logger: {
      info: (message, properties) => logs.push([message, properties]),
    },
    writeResource: async (...args: unknown[]) => {
      writes.push(args);
      return { name: args[1] };
    },
  });
  assert(
    writes.length === 1 && writes[0][0] === "diagnostics" &&
      writes[0][1] === "diagnostics-req-1",
  );
  assert(
    (writes[0][2] as any).authority.execution === false &&
      result.dataHandles.length === 1,
  );
  assert(logs.length === 2);
  assert(
    !model.methods.evaluate.arguments.safeParse({
      requestId: "req-1",
      packet: fixture(),
      unexpected: true,
    }).success,
  );
});
