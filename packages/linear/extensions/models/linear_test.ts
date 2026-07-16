/** Regression tests for Linear schemas and the deterministic client adapter. */

import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import { model } from "./linear.ts";
import { buildLinearClient, type LinearSDKLike } from "./linear/client.ts";

function sdk(overrides: Partial<LinearSDKLike> = {}): LinearSDKLike {
  const unsupported = (): never => {
    throw new Error("unexpected SDK call");
  };
  return {
    viewer: Promise.resolve({ id: "user-1", name: "Ada", email: "ada@test" }),
    createIssue: unsupported,
    issue: unsupported,
    updateIssue: unsupported,
    issues: unsupported,
    teams: unsupported,
    team: unsupported,
    projects: unsupported,
    workflowStates: unsupported,
    issueLabels: unsupported,
    createComment: unsupported,
    ...overrides,
  } as LinearSDKLike;
}

function issueNode() {
  return {
    id: "issue-1",
    identifier: "ENG-42",
    title: "Ship it",
    description: undefined as unknown as string,
    url: "https://linear.test/ENG-42",
    priority: 2,
    state: Promise.resolve(undefined),
    team: Promise.resolve({ id: "team-1", name: "Engineering", key: "ENG" }),
    project: Promise.resolve(undefined),
    assignee: Promise.resolve(undefined),
    labels: () => Promise.resolve({
      nodes: [{ id: "label-1", name: "Bug", color: "#f00" }],
    }),
    comments: () => Promise.reject(new Error("unexpected comments call")),
  };
}

Deno.test("global arguments require an API key and preserve optional defaults", () => {
  assertEquals(model.globalArguments.parse({
    apiKey: "lin_api_key",
    defaultTeamId: "team-1",
    defaultProjectId: "project-1",
  }), {
    apiKey: "lin_api_key",
    defaultTeamId: "team-1",
    defaultProjectId: "project-1",
  });
  assertThrows(() => model.globalArguments.parse({}));
});

Deno.test("issue method schemas enforce required identifiers and priority bounds", () => {
  assertThrows(() => model.methods.getIssue.arguments.parse({}));
  assertEquals(
    model.methods.updateIssue.arguments.parse({ identifier: "ENG-42", priority: 0 }),
    { identifier: "ENG-42", priority: 0 },
  );
  assertThrows(() =>
    model.methods.updateIssue.arguments.parse({ identifier: "ENG-42", priority: 5 })
  );
});

Deno.test("createMyIssue schema accepts its full deterministic payload", () => {
  const input = {
    title: "Ship it",
    description: "Details",
    priority: 4,
    projectId: "project-1",
    labels: "Bug, Urgent",
  };
  assertEquals(model.methods.createMyIssue.arguments.parse(input), input);
});

Deno.test("comment thread resource rejects count and comment type mismatches", () => {
  const thread = {
    issueId: "issue-1",
    identifier: "ENG-42",
    comments: [{
      id: "comment-1",
      body: "Done",
      authorName: "Ada",
      authorId: "user-1",
      isBot: false,
      createdAt: "2026-07-16T12:00:00.000Z",
    }],
    count: 1,
  };
  assertEquals(model.resources.commentThread.schema.parse(thread), thread);
  assertThrows(() =>
    model.resources.commentThread.schema.parse({ ...thread, count: "1" })
  );
  assertThrows(() =>
    model.resources.commentThread.schema.parse({
      ...thread,
      comments: [{ ...thread.comments[0], isBot: "false" }],
    })
  );
});

Deno.test("client adapter resolves viewer fields", async () => {
  assertEquals(await buildLinearClient(sdk()).getViewer(), {
    id: "user-1",
    name: "Ada",
    email: "ada@test",
  });
});

Deno.test("client adapter normalizes absent issue relations", async () => {
  const client = buildLinearClient(sdk({ issue: () => Promise.resolve(issueNode()) }));
  assertEquals(await client.getIssue("ENG-42"), {
    id: "issue-1",
    identifier: "ENG-42",
    title: "Ship it",
    description: "",
    url: "https://linear.test/ENG-42",
    priority: 2,
    state: { id: "", name: "", type: "" },
    team: { id: "team-1", name: "Engineering", key: "ENG" },
    project: null,
    assignee: null,
    labels: [{ id: "label-1", name: "Bug", color: "#f00" }],
  });
});

Deno.test("client adapter builds nested issue filters and forwards pagination", async () => {
  let received: unknown;
  const client = buildLinearClient(sdk({
    issues: (options) => {
      received = options;
      return Promise.resolve({
        nodes: [],
        pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
      });
    },
  }));
  const result = await client.listIssues({
    teamId: "team-1",
    assigneeId: "user-1",
    stateType: "started",
    projectId: "project-1",
    labelName: "Bug",
  }, 25, "cursor-1");
  assertEquals(received, {
    filter: {
      team: { id: { eq: "team-1" } },
      assignee: { id: { eq: "user-1" } },
      state: { type: { eq: "started" } },
      project: { id: { eq: "project-1" } },
      labels: { name: { eq: "Bug" } },
    },
    first: 25,
    after: "cursor-1",
  });
  assertEquals(result, {
    issues: [],
    pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
  });
});

Deno.test("client adapter chooses team-scoped and global project sources", async () => {
  let teamRequested = "";
  const client = buildLinearClient(sdk({
    team: (id) => {
      teamRequested = id;
      return Promise.resolve({ projects: () => Promise.resolve({
        nodes: [{ id: "p1", name: "Scoped", state: "started" }],
      }) });
    },
    projects: () => Promise.resolve({
      nodes: [{ id: "p2", name: "Global", state: "planned" }],
    }),
  }));
  assertEquals(await client.listProjects("team-1"), [
    { id: "p1", name: "Scoped", state: "started" },
  ]);
  assertEquals(teamRequested, "team-1");
  assertEquals(await client.listProjects(), [
    { id: "p2", name: "Global", state: "planned" },
  ]);
});

Deno.test("client adapter sorts comments and resolves user and bot authors", async () => {
  const page = {
    nodes: [
      {
        id: "c2",
        body: "Bot reply",
        createdAt: "2026-07-16T12:01:00.000Z",
        botActor: { id: "bot-1", name: "Helper" },
      },
      {
        id: "c1",
        body: "First",
        createdAt: new Date("2026-07-16T12:00:00.000Z"),
        user: Promise.resolve({ id: "user-1", name: "Ada" }),
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: "" },
    fetchNext: () => Promise.reject(new Error("unexpected next page")),
  };
  const node = { ...issueNode(), comments: () => Promise.resolve(page) };
  const client = buildLinearClient(sdk({ issue: () => Promise.resolve(node) }));
  assertEquals(await client.listComments("issue-1"), [
    {
      id: "c1",
      body: "First",
      authorName: "Ada",
      authorId: "user-1",
      isBot: false,
      createdAt: "2026-07-16T12:00:00.000Z",
    },
    {
      id: "c2",
      body: "Bot reply",
      authorName: "Helper",
      authorId: "bot-1",
      isBot: true,
      createdAt: "2026-07-16T12:01:00.000Z",
    },
  ]);
});

Deno.test("client adapter reports create and update response failures", async () => {
  const client = buildLinearClient(sdk({
    createIssue: () => Promise.resolve({ success: false, issue: Promise.resolve(undefined) }),
    updateIssue: () => Promise.resolve({ success: true, issue: Promise.resolve(undefined) }),
  }));
  await assertRejects(
    () => client.createIssue({ title: "Ship", teamId: "team-1" }),
    Error,
    "issueCreate returned success=false",
  );
  await assertRejects(
    () => client.updateIssue("issue-1", { title: "Renamed" }),
    Error,
    "issueUpdate returned no issue",
  );
});

Deno.test("client adapter reports failed and empty comment creation", async () => {
  const failed = buildLinearClient(sdk({
    createComment: () => Promise.resolve({
      success: false,
      comment: Promise.resolve(undefined),
    }),
  }));
  await assertRejects(
    () => failed.createComment("issue-1", "Hello"),
    Error,
    "commentCreate returned success=false",
  );

  const empty = buildLinearClient(sdk({
    createComment: () => Promise.resolve({
      success: true,
      comment: Promise.resolve(undefined),
    }),
  }));
  await assertRejects(
    () => empty.createComment("issue-1", "Hello"),
    Error,
    "commentCreate returned no comment",
  );
});
