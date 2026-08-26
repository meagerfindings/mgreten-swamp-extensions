import { z } from "npm:zod@4";
import {
  digestMarketingValue,
  marketingCampaignIdSchema,
  marketingCampaignManifestSchema,
  marketingDigestSchema,
  marketingHttpsUrlSchema,
  marketingSha256,
  verifyCampaignManifest,
} from "./marketing_campaign_contracts.ts";

const Platform = z.enum(["facebook", "instagram"]);
const OptionalMetaId = z.union([z.string().regex(/^\d+$/), z.literal("")]);

/** Vault-backed Meta account and bounded Graph request configuration. */
export const globalArgumentsSchema = z.strictObject({
  accessToken: z.string().default("").meta({ sensitive: true }),
  credentialSource: z.enum(["unconfigured", "vault"]).default("unconfigured"),
  facebookPageId: OptionalMetaId.default(""),
  instagramBusinessAccountId: OptionalMetaId.default(""),
  graphVersion: z.string().regex(/^v\d+\.\d+$/).default("v26.0"),
  requestTimeoutMs: z.number().int().min(1000).max(30000).default(10000),
  instagramContainerPollAttempts: z.number().int().min(1).max(20).default(5),
  instagramContainerPollDelayMs: z.number().int().min(100).max(10000).default(
    1000,
  ),
});

const postSchema = z.discriminatedUnion("platform", [
  z.strictObject({
    platform: z.literal("facebook"),
    copy: z.string().trim().min(1).max(5000),
    copyDigest: marketingDigestSchema,
    mediaUrl: marketingHttpsUrlSchema.optional(),
    mediaDigest: marketingDigestSchema.optional(),
  }),
  z.strictObject({
    platform: z.literal("instagram"),
    copy: z.string().trim().min(1).max(2200),
    copyDigest: marketingDigestSchema,
    mediaUrl: marketingHttpsUrlSchema,
    mediaDigest: marketingDigestSchema,
  }),
]);

const socialRightsSchema = z.strictObject({
  rightsId: marketingCampaignIdSchema,
  owner: z.literal("Moment Savor"),
  sourceDigests: z.array(marketingDigestSchema).max(2),
  campaignId: marketingCampaignIdSchema,
  permittedUse: z.literal("organic_social"),
  destinations: z.array(Platform).min(1).max(2),
  effectiveAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
});

const packetSchema = z.strictObject({
  manifest: marketingCampaignManifestSchema,
  campaignPacketDigest: marketingDigestSchema,
  landingPageDigest: marketingDigestSchema,
  socialPacketDigest: marketingDigestSchema,
  posts: z.array(postSchema).min(1).max(2),
  rights: socialRightsSchema,
}).superRefine((value, context) => {
  const platforms = value.posts.map((post) => post.platform);
  if (new Set(platforms).size !== platforms.length) {
    context.addIssue({
      code: "custom",
      path: ["posts"],
      message: "duplicate platform",
    });
  }
  if (value.rights.campaignId !== value.manifest.campaignId) {
    context.addIssue({
      code: "custom",
      path: ["rights", "campaignId"],
      message: "rights must match campaign",
    });
  }
  if (
    platforms.some((platform) => !value.rights.destinations.includes(platform))
  ) {
    context.addIssue({
      code: "custom",
      path: ["rights", "destinations"],
      message: "rights must cover every post destination",
    });
  }
  if (
    Date.parse(value.rights.effectiveAt) >= Date.parse(value.rights.expiresAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["rights"],
      message: "rights chronology is invalid",
    });
  }
  value.posts.forEach((post, index) => {
    if ((post.mediaUrl === undefined) !== (post.mediaDigest === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["posts", index],
        message: "media URL and digest must be supplied together",
      });
    }
  });
  const mediaDigests = [
    ...new Set(
      value.posts.flatMap((post) => post.mediaDigest ? [post.mediaDigest] : []),
    ),
  ].sort();
  const rightsDigests = [...new Set(value.rights.sourceDigests)].sort();
  if (
    mediaDigests.length !== rightsDigests.length ||
    mediaDigests.some((digest, index) => digest !== rightsDigests[index])
  ) {
    context.addIssue({
      code: "custom",
      path: ["rights", "sourceDigests"],
      message: "rights must bind every and only requested media digest",
    });
  }
});

const approvalSchema = z.strictObject({
  approved: z.literal(true),
  actor: z.literal("founder"),
  approvalId: marketingCampaignIdSchema,
  campaignPacketDigest: marketingDigestSchema,
  landingPageDigest: marketingDigestSchema,
  socialPacketDigest: marketingDigestSchema,
});

/** Arguments for credential-free campaign and social packet readiness. */
export const readinessArgumentsSchema = z.strictObject({
  packet: packetSchema,
});
/** Arguments for an exact-approved, idempotent publication attempt. */
export const publishArgumentsSchema = z.strictObject({
  packet: packetSchema,
  approval: approvalSchema,
  idempotencyKey: marketingCampaignIdSchema,
  dryRun: z.boolean().default(false),
});

const evidenceSchema = z.strictObject({
  status: z.enum([
    "ready",
    "blocked",
    "intent",
    "partial",
    "instagram_container_created",
    "published",
    "dry_run",
  ]),
  idempotencyKey: marketingCampaignIdSchema.optional(),
  campaignPacketDigest: marketingDigestSchema,
  landingPageDigest: marketingDigestSchema,
  socialPacketDigest: marketingDigestSchema,
  campaignId: marketingCampaignIdSchema.optional(),
  campaignVersion: z.number().int().positive().optional(),
  approvalId: marketingCampaignIdSchema.optional(),
  approvalActor: z.literal("founder").optional(),
  postDigests: z.array(z.strictObject({
    platform: Platform,
    copyDigest: marketingDigestSchema,
    mediaDigest: marketingDigestSchema.nullable(),
  })).optional(),
  rightsId: marketingCampaignIdSchema.optional(),
  missing: z.array(z.string().min(1)).optional(),
  instagramRequiresPublicHttpsMedia: z.literal(true).optional(),
  requests: z.array(z.strictObject({
    platform: Platform,
    mediaUrl: marketingHttpsUrlSchema.nullable(),
  })).optional(),
  results: z.array(z.strictObject({
    platform: Platform,
    creationId: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
  })).optional(),
});

type Context = {
  globalArgs: z.infer<typeof globalArgumentsSchema>;
  logger: {
    info(message: string, attributes?: Record<string, unknown>): void;
  };
  readResource(name: string): Promise<Record<string, unknown> | null>;
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<unknown>;
  signal?: AbortSignal;
};
type Fetcher = typeof fetch;
type Sleeper = (milliseconds: number) => Promise<void>;

/** Compute the SHA-256 digest of one exact copy string. */
export const digestText = marketingSha256;

/** Compute the canonical digest that binds a complete social packet. */
export function digestSocialPacket(
  packet: Omit<z.infer<typeof packetSchema>, "socialPacketDigest">,
): Promise<string> {
  return digestMarketingValue(packet);
}

async function verifyPacket(raw: unknown) {
  const packet = packetSchema.parse(raw);
  await verifyCampaignManifest(packet.manifest, packet.campaignPacketDigest);
  if (
    await digestMarketingValue(packet.manifest.landingPage) !==
      packet.landingPageDigest
  ) {
    throw new TypeError("landing page digest mismatch");
  }
  for (const post of packet.posts) {
    if (await digestText(post.copy) !== post.copyDigest) {
      throw new TypeError(`${post.platform} copy digest mismatch`);
    }
  }
  const { socialPacketDigest, ...payload } = packet;
  if (await digestSocialPacket(payload) !== socialPacketDigest) {
    throw new TypeError("social packet digest mismatch");
  }
  if (
    Date.parse(packet.rights.effectiveAt) > Date.now() ||
    Date.parse(packet.rights.expiresAt) <= Date.now()
  ) {
    throw new TypeError("social media rights are not currently effective");
  }
  return packet;
}

function verifyApproval(
  packet: z.infer<typeof packetSchema>,
  approval: z.infer<typeof approvalSchema>,
): void {
  const expected = {
    campaignPacketDigest: packet.campaignPacketDigest,
    landingPageDigest: packet.landingPageDigest,
    socialPacketDigest: packet.socialPacketDigest,
  };
  for (const field of Object.keys(expected) as Array<keyof typeof expected>) {
    if (approval[field] !== expected[field]) {
      throw new TypeError(`approval ${field} mismatch`);
    }
  }
}

function boundedSignal(timeoutMs: number, signal?: AbortSignal) {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
}

async function graphPost(
  fetcher: Fetcher,
  url: string,
  body: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: boundedSignal(timeoutMs, signal),
  });
  const payload = await response.json().catch(() => ({})) as Record<
    string,
    unknown
  >;
  if (!response.ok || typeof payload.id !== "string") {
    throw new Error(`Meta Graph request failed (${response.status})`);
  }
  return payload.id;
}

async function waitForInstagramContainer(
  fetcher: Fetcher,
  base: string,
  creationId: string,
  config: z.infer<typeof globalArgumentsSchema>,
  signal?: AbortSignal,
  sleep: Sleeper = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  for (
    let attempt = 1;
    attempt <= config.instagramContainerPollAttempts;
    attempt++
  ) {
    const url = new URL(`${base}/${creationId}`);
    url.searchParams.set("fields", "status_code");
    url.searchParams.set("access_token", config.accessToken);
    const response = await fetcher(url, {
      signal: boundedSignal(config.requestTimeoutMs, signal),
    });
    const payload = await response.json().catch(() => ({})) as Record<
      string,
      unknown
    >;
    const status = payload.status_code;
    if (!response.ok || typeof status !== "string") {
      throw new Error(`Instagram container status failed (${response.status})`);
    }
    if (status === "FINISHED") return;
    if (["ERROR", "EXPIRED"].includes(status)) {
      throw new Error(`Instagram container entered terminal status ${status}`);
    }
    if (attempt < config.instagramContainerPollAttempts) {
      await sleep(config.instagramContainerPollDelayMs);
    }
  }
  throw new Error(
    "Instagram container did not become ready within the bounded poll window",
  );
}

/** Execute a validated publication while persisting intent and partial checkpoints. */
export async function publishPacket(
  raw: unknown,
  context: Context,
  fetcher: Fetcher = fetch,
  sleep?: Sleeper,
) {
  const args = publishArgumentsSchema.parse(raw);
  const packet = await verifyPacket(args.packet);
  await verifyApproval(packet, args.approval);
  const name = `publication-${args.idempotencyKey}`;
  context.logger.info("Preparing exact-approved Meta publication", {
    campaignId: packet.manifest.campaignId,
    idempotencyKey: args.idempotencyKey,
    platforms: packet.posts.map((post) => post.platform),
  });
  const existing = await context.readResource(name);
  if (existing) {
    const same =
      existing.campaignPacketDigest === packet.campaignPacketDigest &&
      existing.socialPacketDigest === packet.socialPacketDigest;
    throw new Error(
      same
        ? "idempotency replay rejected"
        : "idempotency key conflict rejected",
    );
  }
  const credentials = context.globalArgs;
  const platforms = packet.posts.map((post) => post.platform);
  if (
    credentials.credentialSource !== "vault" || !credentials.accessToken ||
    platforms.includes("facebook") && !credentials.facebookPageId ||
    platforms.includes("instagram") && !credentials.instagramBusinessAccountId
  ) throw new Error("vault-backed Meta credentials/accounts are not ready");

  const evidence = {
    idempotencyKey: args.idempotencyKey,
    campaignId: packet.manifest.campaignId,
    campaignVersion: packet.manifest.campaignVersion,
    campaignPacketDigest: packet.campaignPacketDigest,
    landingPageDigest: packet.landingPageDigest,
    socialPacketDigest: packet.socialPacketDigest,
    approvalId: args.approval.approvalId,
    approvalActor: args.approval.actor,
    postDigests: packet.posts.map((post) => ({
      platform: post.platform,
      copyDigest: post.copyDigest,
      mediaDigest: post.mediaDigest ?? null,
    })),
    rightsId: packet.rights.rightsId,
  };
  if (args.dryRun) {
    const handle = await context.writeResource("evidence", name, {
      ...evidence,
      status: "dry_run",
      requests: [],
    });
    context.logger.info("Recorded Meta publication dry run", {
      campaignId: packet.manifest.campaignId,
      idempotencyKey: args.idempotencyKey,
    });
    return handle;
  }

  await context.writeResource("evidence", name, {
    ...evidence,
    status: "intent",
    requests: packet.posts.map((post) => ({
      platform: post.platform,
      mediaUrl: post.mediaUrl ?? null,
    })),
    results: [],
  });
  const base = `https://graph.facebook.com/${credentials.graphVersion}`;
  const results: Array<Record<string, string>> = [];
  const facebook = packet.posts.find((post) => post.platform === "facebook");
  if (facebook) {
    const endpoint = facebook.mediaUrl ? "photos" : "feed";
    const id = await graphPost(
      fetcher,
      `${base}/${credentials.facebookPageId}/${endpoint}`,
      {
        access_token: credentials.accessToken,
        message: facebook.copy,
        ...(facebook.mediaUrl ? { url: facebook.mediaUrl } : {}),
      },
      credentials.requestTimeoutMs,
      context.signal,
    );
    results.push({ platform: "facebook", id });
    if (platforms.includes("instagram")) {
      await context.writeResource("evidence", name, {
        ...evidence,
        status: "partial",
        results: structuredClone(results),
      });
    }
  }
  const instagram = packet.posts.find((post) => post.platform === "instagram");
  if (instagram) {
    const creationId = await graphPost(
      fetcher,
      `${base}/${credentials.instagramBusinessAccountId}/media`,
      {
        access_token: credentials.accessToken,
        caption: instagram.copy,
        image_url: instagram.mediaUrl!,
      },
      credentials.requestTimeoutMs,
      context.signal,
    );
    results.push({ platform: "instagram", creationId });
    await context.writeResource("evidence", name, {
      ...evidence,
      status: "instagram_container_created",
      results: structuredClone(results),
    });
    await waitForInstagramContainer(
      fetcher,
      base,
      creationId,
      credentials,
      context.signal,
      sleep,
    );
    const id = await graphPost(
      fetcher,
      `${base}/${credentials.instagramBusinessAccountId}/media_publish`,
      {
        access_token: credentials.accessToken,
        creation_id: creationId,
      },
      credentials.requestTimeoutMs,
      context.signal,
    );
    results[results.length - 1].id = id;
  }
  const handle = await context.writeResource("evidence", name, {
    ...evidence,
    status: "published",
    results,
  });
  context.logger.info("Completed exact-approved Meta publication", {
    campaignId: packet.manifest.campaignId,
    idempotencyKey: args.idempotencyKey,
    resultCount: results.length,
  });
  return handle;
}

/** Swamp model for fail-closed Facebook Page and Instagram publication. */
export const model = {
  type: "@mgreten/meta-social-publisher",
  version: "2026.08.26.3",
  globalArguments: globalArgumentsSchema,
  resources: {
    evidence: {
      description:
        "Redacted Meta publication intent/checkpoint/result evidence",
      schema: evidenceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 1000,
    },
  },
  methods: {
    readiness: {
      description:
        "Verify exact campaign/social digests and account-independent publication requirements",
      arguments: readinessArgumentsSchema,
      execute: async (
        args: z.infer<typeof readinessArgumentsSchema>,
        context: Context,
      ) => {
        const packet = await verifyPacket(args.packet);
        context.logger.info("Checking Meta publication readiness", {
          campaignId: packet.manifest.campaignId,
        });
        const platforms = packet.posts.map((post) => post.platform);
        const missing = [
          context.globalArgs.credentialSource !== "vault" &&
          "vaultCredentialSource",
          !context.globalArgs.accessToken && "accessToken",
          platforms.includes("facebook") &&
          !context.globalArgs.facebookPageId && "facebookPageId",
          platforms.includes("instagram") &&
          !context.globalArgs.instagramBusinessAccountId &&
          "instagramBusinessAccountId",
        ].filter(Boolean);
        const handle = await context.writeResource(
          "evidence",
          `readiness-${packet.socialPacketDigest}`,
          {
            status: missing.length ? "blocked" : "ready",
            campaignPacketDigest: packet.campaignPacketDigest,
            landingPageDigest: packet.landingPageDigest,
            socialPacketDigest: packet.socialPacketDigest,
            missing,
            instagramRequiresPublicHttpsMedia: true,
            rightsId: packet.rights.rightsId,
          },
        );
        context.logger.info("Completed Meta publication readiness", {
          campaignId: packet.manifest.campaignId,
          status: missing.length ? "blocked" : "ready",
        });
        return { dataHandles: [handle] };
      },
    },
    publish: {
      description:
        "Publish an exactly founder-approved campaign bundle with fail-closed idempotency",
      arguments: publishArgumentsSchema,
      execute: async (
        args: z.infer<typeof publishArgumentsSchema>,
        context: Context,
      ) => ({
        dataHandles: [await publishPacket(args, context)],
      }),
    },
  },
};
