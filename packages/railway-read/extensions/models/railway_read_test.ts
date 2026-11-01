import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { z } from "npm:zod@4";
import {
  collectDeploymentSnapshot,
  model,
  railwayDeploymentSnapshotSchema,
} from "./railway_read.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const environmentId = "22222222-2222-4222-8222-222222222222";
const serviceId = "33333333-3333-4333-8333-333333333333";
const globalArgs = {
  token: "project-token",
  authenticationMode: "project-token" as const,
  services: [{ id: serviceId, name: "web" }],
  apiUrl: "https://backboard.railway.com/graphql/v2",
};

function fakeFetch(responses: unknown[]) {
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> =
    [];
  let index = 0;
  const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify(responses[index++]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetcher: fetcher as typeof fetch, requests };
}

Deno.test("syncDeployments retains bounded commit-correlated read-only status", async () => {
  const { fetcher, requests } = fakeFetch([
    { data: { projectToken: { projectId, environmentId } } },
    {
      data: {
        deployments: {
          edges: [{
            node: {
              id: "deployment-1",
              status: "SUCCESS",
              createdAt: "2026-08-20T18:50:00Z",
              url: "https://example.up.railway.app",
              staticUrl: "example.up.railway.app",
              meta: {
                repo: "example/example-app",
                branch: "main",
                commitHash: "a".repeat(40),
                commitMessage: "fix: example deployment",
              },
            },
          }],
          pageInfo: { hasNextPage: true },
        },
      },
    },
  ]);
  const testing = createModelTestContext({ globalArgs });
  const context = {
    ...testing.context,
    globalArgs,
    _fetch: fetcher,
  };

  const result = await model.methods.syncDeployments.execute(
    { limitPerService: 10 },
    context,
  );

  assertEquals(
    result.dataHandles.map(({ name }) => ({ name })),
    [{ name: "deployments-current" }],
  );
  assertEquals(requests.length, 2);
  assertEquals(
    requests.every((request) =>
      request.headers.get("Project-Access-Token") === "project-token"
    ),
    true,
  );
  assertEquals(
    requests.every((request) =>
      String(request.body.query).includes("mutation") === false
    ),
    true,
  );
  const snapshot = railwayDeploymentSnapshotSchema.parse(
    testing.getWrittenResources()[0].data,
  );
  assertEquals(
    snapshot.services[0].deployments[0].source.commitSha,
    "a".repeat(40),
  );
  assertEquals(
    snapshot.services[0].deployments[0].staticUrl,
    "example.up.railway.app",
  );
  assertEquals(snapshot.authority.mutationsExposed, false);
  assertEquals(snapshot.truncated, true);
});

Deno.test("syncDeployments fails closed on GraphQL errors", async () => {
  const { fetcher } = fakeFetch([{ errors: [{ message: "forbidden" }] }]);
  const testing = createModelTestContext({ globalArgs });
  await assertRejects(
    () =>
      collectDeploymentSnapshot({ limitPerService: 10 }, {
        ...testing.context,
        globalArgs,
        _fetch: fetcher,
      }),
    Error,
    "Railway GraphQL query returned errors: forbidden",
  );
});

Deno.test("syncDeployments fails closed on HTTP errors before writing", async () => {
  const testing = createModelTestContext({ globalArgs });
  await assertRejects(
    () =>
      collectDeploymentSnapshot({ limitPerService: 10 }, {
        ...testing.context,
        globalArgs,
        _fetch: (() =>
          Promise.resolve(new Response(null, { status: 429 }))) as typeof fetch,
      }),
    Error,
    "Railway API request failed with HTTP 429",
  );
  assertEquals(testing.getWrittenResources(), []);
});

Deno.test("syncDeployments rejects malformed token-scope responses", async () => {
  const { fetcher } = fakeFetch([{ data: { projectToken: {} } }]);
  const testing = createModelTestContext({ globalArgs });
  await assertRejects(
    () =>
      collectDeploymentSnapshot({ limitPerService: 10 }, {
        ...testing.context,
        globalArgs,
        _fetch: fetcher,
      }),
    z.ZodError,
  );
  assertEquals(testing.getWrittenResources(), []);
});
