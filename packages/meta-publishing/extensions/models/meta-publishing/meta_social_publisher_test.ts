import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { digestMarketingValue } from "./marketing_campaign_contracts.ts";
import {
  digestSocialPacket,
  digestText,
  dispatchDue,
  model,
  publishPacket,
} from "./meta_social_publisher.ts";

const hash = (character: string) => character.repeat(64);
const facebookCopy = "The little moments deserve a place, too.";
const instagramCopy =
  "Scrapbook the moments that usually don't get scrapbooked.";
const manifest = {
  schemaVersion: "1.0" as const,
  campaignId: "unscrapbooked-moments",
  campaignVersion: 1,
  promise: "Scrapbook the moments that usually don't get scrapbooked.",
  landingPage: {
    url: "https://www.example.com/campaigns/example-campaign",
    headline: "Scrapbook the moments that usually don't get scrapbooked.",
    paragraphs: [
      ["The funny phrase. The ordinary errand. The small story you still want to remember."],
      ["Speak it, type it, or add a photo while the details are still close."],
    ],
    pageCopy:
      "A quiet place for the family moments that never make it into a traditional scrapbook.",
    examples: [
      "The joke they repeated all the way home",
      "The Tuesday-night dinner everyone helped make",
      "The way she always waved from the front step",
    ],
    cta: "Request Early Access",
  },
};

async function packet(
  platforms: Array<"facebook" | "instagram"> = ["facebook", "instagram"],
) {
  const posts = [];
  if (platforms.includes("facebook")) {
    posts.push({
      platform: "facebook" as const,
      copy: facebookCopy,
      copyDigest: await digestText(facebookCopy),
      mediaUrl: "https://cdn.example.test/facebook.jpg",
      mediaDigest: hash("c"),
    });
  }
  if (platforms.includes("instagram")) {
    posts.push({
      platform: "instagram" as const,
      copy: instagramCopy,
      copyDigest: await digestText(instagramCopy),
      mediaUrl: "https://cdn.example.test/instagram.jpg",
      mediaDigest: hash("d"),
    });
  }
  const payload = {
    manifest,
    campaignPacketDigest: await digestMarketingValue(manifest),
    landingPageDigest: await digestMarketingValue(manifest.landingPage),
    posts,
    rights: {
      rightsId: "owned-unscrapbooked-v1",
      owner: "Moment Savor" as const,
      sourceDigests: posts.flatMap((post) =>
        post.mediaDigest ? [post.mediaDigest] : []
      ),
      campaignId: manifest.campaignId,
      permittedUse: "organic_social" as const,
      destinations: platforms,
      effectiveAt: "2026-08-01T00:00:00Z",
      expiresAt: "2030-01-01T00:00:00Z",
    },
  };
  return { ...payload, socialPacketDigest: await digestSocialPacket(payload) };
}

async function approval(
  platforms: Array<"facebook" | "instagram"> = ["facebook", "instagram"],
) {
  const value = await packet(platforms);
  return {
    approved: true as const,
    actor: "founder" as const,
    approvalId: "founder-review-1",
    campaignPacketDigest: value.campaignPacketDigest,
    landingPageDigest: value.landingPageDigest,
    socialPacketDigest: value.socialPacketDigest,
  };
}

function context(
  existing: Record<string, unknown> | null = null,
  credentials = true,
) {
  const writes: Array<[string, string, Record<string, unknown>]> = [];
  return {
    writes,
    value: {
      logger: { info: () => undefined },
      globalArgs: {
        accessToken: credentials ? "secret-token" : "",
        credentialSource: credentials
          ? "vault" as const
          : "unconfigured" as const,
        facebookPageId: credentials ? "123" : "",
        instagramBusinessAccountId: credentials ? "456" : "",
        graphVersion: "v26.0",
        requestTimeoutMs: 10000,
        instagramContainerPollAttempts: 3,
        instagramContainerPollDelayMs: 60000,
      },
      readResource: async (_name: string) => existing,
      writeResource: async (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push([spec, name, data]);
        return { name };
      },
    },
  };
}

Deno.test("readiness is credential-free and preserves cohesive content digests", async () => {
  const ctx = context(null, false);
  const value = await packet();
  const result = await model.methods.readiness.execute(
    { packet: value },
    ctx.value,
  );
  assertEquals(result.dataHandles, [{
    name: `readiness-${value.socialPacketDigest}`,
  }]);
  assertEquals(ctx.writes[0][2].status, "ready");
  assertEquals(
    ctx.writes[0][2].landingPageDigest,
    value.landingPageDigest,
  );
  assertEquals(ctx.writes[0][2].missing, []);
  assertEquals(ctx.writes[0][2].credentialReadinessNotChecked, true);
  assertEquals(ctx.writes[0][2].accountReadinessNotChecked, true);
});

Deno.test("publication policy check fails closed on missing credential configuration", async () => {
  const check = model.checks["meta-social-mutation-configuration"];
  assertEquals(check.labels, ["policy"]);
  assertEquals(check.appliesTo, ["publish", "dispatchDue"]);
  assertEquals(await check.execute(context().value), { pass: true });
  assertEquals(await check.execute(context(null, false).value), {
    pass: false,
    errors: [
      "credentialSource must attest a Swamp vault binding",
      "accessToken must resolve from a Swamp vault",
      "at least one Meta account ID must be configured",
    ],
  });
});

function scheduleContext(
  ledger: Record<string, unknown> | null = null,
  evidence: Record<string, Record<string, unknown>> = {},
  credentials = false,
) {
  const resources = new Map<string, Record<string, unknown>>();
  if (ledger) resources.set("schedule-ledger", structuredClone(ledger));
  for (const [name, value] of Object.entries(evidence)) {
    resources.set(name, value);
  }
  const base = context(null, credentials);
  base.value.readResource = async (name: string) => resources.get(name) ?? null;
  base.value.writeResource = async (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => {
    resources.set(name, structuredClone(data));
    base.writes.push([spec, name, structuredClone(data)]);
    return { name };
  };
  return { ...base, resources };
}

async function scheduledApproval(
  scheduledFor: string,
  idempotencyKey: string,
  revision = 1,
) {
  return {
    ...await approval(["facebook"]),
    approvalId: `${idempotencyKey}-schedule-r${revision}`,
    idempotencyKey,
    revision,
    scheduledFor,
  };
}

Deno.test("schedule canonicalizes offsets, binds approval, supports DST dates and same-day occupancy", async () => {
  const value = await packet(["facebook"]);
  const ctx = scheduleContext();
  for (
    const [key, instant] of [
      ["spring", "2027-03-14T01:30:00-07:00"],
      ["spring-later", "2027-03-14T03:30:00-06:00"],
      ["fall", "2027-11-07T01:30:00-06:00"],
      ["rollover", "2027-03-15T00:30:00-06:00"],
    ]
  ) {
    await model.methods.schedule.execute({
      packet: value,
      approval: await scheduledApproval(instant, key),
      idempotencyKey: key,
      scheduledFor: instant,
    }, ctx.value);
  }
  const entries = ctx.resources.get("schedule-ledger")!.entries as Array<
    Record<string, unknown>
  >;
  assertEquals(entries.map((entry) => entry.localDate), [
    "2027-03-14",
    "2027-03-14",
    "2027-11-07",
    "2027-03-15",
  ]);
  assertEquals(entries[0].scheduledFor, "2027-03-14T08:30:00.000Z");
  await model.methods.inspectDay.execute(
    { localDate: "2027-03-14" },
    ctx.value,
  );
  assertEquals(
    (ctx.resources.get("schedule-day-2027-03-14")!.entries as unknown[]).length,
    2,
  );
  assertEquals(ctx.value.globalArgs.credentialSource, "unconfigured");
});

Deno.test("schedule rejects malformed, past, rights-exceeding, and approval-drifted instants", async () => {
  const value = await packet(["facebook"]);
  for (
    const [scheduledFor, approvedFor] of [
      ["2027-03-14T01:30:00", "2027-03-14T01:30:00-07:00"],
      ["2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z"],
      ["2031-01-01T00:00:00Z", "2031-01-01T00:00:00Z"],
      ["2027-05-01T00:00:00Z", "2027-05-02T00:00:00Z"],
    ]
  ) {
    const boundApproval = await scheduledApproval(approvedFor, "rejected");
    await assertRejects(() =>
      model.methods.schedule.execute({
        packet: value,
        approval: boundApproval,
        idempotencyKey: "rejected",
        scheduledFor,
      }, scheduleContext().value)
    );
  }
});

Deno.test("schedule accepts rights that become effective before the approved future instant", async () => {
  const value = await packet(["facebook"]);
  value.rights.effectiveAt = "2027-01-01T00:00:00Z";
  const { socialPacketDigest: _oldDigest, ...payload } = value;
  value.socialPacketDigest = await digestSocialPacket(payload);
  const scheduledFor = "2027-05-01T00:00:00Z";
  const boundApproval = {
    ...await scheduledApproval(scheduledFor, "future-rights"),
    socialPacketDigest: value.socialPacketDigest,
  };
  const ctx = scheduleContext();

  await model.methods.schedule.execute({
    packet: value,
    approval: boundApproval,
    idempotencyKey: "future-rights",
    scheduledFor,
  }, ctx.value);

  assertEquals(
    (ctx.resources.get("schedule-ledger")!.entries as unknown[]).length,
    1,
  );
});

Deno.test("reschedule retains prior instant and increments a digest-bound successor revision", async () => {
  const value = await packet(["facebook"]);
  const ctx = scheduleContext();
  const first = "2027-04-01T10:00:00-06:00";
  const second = "2027-04-02T10:00:00-06:00";
  await model.methods.schedule.execute({
    packet: value,
    approval: await scheduledApproval(first, "move"),
    idempotencyKey: "move",
    scheduledFor: first,
  }, ctx.value);
  await assertRejects(
    async () =>
      model.methods.reschedule.execute({
        idempotencyKey: "move",
        scheduledFor: second,
        approval: await scheduledApproval(second, "move", 1),
      }, ctx.value),
    Error,
    "revision mismatch",
  );
  const reusedIdentity = await scheduledApproval(second, "move", 2);
  reusedIdentity.approvalId = "move-schedule-r1";
  await assertRejects(
    () =>
      model.methods.reschedule.execute({
        idempotencyKey: "move",
        scheduledFor: second,
        approval: reusedIdentity,
      }, ctx.value),
    Error,
    "identity or revision mismatch",
  );
  await model.methods.reschedule.execute({
    idempotencyKey: "move",
    scheduledFor: second,
    approval: await scheduledApproval(second, "move", 2),
  }, ctx.value);
  const entry = (ctx.resources.get("schedule-ledger")!.entries as Array<
    Record<string, unknown>
  >)[0];
  assertEquals(entry.revision, 2);
  assertEquals(entry.priorScheduledFor, ["2027-04-01T16:00:00.000Z"]);
  assertEquals(entry.socialPacketDigest, value.socialPacketDigest);
});

Deno.test("schedule approval cannot be replayed under another idempotency key", async () => {
  const value = await packet(["facebook"]);
  const scheduledFor = "2027-04-03T10:00:00-06:00";
  await assertRejects(
    async () =>
      model.methods.schedule.execute({
        packet: value,
        approval: await scheduledApproval(scheduledFor, "approved-key"),
        idempotencyKey: "different-key",
        scheduledFor,
      }, scheduleContext().value),
    Error,
    "identity or revision mismatch",
  );
});

Deno.test("bounded ledger prunes only old safe terminal entries and fails closed for active capacity", async () => {
  const value = await packet(["facebook"]);
  const approved = await scheduledApproval(
    "2027-05-01T00:00:00Z",
    "entry-template",
  );
  const make = (index: number, status: "queued" | "published") => ({
    idempotencyKey: `entry-${index}`,
    revision: 1,
    status,
    scheduledFor: "2027-05-01T00:00:00Z",
    priorScheduledFor: [],
    localDate: "2027-04-30",
    packet: value,
    approval: approved,
    campaignPacketDigest: value.campaignPacketDigest,
    landingPageDigest: value.landingPageDigest,
    socialPacketDigest: value.socialPacketDigest,
    updatedAt: "2020-01-01T00:00:00Z",
  });
  const active = Array.from(
    { length: 250 },
    (_, index) => make(index, "queued"),
  );
  await assertRejects(
    () =>
      model.methods.schedule.execute({
        packet: value,
        approval: { ...approved, idempotencyKey: "overflow" },
        idempotencyKey: "overflow",
        scheduledFor: approved.scheduledFor,
      }, scheduleContext({ entries: active }).value),
    Error,
    "capacity exhausted",
  );
  active[0] = make(0, "published");
  const ctx = scheduleContext({ entries: active });
  await model.methods.schedule.execute({
    packet: value,
    approval: { ...approved, idempotencyKey: "replacement" },
    idempotencyKey: "replacement",
    scheduledFor: approved.scheduledFor,
  }, ctx.value);
  const entries = ctx.resources.get("schedule-ledger")!.entries as Array<
    Record<string, unknown>
  >;
  assertEquals(entries.length, 250);
  assert(entries.some((entry) => entry.idempotencyKey === "replacement"));
});

Deno.test("dispatch reconciles interrupted claims, skips early entries, and never duplicates evidence", async () => {
  const value = await packet(["facebook"]);
  const future = "2027-06-01T00:00:00Z";
  const ctx = scheduleContext();
  for (
    const key of ["published-claim", "ambiguous-claim", "safe-claim", "early"]
  ) {
    await model.methods.schedule.execute({
      packet: value,
      approval: await scheduledApproval(future, key),
      idempotencyKey: key,
      scheduledFor: future,
    }, ctx.value);
  }
  const entries = ctx.resources.get("schedule-ledger")!.entries as Array<
    Record<string, unknown>
  >;
  entries[0].status = "dispatching";
  entries[1].status = "dispatching";
  entries[2].status = "dispatching";
  ctx.resources.set("schedule-ledger", { entries });
  ctx.resources.set("publication-published-claim", { status: "published" });
  ctx.resources.set("publication-ambiguous-claim", { status: "intent" });
  let calls = 0;
  await dispatchDue(
    ctx.value,
    (async () => {
      calls++;
      return Response.json({ id: "unexpected" });
    }) as typeof fetch,
  );
  const reconciled = ctx.resources.get("schedule-ledger")!.entries as Array<
    Record<string, unknown>
  >;
  assertEquals(reconciled.map((entry) => entry.status), [
    "published",
    "reconciliation_required",
    "queued",
    "queued",
  ]);
  assertEquals(calls, 0);
});

Deno.test("dispatch claims each due entry, isolates failures, and does not retry ambiguous effects", async () => {
  const value = await packet(["facebook"]);
  const future = "2027-06-01T00:00:00Z";
  const ctx = scheduleContext(null, {}, true);
  for (const key of ["fails", "succeeds"]) {
    await model.methods.schedule.execute({
      packet: value,
      approval: await scheduledApproval(future, key),
      idempotencyKey: key,
      scheduledFor: future,
    }, ctx.value);
  }
  const entries = ctx.resources.get("schedule-ledger")!.entries as Array<
    Record<string, unknown>
  >;
  for (const entry of entries) entry.scheduledFor = "2026-08-27T00:00:00Z";
  ctx.resources.set("schedule-ledger", { entries });
  let calls = 0;
  await dispatchDue(
    ctx.value,
    (async () => {
      calls++;
      return calls === 1
        ? Response.json({ error: { code: 4 } }, { status: 500 })
        : Response.json({ id: "published-id" });
    }) as typeof fetch,
  );
  assertEquals(calls, 2);
  const dispatched = ctx.resources.get("schedule-ledger")!.entries as Array<
    Record<string, unknown>
  >;
  assertEquals(dispatched.map((entry) => entry.status), [
    "reconciliation_required",
    "published",
  ]);
  assertEquals(
    ctx.writes.filter((write) => write[1] === "schedule-ledger").some((write) =>
      (write[2].entries as Array<Record<string, unknown>>).some((entry) =>
        entry.status === "dispatching"
      )
    ),
    true,
  );
});

Deno.test("rejects campaign, landing, copy, social, rights, and approval drift before fetch", async () => {
  const valid = await packet();
  const approved = await approval();
  const attempts = [
    {
      packet: { ...valid, campaignPacketDigest: hash("f") },
      approval: approved,
    },
    {
      packet: { ...valid, manifest: { ...valid.manifest, promise: "Changed" } },
      approval: approved,
    },
    {
      packet: {
        ...valid,
        posts: valid.posts.map((post) => ({ ...post, copy: "changed" })),
      },
      approval: approved,
    },
    { packet: { ...valid, socialPacketDigest: hash("f") }, approval: approved },
    {
      packet: {
        ...valid,
        rights: { ...valid.rights, expiresAt: "2026-08-01T00:00:00Z" },
      },
      approval: approved,
    },
    {
      packet: {
        ...valid,
        rights: { ...valid.rights, sourceDigests: [hash("f")] },
      },
      approval: approved,
    },
    { packet: valid, approval: { ...approved, landingPageDigest: hash("f") } },
  ];
  for (const attempt of attempts) {
    await assertRejects(() =>
      publishPacket(
        { ...attempt, idempotencyKey: "key-1", dryRun: false },
        context().value,
        () => {
          throw new Error("fetch called");
        },
      )
    );
  }
});

Deno.test("publishes channel-specific Facebook and Instagram copy after container readiness", async () => {
  const calls: Array<{ url: string; method: string; body: URLSearchParams }> =
    [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: new URLSearchParams(String(init?.body ?? "")),
    });
    if ((init?.method ?? "GET") === "GET") {
      return Response.json({ status_code: "FINISHED" });
    }
    return Response.json({ id: `id-${calls.length}` });
  }) as typeof fetch;
  const ctx = context();
  await publishPacket(
    {
      packet: await packet(),
      approval: await approval(),
      idempotencyKey: "key-1",
      dryRun: false,
    },
    ctx.value,
    fetcher,
    async () => {},
  );
  assertEquals(calls.length, 4);
  assert(calls[0].url.endsWith("/123/photos"));
  assertEquals(calls[0].body.get("message"), facebookCopy);
  assert(calls[1].url.endsWith("/456/media"));
  assertEquals(calls[1].body.get("caption"), instagramCopy);
  assert(calls[2].url.includes("/id-2?fields=status_code"));
  assert(calls[3].url.endsWith("/456/media_publish"));
  assertEquals(ctx.writes.map((write) => write[2].status), [
    "intent",
    "partial",
    "instagram_container_created",
    "published",
  ]);
  assert(!JSON.stringify(ctx.writes).includes("secret-token"));
});

Deno.test("retains Instagram container checkpoint when bounded readiness fails", async () => {
  const ctx = context();
  const instagramPacket = await packet(["instagram"]);
  const instagramApproval = await approval(["instagram"]);
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") {
      return Response.json({ status_code: "IN_PROGRESS" });
    }
    return Response.json({ id: "container-1" });
  }) as typeof fetch;
  await assertRejects(
    () =>
      publishPacket(
        {
          packet: instagramPacket,
          approval: instagramApproval,
          idempotencyKey: "pending",
          dryRun: false,
        },
        ctx.value,
        fetcher,
        async () => {},
      ),
    Error,
    "bounded poll window",
  );
  assertEquals(ctx.writes.map((write) => write[2].status), [
    "intent",
    "instagram_container_created",
  ]);
  assertEquals(
    (ctx.writes.at(-1)![2].results as Array<Record<string, string>>)[0]
      .creationId,
    "container-1",
  );
});

Deno.test("already-published Instagram containers require reconciliation", async () => {
  const ctx = context();
  const instagramPacket = await packet(["instagram"]);
  const instagramApproval = await approval(["instagram"]);
  const error = await assertRejects(() =>
    publishPacket(
      {
        packet: instagramPacket,
        approval: instagramApproval,
        idempotencyKey: "already-published",
        dryRun: false,
      },
      ctx.value,
      (async (_url: string | URL | Request, init?: RequestInit) =>
        (init?.method ?? "GET") === "GET"
          ? Response.json({ status_code: "PUBLISHED" })
          : Response.json({ id: "container-1" })) as typeof fetch,
      async () => {},
    )
  ) as Error;
  assert(error.message.includes("already published"));
  assertEquals(ctx.writes.map((write) => write[2].status), [
    "intent",
    "instagram_container_created",
  ]);
});

Deno.test("Graph failures are sanitized, classified, and never retried", async () => {
  const ctx = context();
  let calls = 0;
  const value = await packet(["facebook"]);
  const facebookApproval = await approval(["facebook"]);
  const error = await assertRejects(() =>
    publishPacket(
      {
        packet: value,
        approval: facebookApproval,
        idempotencyKey: "rate-limited",
        dryRun: false,
      },
      ctx.value,
      (async () => {
        calls++;
        return Response.json(
          { error: { code: 4, message: "secret provider detail" } },
          { status: 429 },
        );
      }) as typeof fetch,
    )
  ) as Error;
  assertEquals(calls, 1);
  assert(error.message.includes("Meta code 4"));
  assert(error.message.includes("reconcile remote state"));
  assert(!error.message.includes("secret provider detail"));
  assertEquals(ctx.writes.map((write) => write[2].status), ["intent"]);
});

Deno.test("dry run makes no calls and exact/conflicting replays fail closed", async () => {
  let calls = 0;
  const value = await packet(["facebook"]);
  const approved = await approval(["facebook"]);
  const ctx = context();
  await publishPacket(
    {
      packet: value,
      approval: approved,
      idempotencyKey: "dry-1",
      dryRun: true,
    },
    ctx.value,
    (async () => {
      calls++;
      return new Response();
    }) as typeof fetch,
  );
  assertEquals(calls, 0);
  assertEquals(ctx.writes[0][2].status, "dry_run");
  assertEquals(ctx.writes[0][2].requests, [{
    platform: "facebook",
    mediaUrl: "https://cdn.example.test/facebook.jpg",
  }]);
  const exact = {
    campaignPacketDigest: value.campaignPacketDigest,
    socialPacketDigest: value.socialPacketDigest,
  };
  await assertRejects(
    () =>
      publishPacket(
        {
          packet: value,
          approval: approved,
          idempotencyKey: "same",
          dryRun: false,
        },
        context(exact).value,
      ),
    Error,
    "replay rejected",
  );
  await assertRejects(
    () =>
      publishPacket(
        {
          packet: value,
          approval: approved,
          idempotencyKey: "same",
          dryRun: false,
        },
        context({ ...exact, socialPacketDigest: hash("f") }).value,
      ),
    Error,
    "conflict rejected",
  );
});

Deno.test("workflow preserves one exact founder approval boundary", async () => {
  const workflow = await Deno.readTextFile(
    new URL(
      "../../../workflows/workflow-moment-savor-meta-social-publication.yaml",
      import.meta.url,
    ),
  );
  for (
    const text of [
      "manual_approval",
      "step: founder-approve-exact-social-packet",
      "condition: { type: succeeded }",
      "campaignPacketDigest",
      "landingPageDigest",
      "socialPacketDigest",
      "inputs.publish != true",
    ]
  ) assert(workflow.includes(text));
  assert(!workflow.includes("accessToken"));
});
