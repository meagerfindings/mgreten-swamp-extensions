import {
  CandidateCredentialSchema,
  createCandidate,
  GlobalArgsSchema,
  model,
  revokePrevious,
  syncCandidate,
  verifyCandidate,
} from "./model.ts";

const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const base = {
  requestId: "candidate-0001",
  description: "replacement client",
  scopes: ["oauth_keys:read"],
  tags: [] as string[],
};
const metadata = {
  requestId: base.requestId,
  id: "candidate-id",
  keyType: "client",
  description: base.description,
  scopes: base.scopes,
  tags: base.tags,
  created: "2026-07-30T00:00:00Z",
  updated: "2026-07-30T00:00:00Z",
  userId: "user-id",
  status: "active",
};
const provider = (id: string, extra = {}) => ({
  id,
  keyType: "client",
  description: "replacement client",
  created: "2026-07-30T00:00:00Z",
  updated: "2026-07-30T00:00:00Z",
  scopes: base.scopes,
  tags: base.tags,
  userId: "user-id",
  ...extra,
});
const tokenResponse = (extra = {}) =>
  new Response(
    JSON.stringify({
      access_token: "ACCESS-SECRET",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "oauth_keys:read",
      ...extra,
    }),
    { status: 200 },
  );
const tokenScope = (init: RequestInit) => {
  const body = new URLSearchParams(String(init.body));
  const clientId = body.get("client_id");
  const scope = body.get("scope");
  return (clientId === "manager-id" || clientId === refs.previousClientId) &&
      (scope === "oauth_keys" || scope === "oauth_keys:read")
    ? scope
    : null;
};
async function hash(value: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function harness(
  seed: Record<string, unknown> = {},
  fail?: (spec: string, name: string) => boolean,
  signal?: AbortSignal,
) {
  const stored = new Map(Object.entries(seed));
  const writes: Array<{ spec: string; name: string; value: unknown }> = [];
  const logs: unknown[] = [];
  return {
    stored,
    writes,
    logs,
    context: {
      signal,
      globalArgs: {
        managerClientId: "manager-id",
        managerClientSecret: "MANAGER-SECRET",
        timeoutSeconds: 10,
      },
      logger: {
        info: (message: string, properties?: Record<string, unknown>) =>
          logs.push({ message, properties }),
      },
      readResource: (name: string) => Promise.resolve(stored.get(name) ?? null),
      writeResource: (spec: string, name: string, value: unknown) => {
        if (fail?.(spec, name)) {
          return Promise.reject(new Error("storage secret detail"));
        }
        writes.push({ spec, name, value });
        stored.set(name, value);
        return Promise.resolve({ spec, name });
      },
    },
  };
}
async function preview(h: ReturnType<typeof harness>, value = base) {
  await model.methods.previewCreate.execute(value, h.context);
  return (h.stored.get(`create-preview-${value.requestId}`) as {
    confirmation: string;
  }).confirmation;
}
async function expectError(fn: () => Promise<unknown>, text: string) {
  try {
    await fn();
    throw new Error("expected rejection");
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes(text),
      `expected error containing ${text}, got ${error}`,
    );
    return String(error);
  }
}
const verification = (overrides = {}) => ({
  requestId: base.requestId,
  candidateId: metadata.id,
  verifiedAt: "2026-07-30T01:00:00Z",
  requestedScopes: base.scopes,
  requestedTags: base.tags,
  grantedScope: "oauth_keys:read",
  tokenType: "Bearer",
  expiresIn: 3600,
  ...overrides,
});
const refs = {
  requestId: "revoke-0001",
  candidateRequestId: base.requestId,
  candidateId: metadata.id,
  previousClientId: "previous-id",
};
function ready(extra: Record<string, unknown> = {}) {
  return harness({
    [`candidate-${base.requestId}`]: metadata,
    [`candidate-credential-${base.requestId}`]: {
      clientId: metadata.id,
      clientSecret: "CANDIDATE-SECRET",
    },
    [`verification-${base.requestId}`]: verification(),
    [`cutover-${refs.requestId}`]: {
      requestId: refs.requestId,
      candidateRequestId: base.requestId,
      candidateId: metadata.id,
      evidence: ["done"],
      recordedAt: "2026-07-30T02:00:00Z",
      verificationVerifiedAt: "2026-07-30T01:00:00Z",
    },
    ...extra,
  });
}
async function revokePreview(h: ReturnType<typeof harness>, value = refs) {
  await model.methods.previewRevoke.execute(value, h.context);
  return (h.stored.get(`revoke-preview-${value.requestId}`) as {
    confirmation: string;
  }).confirmation;
}

Deno.test("contracts are strict, bounded, tag-aware, and sensitive", () => {
  assert(
    !model.methods.previewCreate.arguments.safeParse({
      ...base,
      description: "bad!",
    }).success,
    "official description characters",
  );
  assert(
    !model.methods.previewCreate.arguments.safeParse({
      ...base,
      description: "x".repeat(51),
    }).success,
    "description max 50",
  );
  assert(
    !model.methods.previewCreate.arguments.safeParse({
      ...base,
      scopes: ["devices:core"],
    }).success,
    "devices tags mandatory",
  );
  assert(
    model.methods.previewCreate.arguments.safeParse({
      ...base,
      scopes: ["all"],
    }).success,
    "all does not require tags",
  );
  assert(
    !model.methods.verifyCandidate.arguments.safeParse({
      requestId: base.requestId,
      requestedScopes: [],
    }).success,
    "subset options removed",
  );
  assert(
    GlobalArgsSchema.shape.managerClientSecret.meta()?.sensitive &&
      CandidateCredentialSchema.shape.clientSecret.meta()?.sensitive &&
      model.resources.candidateCredential.sensitiveOutput,
    "secrets marked",
  );
  assert(
    model.resources.candidateCreationAttempt.lifetime === "infinite" &&
      model.resources.revocationAttempt.lifetime === "infinite",
    "journals durable",
  );
  assert(
    model.methods.createCandidate.arguments.safeParse({
      ...base,
      confirmation: `create-candidate:${"0".repeat(64)}`,
    }).success,
    "strict enriched create args accepted",
  );
  assert(
    model.methods.revokePrevious.arguments.safeParse({
      ...refs,
      confirmation: `revoke-previous:${"0".repeat(64)}`,
    }).success,
    "strict enriched revoke args accepted",
  );
});

Deno.test("creation journal is written after bearer and before POST; completed replay is zero-network", async () => {
  const h = harness();
  const confirmation = await preview(h);
  const events: string[] = [];
  const originalWrite = h.context.writeResource;
  h.context.writeResource = async (spec, name, value) => {
    events.push(`write:${spec}`);
    return await originalWrite(spec, name, value);
  };
  const fetcher = (url: string) => {
    events.push(url.endsWith("/oauth/token") ? "token" : "post");
    return Promise.resolve(
      url.endsWith("/oauth/token")
        ? tokenResponse({ scope: "oauth_keys" })
        : new Response(
          JSON.stringify({ ...provider(metadata.id), key: "CANDIDATE-SECRET" }),
          { status: 200 },
        ),
    );
  };
  await createCandidate({ ...base, confirmation }, h.context, fetcher);
  await createCandidate(
    { ...base, confirmation },
    h.context,
    () => Promise.reject(new Error("network forbidden")),
  );
  assert(
    events.indexOf("token") <
        events.indexOf("write:candidateCreationAttempt") &&
      events.indexOf("write:candidateCreationAttempt") < events.indexOf("post"),
    "journal ordering",
  );
  assert(
    (h.stored.get(`candidate-creation-attempt-${base.requestId}`) as {
      state: string;
    }).state === "completed",
    "completed journal",
  );
});

Deno.test("ambiguous creation blocks retry and changed input reuse", async () => {
  const h = harness();
  const confirmation = await preview(h);
  let posts = 0;
  await expectError(
    () =>
      createCandidate(
        { ...base, confirmation },
        h.context,
        (url) =>
          url.endsWith("/oauth/token")
            ? Promise.resolve(tokenResponse({ scope: "oauth_keys" }))
            : (posts++,
              Promise.reject(new DOMException("lost", "NetworkError"))),
      ),
    "ambiguous",
  );
  await expectError(
    () =>
      createCandidate({ ...base, confirmation }, h.context, () => {
        posts++;
        return Promise.resolve(tokenResponse());
      }),
    "reconcile",
  );
  assert(posts === 1, "no second POST");
  const changed = { ...base, description: "different client" };
  const changedConfirmation = await preview(h, changed);
  await expectError(
    () =>
      createCandidate(
        { ...changed, confirmation: changedConfirmation },
        h.context,
      ),
    "different creation inputs",
  );
});

Deno.test("marker, credential, and metadata write failures are distinct and redacted", async () => {
  for (
    const [failedSpec, expected] of [
      ["candidateCreationAttempt", "POST was not sent"],
      ["candidateCredential", "vaulted credential write failed"],
      ["candidateMetadata", "metadata write failed"],
    ] as const
  ) {
    const h = harness({}, (spec) => spec === failedSpec);
    const confirmation = await preview(h);
    let posts = 0;
    const error = await expectError(
      () =>
        createCandidate(
          { ...base, confirmation },
          h.context,
          (url) =>
            Promise.resolve(
              url.endsWith("/oauth/token")
                ? tokenResponse({ scope: "oauth_keys" })
                : (posts++,
                  new Response(
                    JSON.stringify({ ...provider(metadata.id), key: "SECRET" }),
                    { status: 200 },
                  )),
            ),
        ),
      expected,
    );
    assert(!error.includes("storage secret detail"), "storage errors redacted");
    if (failedSpec === "candidateCreationAttempt") {
      assert(posts === 0, "marker blocks POST");
    }
    if (failedSpec !== "candidateCreationAttempt") {
      await expectError(
        () =>
          createCandidate({ ...base, confirmation }, h.context, () => {
            posts++;
            return Promise.reject(new Error("network forbidden"));
          }),
        "ambiguous or incomplete",
      );
      assert(posts === 1, "partial state prevents a second provider POST");
    }
  }
});

Deno.test("oversized and invalid creation responses remain ambiguous and do not repost", async () => {
  for (
    const response of [
      new Response("x".repeat(64 * 1024 + 1), { status: 200 }),
      new Response(
        JSON.stringify({ id: metadata.id, keyType: "client", key: "SECRET" }),
        { status: 200 },
      ),
    ]
  ) {
    const h = harness();
    const confirmation = await preview(h);
    let posts = 0;
    await expectError(
      () =>
        createCandidate(
          { ...base, confirmation },
          h.context,
          (url) =>
            Promise.resolve(
              url.endsWith("/oauth/token")
                ? tokenResponse({ scope: "oauth_keys" })
                : (posts++, response),
            ),
        ),
      "reconcile",
    );
    await expectError(
      () =>
        createCandidate({ ...base, confirmation }, h.context, () => {
          posts++;
          return Promise.reject(new Error("network forbidden"));
        }),
      "reconcile",
    );
    assert(posts === 1, "ambiguous response prevents second POST");
  }
});

Deno.test("metadata-only, credential-only, mismatched IDs, and missing journal block creation", async () => {
  for (
    const seed of [{ [`candidate-${base.requestId}`]: metadata }, {
      [`candidate-credential-${base.requestId}`]: {
        clientId: metadata.id,
        clientSecret: "SECRET",
      },
    }, {
      [`candidate-${base.requestId}`]: metadata,
      [`candidate-credential-${base.requestId}`]: {
        clientId: "other-id",
        clientSecret: "SECRET",
      },
    }]
  ) {
    const h = harness(seed);
    const confirmation = await preview(h);
    let calls = 0;
    await expectError(
      () =>
        createCandidate({ ...base, confirmation }, h.context, () => {
          calls++;
          return Promise.resolve(tokenResponse());
        }),
      "without its creation journal",
    );
    assert(calls === 0, "no network");
  }
});

Deno.test("verification uses full scope and tags, accepts omitted scope and extras, and rejects missing grant", async () => {
  const tagged = {
    ...metadata,
    scopes: ["auth_keys", "devices:core"],
    tags: ["tag:core"],
  };
  const h = harness({
    [`candidate-${base.requestId}`]: tagged,
    [`candidate-credential-${base.requestId}`]: {
      clientId: metadata.id,
      clientSecret: "SECRET",
    },
  });
  let body = "";
  await verifyCandidate(
    { requestId: base.requestId },
    h.context,
    (_url, init) => {
      body = String(init.body);
      return Promise.resolve(tokenResponse({
        scope: undefined,
        token_type: "bEaReR",
        tags: ["safe-extra"],
        unknown: true,
      }));
    },
  );
  assert(
    body.includes("scope=auth_keys+devices%3Acore") &&
      body.includes("tags=tag%3Acore"),
    "full configured grant requested",
  );
  const receipt = h.writes.at(-1)!.value as {
    grantedScope: unknown;
    requestedScopes: string[];
  };
  assert(
    receipt.grantedScope === null && receipt.requestedScopes.length === 2 &&
      !JSON.stringify(receipt).includes("ACCESS-SECRET"),
    "safe receipt",
  );
  await expectError(
    () =>
      verifyCandidate(
        { requestId: base.requestId },
        h.context,
        () => Promise.resolve(tokenResponse({ scope: "auth_keys" })),
      ),
    "does not cover",
  );
});

Deno.test("identity mismatches and stale embedded cutover identity are rejected", async () => {
  const badMetadata = ready({
    [`candidate-${base.requestId}`]: {
      ...metadata,
      requestId: "candidate-wrong",
    },
  });
  await expectError(
    () =>
      model.methods.previewCutover.execute({
        requestId: refs.requestId,
        candidateRequestId: base.requestId,
        candidateId: metadata.id,
        evidence: ["done"],
      }, badMetadata.context),
    "metadata",
  );
  const badVerification = ready({
    [`verification-${base.requestId}`]: verification({
      requestId: "candidate-wrong",
    }),
  });
  await expectError(
    () =>
      model.methods.previewCutover.execute({
        requestId: refs.requestId,
        candidateRequestId: base.requestId,
        candidateId: metadata.id,
        evidence: ["done"],
      }, badVerification.context),
    "verification",
  );
  const stale = ready({
    [`cutover-${refs.requestId}`]: {
      requestId: refs.requestId,
      candidateRequestId: base.requestId,
      candidateId: metadata.id,
      evidence: ["done"],
      recordedAt: "2026-07-30T02:00:00Z",
      verificationVerifiedAt: "2026-07-30T00:00:01Z",
    },
  });
  await expectError(
    () => model.methods.previewRevoke.execute(refs, stale.context),
    "embedded identities",
  );
});

Deno.test("cutover and revocation request IDs are immutable and exact receipts replay locally", async () => {
  const h = ready();
  const receipt = {
    ...refs,
    revokedAt: "2026-07-30T03:00:00Z",
    providerStatus: "already-missing",
  };
  h.stored.set(`revocation-${refs.requestId}`, receipt);
  let calls = 0;
  await revokePrevious(
    { ...refs, confirmation: `revoke-previous:${"0".repeat(64)}` },
    h.context,
    () => {
      calls++;
      return Promise.resolve(tokenResponse());
    },
  );
  assert(calls === 0, "receipt replay before prerequisites/network");
  await expectError(
    () =>
      revokePrevious({
        ...refs,
        previousClientId: "different-id",
        confirmation: `revoke-previous:${"0".repeat(64)}`,
      }, h.context),
    "conflicting receipt",
  );
});

Deno.test("revoke preflights candidate credential and exact provider IDs before DELETE", async () => {
  const h = ready();
  const confirmation = await revokePreview(h);
  const calls: string[] = [];
  await revokePrevious(
    { ...refs, confirmation },
    h.context,
    (url, init) => {
      calls.push(`${init.method}:${url}`);
      if (url.endsWith("/oauth/token")) {
        return Promise.resolve(tokenResponse({
          scope: tokenScope(init) ?? undefined,
        }));
      }
      if (init.method === "GET") {
        return Promise.resolve(
          new Response(
            JSON.stringify(provider(
              url.endsWith("candidate-id")
                ? metadata.id
                : refs.previousClientId,
            )),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("", { status: 200 }));
    },
  );
  assert(
    calls.some((v) =>
      v ===
        `DELETE:https://api.tailscale.com/api/v2/tailnet/-/keys/${refs.previousClientId}`
    ),
    "exact DELETE",
  );
  assert(
    h.writes.some((w) =>
      w.spec === "revocationAttempt" &&
      (w.value as { state: string }).state === "attempted"
    ),
    "attempt before delete",
  );
});

Deno.test("inactive candidate, wrong previous key type, and prior missing/revoked avoid DELETE", async () => {
  for (
    const mode of [
      "candidate-invalid",
      "previous-auth",
      "previous-404",
      "previous-revoked",
    ] as const
  ) {
    const h = ready();
    const confirmation = await revokePreview(h);
    let deletes = 0;
    const run = () =>
      revokePrevious(
        { ...refs, confirmation },
        h.context,
        (url, init) => {
          if (url.endsWith("/oauth/token")) {
            return Promise.resolve(
              tokenResponse({ scope: tokenScope(init) ?? undefined }),
            );
          }
          if (init.method === "DELETE") {
            deletes++;
            return Promise.resolve(new Response("", { status: 200 }));
          }
          const candidate = url.endsWith(metadata.id);
          if (!candidate && mode === "previous-404") {
            return Promise.resolve(new Response("", { status: 404 }));
          }
          return Promise.resolve(
            new Response(
              JSON.stringify(
                candidate
                  ? provider(
                    metadata.id,
                    mode === "candidate-invalid" ? { invalid: true } : {},
                  )
                  : mode === "previous-auth"
                  ? {
                    id: refs.previousClientId,
                    keyType: "auth",
                    capabilities: { devices: { create: { reusable: false } } },
                    created: "2026-07-30T00:00:00Z",
                    description: "real auth key",
                  }
                  : provider(
                    refs.previousClientId,
                    mode === "previous-revoked"
                      ? { revoked: "2026-07-30T00:00:00Z" }
                      : {},
                  ),
              ),
              { status: 200 },
            ),
          );
        },
      );
    if (mode === "candidate-invalid") await expectError(run, "inactive");
    else if (mode === "previous-auth") {
      await expectError(run, "not an OAuth client");
    } else {
      await run();
      assert(
        (h.writes.at(-1)!.value as { providerStatus: string })
          .providerStatus === "already-missing",
        "idempotent missing",
      );
    }
    assert(deletes === 0, "DELETE avoided");
  }
});

Deno.test("revocation attempt and receipt write failures prevent unsafe retries", async () => {
  for (
    const failedSpec of ["revocationAttempt", "revocationReceipt"] as const
  ) {
    const h = ready();
    const confirmation = await revokePreview(h);
    const original = h.context.writeResource;
    h.context.writeResource = (spec, name, value) =>
      spec === failedSpec
        ? Promise.reject(new Error("secret write detail"))
        : original(spec, name, value);
    let deletes = 0;
    const fetcher = (url: string, init: RequestInit) => {
      if (url.endsWith("/oauth/token")) {
        return Promise.resolve(tokenResponse({
          scope: tokenScope(init) ?? undefined,
        }));
      }
      if (init.method === "GET") {
        return Promise.resolve(
          new Response(
            JSON.stringify(
              provider(
                url.endsWith(metadata.id) ? metadata.id : refs.previousClientId,
              ),
            ),
            { status: 200 },
          ),
        );
      }
      deletes++;
      return Promise.resolve(new Response("", { status: 200 }));
    };
    const error = await expectError(
      () => revokePrevious({ ...refs, confirmation }, h.context, fetcher),
      failedSpec === "revocationAttempt"
        ? "DELETE was not sent"
        : "receipt write failed",
    );
    assert(!error.includes("secret write detail"), "redacted");
    assert(
      deletes === (failedSpec === "revocationAttempt" ? 0 : 1),
      "delete ordering",
    );
  }
});

Deno.test("manager equal to previous still mints bearer before delete", async () => {
  const h = ready();
  h.context.globalArgs.managerClientId = refs.previousClientId;
  const confirmation = await revokePreview(h);
  const sequence: string[] = [];
  await revokePrevious(
    { ...refs, confirmation },
    h.context,
    (url, init) => {
      sequence.push(
        url.endsWith("/oauth/token")
          ? `token:${tokenScope(init)}`
          : `${init.method}:${url}`,
      );
      if (url.endsWith("/oauth/token")) {
        return Promise.resolve(tokenResponse({
          scope: tokenScope(init) ?? undefined,
        }));
      }
      if (init.method === "GET") {
        return Promise.resolve(
          new Response(
            JSON.stringify(
              provider(
                url.endsWith(metadata.id) ? metadata.id : refs.previousClientId,
              ),
            ),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("", { status: 200 }));
    },
  );
  const deleteIndex = sequence.findIndex((v) => v.startsWith("DELETE:"));
  assert(
    sequence.slice(0, deleteIndex).includes("token:oauth_keys"),
    "manager mutation bearer acquired first",
  );
});

Deno.test("receipt reconciles a failed completion write locally with zero network", async () => {
  const h = ready();
  const confirmation = await revokePreview(h);
  const original = h.context.writeResource;
  let attemptWrites = 0;
  h.context.writeResource = (spec, name, value) =>
    spec === "revocationAttempt" && ++attemptWrites === 2
      ? Promise.reject(new Error("completion failed"))
      : original(spec, name, value);
  const fetcher = (url: string, init: RequestInit) => {
    if (url.endsWith("/oauth/token")) {
      return Promise.resolve(
        tokenResponse({ scope: tokenScope(init) ?? undefined }),
      );
    }
    if (init.method === "GET") {
      return Promise.resolve(
        new Response(
          JSON.stringify(
            provider(
              url.endsWith(metadata.id) ? metadata.id : refs.previousClientId,
            ),
          ),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response("", { status: 200 }));
  };
  await expectError(
    () => revokePrevious({ ...refs, confirmation }, h.context, fetcher),
    "journal completion failed",
  );
  await revokePrevious(
    { ...refs, confirmation },
    h.context,
    () => Promise.reject(new Error("network forbidden")),
  );
  assert(
    (h.stored.get(`revocation-attempt-${refs.requestId}`) as { state: string })
      .state === "completed",
    "receipt repaired attempted marker",
  );
});

Deno.test("mismatched provider GET identity blocks DELETE", async () => {
  const h = ready();
  const confirmation = await revokePreview(h);
  let deletes = 0;
  await expectError(
    () =>
      revokePrevious(
        { ...refs, confirmation },
        h.context,
        (url, init) => {
          if (url.endsWith("/oauth/token")) {
            return Promise.resolve(tokenResponse({
              scope: tokenScope(init) ?? undefined,
            }));
          }
          if (init.method === "DELETE") {
            deletes++;
            return Promise.resolve(new Response("", { status: 200 }));
          }
          return Promise.resolve(
            new Response(JSON.stringify(provider("wrong-provider-id")), {
              status: 200,
            }),
          );
        },
      ),
    "mismatched redacted metadata",
  );
  assert(deletes === 0, "identity mismatch avoids DELETE");
});

Deno.test("attempt envelope IDs and cutover replay verification timestamp are exact", async () => {
  const create = harness();
  const createConfirmation = await preview(create);
  const requestHash = await hash(base);
  create.stored.set(`candidate-creation-attempt-${base.requestId}`, {
    requestId: "wrong-request",
    request: base,
    requestHash,
    attemptedAt: "2026-07-30T00:00:00Z",
    state: "attempted",
  });
  await expectError(
    () =>
      createCandidate(
        { ...base, confirmation: createConfirmation },
        create.context,
        () => Promise.reject(new Error("network forbidden")),
      ),
    "different creation inputs",
  );
  const revoke = ready({
    [`revocation-attempt-${refs.requestId}`]: {
      requestId: refs.requestId,
      request: { ...refs, requestId: "wrong-request" },
      requestHash: await hash(refs),
      attemptedAt: "2026-07-30T00:00:00Z",
      state: "attempted",
    },
  });
  await expectError(
    () =>
      revokePrevious(
        { ...refs, confirmation: `revoke-previous:${"0".repeat(64)}` },
        revoke.context,
        () => Promise.reject(new Error("network forbidden")),
      ),
    "different target",
  );
  const stale = ready({
    [`cutover-${refs.requestId}`]: {
      requestId: refs.requestId,
      candidateRequestId: base.requestId,
      candidateId: metadata.id,
      evidence: ["done"],
      recordedAt: "2026-07-30T02:00:00Z",
      verificationVerifiedAt: "2026-07-30T00:00:01Z",
    },
  });
  await expectError(
    () =>
      model.methods.recordCutover.execute({
        requestId: refs.requestId,
        candidateRequestId: base.requestId,
        candidateId: metadata.id,
        evidence: ["done"],
        confirmation: `record-cutover:${"0".repeat(64)}`,
      }, stale.context),
    "stale",
  );
});

Deno.test("sync maps 404, invalid, and revoked timestamp and rejects another key type", async () => {
  for (
    const [response, expected] of [[
      new Response("", { status: 404 }),
      "missing",
    ], [
      new Response(JSON.stringify(provider(metadata.id, { invalid: true })), {
        status: 200,
      }),
      "revoked",
    ], [
      new Response(
        JSON.stringify(
          provider(metadata.id, { revoked: "2026-07-30T00:00:00Z" }),
        ),
        { status: 200 },
      ),
      "revoked",
    ]] as const
  ) {
    const h = harness({ [`candidate-${base.requestId}`]: metadata });
    let n = 0;
    await syncCandidate(
      { requestId: base.requestId },
      h.context,
      () => Promise.resolve(n++ === 0 ? tokenResponse() : response),
    );
    assert(
      (h.writes.at(-1)!.value as { status: string }).status === expected,
      `sync ${expected}`,
    );
  }
  const h = harness({ [`candidate-${base.requestId}`]: metadata });
  let n = 0;
  await expectError(
    () =>
      syncCandidate(
        { requestId: base.requestId },
        h.context,
        () =>
          Promise.resolve(
            n++ === 0 ? tokenResponse() : new Response(
              JSON.stringify(provider(metadata.id, { keyType: "auth" })),
              { status: 200 },
            ),
          ),
      ),
    "another key type",
  );
});

Deno.test("3xx is rejected and already-aborted context reaches fetch", async () => {
  const h = harness();
  const confirmation = await preview(h);
  let n = 0;
  await expectError(
    () =>
      createCandidate(
        { ...base, confirmation },
        h.context,
        () =>
          Promise.resolve(
            n++ === 0
              ? tokenResponse({ scope: "oauth_keys" })
              : new Response("redirect secret", { status: 302 }),
          ),
      ),
    "HTTP 302",
  );
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  const aborted = harness({}, undefined, controller.signal);
  const c = await preview(aborted);
  await expectError(
    () =>
      createCandidate(
        { ...base, confirmation: c },
        aborted.context,
        (_url, init) => {
          assert(init.signal?.aborted, "signal already aborted");
          return Promise.reject(new DOMException("cancelled", "AbortError"));
        },
      ),
    "AbortError",
  );
});

// The official createModelTestContext import is intentionally not added: no stable
// locally installed package/reference is available in this standalone repository.
