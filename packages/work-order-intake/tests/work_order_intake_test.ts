import {
  compatibleAssertAcceptedArgumentsSchema,
  CompatibleWorkOrderIntakeResult,
  evaluateCompatibleWorkOrderIntake,
  evaluateWorkOrderIntake,
  model,
  proposalSha256,
  WORK_ORDER_INTAKE_ACTION,
  WORK_ORDER_LIMITS,
} from "../extensions/models/work_order_intake.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}

const subject = {
  kind: "change-proposal",
  id: "proposal-1",
  version: 1,
  sha256: "a".repeat(64),
};
function proposal() {
  const value = {
    proposalId: "proposal-1",
    subject: structuredClone(subject),
    title: "Constrain a synthetic change",
    context: "A deterministic, test-only proposal.",
    approval: {
      decisionId: "decision-1",
      subject: structuredClone(subject),
      actor: { id: "human-1", role: "decision-owner" },
      decision: "approved",
      rationale: "Proceed within stated bounds",
      scope: {
        resource: "proposal-1",
        allowedActions: [WORK_ORDER_INTAKE_ACTION],
      },
      decidedAt: "2026-08-23T12:00:00Z",
      expiresAt: "2026-08-24T12:00:00Z",
      allowedNextAction: WORK_ORDER_INTAKE_ACTION,
    },
    evaluatedAt: "2026-08-23T13:00:00Z",
    acceptanceCriteria: [{
      criterionId: "criterion-1",
      statement: "The synthetic contract remains deterministic",
    }],
    allowedTargets: ["extensions/models/example.ts"],
    changeBudget: { maxFiles: 2, maxChangedLines: 80 },
    deterministicChecks: [{
      checkId: "test",
      command: "deno test",
      expectedExitCode: 0,
    }],
  };
  value.subject.sha256 = proposalSha256(value);
  subject.sha256 = value.subject.sha256;
  value.approval.subject = structuredClone(value.subject);
  return value;
}

function legacyProposal() {
  const dossierSubject = {
    kind: "proposal",
    id: "dossier-subject",
    version: 1,
    sha256: "c".repeat(64),
  };
  return {
    workOrderId: "legacy-work-order",
    dossier: {
      schemaVersion: "1.0",
      dossierId: "dossier-1",
      subject: dossierSubject,
      version: 2,
      createdAt: "2026-08-20T12:00:00Z",
      problem: {
        statement: "Retain the active contract",
        scope: "One bounded compatibility path",
        evidenceIds: ["e1"],
      },
      affectedSegment: {
        segmentId: "segment-1",
        label: "Existing callers",
        definition: "Callers with an approved dossier",
        evidenceIds: ["e1"],
      },
      confidence: {
        level: "high",
        rationale: "The retained contract is recorded",
        evidenceIds: ["e1"],
      },
      strategicFit: {
        alignment: "aligned",
        rationale: "Compatibility preserves stable behavior",
        principleIds: ["compatibility"],
        evidenceIds: ["e1"],
      },
      evidence: [{
        evidenceId: "e1",
        claim: "The retained workflow uses this shape",
        sourceReference: {
          schemaVersion: "1.0",
          sourceId: "source-1",
          source: {
            system: "fixture",
            resourceType: "record",
            resourceId: "record-1",
          },
          provenance: {
            collector: "test",
            collectorVersion: "1",
            method: "fixture",
            collectedAt: "2026-08-20T11:00:00Z",
          },
          observedAt: "2026-08-20T10:00:00Z",
          freshness: {
            asOf: "2026-08-20T10:00:00Z",
            expiresAt: "2026-08-30T10:00:00Z",
          },
          sensitivity: "internal",
        },
      }],
      options: [{
        optionId: "option-action",
        kind: "action",
        title: "Retain compatibility",
        description: "Accept the exact retained shape",
        evidenceIds: ["e1"],
      }, {
        optionId: "option-none",
        kind: "do_nothing",
        title: "Do nothing",
        description: "Reject existing callers",
        evidenceIds: ["e1"],
      }],
      recommendation: {
        optionId: "option-action",
        rationale: "Compatibility is required",
        evidenceIds: ["e1"],
      },
      effort: {
        size: "small",
        status: "hypothetical",
        estimate: 1,
        unit: "day",
        rationale: "A bounded schema change",
        evidenceIds: [],
        assumptions: ["The retained shape remains stable"],
      },
      economics: {
        estimates: [],
        summary: "No economic estimate is required",
      },
      risks: [],
      authority: {
        decisionMaker: { id: "human-1", role: "decision-owner" },
        authorityBasis: "Explicit approval",
        decisionDueAt: "2026-08-21T12:00:00Z",
      },
      expectedOutcomes: [{
        outcomeId: "outcome-1",
        statement: "Existing callers remain valid",
        metricIds: ["metric-1"],
      }],
      measurementPlan: {
        metrics: [{
          metricId: "metric-1",
          name: "Compatibility checks",
          unit: "checks",
          desiredDirection: "maintain",
          target: 1,
        }],
        windows: [{
          windowId: "window-1",
          purpose: "Verify compatibility",
          window: {
            startsAt: "2026-08-23T12:00:00Z",
            endsAt: "2026-08-24T12:00:00Z",
          },
        }],
        ownerId: "human-1",
        reviewAt: "2026-08-24T12:00:00Z",
      },
    },
    approval: {
      schemaVersion: "1.0",
      decisionId: "legacy-decision",
      subject: dossierSubject,
      actor: { id: "human-1", role: "decision-owner" },
      decision: "approved",
      rationale: "Proceed",
      scope: { resource: "dossier-1", allowedActions: ["create_work_order"] },
      decidedAt: "2026-08-21T12:00:00Z",
      expiresAt: "2026-08-25T12:00:00Z",
      allowedNextAction: "create_work_order",
    },
    evaluatedAt: "2026-08-23T12:00:00Z",
    acceptanceCriteria: [{
      criterionId: "ac-1",
      statement: "Old workflow remains valid",
    }],
    allowedPaths: ["workflows/intake.yaml"],
    changeBudget: { maxFiles: 2, maxChangedLines: 80 },
    riskClassification: {
      level: "low",
      rationale: "Decision-only compatibility",
    },
    deterministicChecks: [{
      checkId: "test",
      command: "deno test",
      expectedExitCode: 0,
    }],
    evidenceLinks: [{ evidenceId: "e1", purpose: "Grounds the proposal" }],
  };
}

Deno.test("old workflow inputs persist workOrder and legacy result assertions remain valid", async () => {
  const accepted = evaluateCompatibleWorkOrderIntake(legacyProposal());
  assert(accepted.accepted && "workOrder" in accepted);
  equal(accepted.workOrder.workOrderId, "legacy-work-order");
  assert(
    CompatibleWorkOrderIntakeResult.safeParse(accepted).success,
    "retained accepted output must parse",
  );
  assert(
    compatibleAssertAcceptedArgumentsSchema.safeParse({ result: accepted })
      .success,
  );
  equal(
    await model.methods.assertAccepted.execute({ result: accepted }, {
      writeResource: () => Promise.resolve({}),
    }),
    { dataHandles: [] },
  );
});

Deno.test("strict contract union rejects malformed generic/legacy hybrids", () => {
  const hybrid = {
    ...proposal(),
    workOrderId: "legacy-work-order",
    dossier: legacyProposal().dossier,
  };
  const result = evaluateCompatibleWorkOrderIntake(hybrid);
  assert(!result.accepted);
  assert(
    !compatibleAssertAcceptedArgumentsSchema.safeParse({
      intakeId: "hybrid",
      subject,
      result: evaluateWorkOrderIntake(proposal()),
    }).success,
  );
  assert(
    !compatibleAssertAcceptedArgumentsSchema.safeParse({
      result: evaluateWorkOrderIntake(proposal()),
    }).success,
    "result-only compatibility form must accept only retained results",
  );
});

Deno.test("retained dossier rejects unknown nested fields and placeholder objects", () => {
  const unknown = legacyProposal();
  unknown.dossier.problem = {
    ...unknown.dossier.problem,
    unexpected: "must fail closed",
  } as typeof unknown.dossier.problem;
  assert(!evaluateCompatibleWorkOrderIntake(unknown).accepted);

  const placeholder = legacyProposal();
  placeholder.dossier.affectedSegment =
    {} as typeof placeholder.dossier.affectedSegment;
  assert(!evaluateCompatibleWorkOrderIntake(placeholder).accepted);
});

Deno.test("retained dossier enforces semantic references, freshness, windows, and dates", () => {
  const cases: unknown[] = [];
  const duplicate = legacyProposal();
  duplicate.dossier.evidence.push(
    structuredClone(duplicate.dossier.evidence[0]),
  );
  cases.push(duplicate);
  const missingEvidence = legacyProposal();
  missingEvidence.dossier.problem.evidenceIds = ["missing"];
  cases.push(missingEvidence);
  const missingOption = legacyProposal();
  missingOption.dossier.recommendation.optionId = "missing";
  cases.push(missingOption);
  const missingMetric = legacyProposal();
  missingMetric.dossier.expectedOutcomes[0].metricIds = ["missing"];
  cases.push(missingMetric);
  const stale = legacyProposal();
  stale.dossier.evidence[0].sourceReference.freshness.asOf =
    "2026-08-19T10:00:00Z";
  cases.push(stale);
  const badWindow = legacyProposal();
  badWindow.dossier.measurementPlan.windows[0].window.endsAt =
    badWindow.dossier.measurementPlan.windows[0].window.startsAt;
  cases.push(badWindow);
  const badDueDate = legacyProposal();
  badDueDate.dossier.authority.decisionDueAt = "2026-08-19T12:00:00Z";
  cases.push(badDueDate);
  const badReviewDate = legacyProposal();
  badReviewDate.dossier.measurementPlan.reviewAt = "2026-08-19T12:00:00Z";
  cases.push(badReviewDate);
  const duplicatePath = legacyProposal();
  duplicatePath.allowedPaths.push(duplicatePath.allowedPaths[0]);
  cases.push(duplicatePath);
  for (const value of cases) {
    assert(!evaluateCompatibleWorkOrderIntake(value).accepted);
  }
});

Deno.test("retained evidence requirements reject unsupported observed and hypothetical claims", () => {
  const effort = legacyProposal();
  effort.dossier.effort.status = "observed";
  effort.dossier.effort.evidenceIds = [];
  assert(!evaluateCompatibleWorkOrderIntake(effort).accepted);

  for (const status of ["observed", "hypothetical"] as const) {
    const estimate = legacyProposal();
    (estimate.dossier.economics.estimates as unknown[]).push({
      estimateId: "estimate-1",
      optionId: "option-action",
      label: "Estimate",
      direction: "cost",
      status,
      asOf: "2026-08-20T12:00:00Z",
      evidenceIds: ["e1"],
      assumptions: [],
      valueType: "quantity",
      value: 1,
      unit: "day",
    });
    assert(!evaluateCompatibleWorkOrderIntake(estimate).accepted);
  }
});

Deno.test("retained result-only assertion logs entry and completion", async () => {
  const messages: string[] = [];
  const result = evaluateCompatibleWorkOrderIntake(legacyProposal());
  assert(result.accepted && "workOrder" in result);
  await model.methods.assertAccepted.execute({ result }, {
    writeResource: () => Promise.resolve({}),
    logger: { info: (message) => messages.push(message) },
  });
  equal(messages, [
    "Asserting retained work-order intake result",
    "Confirmed retained work-order intake result",
  ]);
});

Deno.test("retained persisted split result keeps its exact strict shape", () => {
  const retainedRecord = {
    accepted: false,
    disposition: "split_required",
    diagnostics: [{
      path: "changeBudget.maxChangedLines",
      code: "split_required",
      message: "proposal exceeds 600 changed lines",
    }, {
      path: "changeBudget.maxFiles",
      code: "split_required",
      message: "proposal exceeds 12 files",
    }],
    authority: {
      implementationApprovalGate: "plan-approval",
      mayApproveImplementation: false,
      sideEffects: "none",
      mayExecute: false,
    },
  };
  assert(CompatibleWorkOrderIntakeResult.safeParse(retainedRecord).success);
  assert(
    !CompatibleWorkOrderIntakeResult.safeParse({
      ...retainedRecord,
      privateMetadata: "not part of the retained record",
    }).success,
  );
});

Deno.test("synthetic proposal schema accepts only a bounded, subject-bound decision", () => {
  const result = evaluateWorkOrderIntake(proposal());
  assert(result.accepted, JSON.stringify(result));
  equal(result.acceptedProposal.decisionId, "decision-1");
  equal(result.acceptedProposal.subject, subject);
});

Deno.test("intake is deterministic and idempotently persists the same synthetic result", async () => {
  let stored: Record<string, unknown> | null = null;
  const run = async () => {
    const writes: Array<
      { spec: string; name: string; data: Record<string, unknown> }
    > = [];
    const result = await model.methods.intake.execute({
      intakeId: "synthetic-intake",
      proposal: proposal(),
    }, {
      readResource: () => Promise.resolve(stored),
      writeResource: (spec, name, data) => {
        writes.push({ spec, name, data });
        stored = data;
        return Promise.resolve({ name });
      },
    });
    return { writes, result };
  };
  const first = await run();
  const second = await run();
  equal(first.writes[0].name, "intake-synthetic-intake");
  equal(second.writes, []);
  equal(second.result.dataHandles, []);

  let collisionRejected = false;
  const changed = proposal();
  changed.title = "Different content for the same intake ID";
  try {
    await model.methods.intake.execute({
      intakeId: "synthetic-intake",
      proposal: changed,
    }, {
      readResource: () => Promise.resolve(stored),
      writeResource: () => Promise.resolve({}),
    });
  } catch (error) {
    collisionRejected = String(error).includes("different content");
  }
  assert(collisionRejected);
});

Deno.test("unapproved, mismatched, expired, oversized, and unsafe proposals fail closed", () => {
  const baseline = proposal();
  const cases: unknown[] = [
    {
      ...baseline,
      approval: {
        ...baseline.approval,
        decision: "rejected",
        allowedNextAction: undefined,
      },
    },
    {
      ...baseline,
      approval: {
        ...baseline.approval,
        subject: { ...baseline.approval.subject, sha256: "b".repeat(64) },
      },
    },
    { ...baseline, evaluatedAt: baseline.approval.expiresAt },
    { ...baseline, allowedTargets: ["../escape.ts"] },
    {
      ...baseline,
      changeBudget: {
        ...baseline.changeBudget,
        maxFiles: WORK_ORDER_LIMITS.files + 1,
      },
    },
  ];
  for (const value of cases) {
    assert(!evaluateWorkOrderIntake(value).accepted);
  }
});

Deno.test("the extension retains no authority and cannot perform external actions", () => {
  const result = evaluateWorkOrderIntake(proposal());
  assert(result.accepted);
  equal(result.authority, {
    implementationApprovalGate: "plan-approval",
    mayApproveImplementation: false,
    sideEffects: "none",
    mayExecute: false,
  });
  equal(result.acceptedProposal.authority, {
    implementationApprovalGate: "plan-approval",
    mayApproveImplementation: false,
    sideEffects: "none",
    mayExecute: false,
    humanAcceptancePreserved: true,
  });
  equal(Object.keys(model.methods), ["intake", "assertAccepted"]);
  assert(!("files" in model));
});

Deno.test("assertAccepted trusts only the persisted stable intake identity", async () => {
  const accepted = evaluateWorkOrderIntake(proposal());
  const context = {
    readResource: (name: string) =>
      Promise.resolve(name === "intake-synthetic-intake" ? accepted : null),
    writeResource: () => Promise.resolve({}),
  };
  await model.methods.assertAccepted.execute(
    { intakeId: "synthetic-intake", subject },
    context,
  );

  let rejected = false;
  try {
    await model.methods.assertAccepted.execute(
      { intakeId: "missing", subject },
      context,
    );
  } catch (error) {
    rejected = String(error).includes("missing or invalid");
  }
  assert(rejected);
  assert(
    !model.methods.assertAccepted.arguments.safeParse({
      intakeId: "missing",
      subject,
      result: accepted,
    }).success,
    "fabricated caller results must be rejected",
  );
});

Deno.test("tampered proposal content and confused-deputy assertions fail closed", async () => {
  const tampered = proposal();
  tampered.title = "Tampered after approval";
  assert(!evaluateWorkOrderIntake(tampered).accepted);

  const accepted = evaluateWorkOrderIntake(proposal());
  let rejected = false;
  try {
    await model.methods.assertAccepted.execute({
      intakeId: "synthetic-intake",
      subject: { ...subject, sha256: "b".repeat(64) },
    }, {
      readResource: () => Promise.resolve(accepted),
      writeResource: () => Promise.resolve({}),
    });
  } catch (error) {
    rejected = String(error).includes("expected subject");
  }
  assert(rejected);
});

Deno.test("proposal text and collection inputs have practical hard bounds", () => {
  assert(
    !evaluateWorkOrderIntake({
      ...proposal(),
      title: "x".repeat(10_001),
    }).accepted,
  );
  assert(
    !evaluateWorkOrderIntake({
      ...proposal(),
      acceptanceCriteria: Array.from(
        { length: 101 },
        (_, index) => ({ criterionId: `c-${index}`, statement: "bounded" }),
      ),
    }).accepted,
  );
});
