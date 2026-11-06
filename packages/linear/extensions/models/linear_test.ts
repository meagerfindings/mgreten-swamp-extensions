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
    deleteIssue: unsupported,
    issues: unsupported,
    teams: unsupported,
    team: unsupported,
    project: unsupported,
    projects: unsupported,
    document: unsupported,
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

function documentNode() {
  return {
    id: "document-1",
    slugId: "998cb1fe27f8",
    title: "Automated MS Foundations Video Transcript",
    content: "# Transcript\n\nHello",
    url:
      "https://linear.app/example/document/automated-ms-foundations-video-transcript-998cb1fe27f8",
    sortOrder: 4,
    createdAt: new Date("2026-08-24T12:00:00.000Z"),
    updatedAt: "2026-08-25T12:00:00.000Z",
    project: Promise.resolve({ id: "project-1", name: "Foundations" }),
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

Deno.test("document methods accept URLs and require a project ID", () => {
  const url =
    "https://linear.app/example/document/automated-ms-foundations-video-transcript-998cb1fe27f8";
  assertEquals(model.methods.getDocument.arguments.parse({ idOrUrl: url }), {
    idOrUrl: url,
  });
  assertThrows(() => model.methods.getDocument.arguments.parse({ idOrUrl: "" }));
  assertEquals(
    model.methods.listProjectResources.arguments.parse({
      projectId: "project-1",
    }),
    { projectId: "project-1" },
  );
  assertThrows(() =>
    model.methods.listProjectResources.arguments.parse({ projectId: "" })
  );
});

Deno.test("deleteIssue schema requires exact identity, team, and confirmation", () => {
  const input = {
    identifier: "ENG-42",
    expectedTeamKey: "ENG",
    confirm: "delete" as const,
  };
  assertEquals(model.methods.deleteIssue.arguments.parse(input), input);
  assertThrows(() =>
    model.methods.deleteIssue.arguments.parse({
      identifier: "ENG-42",
      expectedTeamKey: "ENG",
      confirm: "yes",
    })
  );
  assertThrows(() =>
    model.methods.deleteIssue.arguments.parse({
      identifier: "issue-uuid",
      expectedTeamKey: "ENG",
      confirm: "delete",
    })
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

Deno.test("createIssue schema accepts sub-issue parent and estimate fields", () => {
  const input = {
    title: "Vertical slice: upload endpoint + UI",
    teamId: "team-1",
    parentId: "issue-epic-1",
    estimate: 2,
  };
  assertEquals(model.methods.createIssue.arguments.parse(input), input);
  // Unknown keys are stripped by the non-strict schema (swamp enforces
  // additionalProperties:false at the model boundary, not zod here).
  assertEquals(
    model.methods.createIssue.arguments.parse({ ...input, notAField: true }),
    input,
  );
});

Deno.test("client adapter forwards sub-issue parent and estimate to the SDK", async () => {
  let captured: Record<string, unknown> | undefined;
  const client = buildLinearClient(sdk({
    createIssue: (input) => {
      captured = input as unknown as Record<string, unknown>;
      return Promise.resolve({
        success: true,
        issue: Promise.resolve(issueNode()),
      });
    },
  }));

  const result = await client.createIssue({
    title: "Vertical slice",
    teamId: "team-1",
    parentId: "issue-epic-1",
    estimate: 2,
  });

  assertEquals(captured?.parentId, "issue-epic-1");
  assertEquals(captured?.estimate, 2);
  assertEquals(result.identifier, "ENG-42");
});

Deno.test("createEpic schema accepts a parent and children with estimates", () => {
  const input = {
    parent: { title: "Epic: photo upload", teamId: "team-1", estimate: 8 },
    children: [
      { title: "Slice 1: upload endpoint + UI", estimate: 2 },
      { title: "Slice 2: thumbnail render + UI", estimate: 3 },
    ],
  };
  assertEquals(model.methods.createEpic.arguments.parse(input), input);
});

Deno.test("client creates a parent then links each child via parentId", async () => {
  const seen: Array<Record<string, unknown>> = [];
  let counter = 0;
  const client = buildLinearClient(sdk({
    createIssue: (input) => {
      seen.push(input as unknown as Record<string, unknown>);
      counter += 1;
      const node = { ...issueNode(), id: `issue-${counter}` };
      return Promise.resolve({ success: true, issue: Promise.resolve(node) });
    },
  }));

  // Exercise the fan-out through the exported method so parentId wiring and
  // resource writes are both covered.
  const written: Array<{ spec: string; instance: string }> = [];
  const context = {
    globalArgs: { apiKey: "k" },
    logger: { info: () => {} },
    writeResource: (spec: string, instance: string) => {
      written.push({ spec, instance });
      return Promise.resolve({ spec, instance, data: {} });
    },
  };
  const { createEpic } = await import("./linear/methods.ts");
  const result = await createEpic(client, context, {
    parent: { title: "Epic", teamId: "team-1" },
    children: [{ title: "Child A" }, { title: "Child B" }],
  });

  // Parent created first with no parentId; both children carry the parent id.
  assertEquals(seen[0].parentId, undefined);
  assertEquals(seen[1].parentId, "issue-1");
  assertEquals(seen[2].parentId, "issue-1");
  // Children inherit the parent's teamId when they omit their own.
  assertEquals(seen[1].teamId, "team-1");
  assertEquals(result.dataHandles.length, 3);
  assertEquals(written.length, 3);
});

Deno.test("getIssue and listComments key resources by identifier, not by issue.id", async () => {
  // Regression: both used to writeResource(..., issue.id, ...), producing the
  // SAME data name ("<uuid>") for the issue and its comment thread, so the
  // thread write clobbered the issue. Consumers (the linear-intake
  // workflow) also address them as issue-<identifier> / thread-<identifier>.
  // Assert the resource NAMES are identifier-based and distinct.
  const written: Array<{ spec: string; instance: string }> = [];
  const context = {
    globalArgs: { apiKey: "k" },
    logger: { info: () => {} },
    writeResource: (spec: string, instance: string) => {
      written.push({ spec, instance });
      return Promise.resolve({ spec, instance, data: {} });
    },
  };
  const node = {
    ...issueNode(),
    comments: () =>
      Promise.resolve({
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: "" },
        fetchNext: () => Promise.reject(new Error("unexpected next page")),
      }),
  };
  const client = buildLinearClient(sdk({ issue: () => Promise.resolve(node) }));
  const { getIssue, listComments } = await import("./linear/methods.ts");

  await getIssue(client, context, { identifier: "ENG-42" });
  await listComments(client, context, { identifier: "ENG-42" });

  // The issue's UUID is "issue-1"; its human identifier is "ENG-42".
  assertEquals(written[0], { spec: "issue", instance: "issue-ENG-42" });
  assertEquals(written[1], { spec: "commentThread", instance: "thread-ENG-42" });
  // Distinct names — no collision.
  assertEquals(written[0].instance === written[1].instance, false);
  // Never keyed by the raw UUID.
  assertEquals(written.some((w) => w.instance === "issue-1"), false);
});

Deno.test("client reports how many children were created before a failure", async () => {
  let counter = 0;
  const client = buildLinearClient(sdk({
    createIssue: () => {
      counter += 1;
      if (counter === 3) {
        return Promise.reject(new Error("rate limited"));
      }
      const node = { ...issueNode(), id: `issue-${counter}` };
      return Promise.resolve({ success: true, issue: Promise.resolve(node) });
    },
  }));
  const context = {
    globalArgs: { apiKey: "k" },
    logger: { info: () => {} },
    writeResource: (spec: string, instance: string) =>
      Promise.resolve({ spec, instance, data: {} }),
  };
  const { createEpic } = await import("./linear/methods.ts");
  await assertRejects(
    () =>
      createEpic(client, context, {
        parent: { title: "Epic", teamId: "team-1" },
        children: [{ title: "A" }, { title: "B" }],
      }),
    Error,
    "1 child issue(s) were created before the failure",
  );
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

Deno.test("client adapter resolves a document URL to its slug ID", async () => {
  let requested = "";
  const client = buildLinearClient(sdk({
    document: (id) => {
      requested = id;
      return Promise.resolve(documentNode());
    },
  }));
  const document = await client.getDocument(
    "https://linear.app/example/document/automated-ms-foundations-video-transcript-998cb1fe27f8",
  );
  assertEquals(requested, "998cb1fe27f8");
  assertEquals(document, {
    id: "document-1",
    slugId: "998cb1fe27f8",
    title: "Automated MS Foundations Video Transcript",
    content: "# Transcript\n\nHello",
    url:
      "https://linear.app/example/document/automated-ms-foundations-video-transcript-998cb1fe27f8",
    sortOrder: 4,
    project: { id: "project-1", name: "Foundations" },
    createdAt: "2026-08-24T12:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z",
  });
});

Deno.test("client adapter lists project documents and external links", async () => {
  const emptyNextPage = () => Promise.reject(new Error("unexpected next page"));
  const client = buildLinearClient(sdk({
    project: () => Promise.resolve({
      id: "project-1",
      name: "Foundations",
      state: "started",
      documents: () => Promise.resolve({
        nodes: [documentNode()],
        pageInfo: { hasNextPage: false, endCursor: "" },
        fetchNext: emptyNextPage,
      }),
      externalLinks: () => Promise.resolve({
        nodes: [{
          id: "link-1",
          label: "Runbook",
          url: "https://example.test/runbook",
          sortOrder: 5,
          createdAt: "2026-08-24T13:00:00.000Z",
          updatedAt: new Date("2026-08-25T13:00:00.000Z"),
        }],
        pageInfo: { hasNextPage: false, endCursor: "" },
        fetchNext: emptyNextPage,
      }),
    }),
  }));

  const resources = await client.listProjectResources("project-1");
  assertEquals(resources.project, {
    id: "project-1",
    name: "Foundations",
    state: "started",
  });
  assertEquals(resources.documents[0].project, {
    id: "project-1",
    name: "Foundations",
  });
  assertEquals(resources.externalLinks, [{
    id: "link-1",
    label: "Runbook",
    url: "https://example.test/runbook",
    sortOrder: 5,
    project: { id: "project-1", name: "Foundations" },
    createdAt: "2026-08-24T13:00:00.000Z",
    updatedAt: "2026-08-25T13:00:00.000Z",
  }]);
});

Deno.test("client adapter paginates and deduplicates project resources", async () => {
  const secondDocument = {
    ...documentNode(),
    id: "document-2",
    slugId: "abcdef123456",
    title: "Second document",
  };
  const secondPage = {
    nodes: [documentNode(), secondDocument],
    pageInfo: { hasNextPage: false, endCursor: "" },
    fetchNext: () => Promise.reject(new Error("unexpected third page")),
  };
  const client = buildLinearClient(sdk({
    project: () => Promise.resolve({
      id: "project-1",
      name: "Foundations",
      state: "started",
      documents: () => Promise.resolve({
        nodes: [documentNode()],
        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        fetchNext: () => Promise.resolve(secondPage),
      }),
      externalLinks: () => Promise.resolve({
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: "" },
        fetchNext: () => Promise.reject(new Error("unexpected next page")),
      }),
    }),
  }));

  const resources = await client.listProjectResources("project-1");
  assertEquals(resources.documents.map((document) => document.id), [
    "document-1",
    "document-2",
  ]);
});

Deno.test("document methods write distinct document and link resources", async () => {
  const client = buildLinearClient(sdk({
    document: () => Promise.resolve(documentNode()),
    project: () => Promise.resolve({
      id: "project-1",
      name: "Foundations",
      state: "started",
      documents: () => Promise.resolve({
        nodes: [documentNode()],
        pageInfo: { hasNextPage: false, endCursor: "" },
        fetchNext: () => Promise.reject(new Error("unexpected next page")),
      }),
      externalLinks: () => Promise.resolve({
        nodes: [{
          id: "link-1",
          label: "Runbook",
          url: "https://example.test/runbook",
          sortOrder: 5,
          createdAt: "2026-08-24T13:00:00.000Z",
          updatedAt: "2026-08-25T13:00:00.000Z",
        }],
        pageInfo: { hasNextPage: false, endCursor: "" },
        fetchNext: () => Promise.reject(new Error("unexpected next page")),
      }),
    }),
  }));
  const written: Array<{ spec: string; instance: string }> = [];
  const context = {
    globalArgs: { apiKey: "k" },
    logger: { info: () => {} },
    writeResource: (
      spec: string,
      instance: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ spec, instance });
      return Promise.resolve({ spec, instance, data });
    },
  };
  const { getDocument, listProjectResources } = await import(
    "./linear/methods.ts"
  );

  await getDocument(client, context, { idOrUrl: "998cb1fe27f8" });
  await listProjectResources(client, context, { projectId: "project-1" });

  assertEquals(written, [
    { spec: "document", instance: "document-998cb1fe27f8" },
    { spec: "project", instance: "project-1" },
    { spec: "document", instance: "document-998cb1fe27f8" },
    { spec: "projectExternalLink", instance: "project-link-link-1" },
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

Deno.test("deleteIssue verifies the live team before deleting and recording", async () => {
  let deletedId = "";
  const client = buildLinearClient(sdk({
    issue: () => Promise.resolve(issueNode()),
    deleteIssue: (id) => {
      deletedId = id;
      return Promise.resolve({ success: true });
    },
  }));
  const written: Array<{
    spec: string;
    instance: string;
    data: Record<string, unknown>;
  }> = [];
  const context = {
    globalArgs: { apiKey: "k" },
    logger: { info: () => {} },
    writeResource: (
      spec: string,
      instance: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ spec, instance, data });
      return Promise.resolve({ spec, instance, data });
    },
  };
  const { deleteIssue } = await import("./linear/methods.ts");

  await assertRejects(
    () =>
      deleteIssue(client, context, {
        identifier: "ENG-42",
        expectedTeamKey: "OTHER",
        confirm: "delete",
      }),
    Error,
    "expected team OTHER, found ENG",
  );
  assertEquals(deletedId, "");
  assertEquals(written, []);

  const result = await deleteIssue(client, context, {
    identifier: "ENG-42",
    expectedTeamKey: "ENG",
    confirm: "delete",
  });
  assertEquals(deletedId, "issue-1");
  assertEquals(result.dataHandles.length, 1);
  assertEquals(written[0].spec, "issueDeletion");
  assertEquals(written[0].instance, "deletion-ENG-42");
  assertEquals(written[0].data.identifier, "ENG-42");
  assertEquals(written[0].data.teamKey, "ENG");
  assertEquals(written[0].data.deleted, true);
});

Deno.test("client adapter rejects an unsuccessful issue deletion", async () => {
  const client = buildLinearClient(sdk({
    deleteIssue: () => Promise.resolve({ success: false }),
  }));
  await assertRejects(
    () => client.deleteIssue("issue-1"),
    Error,
    "issueDelete returned success=false",
  );
});

Deno.test("deleteIssue replays matching evidence without another API mutation", async () => {
  const client = buildLinearClient(sdk());
  const evidence = {
    id: "issue-1",
    identifier: "ENG-42",
    title: "Ship it",
    teamKey: "ENG",
    deleted: true,
    deletedAt: "2026-08-21T12:00:00.000Z",
  };
  const written: Array<Record<string, unknown>> = [];
  const context = {
    globalArgs: { apiKey: "k" },
    logger: { info: () => {} },
    readResource: () => Promise.resolve(evidence),
    writeResource: (
      spec: string,
      instance: string,
      data: Record<string, unknown>,
    ) => {
      written.push(data);
      return Promise.resolve({ spec, instance, data });
    },
  };
  const { deleteIssue } = await import("./linear/methods.ts");

  const result = await deleteIssue(client, context, {
    identifier: "ENG-42",
    expectedTeamKey: "ENG",
    confirm: "delete",
  });

  assertEquals(result.dataHandles.length, 1);
  assertEquals(written, [evidence]);
  await assertRejects(
    () =>
      deleteIssue(client, {
        ...context,
        readResource: () => Promise.resolve({ ...evidence, teamKey: "OTHER" }),
      }, {
        identifier: "ENG-42",
        expectedTeamKey: "ENG",
        confirm: "delete",
      }),
    Error,
    "stored evidence does not match",
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
