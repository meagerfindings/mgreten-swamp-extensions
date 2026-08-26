import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { digestMarketingValue } from "./marketing_campaign_contracts.ts";
import {
  digestSocialPacket,
  digestText,
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
    url: "https://momentsavor.app/campaigns/s4v8m2k7p9qx",
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
        instagramContainerPollDelayMs: 100,
      },
      readResource: async () => existing,
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

Deno.test("readiness preserves exact cohesive landing/social digests and account blockers", async () => {
  const ctx = context(null, false);
  const value = await packet();
  const result = await model.methods.readiness.execute(
    { packet: value },
    ctx.value,
  );
  assertEquals(result.dataHandles, [{
    name: `readiness-${value.socialPacketDigest}`,
  }]);
  assertEquals(ctx.writes[0][2].status, "blocked");
  assertEquals(
    ctx.writes[0][2].landingPageDigest,
    value.landingPageDigest,
  );
  assertEquals(ctx.writes[0][2].missing, [
    "vaultCredentialSource",
    "accessToken",
    "facebookPageId",
    "instagramBusinessAccountId",
  ]);
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
      "founder-approve-exact-social-packet, condition: { type: succeeded }",
      "campaignPacketDigest",
      "landingPageDigest",
      "socialPacketDigest",
      "inputs.publish != true",
    ]
  ) assert(workflow.includes(text));
  assert(!workflow.includes("accessToken"));
});
