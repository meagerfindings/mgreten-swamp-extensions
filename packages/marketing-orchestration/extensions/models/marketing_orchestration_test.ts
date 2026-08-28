import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260824.32";
import { digestPublicationRequests, model } from "./marketing_orchestration.ts";

const globals = {
  approvalPrincipals: [{
    principal: "alex@example.test",
    role: "marketing-owner",
  }],
  ideationPolicy: { minIdeas: 20, maxIdeas: 60, minGroups: 4 },
  dispatchBindings: [{
    channel: "newsletter",
    model: "newsletter-publisher",
    method: "send",
    intendedState: "send",
    successfulObservedStates: ["delivered"],
  }],
  states: {
    initialObserved: "idle",
    queuedObserved: "accepted",
    failedObserved: "error",
    canceledObserved: "withdrawn",
  },
};
function memoryContext(options: { failWriteSpec?: string } = {}) {
  const records = new Map<string, Record<string, unknown>>();
  const versions = new Map<string, Record<string, unknown>[]>();
  const context = {
    modelType: model.type,
    modelId: "model-1",
    globalArgs: globals,
    readResource: (name: string) => Promise.resolve(records.get(name) ?? null),
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      if (options.failWriteSpec === spec) {
        options.failWriteSpec = undefined;
        return Promise.reject(new Error(`injected ${spec} write failure`));
      }
      records.set(name, structuredClone(data));
      const list = versions.get(name) ?? [];
      list.push(structuredClone(data));
      versions.set(name, list);
      return Promise.resolve({
        kind: "resource",
        specName: spec,
        name,
        version: list.length,
      });
    },
    dataRepository: {
      findAllForModel: () =>
        Promise.resolve(
          Array.from(versions.entries()).flatMap(([name, values]) =>
            values.map(
              (_value, index): {
                name: string;
                version: number;
                createdAt?: string;
                tags: { specName: string };
              } => ({
                name,
                version: index + 1,
                createdAt: new Date(index + 1).toISOString(),
                tags: {
                  specName: name.startsWith("schedule-")
                    ? "scheduleEntry"
                    : "other",
                },
              }),
            )
          ),
        ),
      getContent: (
        _type: string,
        _id: string,
        name: string,
        version?: number,
      ): Promise<Uint8Array | null> =>
        Promise.resolve(
          new TextEncoder().encode(
            JSON.stringify(versions.get(name)?.[(version ?? 1) - 1]),
          ),
        ),
    },
  };
  return { records, versions, context };
}
const ideas = Array.from(
  { length: 20 },
  (_, index) => ({
    ideaId: `idea-${index}`,
    group: `group-${index % 4}`,
    title: `Idea ${index}`,
    audience: "Audience",
    tension: "Tension",
    promise: "Promise",
    proofNeeded: "Proof",
    formatHypothesis: "Format",
    whyItMightWork: "Reason",
  }),
);

Deno.test("ideation policy is bounded, coherent, and enforced at execution", async () => {
  const customGlobals = {
    ...globals,
    ideationPolicy: { minIdeas: 3, maxIdeas: 5, minGroups: 2 },
  };
  assertEquals(model.globalArguments.parse(customGlobals).ideationPolicy, {
    minIdeas: 3,
    maxIdeas: 5,
    minGroups: 2,
  });
  for (
    const ideationPolicy of [
      { minIdeas: 6, maxIdeas: 5, minGroups: 2 },
      { minIdeas: 3, maxIdeas: 5, minGroups: 4 },
      { minIdeas: 1, maxIdeas: 101, minGroups: 1 },
    ]
  ) {
    assertEquals(
      model.globalArguments.safeParse({
        ...globals,
        ideationPolicy,
      }).success,
      false,
    );
  }

  const args = {
    schemaVersion: "1.0" as const,
    campaignId: "policy-campaign",
    campaignName: "Policy campaign",
    brief: "Configurable bounds",
    capturedAt: "2026-08-28T10:00:00Z",
  };
  for (const rejectedIdeas of [ideas.slice(0, 2), ideas.slice(0, 6)]) {
    const state = memoryContext();
    state.context.globalArgs = customGlobals;
    await assertRejects(
      () =>
        model.methods.captureIdeation.execute(
          { ...args, ideas: rejectedIdeas },
          state.context,
        ),
      TypeError,
      "ideation requires 3-5 ideas",
    );
  }
  const state = memoryContext();
  state.context.globalArgs = customGlobals;
  await assertRejects(
    () =>
      model.methods.captureIdeation.execute({
        ...args,
        ideas: ideas.slice(0, 3).map((idea) => ({
          ...idea,
          group: "one-group",
        })),
      }, state.context),
    TypeError,
    "at least 2 groups",
  );
  await model.methods.captureIdeation.execute({
    ...args,
    ideas: ideas.slice(0, 3),
  }, state.context);
  assertEquals(
    (state.records.get("ideation-policy-campaign")?.ideas as unknown[]).length,
    3,
  );
});

async function fixture() {
  const state = memoryContext();
  await model.methods.captureIdeation.execute({
    schemaVersion: "1.0" as const,
    campaignId: "campaign-1",
    campaignName: "Campaign",
    brief: "A bounded brief",
    capturedAt: "2026-08-28T10:00:00Z",
    ideas,
  }, state.context);
  const ideation = state.records.get("ideation-campaign-1")!;
  await model.methods.approveDirection.execute({
    schemaVersion: "1.0",
    campaignId: "campaign-1",
    approvalId: "direction-1",
    principal: "alex@example.test",
    role: "marketing-owner",
    approvedAt: "2026-08-28T11:00:00Z",
    ideationDigest: String(ideation.digest),
    selectedIdeaIds: ["idea-0"],
    thesis: "A useful direction",
    supportingPoints: ["Point one", "Point two"],
  }, state.context);
  await model.methods.stageRelease.execute({
    schemaVersion: "1.0",
    campaignId: "campaign-1",
    releaseId: "release-1",
    directionApprovalId: "direction-1",
    preparedAt: "2026-08-28T12:00:00Z",
    items: [{
      itemId: "item-1",
      ideaId: "idea-0",
      variantId: "variant-1",
      label: "Launch note",
      channel: "newsletter",
      scheduledAt: "2026-09-01T15:00:00Z",
      timeZone: "UTC",
      planningStatus: "approval_pending",
      content: { subject: "Hello", body: "World" },
    }],
  }, state.context);
  const draft = state.records.get("release-draft-campaign-1-release-1")!;
  const approval = {
    campaignId: "campaign-1",
    releaseId: "release-1",
    expectedDraftDigest: String(draft.digest),
    exactApproval: {
      approvalId: "release-approval-1",
      approved: true as const,
      principal: "alex@example.test",
      role: "marketing-owner",
      approvedAt: "2026-08-28T13:00:00Z",
      draftDigest: String(draft.digest),
      publicationRequestsDigest: "0".repeat(64),
    },
    publicationRequests: [{
      itemId: "item-1",
      model: "newsletter-publisher",
      method: "send",
      arguments: {
        payload: { subject: "Hello", body: "World" },
        idempotencyKey: "release-1-item-1",
      },
    }],
  };
  approval.exactApproval.publicationRequestsDigest =
    await digestPublicationRequests(approval.publicationRequests);
  await model.methods.approveRelease.execute(approval, state.context);
  return { ...state, approval };
}

Deno.test("approval is authorized, digest-bound, immutable, and replay-safe", async () => {
  const state = await fixture();
  const release = state.records.get("release-approved-campaign-1-release-1")!;
  assertEquals((release.items as Array<Record<string, unknown>>)[0].dispatch, {
    model: "newsletter-publisher",
    method: "send",
    arguments: {
      payload: { subject: "Hello", body: "World" },
      idempotencyKey: "release-1-item-1",
    },
  });
  assertEquals(
    (await model.methods.approveRelease.execute(state.approval, state.context))
      .dataHandles,
    [],
  );
  const altered = structuredClone(state.approval);
  altered.publicationRequests[0].arguments.idempotencyKey = "altered";
  await assertRejects(
    () => model.methods.approveRelease.execute(altered, state.context),
    TypeError,
    "publication request digest mismatch",
  );
  await assertRejects(
    () =>
      model.methods.approveDirection.execute({
        schemaVersion: "1.0",
        campaignId: "campaign-1",
        approvalId: "other",
        principal: "intruder",
        role: "marketing-owner",
        approvedAt: "2026-08-28T11:00:00Z",
        ideationDigest: "a".repeat(64),
        selectedIdeaIds: ["idea-0"],
        thesis: "No",
        supportingPoints: ["One", "Two"],
      }, state.context),
    TypeError,
    "not authorized",
  );
});

Deno.test("multi-item stage and approval retries heal injected mid-write failures", async () => {
  const state = await fixture();
  const stage = {
    schemaVersion: "1.0" as const,
    campaignId: "campaign-1",
    releaseId: "release-2",
    directionApprovalId: "direction-1",
    preparedAt: "2026-08-28T12:00:00Z",
    items: ["a", "b"].map((suffix, index) => ({
      itemId: `item-${suffix}`,
      ideaId: "idea-0",
      variantId: `variant-${suffix}`,
      label: `Launch note ${suffix}`,
      channel: "newsletter",
      scheduledAt: `2026-09-0${index + 1}T15:00:00Z`,
      timeZone: "UTC",
      planningStatus: "approval_pending" as const,
      content: { subject: `Hello ${suffix}`, body: "World" },
    })),
  };
  const originalWrite = state.context.writeResource;
  let failStage = true;
  state.context.writeResource = (spec, name, data) => {
    if (failStage && name === "schedule-campaign-1-release-2-item-b") {
      failStage = false;
      return Promise.reject(new Error("injected stage mid-write failure"));
    }
    return originalWrite(spec, name, data);
  };
  await assertRejects(
    () => model.methods.stageRelease.execute(stage, state.context),
    Error,
    "injected stage mid-write failure",
  );
  assertEquals(
    state.records.has("schedule-campaign-1-release-2-item-a"),
    true,
  );
  assertEquals(
    state.records.has("schedule-campaign-1-release-2-item-b"),
    false,
  );
  await model.methods.stageRelease.execute(stage, state.context);
  assertEquals(
    state.records.get("schedule-campaign-1-release-2-item-b")?.approvalState,
    "pending",
  );

  const draft = state.records.get("release-draft-campaign-1-release-2")!;
  const publicationRequests = ["a", "b"].map((suffix) => ({
    itemId: `item-${suffix}`,
    model: "newsletter-publisher",
    method: "send",
    arguments: { payload: { subject: `Hello ${suffix}`, body: "World" } },
  }));
  const approval = {
    campaignId: "campaign-1",
    releaseId: "release-2",
    expectedDraftDigest: String(draft.digest),
    exactApproval: {
      approvalId: "release-approval-2",
      approved: true as const,
      principal: "alex@example.test",
      role: "marketing-owner",
      approvedAt: "2026-08-28T13:00:00Z",
      draftDigest: String(draft.digest),
      publicationRequestsDigest: await digestPublicationRequests(
        publicationRequests,
      ),
    },
    publicationRequests,
  };
  let failApproval = true;
  state.context.writeResource = (spec, name, data) => {
    if (failApproval && name === "schedule-campaign-1-release-2-item-b") {
      failApproval = false;
      return Promise.reject(new Error("injected approval mid-write failure"));
    }
    return originalWrite(spec, name, data);
  };
  await assertRejects(
    () => model.methods.approveRelease.execute(approval, state.context),
    Error,
    "injected approval mid-write failure",
  );
  assertEquals(
    state.records.get("schedule-campaign-1-release-2-item-a")?.approvalState,
    "approved",
  );
  assertEquals(
    state.records.get("schedule-campaign-1-release-2-item-b")?.approvalState,
    "pending",
  );
  await model.methods.approveRelease.execute(approval, state.context);
  assertEquals(
    state.records.get("schedule-campaign-1-release-2-item-b")?.approvalState,
    "approved",
  );
});

Deno.test("calendar uses latest state as of generation and does not resurrect deletions", async () => {
  const state = await fixture();
  const name = "schedule-campaign-1-release-1-item-1";
  const values = state.versions.get(name)!;
  state.context.dataRepository.findAllForModel = () =>
    Promise.resolve([
      {
        name,
        version: 1,
        tags: { specName: "scheduleEntry" },
        createdAt: "2026-08-28T12:00:00Z",
      },
      {
        name,
        version: 2,
        tags: { specName: "scheduleEntry" },
        lifecycle: "deleted",
        createdAt: "2026-08-28T14:00:00Z",
      },
    ]);
  values.push(structuredClone(values[0]));
  await model.methods.calendar.execute({
    generatedAt: "2026-08-28T13:00:00Z",
    from: null,
    until: null,
    statuses: [],
  }, state.context);
  assertEquals(
    (state.records.get("calendar-current")?.entries as unknown[]).length,
    1,
  );
  await model.methods.calendar.execute({
    generatedAt: "2026-08-28T15:00:00Z",
    from: null,
    until: null,
    statuses: [],
  }, state.context);
  assertEquals(
    (state.records.get("calendar-current")?.entries as unknown[]).length,
    0,
  );
  await assertRejects(
    () =>
      model.methods.calendar.execute({
        generatedAt: "2026-08-28T15:00:00Z",
        from: "2026-09-02T00:00:00Z",
        until: "2026-09-01T00:00:00Z",
        statuses: [],
      }, state.context),
    TypeError,
    "calendar window is invalid",
  );
});

Deno.test("calendar excludes schedule history without a valid createdAt", async () => {
  const state = await fixture();
  const name = "schedule-campaign-1-release-1-item-1";
  state.context.dataRepository.findAllForModel = () =>
    Promise.resolve([
      { name, version: 1, tags: { specName: "scheduleEntry" } },
      {
        name,
        version: 1,
        tags: { specName: "scheduleEntry" },
        createdAt: "not-a-timestamp",
      },
    ]);
  await model.methods.calendar.execute({
    generatedAt: "2026-08-28T15:00:00Z",
    from: null,
    until: null,
    statuses: [],
  }, state.context);
  assertEquals(
    (state.records.get("calendar-current")?.entries as unknown[]).length,
    0,
  );
});

Deno.test("calendar fails contextually when selected schedule content is missing", async () => {
  const state = await fixture();
  const name = "schedule-campaign-1-release-1-item-1";
  state.context.dataRepository.findAllForModel = () =>
    Promise.resolve([{
      name,
      version: 99,
      tags: { specName: "scheduleEntry" },
      createdAt: "2026-08-28T14:00:00Z",
    }]);
  state.context.dataRepository.getContent = () => Promise.resolve(null);
  await assertRejects(
    () =>
      model.methods.calendar.execute({
        generatedAt: "2026-08-28T15:00:00Z",
        from: null,
        until: null,
        statuses: [],
      }, state.context),
    TypeError,
    `schedule ${name} version 99 content is unavailable`,
  );
});

Deno.test("dispatch attempts are retryable and idempotent per attempt", async () => {
  const state = await fixture();
  const release = state.records.get("release-approved-campaign-1-release-1")!;
  const prepare = (attemptId: string, asOf = "2026-09-01T15:00:00Z") =>
    model.methods.prepareDispatch.execute({
      campaignId: "campaign-1",
      releaseId: "release-1",
      itemId: "item-1",
      attemptId,
      asOf,
    }, state.context);
  await assertRejects(
    () => prepare("attempt-1", "2026-09-01T14:59:59Z"),
    TypeError,
    "not due",
  );
  assertEquals((await prepare("attempt-1")).dataHandles.length, 1);
  assertEquals((await prepare("attempt-1")).dataHandles, []);
  const firstName = "dispatch-campaign-1-release-1-item-1-attempt-1";
  const first = state.records.get(firstName)!;
  const approvedItem = (release.items as Array<Record<string, unknown>>)[0];
  const approvedDispatch = approvedItem.dispatch as Record<string, unknown>;
  assertEquals(first.arguments, approvedDispatch.arguments);
  assertEquals(
    first.claimId,
    "3d66a2c199d073b2c42143edebcb41f984782e7a1601033d5dd9efb826691e53",
  );
  const failed = {
    campaignId: "campaign-1",
    releaseId: "release-1",
    itemId: "item-1",
    expectedReleaseDigest: String(release.digest),
    dispatchClaimId: String(first.claimId),
    attemptId: "attempt-1",
    status: "failed" as const,
    observedPlatformState: "error",
    observedAt: "2026-09-01T15:00:01Z",
    platformReference: null,
    detail: "publisher failed",
  };
  await model.methods.recordDelivery.execute(failed, state.context);
  await assertRejects(
    () => prepare("attempt-1"),
    TypeError,
    "failed dispatch attempt cannot be re-emitted",
  );
  assertEquals((await prepare("attempt-2")).dataHandles.length, 1);
  assertEquals((await prepare("attempt-2")).dataHandles, []);
  const secondName = "dispatch-campaign-1-release-1-item-1-attempt-2";
  const second = state.records.get(secondName)!;
  assertEquals(second.arguments, approvedDispatch.arguments);
  await assertRejects(
    () =>
      model.methods.recordDelivery.execute({
        ...failed,
        dispatchClaimId: String(first.claimId),
        attemptId: "attempt-2",
        observedAt: "2026-09-01T15:00:02Z",
      }, state.context),
    TypeError,
    "schedule dispatch binding mismatch",
  );
  await model.methods.recordDelivery.execute({
    ...failed,
    dispatchClaimId: String(second.claimId),
    attemptId: "attempt-2",
    status: "scheduled",
    observedPlatformState: "accepted",
    observedAt: "2026-09-01T15:00:02Z",
    detail: null,
  }, state.context);
  assertEquals(state.records.get(secondName)?.claimStatus, "reconciled");
  assertEquals(state.records.get(secondName)?.deliveryStatus, "scheduled");
  await assertRejects(
    () => prepare("attempt-3", "2026-09-01T16:00:00Z"),
    TypeError,
    "not dispatchable",
  );
});

Deno.test("recordDelivery rejects schema-valid foreign and stale claims", async () => {
  const state = await fixture();
  const prepare = async (attemptId: string) => {
    await model.methods.prepareDispatch.execute({
      campaignId: "campaign-1",
      releaseId: "release-1",
      itemId: "item-1",
      attemptId,
      asOf: "2026-09-01T15:00:00Z",
    }, state.context);
    return state.records.get(
      `dispatch-campaign-1-release-1-item-1-${attemptId}`,
    )!;
  };
  const expected = await prepare("expected-attempt");
  const claimName = "dispatch-campaign-1-release-1-item-1-expected-attempt";
  const release = state.records.get("release-approved-campaign-1-release-1")!;
  const delivery = {
    campaignId: "campaign-1",
    releaseId: "release-1",
    itemId: "item-1",
    expectedReleaseDigest: String(release.digest),
    dispatchClaimId: String(expected.claimId),
    attemptId: "expected-attempt",
    status: "failed" as const,
    observedPlatformState: "error",
    observedAt: "2026-09-01T15:00:01Z",
    platformReference: null,
    detail: "hostile claim",
  };

  // A schema-valid claim from another attempt occupies the expected name.
  state.records.set(claimName, {
    ...structuredClone(expected),
    attemptId: "foreign-attempt",
  });
  await assertRejects(
    () => model.methods.recordDelivery.execute(delivery, state.context),
    TypeError,
    "dispatch claim mismatch",
  );

  // Even the expected digest cannot bless stale publisher fields.
  state.records.set(claimName, {
    ...structuredClone(expected),
    model: "foreign-publisher",
    method: "publish",
    arguments: { payload: { subject: "Stale", body: "packet" } },
  });
  await assertRejects(
    () => model.methods.recordDelivery.execute(delivery, state.context),
    TypeError,
    "dispatch claim mismatch",
  );
});

Deno.test("schedule binding serializes distinct attempts until reconciliation", async () => {
  const state = await fixture();
  const prepare = (attemptId: string) =>
    model.methods.prepareDispatch.execute({
      campaignId: "campaign-1",
      releaseId: "release-1",
      itemId: "item-1",
      attemptId,
      asOf: "2026-09-01T15:00:00Z",
    }, state.context);
  const results = await Promise.allSettled([
    prepare("parallel-a"),
    prepare("parallel-b"),
  ]);
  assertEquals(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assertEquals(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
  const schedule = state.records.get("schedule-campaign-1-release-1-item-1")!;
  assertEquals(schedule.status, "dispatching");
  assertEquals(
    ["parallel-a", "parallel-b"].includes(String(schedule.dispatchAttemptId)),
    true,
  );
});

Deno.test("prepareDispatch repairs a claim-write interruption for only the bound attempt", async () => {
  const state = await fixture();
  const originalWrite = state.context.writeResource;
  let failClaim = true;
  state.context.writeResource = (spec, name, data) => {
    if (spec === "dispatch" && failClaim) {
      failClaim = false;
      return Promise.reject(new Error("injected claim write failure"));
    }
    return originalWrite(spec, name, data);
  };
  const prepare = (attemptId: string) =>
    model.methods.prepareDispatch.execute({
      campaignId: "campaign-1",
      releaseId: "release-1",
      itemId: "item-1",
      attemptId,
      asOf: "2026-09-01T15:00:00Z",
    }, state.context);
  await assertRejects(
    () => prepare("repair-claim"),
    Error,
    "injected claim write failure",
  );
  const schedule = state.records.get("schedule-campaign-1-release-1-item-1")!;
  assertEquals(schedule.status, "dispatching");
  assertEquals(schedule.dispatchAttemptId, "repair-claim");
  await assertRejects(
    () => prepare("other-claim"),
    TypeError,
    "another dispatch attempt is already in progress",
  );
  assertEquals((await prepare("repair-claim")).dataHandles.length, 1);
  assertEquals((await prepare("repair-claim")).dataHandles, []);
});

Deno.test("prepareDispatch does not create a claim when the schedule write fails", async () => {
  const state = await fixture();
  const originalWrite = state.context.writeResource;
  let failSchedule = true;
  state.context.writeResource = (spec, name, data) => {
    if (spec === "scheduleEntry" && failSchedule) {
      failSchedule = false;
      return Promise.reject(new Error("injected schedule write failure"));
    }
    return originalWrite(spec, name, data);
  };
  const args = {
    campaignId: "campaign-1",
    releaseId: "release-1",
    itemId: "item-1",
    attemptId: "schedule-repair",
    asOf: "2026-09-01T15:00:00Z",
  };
  await assertRejects(
    () => model.methods.prepareDispatch.execute(args, state.context),
    Error,
    "injected schedule write failure",
  );
  assertEquals(
    state.records.has(
      "dispatch-campaign-1-release-1-item-1-schedule-repair",
    ),
    false,
  );
  assertEquals(
    state.records.get("schedule-campaign-1-release-1-item-1")?.status,
    "approved",
  );
  assertEquals(
    (await model.methods.prepareDispatch.execute(args, state.context))
      .dataHandles
      .length,
    1,
  );
});

Deno.test("recordDelivery repairs a prepared claim after the schedule write succeeds", async () => {
  const state = await fixture();
  await model.methods.prepareDispatch.execute({
    campaignId: "campaign-1",
    releaseId: "release-1",
    itemId: "item-1",
    attemptId: "repair-attempt",
    asOf: "2026-09-01T15:00:00Z",
  }, state.context);
  const release = state.records.get("release-approved-campaign-1-release-1")!;
  const claimName = "dispatch-campaign-1-release-1-item-1-repair-attempt";
  const claim = state.records.get(claimName)!;
  const args = {
    campaignId: "campaign-1",
    releaseId: "release-1",
    itemId: "item-1",
    expectedReleaseDigest: String(release.digest),
    dispatchClaimId: String(claim.claimId),
    attemptId: "repair-attempt",
    status: "failed" as const,
    observedPlatformState: "error",
    observedAt: "2026-09-01T15:00:01Z",
    platformReference: null,
    detail: "publisher rejected request",
  };
  const originalWrite = state.context.writeResource;
  let failDispatch = true;
  state.context.writeResource = (spec, name, data) => {
    if (spec === "dispatch" && failDispatch) {
      failDispatch = false;
      return Promise.reject(new Error("injected dispatch write failure"));
    }
    return originalWrite(spec, name, data);
  };
  await assertRejects(
    () => model.methods.recordDelivery.execute(args, state.context),
    Error,
    "injected dispatch write failure",
  );
  assertEquals(
    state.records.get("schedule-campaign-1-release-1-item-1")?.status,
    "failed",
  );
  assertEquals(state.records.get(claimName)?.claimStatus, "prepared");

  const result = await model.methods.recordDelivery.execute(
    args,
    state.context,
  );
  assertEquals(result.dataHandles.length, 1);
  assertEquals(state.records.get(claimName)?.claimStatus, "reconciled");
  assertEquals(state.records.get(claimName)?.deliveryStatus, "failed");
});

Deno.test("methods emit named structured entry and completion logs", async () => {
  const test = createModelTestContext({ globalArgs: globals });
  const context = {
    ...test.context,
    globalArgs: globals,
    modelType: model.type,
    modelId: "model-1",
    dataRepository: {
      findAllForModel: () => Promise.resolve([]),
      getContent: () => Promise.resolve(null),
    },
  };
  await model.methods.captureIdeation.execute({
    schemaVersion: "1.0",
    campaignId: "logged-campaign",
    campaignName: "Logged campaign",
    brief: "Verify structured lifecycle logs",
    capturedAt: "2026-08-28T10:00:00Z",
    ideas,
  }, context);
  assertEquals(test.getLogsByLevel("info"), [
    {
      level: "info",
      message: "Marketing orchestration method {operation} entered",
      args: [{ operation: "captureIdeation", campaignId: "logged-campaign" }],
    },
    {
      level: "info",
      message:
        "Marketing orchestration method {operation} completed with {outputCount} outputs",
      args: [{ operation: "captureIdeation", outputCount: 1 }],
    },
  ]);
});
