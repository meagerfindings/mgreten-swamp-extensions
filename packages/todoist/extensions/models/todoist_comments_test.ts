import { model } from "./todoist.ts";
import { createTaskComment, fetchTaskComments } from "./todoist/comments.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const rawComment = {
  id: 123,
  task_id: 456,
  project_id: "project-id",
  content: "Android physical-device test passed.",
  posted_at: "2026-07-27T00:00:00Z",
  attachment: null,
};

Deno.test("comment transport paginates, normalizes, and creates with Todoist API v1", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    const url = new URL(String(input));
    if (init?.method === "POST") {
      return Promise.resolve(Response.json(rawComment));
    }
    return Promise.resolve(
      Response.json({
        results: [rawComment],
        next_cursor: url.searchParams.has("cursor") ? null : "next-page",
      }),
    );
  };
  try {
    const comments = await fetchTaskComments("token", "task-id");
    const created = await createTaskComment(
      "token",
      "task-id",
      rawComment.content,
    );
    assert(comments.length === 2, "all comment pages were not returned");
    assert(
      comments[0].taskId === "456" &&
        comments[0].postedAt === rawComment.posted_at,
      "comment fields were not normalized",
    );
    assert(created.id === "123", "created comment was not normalized");
    const first = new URL(requests[0].url);
    assert(
      first.pathname === "/api/v1/comments" &&
        first.searchParams.get("task_id") === "task-id",
      "wrong comment-list contract",
    );
    assert(
      first.searchParams.get("limit") === "200",
      "missing comment page limit",
    );
    assert(
      new URL(requests[1].url).searchParams.get("cursor") === "next-page",
      "cursor was not forwarded",
    );
    assert(
      requests[2].init?.method === "POST",
      "comment create did not use POST",
    );
    assert(
      JSON.parse(String(requests[2].init?.body)).task_id === "task-id",
      "wrong comment task field",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("syncTaskComments writes a normalized resource", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      Response.json({ results: [rawComment], next_cursor: null }),
    );
  const written: Array<
    { spec: string; instance: string; data: Record<string, unknown> }
  > = [];
  try {
    const result = await model.methods.syncTaskComments.execute({
      taskId: "task-id",
    }, {
      globalArgs: { apiToken: "token" },
      logger: { info: (_message: string): void => {} },
      writeResource: (
        spec: string,
        instance: string,
        data: Record<string, unknown>,
      ) => {
        written.push({ spec, instance, data });
        return Promise.resolve({ spec, instance, data });
      },
    });
    assert(
      result.dataHandles.length === 1,
      "comment sync did not return one handle",
    );
    assert(
      written[0].spec === "comment" && written[0].instance === "123",
      "wrong comment resource identity",
    );
    assert(
      model.resources.comment.schema.safeParse(written[0].data).success,
      "comment resource failed schema validation",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("public comment methods reject unsafe IDs and empty content", () => {
  assert(
    !model.methods.syncTaskComments.arguments.safeParse({ taskId: "../task" })
      .success,
    "sync accepted unsafe task ID",
  );
  assert(
    !model.methods.createTaskComment.arguments.safeParse({
      taskId: "task-id",
      content: "",
    }).success,
    "create accepted empty content",
  );
});
