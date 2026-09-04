import { z } from "npm:zod@4";

const platformSchema = z.string().trim().min(1).max(100);
const idSchema = z.string().trim().min(1).max(200);
const MAX_ACCOUNT_PAGES = 10;
const ACCOUNTS_PER_PAGE = 100;

/** Vault-backed configuration for the read-only Zernio account-inspection API. */
export const globalArgumentsSchema = z.strictObject({
  apiKey: z.string().min(1).meta({ sensitive: true }),
  credentialSource: z.literal("vault"),
  profileId: idSchema,
  expectedAccounts: z.array(z.strictObject({
    platform: platformSchema,
    accountId: idSchema,
  })).min(1).max(100).superRefine((accounts, context) => {
    const keys = accounts.map((account) =>
      `${account.platform}:${account.accountId}`
    );
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["expectedAccounts"],
        message:
          "expectedAccounts may not contain duplicate platform/account pairs",
      });
    }
  }),
  apiBaseUrl: z.url().default("https://zernio.com/api/v1"),
  requestTimeoutMs: z.number().int().min(1000).max(30000).default(10000),
});

const inspectAccountsArgumentsSchema = z.strictObject({});
const accountSchema = z.strictObject({
  platform: platformSchema,
  accountId: idSchema,
  profileId: idSchema,
  displayName: z.string().trim().min(1).max(500).nullable(),
  username: z.string().trim().min(1).max(500).nullable(),
  connected: z.boolean(),
});
const receiptSchema = z.strictObject({
  apiVersion: z.literal("2026-09-04"),
  provider: z.literal("zernio"),
  observedAt: z.iso.datetime(),
  profileId: idSchema,
  status: z.enum(["ready", "blocked"]),
  accounts: z.array(accountSchema).min(1).max(100),
  missing: z.array(z.string()),
  pagesInspected: z.number().int().positive(),
  truncated: z.boolean(),
});
const healthAccountSchema = z.strictObject({
  accountId: idSchema,
  platform: platformSchema,
  status: z.enum(["healthy", "warning", "error"]),
  canPost: z.boolean(),
  canFetchAnalytics: z.boolean(),
  tokenValid: z.boolean(),
  needsReconnect: z.boolean(),
  issues: z.array(z.string()),
});
const healthReceiptSchema = z.strictObject({
  apiVersion: z.literal("2026-09-04"),
  provider: z.literal("zernio"),
  observedAt: z.iso.datetime(),
  profileId: idSchema,
  status: z.enum(["ready", "blocked"]),
  accounts: z.array(healthAccountSchema).min(1).max(100),
  missing: z.array(z.string()),
});

type Context = {
  globalArgs: z.infer<typeof globalArgumentsSchema>;
  logger: { info(message: string, attributes?: Record<string, unknown>): void };
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
  signal?: AbortSignal;
};

type Fetcher = typeof fetch;

function collection(payload: unknown, name: string): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  const value = payload[name] ?? payload.data;
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasMorePages(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (payload.hasMore === true) return true;
  return isRecord(payload.pagination) && payload.pagination.hasMore === true ||
    isRecord(payload.meta) && payload.meta.hasMore === true;
}

async function getJson(
  fetcher: Fetcher,
  config: z.infer<typeof globalArgumentsSchema>,
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetcher(new URL(path, `${config.apiBaseUrl}/`), {
    headers: { authorization: `Bearer ${config.apiKey}` },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)])
      : AbortSignal.timeout(config.requestTimeoutMs),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Zernio account inspection failed (${response.status})`);
  }
  return payload;
}

function normalizeAccount(
  raw: Record<string, unknown>,
  profileId: string,
): z.infer<typeof accountSchema> | null {
  const platform = raw.platform;
  const accountId = stringValue(raw.accountId) ?? stringValue(raw.id);
  if (typeof platform !== "string" || !platform.trim() || !accountId) {
    return null;
  }
  return {
    platform,
    accountId,
    profileId: stringValue(raw.profileId) ?? profileId,
    displayName: stringValue(raw.displayName) ?? stringValue(raw.name),
    username: stringValue(raw.username),
    connected: raw.connected !== false && raw.isActive !== false &&
      raw.status !== "disconnected",
  };
}

function normalizeHealthAccount(
  raw: Record<string, unknown>,
): z.infer<typeof healthAccountSchema> | null {
  const accountId = stringValue(raw.accountId);
  const platform = stringValue(raw.platform);
  if (
    !accountId || !platform ||
    !["healthy", "warning", "error"].includes(String(raw.status))
  ) {
    return null;
  }
  return {
    accountId,
    platform,
    status: raw.status as "healthy" | "warning" | "error",
    canPost: raw.canPost === true,
    canFetchAnalytics: raw.canFetchAnalytics === true,
    tokenValid: raw.tokenValid === true,
    needsReconnect: raw.needsReconnect === true,
    issues: Array.isArray(raw.issues)
      ? raw.issues.filter((issue): issue is string => typeof issue === "string")
      : [],
  };
}

/**
 * Verify that the configured Zernio profile exposes the exact allowlisted
 * Facebook and Instagram account IDs, then persist a redacted readiness receipt.
 */
export async function inspectAccounts(
  context: Context,
  fetcher: Fetcher = fetch,
): Promise<{ name: string }> {
  const config = globalArgumentsSchema.parse(context.globalArgs);
  context.logger.info("Inspecting allowlisted Zernio social accounts", {
    profileId: config.profileId,
    platforms: config.expectedAccounts.map((account) => account.platform),
  });

  const profiles = collection(
    await getJson(fetcher, config, "profiles", context.signal),
    "profiles",
  );
  if (
    !profiles.some((profile) =>
      (stringValue(profile.id) ?? stringValue(profile.profileId)) ===
        config.profileId
    )
  ) {
    throw new Error(
      "Configured Zernio profile was not returned by account inspection",
    );
  }
  const rawAccounts: Record<string, unknown>[] = [];
  let pagesInspected = 0;
  let hasMore = true;
  while (hasMore && pagesInspected < MAX_ACCOUNT_PAGES) {
    pagesInspected++;
    const payload = await getJson(
      fetcher,
      config,
      `accounts?profileId=${
        encodeURIComponent(config.profileId)
      }&page=${pagesInspected}&limit=${ACCOUNTS_PER_PAGE}`,
      context.signal,
    );
    rawAccounts.push(...collection(payload, "accounts"));
    hasMore = hasMorePages(payload);
  }
  const truncated = hasMore;
  const accounts = rawAccounts.map((account) =>
    normalizeAccount(account, config.profileId)
  ).filter((
    account,
  ): account is z.infer<typeof accountSchema> => account !== null);

  const expected = new Map(
    config.expectedAccounts.map((
      account,
    ) => [`${account.platform}:${account.accountId}`, account]),
  );
  const observed = accounts.filter((account) =>
    expected.has(`${account.platform}:${account.accountId}`)
  );
  const missing = config.expectedAccounts.flatMap((account) => {
    const observedAccount = observed.find((candidate) =>
      candidate.platform === account.platform &&
      candidate.accountId === account.accountId
    );
    return !observedAccount
      ? [`${account.platform}:${account.accountId} was not returned`]
      : !observedAccount.connected
      ? [`${account.platform}:${account.accountId} is disconnected`]
      : [];
  });
  if (truncated) {
    missing.push("account listing exceeded the bounded pagination limit");
  }
  const receipt = receiptSchema.parse({
    apiVersion: "2026-09-04",
    provider: "zernio",
    observedAt: new Date().toISOString(),
    profileId: config.profileId,
    status: missing.length ? "blocked" : "ready",
    accounts: config.expectedAccounts.map((expectedAccount) =>
      observed.find((account) =>
        account.platform === expectedAccount.platform &&
        account.accountId === expectedAccount.accountId
      ) ?? {
        ...expectedAccount,
        profileId: config.profileId,
        displayName: null,
        username: null,
        connected: false,
      }
    ),
    missing,
    pagesInspected,
    truncated,
  });
  return await context.writeResource(
    "readiness",
    `zernio-readiness-${config.profileId}`,
    receipt,
  );
}

/** Read the Zernio health summary for every configured, allowlisted account. */
export async function inspectAccountHealth(
  context: Context,
  fetcher: Fetcher = fetch,
): Promise<{ name: string }> {
  const config = globalArgumentsSchema.parse(context.globalArgs);
  context.logger.info("Inspecting Zernio account health", {
    profileId: config.profileId,
    accountCount: config.expectedAccounts.length,
  });
  const payload = await getJson(
    fetcher,
    config,
    `accounts/health?profileId=${encodeURIComponent(config.profileId)}`,
    context.signal,
  );
  const expected = new Map(
    config.expectedAccounts.map((
      account,
    ) => [`${account.platform}:${account.accountId}`, account]),
  );
  const observed = collection(payload, "accounts").map(normalizeHealthAccount)
    .filter((account): account is z.infer<typeof healthAccountSchema> =>
      account !== null &&
      expected.has(`${account.platform}:${account.accountId}`)
    );
  const missing = config.expectedAccounts.flatMap((account) => {
    const health = observed.find((candidate) =>
      candidate.platform === account.platform &&
      candidate.accountId === account.accountId
    );
    return !health
      ? [`${account.platform}:${account.accountId} health was not returned`]
      : health.status === "error" || health.needsReconnect || !health.tokenValid
      ? [`${account.platform}:${account.accountId} is not healthy`]
      : [];
  });
  const receipt = healthReceiptSchema.parse({
    apiVersion: "2026-09-04",
    provider: "zernio",
    observedAt: new Date().toISOString(),
    profileId: config.profileId,
    status: missing.length ? "blocked" : "ready",
    accounts: config.expectedAccounts.map((expectedAccount) =>
      observed.find((account) =>
        account.platform === expectedAccount.platform &&
        account.accountId === expectedAccount.accountId
      ) ?? {
        ...expectedAccount,
        status: "error",
        canPost: false,
        canFetchAnalytics: false,
        tokenValid: false,
        needsReconnect: true,
        issues: ["health was not returned"],
      }
    ),
    missing,
  });
  return await context.writeResource(
    "health",
    `zernio-health-${config.profileId}`,
    receipt,
  );
}

/** Read-only Zernio Swamp model; no provider mutation methods are defined. */
export const model = {
  type: "@mgreten/zernio",
  version: "2026.09.04.2",
  globalArguments: globalArgumentsSchema,
  upgrades: [
    {
      toVersion: "2026.09.04.2",
      description: "Broaden the account allowlist without changing its fields",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    readiness: {
      description:
        "Redacted Zernio profile and connected-account readiness receipt",
      schema: receiptSchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
    health: {
      description:
        "Redacted Zernio account-health receipt for the configured allowlist",
      schema: healthReceiptSchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
  },
  checks: {
    "zernio-vault-configuration": {
      description: "Require an explicitly vault-backed Zernio API key",
      labels: ["policy"],
      appliesTo: ["inspectAccounts", "inspectAccountHealth"],
      execute: (context: Context) => {
        const config = globalArgumentsSchema.parse(context.globalArgs);
        return config.credentialSource === "vault" && config.apiKey
          ? { pass: true }
          : { pass: false, errors: ["apiKey must resolve from a Swamp vault"] };
      },
    },
  },
  methods: {
    inspectAccounts: {
      description:
        "Read and verify the configured Facebook and Instagram accounts without external writes",
      arguments: inspectAccountsArgumentsSchema,
      execute: async (_args: Record<string, never>, context: Context) => ({
        dataHandles: [await inspectAccounts(context)],
      }),
    },
    inspectAccountHealth: {
      description:
        "Read and verify health for configured accounts without external writes",
      arguments: inspectAccountsArgumentsSchema,
      execute: async (_args: Record<string, never>, context: Context) => ({
        dataHandles: [await inspectAccountHealth(context)],
      }),
    },
  },
};
