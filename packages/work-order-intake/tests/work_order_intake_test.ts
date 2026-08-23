import {
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
