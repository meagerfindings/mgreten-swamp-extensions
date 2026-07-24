import { model } from "./todoist.ts";
import { buildTodoistClient } from "./todoist/client.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function rawTask(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "task-id",
    content: "Test task",
    description: "",
    project_id: "project-id",
    section_id: null,
    parent_id: null,
    labels: [],
    priority: 1,
    due: null,
    checked: false,
    added_at: null,
    responsible_uid: null,
    child_order: 1,
    ...overrides,
  };
}

const project = {
  id: "project-id",
  name: "Test project",
  color: "charcoal",
  parent_id: null,
  child_order: 1,
  is_shared: false,
  is_favorite: true,
  inbox_project: true,
};

Deno.test("client paginates the v1 filter endpoint and normalizes task fields", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    const url = new URL(String(input));
    const body = init?.method === "POST" ? rawTask() : {
      results: [rawTask()],
      next_cursor: url.searchParams.has("cursor") ? null : "next-page",
    };
    return Promise.resolve(Response.json(body));
  };

  try {
    const client = buildTodoistClient("token");
    const tasks = await client.getTasks("today");
    await client.createTask({
      content: "Test task",
      assigneeId: "user-id",
      order: 3,
    });

    assert(tasks.length === 2, "all task pages were not returned");
    assert(tasks[0].createdAt === null, "nullable added_at was not preserved");
    assert(tasks[0].isCompleted === false, "checked was not normalized");
    assert(tasks[0].order === 1, "child_order was not normalized");

    const filterUrl = new URL(requests[0].url);
    assert(filterUrl.pathname === "/api/v1/tasks/filter", "wrong filter path");
    assert(filterUrl.searchParams.get("query") === "today", "missing query");
    assert(
      !filterUrl.searchParams.has("filter"),
      "legacy filter parameter used",
    );

    const secondPageUrl = new URL(requests[1].url);
    assert(
      secondPageUrl.searchParams.get("cursor") === "next-page",
      "pagination cursor was not forwarded",
    );
    assert(secondPageUrl.searchParams.get("query") === "today", "query lost");

    const createBody = JSON.parse(String(requests[2].init?.body));
    assert(createBody.assignee_id === "user-id", "wrong assignee field");
    assert(createBody.order === 3, "wrong create order field");
    assert(!("responsible_uid" in createBody), "Sync assignee field used");
    assert(!("child_order" in createBody), "update-only order field used");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("client paginates and normalizes v1 projects", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url.pathname + url.search);
    return Promise.resolve(Response.json({
      results: [project],
      next_cursor: url.searchParams.has("cursor") ? null : "next-project-page",
    }));
  };

  try {
    const projects = await buildTodoistClient("token").getProjects();
    assert(projects.length === 2, "all project pages were not returned");
    assert(projects[0].isInboxProject, "inbox_project was not normalized");
    assert(projects[0].isFavorite, "is_favorite was not normalized");
    assert(
      projects[0].url === "https://app.todoist.com/app/project/project-id",
      "wrong project detail URL",
    );
    assert(
      requests[1].includes("cursor=next-project-page"),
      "project cursor was not forwarded",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("client uses v1 update, close, and delete contracts", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    if (init?.method === "DELETE") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (String(input).endsWith("/close")) {
      return Promise.resolve(Response.json(null));
    }
    return Promise.resolve(Response.json(rawTask()));
  };

  try {
    const client = buildTodoistClient("token");
    await client.updateTask("task-id", { assigneeId: "user-id" });
    await client.closeTask("task-id");
    await client.deleteTask("task-id");

    assert(requests[0].init?.method === "POST", "update did not use POST");
    assert(
      new URL(requests[0].url).pathname.endsWith("/tasks/task-id"),
      "wrong update path",
    );
    const updateBody = JSON.parse(String(requests[0].init?.body));
    assert(updateBody.assignee_id === "user-id", "wrong update assignee field");
    assert(
      new URL(requests[1].url).pathname.endsWith("/tasks/task-id/close"),
      "wrong close path",
    );
    assert(requests[1].init?.method === "POST", "close did not use POST");
    assert(requests[2].init?.method === "DELETE", "delete did not use DELETE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("completeTask preserves regular and recurring task state", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const recurring of [false, true]) {
      const requests: string[] = [];
      const written: Array<
        { spec: string; instance: string; data: Record<string, unknown> }
      > = [];
      globalThis.fetch = (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        requests.push(
          `${init?.method ?? "GET"} ${new URL(String(input)).pathname}`,
        );
        if (String(input).endsWith("/close")) {
          return Promise.resolve(Response.json(null));
        }
        const isRefetch = requests.filter((request) =>
          request.startsWith("GET")
        ).length > 1;
        return Promise.resolve(Response.json(rawTask({
          due: {
            string: recurring ? "every day" : "today",
            date: isRefetch ? "2026-07-24" : "2026-07-23",
            is_recurring: recurring,
          },
        })));
      };
      const context = {
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
      };

      await model.methods.completeTask.execute({ taskId: "task-id" }, context);
      assert(written.length === 1, "completeTask did not write one resource");
      assert(written[0].spec === "task", "completeTask wrote the wrong spec");
      assert(
        written[0].instance === "task-id",
        "completeTask used the wrong instance",
      );
      assert(
        model.resources.task.schema.safeParse(written[0].data).success,
        "completeTask wrote data outside the resource schema",
      );
      assert(
        written[0].data.isCompleted === !recurring,
        "completeTask recorded the wrong completion state",
      );
      assert(
        written[0].data.dueDate === (recurring ? "2026-07-24" : "2026-07-23"),
        "completeTask recorded the wrong due date",
      );
      assert(
        requests.length === (recurring ? 3 : 2),
        "completeTask used the wrong request sequence",
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("client surfaces API status and response details", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response('{"error":"rate limited"}', {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    );

  try {
    const client = buildTodoistClient("token");
    let message = "";
    try {
      await client.getTask("task-id");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes("429"), "HTTP status missing from error");
    assert(
      message.includes("rate limited"),
      "response detail missing from error",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
