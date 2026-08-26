import { z } from "npm:zod@4";
import {
  digestMarketingValue,
  marketingCampaignIdSchema,
  marketingCampaignManifestSchema,
  marketingDigestSchema,
  marketingHttpsUrlSchema,
  verifyCampaignManifest,
} from "./marketing_campaign_contracts.ts";

const MetaId = z.string().regex(/^\d+$/);
const OptionalMetaId = z.union([MetaId, z.literal("")]);
const OptionalAdAccountId = z.union([
  z.string().regex(/^(?:act_)?\d+$/),
  z.literal(""),
]);
const Timestamp = z.iso.datetime({ offset: true });

/** Vault-backed Meta Ads account, request, and budget-ceiling configuration. */
export const globalArgumentsSchema = z.strictObject({
  accessToken: z.string().default("").meta({ sensitive: true }),
  credentialSource: z.enum(["unconfigured", "vault"]).default("unconfigured"),
  businessId: OptionalMetaId.default(""),
  adAccountId: OptionalAdAccountId.default(""),
  pageId: OptionalMetaId.default(""),
  pixelId: OptionalMetaId.default(""),
  appId: OptionalMetaId.default(""),
  graphVersion: z.string().regex(/^v\d+\.\d+$/).default("v26.0"),
  requestTimeoutMs: z.number().int().min(1000).max(30000).default(10000),
  maxDailyBudgetMinor: z.number().int().min(100).max(100000).default(2000),
  maxLifetimeBudgetMinor: z.number().int().min(100).max(1000000).default(20000),
});

const creativeSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  primaryText: z.string().trim().min(1).max(2200),
  headline: z.string().trim().min(1).max(255),
  description: z.string().trim().max(255).optional(),
  callToAction: z.enum(["LEARN_MORE", "SIGN_UP"]),
  imageHash: z.string().regex(/^[0-9a-f]+$/),
  mediaDigest: marketingDigestSchema,
});

const paidRightsSchema = z.strictObject({
  rightsId: marketingCampaignIdSchema,
  owner: z.literal("Moment Savor"),
  sourceDigest: marketingDigestSchema,
  campaignId: marketingCampaignIdSchema,
  permittedUse: z.literal("paid_ads"),
  effectiveAt: Timestamp,
  expiresAt: Timestamp,
});

const packetSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  manifest: marketingCampaignManifestSchema,
  campaignPacketDigest: marketingDigestSchema,
  landingPageDigest: marketingDigestSchema,
  socialPacketDigest: marketingDigestSchema,
  creativeDigest: marketingDigestSchema,
  adsPacketDigest: marketingDigestSchema,
  campaign: z.strictObject({
    name: z.string().trim().min(1).max(200),
    objective: z.enum(["OUTCOME_TRAFFIC", "OUTCOME_SALES"]),
    specialAdCategories: z.array(z.enum([
      "NONE",
      "CREDIT",
      "EMPLOYMENT",
      "HOUSING",
      "ISSUES_ELECTIONS_POLITICS",
    ])).min(1).max(4),
  }),
  adSet: z.strictObject({
    name: z.string().trim().min(1).max(200),
    conversionLocation: z.literal("WEBSITE"),
    optimizationGoal: z.enum(["LANDING_PAGE_VIEWS", "OFFSITE_CONVERSIONS"]),
    billingEvent: z.literal("IMPRESSIONS"),
    dailyBudgetMinor: z.number().int().positive().optional(),
    lifetimeBudgetMinor: z.number().int().positive().optional(),
    startTime: Timestamp.optional(),
    endTime: Timestamp.optional(),
    targeting: z.strictObject({
      minimumAge: z.number().int().min(18).max(65),
      geographies: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(10),
      mode: z.enum(["broad", "advantage_plus"]),
    }),
  }),
  creative: creativeSchema,
  ad: z.strictObject({ name: z.string().trim().min(1).max(200) }),
  destination: z.strictObject({
    url: marketingHttpsUrlSchema,
    utmSource: z.literal("facebook"),
    utmMedium: z.literal("paid_social"),
    utmCampaign: marketingCampaignIdSchema,
    utmContent: marketingCampaignIdSchema,
  }),
  rights: paidRightsSchema,
}).superRefine((value, context) => {
  const issue = (path: PropertyKey[], message: string) =>
    context.addIssue({ code: "custom", path, message });
  const daily = value.adSet.dailyBudgetMinor !== undefined;
  const lifetime = value.adSet.lifetimeBudgetMinor !== undefined;
  if (daily === lifetime) {
    issue(["adSet"], "exactly one bounded budget is required");
  }
  if (lifetime && (!value.adSet.startTime || !value.adSet.endTime)) {
    issue(["adSet"], "lifetime budget requires start and end times");
  }
  if (
    value.adSet.startTime && value.adSet.endTime &&
    Date.parse(value.adSet.startTime) >= Date.parse(value.adSet.endTime)
  ) issue(["adSet", "endTime"], "lifetime budget end must follow start");
  if (
    value.campaign.objective === "OUTCOME_TRAFFIC" &&
    value.adSet.optimizationGoal !== "LANDING_PAGE_VIEWS"
  ) issue(["adSet", "optimizationGoal"], "traffic requires LANDING_PAGE_VIEWS");
  if (
    value.campaign.objective === "OUTCOME_SALES" &&
    value.adSet.optimizationGoal !== "OFFSITE_CONVERSIONS"
  ) issue(["adSet", "optimizationGoal"], "sales requires OFFSITE_CONVERSIONS");
  if (
    new Set(value.campaign.specialAdCategories).size !==
      value.campaign.specialAdCategories.length
  ) {
    issue(
      ["campaign", "specialAdCategories"],
      "special ad categories must be unique",
    );
  }
  if (
    value.campaign.specialAdCategories.includes("NONE") &&
    value.campaign.specialAdCategories.length !== 1
  ) {
    issue(
      ["campaign", "specialAdCategories"],
      "NONE cannot be combined with another category",
    );
  }
  if (value.destination.utmCampaign !== value.manifest.campaignId) {
    issue(
      ["destination", "utmCampaign"],
      "UTM campaign identity must equal campaignId",
    );
  }
  if (value.destination.url !== value.manifest.landingPage.url) {
    issue(
      ["destination", "url"],
      "ad destination must equal the exact campaign landing URL",
    );
  }
  const url = new URL(value.destination.url);
  const exact = {
    utm_source: value.destination.utmSource,
    utm_medium: value.destination.utmMedium,
    utm_campaign: value.destination.utmCampaign,
    utm_content: value.destination.utmContent,
  };
  for (const [key, expected] of Object.entries(exact)) {
    if (url.searchParams.get(key) !== expected) {
      issue(["destination", "url"], `${key} must be explicit and exact`);
    }
  }
  if (value.rights.campaignId !== value.manifest.campaignId) {
    issue(["rights", "campaignId"], "rights must match campaign");
  }
  if (value.rights.sourceDigest !== value.creative.mediaDigest) {
    issue(
      ["rights", "sourceDigest"],
      "rights must bind the paid creative media digest",
    );
  }
  if (
    Date.parse(value.rights.effectiveAt) >= Date.parse(value.rights.expiresAt)
  ) {
    issue(["rights"], "rights chronology is invalid");
  }
});

const approvalSchema = z.strictObject({
  approved: z.literal(true),
  actor: z.literal("founder"),
  approvalId: marketingCampaignIdSchema,
  campaignPacketDigest: marketingDigestSchema,
  landingPageDigest: marketingDigestSchema,
  socialPacketDigest: marketingDigestSchema,
  creativeDigest: marketingDigestSchema,
  adsPacketDigest: marketingDigestSchema,
});
/** Arguments for credential-free paid packet readiness validation. */
export const readinessArgumentsSchema = z.strictObject({
  packet: packetSchema,
});
/** Arguments for an exact-approved, idempotent PAUSED draft hierarchy. */
export const createDraftArgumentsSchema = z.strictObject({
  packet: packetSchema,
  approval: approvalSchema,
  idempotencyKey: marketingCampaignIdSchema,
});

type Packet = z.infer<typeof packetSchema>;
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

/** Compute the canonical digest that binds a complete Meta Ads packet. */
export function digestAdsPacket(
  packet: Omit<Packet, "adsPacketDigest">,
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
  if (await digestMarketingValue(packet.creative) !== packet.creativeDigest) {
    throw new TypeError("creative digest mismatch");
  }
  const { adsPacketDigest, ...payload } = packet;
  if (await digestAdsPacket(payload) !== adsPacketDigest) {
    throw new TypeError("ads packet digest mismatch");
  }
  if (
    Date.parse(packet.rights.effectiveAt) > Date.now() ||
    Date.parse(packet.rights.expiresAt) <= Date.now()
  ) {
    throw new TypeError("paid media rights are not currently effective");
  }
  return packet;
}

function verifyApproval(
  packet: Packet,
  approval: z.infer<typeof approvalSchema>,
) {
  for (
    const field of [
      "campaignPacketDigest",
      "landingPageDigest",
      "socialPacketDigest",
      "creativeDigest",
      "adsPacketDigest",
    ] as const
  ) {
    if (packet[field] !== approval[field]) {
      throw new TypeError(`approval ${field} mismatch`);
    }
  }
}

function missingConfiguration(
  packet: Packet,
  config: z.infer<typeof globalArgumentsSchema>,
  credentials = true,
) {
  return [
    credentials && config.credentialSource !== "vault" &&
    "vaultCredentialSource",
    credentials && !config.accessToken && "systemUserAccessToken",
    !config.businessId && "businessId",
    !config.adAccountId && "adAccountId",
    !config.pageId && "pageId",
    !config.appId && "appId",
    packet.campaign.objective === "OUTCOME_SALES" && !config.pixelId &&
    "pixelId",
  ].filter(Boolean) as string[];
}

function validateBudget(
  packet: Packet,
  config: z.infer<typeof globalArgumentsSchema>,
) {
  if ((packet.adSet.dailyBudgetMinor ?? 0) > config.maxDailyBudgetMinor) {
    throw new TypeError("daily budget exceeds configured bound");
  }
  if ((packet.adSet.lifetimeBudgetMinor ?? 0) > config.maxLifetimeBudgetMinor) {
    throw new TypeError("lifetime budget exceeds configured bound");
  }
}

async function graphPost(
  fetcher: Fetcher,
  url: string,
  fields: Record<string, string>,
  config: z.infer<typeof globalArgumentsSchema>,
  signal?: AbortSignal,
) {
  const bounded = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)])
    : AbortSignal.timeout(config.requestTimeoutMs);
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, access_token: config.accessToken }),
    signal: bounded,
  });
  const payload = await response.json().catch(() => ({})) as Record<
    string,
    unknown
  >;
  if (!response.ok || typeof payload.id !== "string") {
    throw new Error(`Meta Marketing API request failed (${response.status})`);
  }
  return payload.id;
}

const json = (value: unknown) => JSON.stringify(value);

/** Create a PAUSED-only hierarchy while checkpointing every remote object ID. */
export async function createPausedDraft(
  raw: unknown,
  context: Context,
  fetcher: Fetcher = fetch,
) {
  const args = createDraftArgumentsSchema.parse(raw);
  const packet = await verifyPacket(args.packet);
  verifyApproval(packet, args.approval);
  validateBudget(packet, context.globalArgs);
  context.logger.info("Preparing exact-approved PAUSED Meta Ads draft", {
    campaignId: packet.manifest.campaignId,
    idempotencyKey: args.idempotencyKey,
  });
  const missing = missingConfiguration(packet, context.globalArgs, true);
  if (missing.length) {
    throw new Error(`Meta Ads configuration blocked: ${missing.join(", ")}`);
  }

  const resourceName = `draft-${args.idempotencyKey}`;
  const identity = {
    campaignPacketDigest: packet.campaignPacketDigest,
    landingPageDigest: packet.landingPageDigest,
    socialPacketDigest: packet.socialPacketDigest,
    creativeDigest: packet.creativeDigest,
    adsPacketDigest: packet.adsPacketDigest,
  };
  const existing = await context.readResource(resourceName);
  if (existing) {
    const same = Object.entries(identity).every(([key, value]) =>
      existing[key] === value
    );
    throw new Error(
      same
        ? "idempotency replay rejected"
        : "idempotency key conflict rejected",
    );
  }

  const config = context.globalArgs;
  const account = config.adAccountId.startsWith("act_")
    ? config.adAccountId
    : `act_${config.adAccountId}`;
  const base = `https://graph.facebook.com/${config.graphVersion}`;
  const destination = packet.destination.url;
  const requests = ["campaign", "adset", "adcreative", "ad"].map((
    resource,
  ) => ({
    resource,
    method: "POST",
    requestedDeliveryStatus: resource === "adcreative"
      ? "not_applicable"
      : "PAUSED",
    destination: resource === "adcreative" ? destination : undefined,
  }));
  const evidence = {
    schemaVersion: "1.0",
    status: "intent",
    idempotencyKey: args.idempotencyKey,
    campaignId: packet.manifest.campaignId,
    campaignVersion: packet.manifest.campaignVersion,
    ...identity,
    approvalId: args.approval.approvalId,
    approvalActor: args.approval.actor,
    destination,
    budget: {
      dailyBudgetMinor: packet.adSet.dailyBudgetMinor,
      lifetimeBudgetMinor: packet.adSet.lifetimeBudgetMinor,
    },
    specialAdCategories: packet.campaign.specialAdCategories,
    rightsId: packet.rights.rightsId,
    requests,
  };
  await context.writeResource("evidence", resourceName, {
    ...evidence,
    results: {},
  });

  const results: Record<string, string> = {};
  results.campaignId = await graphPost(
    fetcher,
    `${base}/${account}/campaigns`,
    {
      name: packet.campaign.name,
      objective: packet.campaign.objective,
      special_ad_categories: json(packet.campaign.specialAdCategories),
      status: "PAUSED",
    },
    config,
    context.signal,
  );
  await context.writeResource("evidence", resourceName, {
    ...evidence,
    status: "campaign_created",
    results: structuredClone(results),
  });

  const adSetFields: Record<string, string> = {
    name: packet.adSet.name,
    campaign_id: results.campaignId,
    billing_event: packet.adSet.billingEvent,
    optimization_goal: packet.adSet.optimizationGoal,
    destination_type: packet.adSet.conversionLocation,
    targeting: json({
      age_min: packet.adSet.targeting.minimumAge,
      geo_locations: { countries: packet.adSet.targeting.geographies },
      advantage_audience: packet.adSet.targeting.mode === "advantage_plus"
        ? 1
        : 0,
    }),
    status: "PAUSED",
    ...(packet.adSet.dailyBudgetMinor
      ? { daily_budget: String(packet.adSet.dailyBudgetMinor) }
      : {
        lifetime_budget: String(packet.adSet.lifetimeBudgetMinor),
        start_time: packet.adSet.startTime!,
        end_time: packet.adSet.endTime!,
      }),
  };
  if (packet.campaign.objective === "OUTCOME_SALES") {
    adSetFields.promoted_object = json({
      pixel_id: config.pixelId,
      custom_event_type: "PURCHASE",
    });
  }
  results.adSetId = await graphPost(
    fetcher,
    `${base}/${account}/adsets`,
    adSetFields,
    config,
    context.signal,
  );
  await context.writeResource("evidence", resourceName, {
    ...evidence,
    status: "adset_created",
    results: structuredClone(results),
  });

  results.creativeId = await graphPost(
    fetcher,
    `${base}/${account}/adcreatives`,
    {
      name: packet.creative.name,
      object_story_spec: json({
        page_id: config.pageId,
        link_data: {
          link: destination,
          image_hash: packet.creative.imageHash,
          message: packet.creative.primaryText,
          name: packet.creative.headline,
          description: packet.creative.description ?? "",
          call_to_action: {
            type: packet.creative.callToAction,
            value: { link: destination },
          },
        },
      }),
    },
    config,
    context.signal,
  );
  await context.writeResource("evidence", resourceName, {
    ...evidence,
    status: "creative_created",
    results: structuredClone(results),
  });

  results.adId = await graphPost(
    fetcher,
    `${base}/${account}/ads`,
    {
      name: packet.ad.name,
      adset_id: results.adSetId,
      creative: json({ creative_id: results.creativeId }),
      status: "PAUSED",
    },
    config,
    context.signal,
  );
  const handle = await context.writeResource("evidence", resourceName, {
    ...evidence,
    status: "created_paused",
    results,
    deliveryStatuses: { campaign: "PAUSED", adSet: "PAUSED", ad: "PAUSED" },
  });
  context.logger.info("Completed PAUSED Meta Ads draft hierarchy", {
    campaignId: packet.manifest.campaignId,
    idempotencyKey: args.idempotencyKey,
  });
  return handle;
}

const evidenceSchema = z.strictObject({
  schemaVersion: z.literal("1.0").optional(),
  status: z.enum([
    "ready",
    "blocked",
    "intent",
    "campaign_created",
    "adset_created",
    "creative_created",
    "created_paused",
  ]),
  campaignPacketDigest: marketingDigestSchema,
  landingPageDigest: marketingDigestSchema,
  socialPacketDigest: marketingDigestSchema,
  creativeDigest: marketingDigestSchema,
  adsPacketDigest: marketingDigestSchema,
  idempotencyKey: marketingCampaignIdSchema.optional(),
  campaignId: marketingCampaignIdSchema.optional(),
  campaignVersion: z.number().int().positive().optional(),
  approvalId: marketingCampaignIdSchema.optional(),
  approvalActor: z.literal("founder").optional(),
  destination: marketingHttpsUrlSchema.optional(),
  budget: z.strictObject({
    dailyBudgetMinor: z.number().int().positive().optional(),
    lifetimeBudgetMinor: z.number().int().positive().optional(),
  }).optional(),
  specialAdCategories: z.array(z.enum([
    "NONE",
    "CREDIT",
    "EMPLOYMENT",
    "HOUSING",
    "ISSUES_ELECTIONS_POLITICS",
  ])).optional(),
  rightsId: marketingCampaignIdSchema.optional(),
  requests: z.array(z.strictObject({
    resource: z.enum(["campaign", "adset", "adcreative", "ad"]),
    method: z.literal("POST"),
    requestedDeliveryStatus: z.enum(["PAUSED", "not_applicable"]),
    destination: marketingHttpsUrlSchema.optional(),
  })).optional(),
  results: z.strictObject({
    campaignId: z.string().min(1).optional(),
    adSetId: z.string().min(1).optional(),
    creativeId: z.string().min(1).optional(),
    adId: z.string().min(1).optional(),
  }).optional(),
  deliveryStatuses: z.strictObject({
    campaign: z.literal("PAUSED"),
    adSet: z.literal("PAUSED"),
    ad: z.literal("PAUSED"),
  }).optional(),
  missing: z.array(z.string().min(1)).optional(),
  credentialReadinessNotChecked: z.literal(true).optional(),
  createsOnlyPausedDeliveryObjects: z.literal(true).optional(),
});

/** Swamp model for exact-approved Meta Ads PAUSED draft creation. */
export const model = {
  type: "@mgreten/meta-ads-publisher",
  version: "2026.08.26.2",
  globalArguments: globalArgumentsSchema,
  resources: {
    evidence: {
      description:
        "Durable redacted Meta Ads readiness, checkpoints, and paused-draft evidence",
      schema: evidenceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 1000,
    },
  },
  methods: {
    readiness: {
      description:
        "Validate an exact paid packet and report prerequisites; credentials are optional",
      arguments: readinessArgumentsSchema,
      execute: async (
        args: z.infer<typeof readinessArgumentsSchema>,
        context: Context,
      ) => {
        const packet = await verifyPacket(args.packet);
        context.logger.info("Checking Meta Ads draft readiness", {
          campaignId: packet.manifest.campaignId,
        });
        validateBudget(packet, context.globalArgs);
        const missing = missingConfiguration(packet, context.globalArgs, false);
        const handle = await context.writeResource(
          "evidence",
          `readiness-${packet.adsPacketDigest}`,
          {
            status: missing.length ? "blocked" : "ready",
            campaignId: packet.manifest.campaignId,
            campaignPacketDigest: packet.campaignPacketDigest,
            landingPageDigest: packet.landingPageDigest,
            socialPacketDigest: packet.socialPacketDigest,
            creativeDigest: packet.creativeDigest,
            adsPacketDigest: packet.adsPacketDigest,
            missing,
            credentialReadinessNotChecked: true,
            createsOnlyPausedDeliveryObjects: true,
            rightsId: packet.rights.rightsId,
          },
        );
        context.logger.info("Completed Meta Ads draft readiness", {
          campaignId: packet.manifest.campaignId,
          status: missing.length ? "blocked" : "ready",
        });
        return { dataHandles: [handle] };
      },
    },
    createDraft: {
      description:
        "Create an exactly founder-approved Campaign, Ad Set, Creative, and PAUSED Ad hierarchy",
      arguments: createDraftArgumentsSchema,
      execute: async (
        args: z.infer<typeof createDraftArgumentsSchema>,
        context: Context,
      ) => ({
        dataHandles: [await createPausedDraft(args, context)],
      }),
    },
  },
};
