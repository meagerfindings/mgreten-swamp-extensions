import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { discoverAccounts, inspectAccounts } from "./zernio.ts";

// All provider requests are injected; no live Zernio account is required.
const config = {
  apiKey: "zernio-secret",
  credentialSource: "vault" as const,
  profileId: "profile-1",
  expectedAccounts: [
    { platform: "facebook" as const, accountId: "facebook-1" },
    { platform: "instagram" as const, accountId: "instagram-1" },
  ],
  apiBaseUrl: "https://zernio.example/api/v1",
  requestTimeoutMs: 1000,
};

function context() {
  const writes: Array<[string, string, Record<string, unknown>]> = [];
  return {
    writes,
    value: {
      globalArgs: config,
      logger: { info: () => undefined },
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

Deno.test("inspectAccounts writes a redacted ready receipt using GET-only Zernio requests", async () => {
  const ctx = context();
  const requests: Request[] = [];
  await inspectAccounts(ctx.value, async (input, init) => {
    requests.push(new Request(input, init));
    return new Response(
      JSON.stringify(
        new URL(input.toString()).pathname.endsWith("profiles")
          ? { profiles: [{ id: "profile-1" }] }
          : {
            accounts: [
              {
                id: "facebook-1",
                platform: "facebook",
                displayName: "Moment Savor",
                isActive: true,
              },
              {
                id: "instagram-1",
                platform: "instagram",
                username: "momentsavor",
                isActive: true,
              },
            ],
          },
      ),
      { status: 200 },
    );
  });
  assertEquals(requests.map((request) => request.method), ["GET", "GET"]);
  assertEquals(
    requests.map((request) => request.headers.get("authorization")),
    ["Bearer zernio-secret", "Bearer zernio-secret"],
  );
  assertEquals(ctx.writes[0][2].status, "ready");
  assertEquals(ctx.writes[0][2].missing, []);
  assertEquals(ctx.writes[0][2].pagesInspected, 1);
  assertEquals(ctx.writes[0][2].truncated, false);
  assertEquals(
    JSON.stringify(ctx.writes[0][2]).includes("zernio-secret"),
    false,
  );
});

Deno.test("inspectAccounts follows pagination and records every inspected page", async () => {
  const ctx = context();
  await inspectAccounts(ctx.value, async (input) => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith("profiles")) {
      return new Response(JSON.stringify({ profiles: [{ id: "profile-1" }] }));
    }
    if (url.searchParams.get("page") === "1") {
      return new Response(
        JSON.stringify({
          accounts: [{ id: "facebook-1", platform: "facebook" }],
          hasMore: true,
        }),
      );
    }
    return new Response(
      JSON.stringify({
        accounts: [{ id: "instagram-1", platform: "instagram" }],
        hasMore: false,
      }),
    );
  });
  assertEquals(ctx.writes[0][2].status, "ready");
  assertEquals(ctx.writes[0][2].pagesInspected, 2);
  assertEquals(ctx.writes[0][2].truncated, false);
});

Deno.test("inspectAccountHealth writes a ready receipt using one GET request", async () => {
  const ctx = context();
  const { inspectAccountHealth } = await import("./zernio.ts");
  const requests: Request[] = [];
  await inspectAccountHealth(ctx.value, async (input, init) => {
    requests.push(new Request(input, init));
    return new Response(JSON.stringify({
      accounts: [
        {
          accountId: "facebook-1",
          platform: "facebook",
          status: "healthy",
          canPost: true,
          canFetchAnalytics: true,
          tokenValid: true,
          needsReconnect: false,
          issues: [],
        },
        {
          accountId: "instagram-1",
          platform: "instagram",
          status: "warning",
          canPost: true,
          canFetchAnalytics: false,
          tokenValid: true,
          needsReconnect: false,
          issues: ["analytics permission missing"],
        },
      ],
    }));
  });
  assertEquals(requests.map((request) => request.method), ["GET"]);
  assertEquals(ctx.writes[0][0], "health");
  assertEquals(ctx.writes[0][2].status, "ready");
});

Deno.test("inspectAccounts fails closed when the configured profile is absent", async () => {
  const ctx = context();
  await assertRejects(
    () =>
      inspectAccounts(
        ctx.value,
        async () =>
          new Response(JSON.stringify({ profiles: [] }), { status: 200 }),
      ),
    Error,
    "Configured Zernio profile was not returned",
  );
});

Deno.test("discoverAccounts uses GET-only requests and does not retain the API key", async () => {
  const ctx = context();
  const requests: Request[] = [];
  await discoverAccounts({
    ...ctx.value,
    globalArgs: { ...config, profileId: "", expectedAccounts: [] },
  }, async (input, init) => {
    requests.push(new Request(input, init));
    return new Response(JSON.stringify(
      new URL(input.toString()).pathname.endsWith("profiles")
        ? { profiles: [{ id: "profile-1", name: "Primary" }] }
        : {
          accounts: [{
            id: "facebook-1",
            platform: "facebook",
            profileId: "profile-1",
            isActive: true,
          }],
        },
    ));
  });
  assertEquals(requests.map((request) => request.method), ["GET", "GET"]);
  assertEquals(ctx.writes[0][0], "discovery");
  assertEquals(ctx.writes[0][2].profiles, [{
    id: "profile-1",
    name: "Primary",
  }]);
  assertEquals(
    JSON.stringify(ctx.writes[0][2]).includes("zernio-secret"),
    false,
  );
});
