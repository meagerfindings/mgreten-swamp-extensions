import { z } from "npm:zod@4";

export const marketingCampaignIdSchema = z.string().trim().regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
);
export const marketingDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const marketingHttpsUrlSchema = z.url().refine(
  (value) => new URL(value).protocol === "https:",
  "campaign URLs must use HTTPS",
);

const copy = (maximum: number) => z.string().trim().min(1).max(maximum);

export const campaignLandingPageSchema = z.strictObject({
  url: marketingHttpsUrlSchema,
  headline: copy(200),
  paragraphs: z.array(z.array(copy(500)).min(1).max(3)).min(1).max(3),
  pageCopy: copy(500),
  examples: z.array(copy(120)).min(1).max(3),
  cta: copy(80),
  heroMedia: z.strictObject({
    assetId: marketingCampaignIdSchema,
    digest: marketingDigestSchema,
    alt: copy(200),
  }).optional(),
});

export const marketingCampaignManifestSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  campaignId: marketingCampaignIdSchema,
  campaignVersion: z.number().int().positive(),
  promise: copy(200),
  landingPage: campaignLandingPageSchema,
}).superRefine((value, context) => {
  if (value.promise !== value.landingPage.headline) {
    context.addIssue({
      code: "custom",
      path: ["landingPage", "headline"],
      message:
        "landing-page hero must exactly carry the canonical campaign promise",
    });
  }
});

export function canonicalMarketingJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalMarketingJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) =>
          `${JSON.stringify(key)}:${canonicalMarketingJson(nested)}`
        )
        .join(",")
    }}`;
  }
  return JSON.stringify(value);
}

export async function marketingSha256(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const digestMarketingValue = (value: unknown) =>
  marketingSha256(canonicalMarketingJson(value));

export async function verifyCampaignManifest(
  raw: unknown,
  expectedDigest: string,
) {
  const manifest = marketingCampaignManifestSchema.parse(raw);
  if (await digestMarketingValue(manifest) !== expectedDigest) {
    throw new TypeError("campaign packet digest mismatch");
  }
  return manifest;
}
