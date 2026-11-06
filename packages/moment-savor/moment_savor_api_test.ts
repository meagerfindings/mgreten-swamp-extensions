import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { model } from "./moment_savor_api.ts";

const BASE = "https://moments.example.com";
const FAKE_TOKEN = "fake-api-token";
const FAMILY = "11111111-1111-4111-8111-111111111111";
const MEM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const MEM_B = "aaaaaaaa-0000-4000-8000-000000000002";
const MEM_C = "aaaaaaaa-0000-4000-8000-000000000003";
const TOKEN_ID = "bbbbbbbb-0000-4000-8000-000000000001";
const MEMBER_ID = "cccccccc-0000-4000-8000-000000000001";
const USER_ID = "dddddddd-0000-4000-8000-000000000001";

function memory(id: string, title: string | null = `Memory ${id.slice(-1)}`) {
  return {
    id,
    family_id: FAMILY,
    created_by_user_id: null,
    title,
    transcript: null,
    notes: null,
    recorded_at: "2026-01-01T10:00:00Z",
    location_name: null,
    tags: ["park"],
    visibility: "visible",
    transcription_status: "completed",
    transcription_completed_at: null,
    ai_data: {},
    ai_extraction_status: "pending",
    ai_extraction_completed_at: null,
    created_at: "2026-01-01T10:00:00Z",
    updated_at: "2026-01-01T10:00:00Z",
    first_memory: false,
  };
}

const apiToken = {
  id: TOKEN_ID,
  name: "cli",
  scope: "read" as const,
  family_id: FAMILY,
  last_used_at: null,
  created_at: "2026-01-01T00:00:00Z",
};

const member = {
  id: MEMBER_ID,
  user_id: USER_ID,
  name: "Test Person",
  email: "person@example.com",
  role: "member",
  joined_at: null,
};

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

async function withFetch<T>(
  respond: (call: Call) => Response,
  fn: (calls: Call[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    return Promise.resolve(respond(call));
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function makeContext() {
  const writes: Array<{ name: string; instance: string; data: unknown }> = [];
  const logs: string[] = [];
  return {
    writes,
    logs,
    context: {
      globalArgs: model.globalArguments.parse({ apiToken: FAKE_TOKEN, baseUrl: BASE }),
      logger: { info: (msg: string) => logs.push(msg) },
      writeResource: (name: string, instance: string, data: unknown) => {
        writes.push({ name, instance, data });
        return Promise.resolve({ name: `${name}/${instance}` });
      },
    },
  };
}

Deno.test("global arguments require a token and default the base URL", () => {
  assertThrows(() => model.globalArguments.parse({}));
  assertEquals(model.globalArguments.parse({ apiToken: FAKE_TOKEN }), {
    apiToken: FAKE_TOKEN,
    baseUrl: "https://momentsavor.app",
  });
  assertThrows(() => model.globalArguments.parse({ apiToken: FAKE_TOKEN, baseUrl: "nope" }));
  assertThrows(() => model.methods.deleteMemory.arguments.parse({ id: "not-a-uuid" }));
  assertThrows(() => model.methods.sendInvitation.arguments.parse({ email: "bad" }));
  assertEquals(
    model.methods.sendInvitation.arguments.parse({ email: "a@example.com" }).role,
    "member",
  );
});

Deno.test("sync follows memory cursors, encodes query, and writes three snapshots", async () => {
  const { context, writes, logs } = makeContext();
  const result = await withFetch((call) => {
    const url = new URL(call.url);
    if (url.pathname === "/api/v1/memories") {
      if (!url.searchParams.has("cursor")) {
        return json({ data: [memory(MEM_A), memory(MEM_B)], meta: { next_cursor: "c/2+" } });
      }
      return json({ data: [memory(MEM_C)], meta: { next_cursor: null } });
    }
    if (url.pathname === "/api/v1/tokens") return json({ data: [apiToken] });
    if (url.pathname === "/api/v1/family/members") return json({ data: [member] });
    return json({}, 404);
  }, async (calls) => {
    const r = await model.methods.sync.execute({ query: "beach day" }, context);
    assertEquals(calls.map((c) => [c.method, c.url]), [
      ["GET", `${BASE}/api/v1/memories?per_page=100&q=beach%20day`],
      ["GET", `${BASE}/api/v1/memories?per_page=100&q=beach%20day&cursor=c%2F2%2B`],
      ["GET", `${BASE}/api/v1/tokens`],
      ["GET", `${BASE}/api/v1/family/members`],
    ]);
    for (const call of calls) {
      assertEquals(call.headers, {
        Authorization: `Bearer ${FAKE_TOKEN}`,
        Accept: "application/json",
      });
      assertEquals(call.body, undefined);
    }
    return r;
  });

  assertEquals(result.dataHandles, [
    { name: "memories/current" },
    { name: "tokens/current" },
    { name: "family-members/current" },
  ]);
  const memories = model.resources.memories.schema.parse(writes[0].data);
  assertEquals(memories.memories.map((m) => m.id), [MEM_A, MEM_B, MEM_C]);
  assertEquals(memories.total_count, 3);
  assertEquals(memories.query, "beach day");
  assertEquals(memories.memories[0].photos, []); // default applied
  assertEquals(model.resources.tokens.schema.parse(writes[1].data).tokens, [apiToken]);
  assertEquals(model.resources["family-members"].schema.parse(writes[2].data).members, [member]);
  assertEquals(logs.at(-1), "Synced 3 memories, 1 tokens, 1 members");
});

Deno.test("sync without a query omits q and the query field", async () => {
  const { context, writes } = makeContext();
  await withFetch((call) => {
    const path = new URL(call.url).pathname;
    return json({ data: path === "/api/v1/memories" ? [memory(MEM_A)] : [] });
  }, async (calls) => {
    await model.methods.sync.execute({}, context);
    assertEquals(calls[0].url, `${BASE}/api/v1/memories?per_page=100`);
  });
  assertEquals("query" in (writes[0].data as object), false);
});

Deno.test("sync surfaces API errors and invalid payloads before writing", async () => {
  const unauthorized = makeContext();
  await withFetch(
    () => json({ error: { code: "unauthorized", message: "token revoked" } }, 401),
    async () => {
      await assertRejects(
        () => model.methods.sync.execute({}, unauthorized.context),
        Error,
        "API error 401: token revoked",
      );
    },
  );
  assertEquals(unauthorized.writes.length, 0);

  const validation = makeContext();
  await withFetch(() => json({ errors: ["bad page"] }, 422), async () => {
    await assertRejects(
      () => model.methods.sync.execute({}, validation.context),
      Error,
      'API error 422: ["bad page"]',
    );
  });

  const malformed = makeContext();
  await withFetch(() => json({ data: [{ ...memory(MEM_A), id: "not-a-uuid" }] }), async () => {
    await assertRejects(() => model.methods.sync.execute({}, malformed.context));
  });
  assertEquals(malformed.writes.length, 0);
});

Deno.test("memory mutations send the right verb, path, and wrapped body", async () => {
  const { context, logs } = makeContext();
  await withFetch((call) => {
    if (call.method === "POST") return json({ data: memory(MEM_A, null) }, 201);
    if (call.method === "PATCH") return json({ data: memory(MEM_A) }, 200);
    return new Response(null, { status: 204 });
  }, async (calls) => {
    const created = await model.methods.createMemory.execute(
      { recorded_at: "2026-01-01T10:00:00Z", title: "Zoo", tags: ["a"] },
      context,
    );
    assertEquals(created, { dataHandles: [] });
    await model.methods.updateMemory.execute({ id: MEM_A, pinned: true }, context);
    await model.methods.deleteMemory.execute({ id: MEM_A }, context);

    assertEquals(calls.map((c) => [c.method, c.url, c.body]), [
      ["POST", `${BASE}/api/v1/memories`, {
        memory: { recorded_at: "2026-01-01T10:00:00Z", title: "Zoo", tags: ["a"] },
      }],
      ["PATCH", `${BASE}/api/v1/memories/${MEM_A}`, { memory: { pinned: true } }],
      ["DELETE", `${BASE}/api/v1/memories/${MEM_A}`, undefined],
    ]);
    assertEquals(calls[0].headers["Content-Type"], "application/json");
    assertEquals("Content-Type" in calls[2].headers, false);
  });
  assertEquals(logs, [
    `Created memory ${MEM_A}: (untitled)`,
    `Updated memory ${MEM_A}`,
    `Deleted memory ${MEM_A}`,
  ]);
});

Deno.test("mutations reject when the status differs from the expected one", async () => {
  const { context } = makeContext();
  // A 200 is not the 204 a delete must return.
  await withFetch(() => json({}, 200), async () => {
    await assertRejects(
      () => model.methods.deleteMemory.execute({ id: MEM_A }, context),
      Error,
      "API error 200",
    );
  });
  // A 200 is not the 201 a create must return.
  await withFetch(() => json({ data: memory(MEM_A) }, 200), async () => {
    await assertRejects(
      () => model.methods.createMemory.execute({ recorded_at: "x" }, context),
      Error,
      "API error 200",
    );
  });
});

Deno.test("createToken and rotateToken store the one-time raw token", async () => {
  const { context, writes } = makeContext();
  await withFetch((call) => {
    const status = call.url.endsWith("/rotate") ? 200 : 201;
    return json({ data: { ...apiToken, token: `raw-${status}` } }, status);
  }, async (calls) => {
    const created = await model.methods.createToken.execute(
      { name: "cli", scope: "read" },
      context,
    );
    const rotated = await model.methods.rotateToken.execute({ id: TOKEN_ID }, context);
    assertEquals(created.dataHandles, [{ name: "issued-token/latest" }]);
    assertEquals(rotated.dataHandles, [{ name: "issued-token/latest" }]);
    assertEquals(calls.map((c) => [c.method, c.url, c.body]), [
      ["POST", `${BASE}/api/v1/tokens`, { token: { name: "cli", scope: "read" } }],
      ["POST", `${BASE}/api/v1/tokens/${TOKEN_ID}/rotate`, {}],
    ]);
  });
  const issued = writes.map((w) => model.resources["issued-token"].schema.parse(w.data));
  assertEquals(issued.map((i) => i.raw_token), ["raw-201", "raw-200"]);
  // The stored token metadata is stripped of the raw secret.
  assertEquals(issued[0].token, apiToken);
});

Deno.test("family and token admin methods hit their endpoints", async () => {
  const { context } = makeContext();
  await withFetch((call) => {
    if (call.method === "DELETE") return new Response(null, { status: 204 });
    if (call.method === "PATCH") return json({ data: member });
    return json({ data: {} }, 201);
  }, async (calls) => {
    await model.methods.revokeToken.execute({ id: TOKEN_ID }, context);
    await model.methods.updateMemberRole.execute({ id: MEMBER_ID, role: "admin" }, context);
    await model.methods.removeMember.execute({ id: MEMBER_ID }, context);
    await model.methods.sendInvitation.execute(
      { email: "invitee@example.com", role: "member" },
      context,
    );
    assertEquals(calls.map((c) => [c.method, c.url, c.body]), [
      ["DELETE", `${BASE}/api/v1/tokens/${TOKEN_ID}`, undefined],
      ["PATCH", `${BASE}/api/v1/family/members/${MEMBER_ID}`, { role: "admin" }],
      ["DELETE", `${BASE}/api/v1/family/members/${MEMBER_ID}`, undefined],
      ["POST", `${BASE}/api/v1/family/invitations`, {
        invitation: { email: "invitee@example.com", role: "member" },
      }],
    ]);
  });
});

Deno.test("live checks distinguish invalid tokens from unreachable API", async () => {
  const { context } = makeContext();
  const check = model.methods.createMemory.checks[0];
  await withFetch(() => json({ data: [] }), async (calls) => {
    await check.execute({}, context);
    assertEquals(calls[0].url, `${BASE}/api/v1/memories?per_page=1`);
  });
  await withFetch(() => json({}, 401), async () => {
    await assertRejects(() => check.execute({}, context), Error, "Invalid API token");
  });
  await withFetch(() => json({ down: true }, 503), async () => {
    await assertRejects(
      () => check.execute({}, context),
      Error,
      'Moment Savor API unreachable (HTTP 503): {"down":true}',
    );
  });
  await withFetch(() => json({ data: [] }), async (calls) => {
    await model.methods.rotateToken.checks[0].execute({}, context);
    await model.methods.sendInvitation.checks[0].execute({}, context);
    assertEquals(calls.map((c) => c.url), [
      `${BASE}/api/v1/tokens`,
      `${BASE}/api/v1/family/members`,
    ]);
  });
});
