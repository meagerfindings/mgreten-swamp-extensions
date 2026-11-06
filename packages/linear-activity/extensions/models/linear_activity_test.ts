import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { model } from "./linear_activity.ts";

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, unknown> };
};

const FAKE_KEY = "lin_api_FAKE_TEST_KEY";
const DATE = "2026-03-04";
const START = new Date(`${DATE}T00:00:00`).toISOString();
const END = new Date(`${DATE}T23:59:59.999`).toISOString();
const INSIDE = new Date(`${DATE}T12:00:00`).toISOString();
const BEFORE = new Date(new Date(`${DATE}T00:00:00`).getTime() - 1).toISOString();

function issue(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `id-${id}`,
    identifier: id,
    title: `Title ${id}`,
    url: `https://linear.example.com/issue/${id}`,
    priority: 2,
    updatedAt: INSIDE,
    completedAt: null,
    state: { id: "st", name: "In Progress", type: "started" },
    team: { id: "t1", key: "ENG" },
    assignee: { id: "viewer-1", email: "viewer@example.com" },
    ...overrides,
  };
}

function comment(id: string, teamKey: string | null, body = "note") {
  return {
    id,
    createdAt: INSIDE,
    body,
    issue: {
      identifier: `${teamKey ?? "X"}-1`,
      title: "Commented issue",
      url: "https://linear.example.com/issue/c",
      state: { name: "Todo" },
      team: teamKey ? { key: teamKey } : null,
    },
  };
}

/** Responds to the five sequential GraphQL calls by inspecting the query/filter. */
function responder(body: Call["body"]): unknown {
  const filter = (body.variables.filter ?? {}) as Record<string, unknown>;
  if (body.query.includes("viewer")) {
    return { data: { viewer: { id: "viewer-1", email: "viewer@example.com", displayName: "V" } } };
  }
  if (body.query.includes("comments(")) {
    return {
      data: {
        comments: {
          nodes: [
            comment("c-eng", "ENG", "y".repeat(600)),
            comment("c-ops", "OPS"),
            comment("c-none", null),
          ],
        },
      },
    };
  }
  if ("completedAt" in filter) {
    return {
      data: {
        issues: {
          nodes: [
            issue("ENG-1", {
              completedAt: INSIDE,
              state: null,
              team: null,
              assignee: null,
              priority: undefined,
            }),
          ],
        },
      },
    };
  }
  if ("state" in filter) {
    return {
      data: {
        issues: {
          nodes: [
            issue("ENG-2", { state: { id: "s", name: "In Review", type: "started" } }),
            issue("ENG-3", {
              state: { id: "s", name: "Code review", type: "started" },
              updatedAt: BEFORE,
            }),
            issue("ENG-4"),
          ],
        },
      },
    };
  }
  if ("creator" in filter) {
    return { data: { issues: { nodes: [issue("ENG-5")] } } };
  }
  throw new Error(`unexpected query ${body.query}`);
}

async function withFetch<T>(
  handler: (call: Call) => Response,
  fn: (calls: Call[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    };
    calls.push(call);
    return Promise.resolve(handler(call));
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function makeContext(teamKeys?: string[]) {
  const writes: Array<{ spec: string; instance: string; data: unknown }> = [];
  const logs: Array<{ msg: string; props?: Record<string, unknown> }> = [];
  const log = (msg: string, props?: Record<string, unknown>) => logs.push({ msg, props });
  return {
    writes,
    logs,
    context: {
      globalArgs: model.globalArguments.parse({ apiKey: FAKE_KEY, teamKeys }),
      writeResource: (spec: string, instance: string, data: unknown) => {
        writes.push({ spec, instance, data });
        return Promise.resolve({ name: instance });
      },
      logger: { info: log, warning: log, error: log },
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.test("global arguments require apiKey and default teamKeys to empty", () => {
  assertThrows(() => model.globalArguments.parse({}));
  assertEquals(model.globalArguments.parse({ apiKey: FAKE_KEY }), {
    apiKey: FAKE_KEY,
    teamKeys: [],
  });
  assertThrows(() => model.globalArguments.parse({ apiKey: FAKE_KEY, teamKeys: "ENG" }));
});

Deno.test("daily_activity sends authenticated, team-scoped day-window GraphQL queries", async () => {
  const { context } = makeContext(["ENG"]);
  await withFetch((call) => json(responder(call.body)), async (calls) => {
    await model.methods.daily_activity.execute({ date: DATE }, context);
    assertEquals(calls.length, 5);
    for (const call of calls) {
      assertEquals(call.url, "https://api.linear.app/graphql");
      assertEquals(call.method, "POST");
      assertEquals(call.headers.Authorization, FAKE_KEY);
      assertEquals(call.headers["Content-Type"], "application/json");
    }
    const [, completed, inFlight, created, comments] = calls.map((c) => c.body.variables);
    assertEquals(completed, {
      filter: {
        team: { key: { in: ["ENG"] } },
        assignee: { id: { eq: "viewer-1" } },
        completedAt: { gte: START, lte: END },
      },
      first: 50,
    });
    assertEquals(inFlight, {
      filter: {
        team: { key: { in: ["ENG"] } },
        assignee: { id: { eq: "viewer-1" } },
        state: { type: { in: ["started", "unstarted"] } },
      },
      first: 50,
    });
    assertEquals(created, {
      filter: {
        team: { key: { in: ["ENG"] } },
        creator: { id: { eq: "viewer-1" } },
        createdAt: { gte: START, lte: END },
      },
      first: 50,
    });
    // CommentFilter has no team field, so it is never sent there.
    assertEquals(comments, {
      filter: { user: { id: { eq: "viewer-1" } }, createdAt: { gte: START, lte: END } },
      first: 100,
    });
  });
});

Deno.test("daily_activity classifies issues and filters comments by team", async () => {
  const { context, writes, logs } = makeContext(["ENG"]);
  const result = await withFetch(
    (call) => json(responder(call.body)),
    () => model.methods.daily_activity.execute({ date: DATE }, context),
  );
  assertEquals(result, { dataHandles: [{ name: `linear-${DATE}` }] });
  assertEquals(writes.length, 1);
  assertEquals(writes[0].spec, "linear_activity");
  const data = model.resources.linear_activity.schema.parse(writes[0].data);
  assertEquals(data.date, DATE);
  assertEquals(data.viewerId, "viewer-1");
  assertEquals(data.teamKeys, ["ENG"]);

  // Null nested fields flatten to empty strings / null / priority 0.
  assertEquals(data.issuesCompleted, [{
    id: "id-ENG-1",
    identifier: "ENG-1",
    title: "Title ENG-1",
    url: "https://linear.example.com/issue/ENG-1",
    stateName: "",
    stateType: "",
    teamKey: "",
    priority: 0,
    assigneeEmail: null,
    updatedAt: INSIDE,
    completedAt: INSIDE,
  }]);
  // ENG-3 is a review state but updated 1ms before the day starts; ENG-4 is not review.
  assertEquals(data.issuesMovedToReview.map((i) => i.identifier), ["ENG-2"]);
  assertEquals(data.issuesInFlight.map((i) => i.identifier), ["ENG-2", "ENG-3", "ENG-4"]);
  assertEquals(data.issuesCreated.map((i) => i.identifier), ["ENG-5"]);
  assertEquals(data.commentsByMe.map((c) => c.id), ["c-eng"]);
  assertEquals(data.commentsByMe[0].body.length, 500);
  assertEquals(logs.at(-1)?.props, {
    completed: 1,
    review: 1,
    created: 1,
    comments: 1,
    flight: 3,
  });
});

Deno.test("daily_activity without teamKeys omits the team filter and keeps all comments", async () => {
  const { context, writes } = makeContext();
  await withFetch((call) => json(responder(call.body)), async (calls) => {
    await model.methods.daily_activity.execute({ date: DATE }, context);
    for (const call of calls.slice(1, 4)) {
      assertEquals("team" in (call.body.variables.filter as object), false);
    }
  });
  const data = model.resources.linear_activity.schema.parse(writes[0].data);
  assertEquals(data.commentsByMe.map((c) => c.id), ["c-eng", "c-ops", "c-none"]);
});

Deno.test("daily_activity surfaces HTTP, GraphQL, and empty-data errors without writing", async () => {
  const cases: Array<[() => Response, string]> = [
    [() => new Response("rate limited", { status: 429 }), "Linear GraphQL HTTP 429: rate limited"],
    [
      () => json({ errors: [{ message: "bad field" }, { message: "auth" }] }),
      "Linear GraphQL errors: bad field; auth",
    ],
    [() => json({}), "Linear GraphQL returned no data"],
  ];
  for (const [respond, message] of cases) {
    const { context, writes } = makeContext();
    await withFetch(respond, async (calls) => {
      await assertRejects(
        () => model.methods.daily_activity.execute({ date: DATE }, context),
        Error,
        message,
      );
      assertEquals(calls.length, 1);
    });
    assertEquals(writes.length, 0);
  }
});

Deno.test("daily_activity method arguments accept an optional date only as a string", () => {
  const args = model.methods.daily_activity.arguments;
  assertEquals(args.parse({}), {});
  assertEquals(args.parse({ date: DATE }), { date: DATE });
  assertThrows(() => args.parse({ date: 20260304 }));
});
