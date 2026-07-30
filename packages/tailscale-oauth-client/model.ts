/** Safely stage replacement of Tailscale OAuth clients. @module */
import { z } from "npm:zod@4";

const ORIGIN = "https://api.tailscale.com";
const TOKEN_PATH = "/api/v2/oauth/token";
const KEYS_PATH = "/api/v2/tailnet/-/keys";
const MAX_BODY = 64 * 1024;
const Id = z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/);
const RequestId = z.string().min(8).max(80).regex(/^[A-Za-z0-9._-]+$/);
const Description = z.string().trim().min(1).max(50).regex(/^[A-Za-z0-9 -]+$/);
const Scope = z.string().min(1).max(100).regex(/^[A-Za-z0-9:_-]+$/);
const Scopes = z.array(Scope).min(1).max(32).refine(
  (v) => new Set(v).size === v.length,
  "scopes must be unique",
);
const Tag = z.string().max(100).regex(/^tag:[A-Za-z0-9_-]+$/);
const Tags = z.array(Tag).max(32).refine(
  (v) => new Set(v).size === v.length,
  "tags must be unique",
);
const Confirmation = z.string().regex(/^[a-z-]+:[0-9a-f]{64}$/);
const Timestamp = z.string().datetime({ offset: true }).max(35);
const needsTags = (scopes: string[]) =>
  scopes.some((s) => s === "devices:core" || s === "auth_keys");
const CreateRequest = z.object({
  requestId: RequestId,
  description: Description,
  scopes: Scopes,
  tags: Tags,
})
  .refine((v) => !needsTags(v.scopes) || v.tags.length > 0, {
    message: "tags are required for devices:core or auth_keys scopes",
    path: ["tags"],
  });
const CandidateRef = z.object({
  requestId: RequestId,
  candidateRequestId: RequestId,
  candidateId: Id,
});
const Evidence = z.array(z.string().trim().min(1).max(300)).min(1).max(20);

/** Validates the vault-backed OAuth client used to administer trust credentials. */
export const GlobalArgsSchema = z.object({
  managerClientId: z.string().min(1).max(300),
  managerClientSecret: z.string().min(1).max(1000).meta({ sensitive: true }),
  timeoutSeconds: z.number().int().min(2).max(30).default(10),
}).strict();
/** Validates one candidate client ID and its one-time, vault-backed secret. */
export const CandidateCredentialSchema = z.object({
  clientId: Id,
  clientSecret: z.string().min(1).max(4096).meta({ sensitive: true }),
}).strict();
const CandidateMetadataSchema = z.object({
  requestId: RequestId,
  id: Id,
  keyType: z.literal("client"),
  description: Description,
  scopes: Scopes,
  tags: Tags,
  created: Timestamp,
  updated: Timestamp,
  userId: z.string().max(200),
  status: z.enum(["active", "missing", "revoked"]),
  syncedAt: Timestamp.optional(),
}).strict();
const ProviderKeySchema = z.object({
  id: Id,
  keyType: z.string().min(1).max(40),
  key: z.string().min(1).max(4096),
  description: Description,
  created: Timestamp,
  updated: Timestamp.nullish(),
  scopes: Scopes,
  tags: Tags.nullish(),
  userId: z.string().max(200).nullish(),
  invalid: z.boolean().optional(),
  revoked: Timestamp.nullable().optional(),
});
const ProviderMetadataSchema = ProviderKeySchema.omit({ key: true }).extend({
  keyType: z.literal("client"),
});
const ProviderKeyEnvelopeSchema = z.object({
  id: Id,
  keyType: z.string().min(1).max(40),
  invalid: z.boolean().optional(),
  revoked: Timestamp.nullable().optional(),
}).passthrough();
const TokenSchema = z.object({
  access_token: z.string().min(1).max(16384).meta({ sensitive: true }),
  token_type: z.string().min(1).max(40).meta({ sensitive: true }),
  expires_in: z.number().int().positive().max(86400),
  scope: z.string().max(4000).optional(),
});
const PreviewSchema = CreateRequest.extend({
  confirmation: Confirmation,
  warning: z.string().max(500),
}).strict();
const VerificationSchema = z.object({
  requestId: RequestId,
  candidateId: z.string().max(200).optional(),
  verifiedAt: Timestamp,
  requestedScopes: Scopes,
  requestedTags: Tags,
  grantedScope: z.string().max(4000).nullable(),
  tokenType: z.literal("Bearer"),
  expiresIn: z.number().int().positive().max(86400),
}).strict();
const CutoverPreviewSchema = CandidateRef.extend({
  evidence: Evidence,
  confirmation: Confirmation,
  warning: z.string().max(500),
}).strict();
const CutoverSchema = CandidateRef.extend({
  evidence: Evidence,
  recordedAt: Timestamp,
  verificationVerifiedAt: Timestamp,
}).strict();
const RevokeRequest = CandidateRef.extend({ previousClientId: Id });
const RevokePreviewSchema = RevokeRequest.extend({
  confirmation: Confirmation,
  warning: z.string().max(500),
}).strict();
const RevocationSchema = RevokeRequest.extend({
  revokedAt: Timestamp,
  providerStatus: z.enum(["deleted", "already-missing"]),
}).strict();
const CreationAttemptSchema = z.object({
  requestId: RequestId,
  request: CreateRequest.strict(),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  attemptedAt: Timestamp,
  state: z.enum(["attempted", "completed"]),
  candidateId: Id.optional(),
}).strict();
const RevocationAttemptSchema = z.object({
  requestId: RequestId,
  request: RevokeRequest.strict(),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  attemptedAt: Timestamp,
  state: z.enum(["attempted", "completed"]),
  providerStatus: z.enum(["deleted", "already-missing"]).optional(),
}).strict();

function toCreateRequest(
  value: {
    requestId: string;
    description: string;
    scopes: string[];
    tags: string[];
  },
) {
  return CreateRequest.parse({
    requestId: value.requestId,
    description: value.description,
    scopes: value.scopes,
    tags: value.tags,
  });
}
function toRevokeRequest(
  value: {
    requestId: string;
    candidateRequestId: string;
    candidateId: string;
    previousClientId: string;
  },
) {
  return RevokeRequest.parse({
    requestId: value.requestId,
    candidateRequestId: value.candidateRequestId,
    candidateId: value.candidateId,
    previousClientId: value.previousClientId,
  });
}

type Globals = z.infer<typeof GlobalArgsSchema>;
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
type Context = {
  globalArgs: Globals;
  signal?: AbortSignal;
  logger: { info(message: string, properties?: Record<string, unknown>): void };
  readResource(name: string): Promise<unknown>;
  writeResource(spec: string, name: string, value: unknown): Promise<unknown>;
};
const now = () => new Date().toISOString();
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));
async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
async function confirmation(prefix: string, value: unknown): Promise<string> {
  return `${prefix}:${await sha256({ version: 1, ...value as object })}`;
}
async function readBody(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_BODY) {
    throw new Error("Tailscale response exceeded the 64 KiB limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw new Error("Tailscale response exceeded the 64 KiB limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}
function statusError(operation: string, response: Response): Error {
  const retryAfter = response.headers.get("retry-after");
  return new Error(
    `Tailscale ${operation} failed with HTTP ${response.status}; response body redacted${
      retryAfter ? `; Retry-After: ${retryAfter}` : ""
    }`,
  );
}
async function request(
  path: string,
  init: RequestInit,
  context: Context,
  fetcher: FetchLike,
  operation: string,
  ambiguousMutation = false,
) {
  const globals = GlobalArgsSchema.parse(context.globalArgs);
  const controller = new AbortController();
  if (context.signal?.aborted) controller.abort(context.signal.reason);
  const timer = setTimeout(
    () => controller.abort(new DOMException("Timed out", "TimeoutError")),
    globals.timeoutSeconds * 1000,
  );
  const abort = () => controller.abort(context.signal?.reason);
  context.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetcher(`${ORIGIN}${path}`, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
    return { response, body: await readBody(response) };
  } catch (error) {
    const kind = error instanceof Error ? error.name : "network error";
    throw new Error(
      ambiguousMutation
        ? `Tailscale ${operation} outcome is ambiguous (${kind}); reconcile before retrying`
        : `Tailscale ${operation} failed (${kind}); no response details retained`,
    );
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", abort);
  }
}
async function token(
  clientId: string,
  clientSecret: string,
  scopes: string[],
  tags: string[],
  context: Context,
  fetcher: FetchLike,
) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope: scopes.join(" "),
  });
  if (tags.length) body.set("tags", tags.join(" "));
  const result = await request(
    TOKEN_PATH,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
    context,
    fetcher,
    "token exchange",
  );
  if (!result.response.ok) throw statusError("token exchange", result.response);
  const oauthResponse = (() => {
    try {
      return TokenSchema.parse(JSON.parse(result.body));
    } catch {
      throw new Error(
        "Tailscale token exchange returned an invalid redacted response",
      );
    }
  })();
  if (oauthResponse.token_type.toLowerCase() !== "bearer") {
    throw new Error(
      "Tailscale token exchange returned a non-Bearer token type",
    );
  }
  if (oauthResponse.scope !== undefined) {
    const granted = new Set(oauthResponse.scope.split(/\s+/).filter(Boolean));
    if (!granted.has("all") && scopes.some((scope) => !granted.has(scope))) {
      throw new Error(
        "Tailscale token exchange grant does not cover every requested scope",
      );
    }
  }
  return oauthResponse;
}
async function managerToken(
  context: Context,
  fetcher: FetchLike,
  scope: "oauth_keys" | "oauth_keys:read",
) {
  const g = GlobalArgsSchema.parse(context.globalArgs);
  return (await token(
    g.managerClientId,
    g.managerClientSecret,
    [scope],
    [],
    context,
    fetcher,
  )).access_token;
}
const read = async <T>(
  context: Context,
  name: string,
  schema: z.ZodType<T>,
): Promise<T | null> => {
  const value = await context.readResource(name);
  return value == null ? null : schema.parse(value);
};
const candidateName = (id: string) => `candidate-${id}`;
const credentialName = (id: string) => `candidate-credential-${id}`;
const creationAttemptName = (id: string) => `candidate-creation-attempt-${id}`;
const verificationName = (id: string) => `verification-${id}`;
const cutoverName = (id: string) => `cutover-${id}`;
const revocationName = (id: string) => `revocation-${id}`;
const revocationAttemptName = (id: string) => `revocation-attempt-${id}`;
async function getKey(
  id: string,
  bearer: string,
  context: Context,
  fetcher: FetchLike,
  operation: string,
) {
  const result = await request(
    `${KEYS_PATH}/${encodeURIComponent(id)}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${bearer}`,
      },
    },
    context,
    fetcher,
    operation,
  );
  if (result.response.status === 404) return null;
  if (!result.response.ok) throw statusError(operation, result.response);
  let raw: unknown;
  let envelope: z.infer<typeof ProviderKeyEnvelopeSchema>;
  try {
    raw = JSON.parse(result.body);
    envelope = ProviderKeyEnvelopeSchema.parse(raw);
  } catch {
    throw new Error(
      `Tailscale ${operation} returned invalid or mismatched redacted metadata`,
    );
  }
  if (envelope.id !== id) {
    throw new Error(
      `Tailscale ${operation} returned invalid or mismatched redacted metadata`,
    );
  }
  if (envelope.keyType !== "client") {
    return {
      id: envelope.id,
      keyType: "non-client" as const,
      providerKeyType: envelope.keyType,
      invalid: envelope.invalid,
      revoked: envelope.revoked,
    };
  }
  try {
    return ProviderMetadataSchema.parse(raw);
  } catch {
    throw new Error(
      `Tailscale ${operation} returned invalid or mismatched redacted metadata`,
    );
  }
}

/** Creates exactly one journaled OAuth candidate and vaults its one-time secret. */
export async function createCandidate(
  args: z.infer<typeof CreateRequest> & { confirmation: string },
  context: Context,
  fetcher: FetchLike = fetch,
) {
  const normalized = toCreateRequest(args);
  context.logger.info("Candidate creation entered", {
    requestId: normalized.requestId,
  });
  const expected = await confirmation("create-candidate", normalized);
  const preview = await read(
    context,
    `create-preview-${normalized.requestId}`,
    PreviewSchema,
  );
  if (
    !preview || preview.confirmation !== args.confirmation ||
    args.confirmation !== expected ||
    !same(toCreateRequest(preview), normalized)
  ) {
    throw new Error(
      "Confirmation does not match the exact persisted candidate preview",
    );
  }
  const hash = await sha256(normalized);
  const attempt = await read(
    context,
    creationAttemptName(normalized.requestId),
    CreationAttemptSchema,
  );
  const metadata = await read(
    context,
    candidateName(normalized.requestId),
    CandidateMetadataSchema,
  );
  const credential = await read(
    context,
    credentialName(normalized.requestId),
    CandidateCredentialSchema,
  );
  if (attempt) {
    if (
      attempt.requestId !== normalized.requestId ||
      attempt.request.requestId !== normalized.requestId ||
      attempt.requestHash !== hash || !same(attempt.request, normalized)
    ) {
      throw new Error(
        "Candidate request ID is already bound to different creation inputs",
      );
    }
    const matches = metadata && credential &&
      metadata.requestId === normalized.requestId &&
      metadata.id === credential.clientId &&
      metadata.description === normalized.description &&
      sameSet(metadata.scopes, normalized.scopes) &&
      sameSet(metadata.tags, normalized.tags);
    if (
      attempt.state === "completed" && matches &&
      attempt.candidateId === metadata.id
    ) return { dataHandles: [] };
    if (matches) {
      const h = await context.writeResource(
        "candidateCreationAttempt",
        creationAttemptName(normalized.requestId),
        { ...attempt, state: "completed", candidateId: metadata.id },
      );
      return { dataHandles: [h] };
    }
    throw new Error(
      "Candidate creation attempt has an ambiguous or incomplete result; reconcile provider state, metadata, and vaulted credential before retrying",
    );
  }
  if (metadata || credential) {
    throw new Error(
      "Candidate state exists without its creation journal; reconcile metadata and vaulted credential before retrying",
    );
  }
  const creationScopes = normalized.scopes.includes("all") ? ["all"] : [
    ...new Set([
      "oauth_keys",
      ...normalized.scopes.filter((scope) => scope !== "oauth_keys:read"),
    ]),
  ];
  const globals = GlobalArgsSchema.parse(context.globalArgs);
  const bearer = (await token(
    globals.managerClientId,
    globals.managerClientSecret,
    creationScopes,
    normalized.tags,
    context,
    fetcher,
  )).access_token;
  const attempted = {
    requestId: normalized.requestId,
    request: normalized,
    requestHash: hash,
    attemptedAt: now(),
    state: "attempted" as const,
  };
  try {
    await context.writeResource(
      "candidateCreationAttempt",
      creationAttemptName(normalized.requestId),
      attempted,
    );
  } catch {
    throw new Error(
      "Could not persist candidate creation attempt marker; provider POST was not sent",
    );
  }
  const result = await request(
    KEYS_PATH,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        keyType: "client",
        description: normalized.description,
        scopes: normalized.scopes,
        tags: normalized.tags,
      }),
    },
    context,
    fetcher,
    "candidate creation",
    true,
  );
  if (!result.response.ok) {
    if (result.response.status >= 500) {
      throw new Error(
        `Tailscale candidate creation outcome is ambiguous (HTTP ${result.response.status}); reconcile before retrying`,
      );
    }
    throw statusError("candidate creation", result.response);
  }
  let provider: z.infer<typeof ProviderKeySchema>;
  try {
    provider = ProviderKeySchema.parse(JSON.parse(result.body));
    if (provider.keyType !== "client") throw new Error("wrong type");
  } catch {
    throw new Error(
      "Tailscale candidate creation returned an invalid redacted response; reconcile before retrying",
    );
  }
  const safe = {
    requestId: normalized.requestId,
    id: provider.id,
    keyType: "client" as const,
    description: provider.description,
    scopes: provider.scopes,
    tags: provider.tags ?? [],
    created: provider.created,
    updated: provider.updated ?? provider.created,
    userId: provider.userId ?? "",
    status: provider.invalid || provider.revoked
      ? "revoked" as const
      : "active" as const,
  };
  let credentialHandle: unknown;
  try {
    credentialHandle = await context.writeResource(
      "candidateCredential",
      credentialName(normalized.requestId),
      { clientId: provider.id, clientSecret: provider.key },
    );
  } catch {
    throw new Error(
      "Candidate was created but vaulted credential write failed; reconcile manually and do not retry",
    );
  }
  let metadataHandle: unknown;
  try {
    metadataHandle = await context.writeResource(
      "candidateMetadata",
      candidateName(normalized.requestId),
      safe,
    );
  } catch {
    throw new Error(
      "Candidate credential was vaulted but metadata write failed; reconcile manually and do not retry",
    );
  }
  let attemptHandle: unknown;
  try {
    attemptHandle = await context.writeResource(
      "candidateCreationAttempt",
      creationAttemptName(normalized.requestId),
      { ...attempted, state: "completed", candidateId: provider.id },
    );
  } catch {
    throw new Error(
      "Candidate metadata and credential were stored but creation journal completion failed; retry only to reconcile locally",
    );
  }
  context.logger.info("Candidate creation completed", {
    requestId: normalized.requestId,
    candidateId: provider.id,
  });
  return { dataHandles: [credentialHandle, metadataHandle, attemptHandle] };
}

/** Verifies a candidate against all of its configured scopes and tags. */
export async function verifyCandidate(
  args: { requestId: string },
  context: Context,
  fetcher: FetchLike = fetch,
) {
  context.logger.info("Candidate verification entered", {
    requestId: args.requestId,
  });
  const metadata = await read(
    context,
    candidateName(args.requestId),
    CandidateMetadataSchema,
  );
  const credential = await read(
    context,
    credentialName(args.requestId),
    CandidateCredentialSchema,
  );
  if (
    !metadata || metadata.requestId !== args.requestId || !credential ||
    metadata.id !== credential.clientId || metadata.status !== "active"
  ) {
    throw new Error(
      "Matching active candidate metadata and vaulted credential are required",
    );
  }
  const issued = await token(
    credential.clientId,
    credential.clientSecret,
    metadata.scopes,
    metadata.tags,
    context,
    fetcher,
  );
  const receipt = {
    requestId: args.requestId,
    verifiedAt: now(),
    requestedScopes: metadata.scopes,
    requestedTags: metadata.tags,
    grantedScope: issued.scope ?? null,
    tokenType: "Bearer" as const,
    expiresIn: issued.expires_in,
  };
  const handle = await context.writeResource(
    "verificationReceipt",
    verificationName(args.requestId),
    receipt,
  );
  context.logger.info("Candidate verification completed", {
    requestId: args.requestId,
    candidateId: metadata.id,
  });
  return { dataHandles: [handle] };
}
async function prerequisites(
  args: z.infer<typeof CandidateRef>,
  context: Context,
) {
  const metadata = await read(
    context,
    candidateName(args.candidateRequestId),
    CandidateMetadataSchema,
  );
  const verification = await read(
    context,
    verificationName(args.candidateRequestId),
    VerificationSchema,
  );
  if (
    !metadata || metadata.requestId !== args.candidateRequestId ||
    metadata.id !== args.candidateId || metadata.status !== "active"
  ) throw new Error("Matching active candidate metadata is required");
  if (
    !verification || verification.requestId !== args.candidateRequestId ||
    !same(verification.requestedScopes, metadata.scopes) ||
    !same(verification.requestedTags, metadata.tags)
  ) {
    throw new Error(
      "Matching full-scope candidate verification receipt is required",
    );
  }
  return { metadata, verification };
}
async function recordCutover(
  args: z.infer<typeof CandidateRef> & {
    evidence: string[];
    confirmation: string;
  },
  context: Context,
) {
  const base = {
    requestId: args.requestId,
    candidateRequestId: args.candidateRequestId,
    candidateId: args.candidateId,
    evidence: args.evidence,
  };
  context.logger.info("Cutover recording entered", {
    requestId: args.requestId,
    candidateId: args.candidateId,
  });
  const existing = await read(
    context,
    cutoverName(args.requestId),
    CutoverSchema,
  );
  if (existing) {
    const { verification } = await prerequisites(args, context);
    if (
      same({
        requestId: existing.requestId,
        candidateRequestId: existing.candidateRequestId,
        candidateId: existing.candidateId,
        evidence: existing.evidence,
      }, base) && existing.verificationVerifiedAt === verification.verifiedAt
    ) return { dataHandles: [] };
    throw new Error(
      "Cutover request ID is already bound to conflicting or stale evidence, verification, or candidate identity",
    );
  }
  const preview = await read(
    context,
    `cutover-preview-${args.requestId}`,
    CutoverPreviewSchema,
  );
  if (
    !preview || preview.confirmation !== args.confirmation ||
    args.confirmation !== await confirmation("record-cutover", base) ||
    !same({
      requestId: preview.requestId,
      candidateRequestId: preview.candidateRequestId,
      candidateId: preview.candidateId,
      evidence: preview.evidence,
    }, base)
  ) {
    throw new Error(
      "Confirmation does not match the exact persisted cutover preview",
    );
  }
  const { verification } = await prerequisites(args, context);
  const value = {
    ...base,
    recordedAt: now(),
    verificationVerifiedAt: verification.verifiedAt,
  };
  const handle = await context.writeResource(
    "cutoverReceipt",
    cutoverName(args.requestId),
    value,
  );
  context.logger.info("Cutover recording completed", {
    requestId: args.requestId,
  });
  return { dataHandles: [handle] };
}
async function requireCutover(
  args: z.infer<typeof CandidateRef>,
  context: Context,
) {
  const { metadata, verification } = await prerequisites(args, context);
  const cutover = await read(
    context,
    cutoverName(args.requestId),
    CutoverSchema,
  );
  if (
    !cutover || cutover.requestId !== args.requestId ||
    cutover.candidateRequestId !== args.candidateRequestId ||
    cutover.candidateId !== args.candidateId ||
    cutover.verificationVerifiedAt !== verification.verifiedAt
  ) {
    throw new Error(
      "Matching cutover receipt with current embedded identities is required",
    );
  }
  return { metadata, verification, cutover };
}

/** Revalidates the candidate and safely revokes one exact previous OAuth client. */
export async function revokePrevious(
  args: z.infer<typeof RevokeRequest> & { confirmation: string },
  context: Context,
  fetcher: FetchLike = fetch,
) {
  const normalized = toRevokeRequest(args);
  context.logger.info("Previous-client revocation entered", {
    requestId: normalized.requestId,
    candidateId: normalized.candidateId,
    previousClientId: normalized.previousClientId,
  });
  if (normalized.previousClientId === normalized.candidateId) {
    throw new Error("Refusing to revoke the candidate client itself");
  }
  const hash = await sha256(normalized);
  const receipt = await read(
    context,
    revocationName(normalized.requestId),
    RevocationSchema,
  );
  const attempt = await read(
    context,
    revocationAttemptName(normalized.requestId),
    RevocationAttemptSchema,
  );
  if (receipt) {
    if (
      !same(toRevokeRequest(receipt), normalized) ||
      (attempt &&
        (attempt.requestId !== normalized.requestId ||
          attempt.request.requestId !== normalized.requestId ||
          attempt.requestHash !== hash || !same(attempt.request, normalized) ||
          (attempt.providerStatus &&
            attempt.providerStatus !== receipt.providerStatus)))
    ) {
      throw new Error(
        "Revocation request ID has a conflicting receipt or attempt",
      );
    }
    if (attempt?.state === "attempted") {
      try {
        const h = await context.writeResource(
          "revocationAttempt",
          revocationAttemptName(normalized.requestId),
          {
            ...attempt,
            state: "completed",
            providerStatus: receipt.providerStatus,
          },
        );
        return { dataHandles: [h] };
      } catch {
        return { dataHandles: [] };
      }
    }
    return { dataHandles: [] };
  }
  if (attempt) {
    throw new Error(
      attempt.requestId === normalized.requestId &&
        attempt.request.requestId === normalized.requestId &&
        attempt.requestHash === hash && same(attempt.request, normalized)
        ? "Revocation attempt has no completed receipt; reconcile provider state before retrying"
        : "Revocation request ID is already bound to a different target",
    );
  }
  const { metadata: candidateMetadata } = await requireCutover(
    normalized,
    context,
  );
  const preview = await read(
    context,
    `revoke-preview-${normalized.requestId}`,
    RevokePreviewSchema,
  );
  if (
    !preview || preview.confirmation !== args.confirmation ||
    args.confirmation !== await confirmation("revoke-previous", normalized) ||
    !same(toRevokeRequest(preview), normalized)
  ) {
    throw new Error(
      "Confirmation does not match the exact persisted revocation preview",
    );
  }
  const credential = await read(
    context,
    credentialName(normalized.candidateRequestId),
    CandidateCredentialSchema,
  );
  if (!credential || candidateMetadata.id !== credential.clientId) {
    throw new Error(
      "Matching candidate credential is required for revocation preflight",
    );
  }
  await token(
    credential.clientId,
    credential.clientSecret,
    candidateMetadata.scopes,
    candidateMetadata.tags,
    context,
    fetcher,
  );
  const readBearer = await managerToken(context, fetcher, "oauth_keys:read");
  const candidateLive = await getKey(
    normalized.candidateId,
    readBearer,
    context,
    fetcher,
    "candidate preflight",
  );
  if (
    !candidateLive || candidateLive.keyType !== "client" ||
    candidateLive.invalid || candidateLive.revoked
  ) {
    throw new Error(
      "Candidate is missing, inactive, revoked, or not an OAuth client; revocation aborted",
    );
  }
  const previousLive = await getKey(
    normalized.previousClientId,
    readBearer,
    context,
    fetcher,
    "previous-client preflight",
  );
  if (previousLive && previousLive.keyType !== "client") {
    throw new Error("Previous target exists but is not an OAuth client");
  }
  if (!previousLive || previousLive.invalid || previousLive.revoked) {
    const value = {
      ...normalized,
      revokedAt: now(),
      providerStatus: "already-missing" as const,
    };
    const h = await context.writeResource(
      "revocationReceipt",
      revocationName(normalized.requestId),
      value,
    );
    return { dataHandles: [h] };
  }
  const deleteBearer = await managerToken(context, fetcher, "oauth_keys");
  const attempted = {
    requestId: normalized.requestId,
    request: normalized,
    requestHash: hash,
    attemptedAt: now(),
    state: "attempted" as const,
  };
  try {
    await context.writeResource(
      "revocationAttempt",
      revocationAttemptName(normalized.requestId),
      attempted,
    );
  } catch {
    throw new Error(
      "Could not persist revocation attempt marker; DELETE was not sent",
    );
  }
  const result = await request(
    `${KEYS_PATH}/${encodeURIComponent(normalized.previousClientId)}`,
    {
      method: "DELETE",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${deleteBearer}`,
      },
    },
    context,
    fetcher,
    "previous-client revocation",
    true,
  );
  if (!result.response.ok && result.response.status !== 404) {
    if (result.response.status >= 500) {
      throw new Error(
        `Tailscale revocation outcome is ambiguous (HTTP ${result.response.status}); reconcile before retrying`,
      );
    }
    throw statusError("previous-client revocation", result.response);
  }
  const providerStatus = result.response.status === 404
    ? "already-missing" as const
    : "deleted" as const;
  const value = { ...normalized, revokedAt: now(), providerStatus };
  let receiptHandle: unknown;
  try {
    receiptHandle = await context.writeResource(
      "revocationReceipt",
      revocationName(normalized.requestId),
      value,
    );
  } catch {
    throw new Error(
      "Previous client may be revoked but revocation receipt write failed; reconcile manually and do not retry",
    );
  }
  let attemptHandle: unknown;
  try {
    attemptHandle = await context.writeResource(
      "revocationAttempt",
      revocationAttemptName(normalized.requestId),
      { ...attempted, state: "completed", providerStatus },
    );
  } catch {
    throw new Error(
      "Revocation receipt was stored but journal completion failed; reconcile locally before retrying",
    );
  }
  context.logger.info("Previous-client revocation completed", {
    requestId: normalized.requestId,
    previousClientId: normalized.previousClientId,
  });
  return { dataHandles: [receiptHandle, attemptHandle] };
}

/** Refreshes non-secret candidate metadata from the fixed Tailscale API. */
export async function syncCandidate(
  args: { requestId: string },
  context: Context,
  fetcher: FetchLike = fetch,
) {
  context.logger.info("Candidate sync entered", { requestId: args.requestId });
  const stored = await read(
    context,
    candidateName(args.requestId),
    CandidateMetadataSchema,
  );
  if (!stored || stored.requestId !== args.requestId) {
    throw new Error("Matching candidate metadata is required before sync");
  }
  const bearer = await managerToken(context, fetcher, "oauth_keys:read");
  const live = await getKey(
    stored.id,
    bearer,
    context,
    fetcher,
    "candidate sync",
  );
  const syncedAt = now();
  const refreshed = !live
    ? { ...stored, status: "missing" as const, syncedAt }
    : (() => {
      if (live.keyType !== "client") {
        throw new Error("Tailscale candidate sync returned another key type");
      }
      return {
        requestId: args.requestId,
        id: live.id,
        keyType: "client" as const,
        description: live.description,
        scopes: live.scopes,
        tags: live.tags ?? [],
        created: live.created,
        updated: live.updated ?? live.created,
        userId: live.userId ?? "",
        status: live.invalid || live.revoked
          ? "revoked" as const
          : "active" as const,
        syncedAt,
      };
    })();
  const handle = await context.writeResource(
    "candidateMetadata",
    candidateName(args.requestId),
    refreshed,
  );
  context.logger.info("Candidate sync completed", {
    requestId: args.requestId,
    candidateId: stored.id,
    status: refreshed.status,
  });
  return { dataHandles: [handle] };
}

/** Public Swamp model for receipt-gated Tailscale OAuth client replacement. */
export const model = {
  type: "@mgreten/tailscale-oauth-client",
  version: "2026.07.29.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    createPreview: {
      description: "Bound candidate-creation preview",
      schema: PreviewSchema,
      lifetime: "7d",
      garbageCollection: 3,
    },
    candidateCreationAttempt: {
      description: "Durable non-secret creation journal",
      schema: CreationAttemptSchema,
      lifetime: "infinite",
      garbageCollection: 52,
    },
    candidateMetadata: {
      description: "Non-secret candidate OAuth-client state",
      schema: CandidateMetadataSchema,
      lifetime: "infinite",
      garbageCollection: 52,
    },
    candidateCredential: {
      description: "Vaulted one-time candidate credential",
      schema: CandidateCredentialSchema,
      sensitiveOutput: true,
      lifetime: "infinite",
      garbageCollection: 1,
    },
    verificationReceipt: {
      description: "Non-secret OAuth issuance verification",
      schema: VerificationSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    cutoverPreview: {
      description: "Bound non-secret cutover preview",
      schema: CutoverPreviewSchema,
      lifetime: "7d",
      garbageCollection: 3,
    },
    cutoverReceipt: {
      description: "Operator-recorded cutover evidence",
      schema: CutoverSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    revokePreview: {
      description: "Bound irreversible-revocation preview",
      schema: RevokePreviewSchema,
      lifetime: "7d",
      garbageCollection: 3,
    },
    revocationAttempt: {
      description: "Durable non-secret revocation journal",
      schema: RevocationAttemptSchema,
      lifetime: "infinite",
      garbageCollection: 52,
    },
    revocationReceipt: {
      description: "Non-secret prior-client revocation receipt",
      schema: RevocationSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  checks: {
    "fixed-secure-origin": {
      description: "Require bounded vaulted manager credentials and timeout",
      labels: ["policy"],
      appliesTo: ["createCandidate", "revokePrevious"],
      execute: (ctx: { globalArgs: unknown }) =>
        GlobalArgsSchema.safeParse(ctx.globalArgs).success ? { pass: true } : {
          pass: false,
          errors: ["Invalid manager credential configuration or timeout"],
        },
    },
    "tailscale-live-mutation": {
      description: "Label live Tailscale mutations",
      labels: ["live"],
      appliesTo: ["createCandidate", "revokePrevious"],
      execute: () => ({ pass: true }),
    },
  },
  methods: {
    previewCreate: {
      description: "Persist a no-network candidate preview",
      arguments: CreateRequest,
      execute: async (args: z.infer<typeof CreateRequest>, ctx: Context) => {
        const normalized = toCreateRequest(args);
        ctx.logger.info("Candidate preview entered", {
          requestId: normalized.requestId,
        });
        const value = {
          ...normalized,
          confirmation: await confirmation("create-candidate", normalized),
          warning:
            "Creation is journaled. Reconcile any attempted state rather than repeating the provider mutation.",
        };
        const h = await ctx.writeResource(
          "createPreview",
          `create-preview-${normalized.requestId}`,
          value,
        );
        ctx.logger.info("Candidate preview completed", {
          requestId: normalized.requestId,
        });
        return { dataHandles: [h] };
      },
    },
    createCandidate: {
      description: "Create and vault one exactly journaled candidate",
      arguments: CreateRequest.extend({ confirmation: Confirmation }),
      execute: createCandidate,
    },
    verifyCandidate: {
      description: "Verify full configured candidate OAuth issuance",
      arguments: z.object({ requestId: RequestId }),
      execute: verifyCandidate,
    },
    previewCutover: {
      description: "Preview recording verified operator cutover evidence",
      arguments: CandidateRef.extend({ evidence: Evidence }),
      execute: async (
        args: z.infer<typeof CandidateRef> & { evidence: string[] },
        ctx: Context,
      ) => {
        await prerequisites(args, ctx);
        const value = {
          ...args,
          confirmation: await confirmation("record-cutover", args),
          warning: "Records evidence only; it does not deploy credentials.",
        };
        const h = await ctx.writeResource(
          "cutoverPreview",
          `cutover-preview-${args.requestId}`,
          value,
        );
        return { dataHandles: [h] };
      },
    },
    recordCutover: {
      description: "Persist immutable verified cutover evidence",
      arguments: CandidateRef.extend({
        evidence: Evidence,
        confirmation: Confirmation,
      }),
      execute: recordCutover,
    },
    previewRevoke: {
      description: "Preview exact irreversible prior-client revocation",
      arguments: RevokeRequest,
      execute: async (args: z.infer<typeof RevokeRequest>, ctx: Context) => {
        const normalized = toRevokeRequest(args);
        if (normalized.previousClientId === normalized.candidateId) {
          throw new Error("Refusing to revoke the candidate client itself");
        }
        await requireCutover(normalized, ctx);
        const existing = await read(
          ctx,
          revocationName(normalized.requestId),
          RevocationSchema,
        );
        if (existing && !same(toRevokeRequest(existing), normalized)) {
          throw new Error(
            "Revocation request ID is already bound to a different target",
          );
        }
        const value = {
          ...normalized,
          confirmation: await confirmation("revoke-previous", normalized),
          warning:
            "IRREVERSIBLE: verify all consumers use the candidate first.",
        };
        const h = await ctx.writeResource(
          "revokePreview",
          `revoke-preview-${normalized.requestId}`,
          value,
        );
        return { dataHandles: [h] };
      },
    },
    revokePrevious: {
      description: "Preflight and journal exact previous-client revocation",
      arguments: RevokeRequest.extend({ confirmation: Confirmation }),
      execute: revokePrevious,
    },
    syncCandidate: {
      description: "Refresh candidate metadata or provider absence",
      arguments: z.object({ requestId: RequestId }),
      execute: syncCandidate,
    },
  },
};
