import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { digestMarketingValue } from "./marketing_campaign_contracts.ts";
import {
  createPausedDraft,
  digestAdsPacket,
  model,
} from "./meta_ads_publisher.ts";

const hash = (character: string) => character.repeat(64);
const destination =
  "https://momentsavor.app/campaigns/s4v8m2k7p9qx?utm_source=facebook&utm_medium=paid_social&utm_campaign=unscrapbooked-moments&utm_content=ordinary-moments";

const baseManifest = {
  schemaVersion: "1.0" as const,
  campaignId: "unscrapbooked-moments",
  campaignVersion: 1,
  promise: "Scrapbook the moments that usually don't get scrapbooked.",
  landingPage: {
    url: destination,
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

async function packet(overrides: Record<string, unknown> = {}) {
  const manifest = structuredClone(baseManifest);
  const creative = {
    name: "Unscrapbooked moments",
    primaryText: "The little moments deserve a place, too.",
    headline: "Keep the story, not the project",
    description: "A calm place for ordinary family memories",
    callToAction: "LEARN_MORE" as const,
    imageHash: "abc123",
    mediaDigest: hash("e"),
  };
  const draft = {
    schemaVersion: "1.0" as const,
    manifest,
    campaignPacketDigest: await digestMarketingValue(manifest),
    landingPageDigest: await digestMarketingValue(manifest.landingPage),
    socialPacketDigest: hash("c"),
    creativeDigest: await digestMarketingValue(creative),
    campaign: {
      name: "Unscrapbooked moments pilot",
      objective: "OUTCOME_TRAFFIC" as const,
      specialAdCategories: ["NONE" as const],
    },
    adSet: {
      name: "US broad adults",
      conversionLocation: "WEBSITE" as const,
      optimizationGoal: "LANDING_PAGE_VIEWS" as const,
      billingEvent: "IMPRESSIONS" as const,
      lifetimeBudgetMinor: 20000,
      startTime: "2026-09-01T12:00:00Z",
      endTime: "2026-09-08T12:00:00Z",
      targeting: {
        minimumAge: 18,
        geographies: ["US"],
        mode: "broad" as const,
      },
    },
    creative,
    ad: { name: "Unscrapbooked moments ad" },
    destination: {
      url: destination,
      utmSource: "facebook" as const,
      utmMedium: "paid_social" as const,
      utmCampaign: manifest.campaignId,
      utmContent: "ordinary-moments",
    },
    rights: {
      rightsId: "owned-unscrapbooked-paid-v1",
      owner: "Moment Savor" as const,
      sourceDigest: hash("e"),
      campaignId: manifest.campaignId,
      permittedUse: "paid_ads" as const,
      effectiveAt: "2026-08-01T00:00:00Z",
      expiresAt: "2030-01-01T00:00:00Z",
    },
    ...overrides,
  };
  return { ...draft, adsPacketDigest: await digestAdsPacket(draft as never) };
}

const approval = async (
  value: Awaited<ReturnType<typeof packet>>,
  overrides = {},
) => ({
  approved: true as const,
  actor: "founder" as const,
  approvalId: "approval-1",
  campaignPacketDigest: value.campaignPacketDigest,
  landingPageDigest: value.landingPageDigest,
  socialPacketDigest: value.socialPacketDigest,
  creativeDigest: value.creativeDigest,
  adsPacketDigest: value.adsPacketDigest,
  ...overrides,
});

function context(
  configured = true,
  existing: Record<string, unknown> | null = null,
) {
  const writes: Array<Record<string, unknown>> = [];
  return {
    writes,
    value: {
      logger: { info: () => undefined },
      globalArgs: {
        accessToken: configured ? "system-user-secret" : "",
        credentialSource: configured ? "vault" : "unconfigured",
        businessId: configured ? "1" : "",
        adAccountId: configured ? "2" : "",
        pageId: configured ? "3" : "",
        pixelId: configured ? "4" : "",
        appId: configured ? "5" : "",
        graphVersion: "v26.0",
        requestTimeoutMs: 10000,
        maxDailyBudgetMinor: 2000,
        maxLifetimeBudgetMinor: 20000,
      },
      readResource: async () => existing,
      writeResource: async (
        _spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push(data);
        return { name };
      },
    },
  };
}

Deno.test("readiness verifies exact campaign, landing, creative, and ads packet digests", async () => {
  const ctx = context(false);
  const value = await packet();
  await model.methods.readiness.execute(
    { packet: value } as never,
    ctx.value as never,
  );
  assertEquals(ctx.writes[0].status, "blocked");
  assertEquals(ctx.writes[0].adsPacketDigest, value.adsPacketDigest);
  assertEquals(ctx.writes[0].missing, [
    "businessId",
    "adAccountId",
    "pageId",
    "appId",
  ]);
  assertEquals(ctx.writes[0].credentialReadinessNotChecked, true);
});

Deno.test("creates Campaign, Ad Set, Creative, and Ad with paused delivery objects", async () => {
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: new URLSearchParams(String(init?.body)),
    });
    return Response.json({ id: `meta-${calls.length}` });
  }) as typeof fetch;
  const ctx = context();
  const value = await packet();
  await createPausedDraft(
    {
      packet: value,
      approval: await approval(value),
      idempotencyKey: "draft-1",
    },
    ctx.value as never,
    fetcher,
  );
  assertEquals(
    calls.map((call) => new URL(call.url).pathname.split("/").at(-1)),
    [
      "campaigns",
      "adsets",
      "adcreatives",
      "ads",
    ],
  );
  assertEquals(calls[0].body.get("status"), "PAUSED");
  assertEquals(calls[1].body.get("status"), "PAUSED");
  assertEquals(calls[1].body.get("destination_type"), "WEBSITE");
  assertEquals(calls[3].body.get("status"), "PAUSED");
  assert(
    calls.every((call) =>
      call.body.get("access_token") === "system-user-secret"
    ),
  );
  assertEquals(ctx.writes.map((row) => row.status), [
    "intent",
    "campaign_created",
    "adset_created",
    "creative_created",
    "created_paused",
  ]);
  assertEquals(ctx.writes.at(-1)!.deliveryStatuses, {
    campaign: "PAUSED",
    adSet: "PAUSED",
    ad: "PAUSED",
  });
  assert(!JSON.stringify(ctx.writes).includes("system-user-secret"));
});

Deno.test("fails closed on content/digest/approval drift, replay, credentials, and budget", async () => {
  const value = await packet();
  const approved = await approval(value);
  const creativeDrift = {
    ...value,
    creative: { ...value.creative, headline: "Changed after approval" },
  };
  const adsDrift = {
    ...value,
    adSet: {
      ...value.adSet,
      targeting: { ...value.adSet.targeting, minimumAge: 25 },
    },
  };
  await assertRejects(
    () =>
      createPausedDraft({
        packet: creativeDrift,
        approval: approved,
        idempotencyKey: "x",
      }, context().value as never),
    TypeError,
    "creative digest mismatch",
  );
  await assertRejects(
    () =>
      createPausedDraft({
        packet: adsDrift,
        approval: approved,
        idempotencyKey: "x",
      }, context().value as never),
    TypeError,
    "ads packet digest mismatch",
  );
  await assertRejects(
    () =>
      createPausedDraft({
        packet: value,
        approval: { ...approved, creativeDigest: hash("f") },
        idempotencyKey: "x",
      }, context().value as never),
    TypeError,
    "approval creativeDigest mismatch",
  );
  const exact = {
    campaignPacketDigest: value.campaignPacketDigest,
    landingPageDigest: value.landingPageDigest,
    socialPacketDigest: value.socialPacketDigest,
    creativeDigest: value.creativeDigest,
    adsPacketDigest: value.adsPacketDigest,
  };
  await assertRejects(
    () =>
      createPausedDraft({
        packet: value,
        approval: approved,
        idempotencyKey: "x",
      }, context(true, exact).value as never),
    Error,
    "replay rejected",
  );
  await assertRejects(
    () =>
      createPausedDraft(
        { packet: value, approval: approved, idempotencyKey: "x" },
        context(true, { ...exact, adsPacketDigest: hash("f") }).value as never,
      ),
    Error,
    "conflict rejected",
  );
  await assertRejects(
    () =>
      createPausedDraft({
        packet: value,
        approval: approved,
        idempotencyKey: "x",
      }, context(false).value as never),
    Error,
    "configuration blocked",
  );
  const over = await packet({
    adSet: { ...value.adSet, lifetimeBudgetMinor: 20001 },
  });
  const overApproval = await approval(over);
  await assertRejects(
    () =>
      createPausedDraft({
        packet: over,
        approval: overApproval,
        idempotencyKey: "x",
      }, context().value as never),
    TypeError,
    "budget exceeds",
  );
});

Deno.test("rejects category ambiguity, country codes, chronology, UTM, minors, and undeclared budget", async () => {
  const value = await packet();
  const invalid = [
    await packet({
      campaign: { ...value.campaign, specialAdCategories: ["NONE", "HOUSING"] },
    }),
    await packet({
      destination: { ...value.destination, url: "https://momentsavor.app/x" },
    }),
    await packet({
      adSet: {
        ...value.adSet,
        targeting: { ...value.adSet.targeting, minimumAge: 17 },
      },
    }),
    await packet({
      adSet: {
        ...value.adSet,
        targeting: { ...value.adSet.targeting, geographies: ["United States"] },
      },
    }),
    await packet({
      adSet: {
        ...value.adSet,
        startTime: "2026-09-08T12:00:00Z",
        endTime: "2026-09-01T12:00:00Z",
      },
    }),
    await packet({
      adSet: {
        ...value.adSet,
        lifetimeBudgetMinor: undefined,
        startTime: undefined,
        endTime: undefined,
      },
    }),
    await packet({ rights: { ...value.rights, sourceDigest: hash("f") } }),
  ];
  for (const bad of invalid) {
    const badApproval = await approval(bad);
    await assertRejects(() =>
      createPausedDraft({
        packet: bad,
        approval: badApproval,
        idempotencyKey: "invalid",
      }, context().value as never)
    );
  }
});

Deno.test("API failures retain the last successful remote-object checkpoint", async () => {
  let calls = 0;
  const ctx = context();
  const value = await packet();
  const fetcher = (async () => {
    calls++;
    if (calls === 1) return Response.json({ id: "campaign-1" });
    return Response.json({ error: { message: "secret details" } }, {
      status: 400,
    });
  }) as typeof fetch;
  const approved = await approval(value);
  await assertRejects(
    () =>
      createPausedDraft(
        { packet: value, approval: approved, idempotencyKey: "fail" },
        ctx.value as never,
        fetcher,
      ),
    Error,
    "request failed (400)",
  );
  assertEquals(calls, 2);
  assertEquals(ctx.writes.map((row) => row.status), [
    "intent",
    "campaign_created",
  ]);
  assertEquals(
    (ctx.writes.at(-1)!.results as Record<string, string>).campaignId,
    "campaign-1",
  );
  assert(!JSON.stringify(ctx.writes).includes("system-user-secret"));
});

Deno.test("workflow requires one exact founder approval and grants no activation", async () => {
  const workflow = await Deno.readTextFile(
    new URL(
      "../../../workflows/workflow-moment-savor-meta-ads-draft.yaml",
      import.meta.url,
    ),
  );
  for (
    const text of [
      "manual_approval",
      "createDraft",
      "campaignPacketDigest",
      "landingPageDigest",
      "socialPacketDigest",
      "creativeDigest",
      "adsPacketDigest",
      "inputs.createDraft != true",
    ]
  ) assert(workflow.includes(text));
  assert(!workflow.includes("accessToken"));
  assert(!workflow.toLowerCase().includes("activate"));
});
