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
      parentId: "parent-id",
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
    assert(createBody.parent_id === "parent-id", "wrong parent field");
    assert(createBody.assignee_id === "user-id", "wrong assignee field");
    assert(createBody.order === 3, "wrong create order field");
    assert(!("responsible_uid" in createBody), "Sync assignee field used");
    assert(!("child_order" in createBody), "update-only order field used");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("createTask exposes and forwards parentId for subtasks", async () => {
  const originalFetch = globalThis.fetch;
  let createBody: Record<string, unknown> = {};
  globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) => {
    createBody = JSON.parse(String(init?.body));
    return Promise.resolve(Response.json(rawTask({ parent_id: "parent-id" })));
  };

  const written: Array<
    { spec: string; instance: string; data: Record<string, unknown> }
  > = [];

  try {
    const args = {
      content: "Child task",
      projectId: "project-id",
      parentId: "parent-id",
    };
    assert(
      model.methods.createTask.arguments.safeParse(args).success,
      "public create schema rejected parentId",
    );

    await model.methods.createTask.execute(args, {
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

    assert(createBody.parent_id === "parent-id", "method dropped parentId");
    assert(written.length === 1, "createTask did not write one resource");
    assert(
      written[0].data.parentId === "parent-id",
      "created subtask resource lost parentId",
    );
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
      return Promise.resolve(Response.json(null));
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

Deno.test("client surfaces redacted API status and response details", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response('{"error":"secret-token forbidden"}', {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    );

  try {
    const client = buildTodoistClient("secret-token");
    let message = "";
    try {
      await client.getTask("task-id");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes("403"), "HTTP status missing from error");
    assert(
      message.includes("forbidden"),
      "response detail missing from error",
    );
    assert(
      !message.includes("secret-token"),
      "token leaked from response body",
    );
    assert(message.includes("[REDACTED]"), "token was not visibly redacted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("client rejects repeated pagination cursors", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = () => {
    const cursors = ["cursor-a", "cursor-b", "cursor-a"];
    const nextCursor = cursors[requestCount];
    requestCount += 1;
    return Promise.resolve(Response.json({
      results: [],
      next_cursor: nextCursor,
    }));
  };

  try {
    let message = "";
    try {
      await buildTodoistClient("token").getTasks();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(requestCount === 3, "multi-node cursor cycle was not detected");
    assert(
      message.includes("repeated pagination cursor"),
      "cursor-cycle error was not actionable",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("client accepts valid nullable due fields and rejects incomplete due data", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = () =>
      Promise.resolve(Response.json(rawTask({
        due: {
          string: "tomorrow",
          date: "2026-07-25",
          is_recurring: false,
          datetime: null,
          timezone: null,
        },
      })));
    const task = await buildTodoistClient("token").getTask("task-id");
    assert(task.dueDate === "2026-07-25", "valid due date was rejected");
    assert(task.dueDatetime === "", "nullable datetime was not normalized");

    globalThis.fetch = () =>
      Promise.resolve(Response.json(rawTask({
        due: { date: "2026-07-25", is_recurring: false },
      })));
    let message = "";
    try {
      await buildTodoistClient("token").getTask("task-id");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes("due.string"), "incomplete due data was accepted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("client accepts workspace projects without personal-project fields", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(Response.json({
      results: [{
        id: "workspace-project",
        name: "Workspace project",
        color: "blue",
        child_order: 2,
        is_shared: true,
        is_favorite: false,
      }],
      next_cursor: null,
    }));

  try {
    const projects = await buildTodoistClient("token").getProjects();
    assert(projects.length === 1, "workspace project was not returned");
    assert(projects[0].parentId === "", "missing parent was not normalized");
    assert(!projects[0].isInboxProject, "workspace project marked as inbox");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("client validates Todoist response fields", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(Response.json(rawTask({ priority: "urgent" })));

  try {
    let message = "";
    try {
      await buildTodoistClient("secret-token").getTask("task-id");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(
      message.includes("GET /tasks/task-id"),
      "endpoint missing from error",
    );
    assert(message.includes("priority"), "malformed field missing from error");
    assert(
      !message.includes("secret-token"),
      "API token leaked into validation error",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("client distinguishes request timeouts without leaking tokens", async () => {
  const originalFetch = globalThis.fetch;
  let signalWasSet = false;
  globalThis.fetch = (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    signalWasSet = init?.signal instanceof AbortSignal;
    return Promise.reject(
      new DOMException("request timed out", "TimeoutError"),
    );
  };

  try {
    let message = "";
    try {
      await buildTodoistClient("secret-token").getTask("task-id");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(signalWasSet, "request did not include an abort signal");
    assert(
      message.includes("timed out after 15000ms"),
      "timeout not identified",
    );
    assert(!message.includes("secret-token"), "API token leaked into error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("client classifies body timeouts and network failures", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () =>
          Promise.reject(new DOMException("body timed out", "TimeoutError")),
      } as Response);
    let message = "";
    try {
      await buildTodoistClient("token").getTask("task-id");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(
      message.includes("timed out after 15000ms"),
      "body timeout mislabeled",
    );
    assert(
      !message.includes("invalid JSON"),
      "body timeout labeled invalid JSON",
    );

    globalThis.fetch = () =>
      Promise.reject(new TypeError("secret-token connection reset"));
    message = "";
    try {
      await buildTodoistClient("secret-token").getTask("task-id");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(
      message.includes("network request failed"),
      "network error mislabeled",
    );
    assert(message.includes("connection reset"), "network detail omitted");
    assert(
      !message.includes("secret-token"),
      "token leaked from network error",
    );

    globalThis.fetch = () =>
      Promise.resolve({
        ok: false,
        status: 503,
        headers: new Headers(),
        text: () =>
          Promise.reject(new DOMException("body timed out", "TimeoutError")),
      } as Response);
    message = "";
    try {
      await buildTodoistClient("token").getTask("task-id");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(
      message.includes("timed out after 15000ms"),
      "error-body timeout mislabeled",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("client rejects malformed list envelopes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(Response.json({ next_cursor: null }));

  try {
    let message = "";
    try {
      await buildTodoistClient("token").getTasks();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(
      message.includes("results"),
      "missing results envelope was accepted",
    );
    assert(message.includes("GET /tasks"), "list endpoint missing from error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("delete is idempotent only for already-absent tasks", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = () =>
      Promise.resolve(new Response("not found", { status: 404 }));
    await buildTodoistClient("token").deleteTask("missing-task");

    globalThis.fetch = () =>
      Promise.resolve(new Response("service unavailable", { status: 503 }));
    let message = "";
    try {
      await buildTodoistClient("token").deleteTask("existing-task");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes("503"), "non-404 delete error was swallowed");
    assert(
      message.includes("service unavailable"),
      "delete failure omitted API detail",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("GET retries honor Retry-After without retrying mutations", async () => {
  const originalFetch = globalThis.fetch;
  let getRequests = 0;
  globalThis.fetch = () => {
    getRequests += 1;
    return Promise.resolve(
      getRequests === 1
        ? new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "0" },
        })
        : Response.json(rawTask()),
    );
  };

  try {
    const task = await buildTodoistClient("token").getTask("task-id");
    assert(task.id === "task-id", "GET did not recover after rate limit");
    assert(getRequests === 2, "GET did not use bounded Retry-After retry");

    let exhaustedRequests = 0;
    globalThis.fetch = () => {
      exhaustedRequests += 1;
      return Promise.resolve(
        new Response("unavailable", {
          status: 503,
          headers: { "Retry-After": "0" },
        }),
      );
    };
    let message = "";
    try {
      await buildTodoistClient("token").getTask("task-id");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(exhaustedRequests === 3, "GET retries were not bounded");
    assert(message.includes("503"), "exhausted GET omitted final status");

    let mutationRequests = 0;
    globalThis.fetch = () => {
      mutationRequests += 1;
      return Promise.resolve(new Response("unavailable", { status: 503 }));
    };
    try {
      await buildTodoistClient("token").createTask({ content: "Test" });
    } catch { /* expected */ }
    assert(mutationRequests === 1, "mutating request was unsafely retried");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("client rejects unsafe resource IDs before fetch", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = () => {
    requestCount += 1;
    return Promise.resolve(Response.json(rawTask()));
  };

  try {
    const client = buildTodoistClient("token");
    const invalidIds = ["..", "../projects/id", "/", "?", "#", "%2e%2e"];
    for (const id of invalidIds) {
      const operations = [
        () => client.getTask(id),
        () => client.updateTask(id, { content: "Updated" }),
        () => client.closeTask(id),
        () => client.reopenTask(id),
        () => client.deleteTask(id),
        () => client.getProject(id),
      ];
      for (const operation of operations) {
        let message = "";
        try {
          await operation();
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        assert(
          message.includes("Invalid Todoist"),
          `unsafe ID accepted: ${id}`,
        );
      }
    }
    assert(requestCount === 0, "unsafe ID reached fetch");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("method logs redact tokens embedded in identifiers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(Response.json(null));
  const logs: Array<{
    message: string;
    properties?: Record<string, unknown>;
  }> = [];

  try {
    await model.methods.deleteTask.execute({ taskId: "secrettoken" }, {
      globalArgs: { apiToken: "secrettoken" },
      logger: {
        info: (
          message: string,
          properties?: Record<string, unknown>,
        ): void => {
          logs.push({ message, properties });
        },
      },
      writeResource: () => Promise.reject(new Error("unexpected write")),
    });
    const serialized = JSON.stringify(logs);
    assert(!serialized.includes("secrettoken"), "identifier leaked API token");
    assert(serialized.includes("[REDACTED]"), "identifier was not redacted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("public schemas reject unsafe IDs and fractional priorities", () => {
  assert(
    !model.methods.deleteTask.arguments.safeParse({ taskId: "../projects/id" })
      .success,
    "public delete schema accepted an unsafe task ID",
  );
  assert(
    !model.methods.createTask.arguments.safeParse({
      content: "Test",
      priority: 1.5,
    }).success,
    "create schema accepted fractional priority",
  );
  assert(
    !model.methods.updateTask.arguments.safeParse({
      taskId: "taskid",
      priority: 2.5,
    }).success,
    "update schema accepted fractional priority",
  );
});

Deno.test("task sync bounds writes, preserves order, and logs completion", async () => {
  const originalFetch = globalThis.fetch;
  const taskCount = 25;
  globalThis.fetch = () =>
    Promise.resolve(Response.json({
      results: Array.from(
        { length: taskCount },
        (_, index) => rawTask({ id: `task-${index}` }),
      ),
      next_cursor: null,
    }));

  let activeWrites = 0;
  let maxActiveWrites = 0;
  const logs: Array<{
    message: string;
    properties?: Record<string, unknown>;
  }> = [];

  try {
    const sensitiveFilter = "#Confidential assigned to: Alice";
    const result = await model.methods.syncTasks.execute({
      filter: sensitiveFilter,
    }, {
      globalArgs: { apiToken: "secret-token" },
      logger: {
        info: (
          message: string,
          properties?: Record<string, unknown>,
        ): void => {
          logs.push({ message, properties });
        },
      },
      writeResource: async (
        spec: string,
        instance: string,
        data: Record<string, unknown>,
      ) => {
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeWrites -= 1;
        return { spec, instance, data };
      },
    });

    assert(maxActiveWrites === 10, "writes did not use the concurrency bound");
    assert(
      result.dataHandles.length === taskCount,
      "not all tasks were written",
    );
    assert(
      result.dataHandles.every((handle, index) =>
        handle.instance === `task-${index}`
      ),
      "bounded writes changed result order",
    );
    assert(logs.length === 2, "sync did not log entry and completion");
    assert(logs[0].message === "Syncing Todoist tasks", "wrong entry log");
    assert(
      logs[1].properties?.taskCount === taskCount,
      "completion log omitted task count",
    );
    assert(
      !JSON.stringify(logs).includes("secret-token"),
      "API token leaked into logs",
    );
    assert(
      !JSON.stringify(logs).includes(sensitiveFilter),
      "raw task filter leaked into logs",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("failed write batches settle before rejecting and stop later batches", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(Response.json({
      results: Array.from(
        { length: 25 },
        (_, index) => rawTask({ id: `task-${index}` }),
      ),
      next_cursor: null,
    }));

  const started: string[] = [];
  let settledCount = 0;
  let activeWrites = 0;
  let maxActiveWrites = 0;

  try {
    let message = "";
    try {
      await model.methods.syncTasks.execute({}, {
        globalArgs: { apiToken: "token" },
        logger: { info: (_message: string): void => {} },
        writeResource: (
          spec: string,
          instance: string,
          data: Record<string, unknown>,
        ) => {
          started.push(instance);
          const index = Number(instance.slice("task-".length));
          if (index === 2) {
            settledCount += 1;
            throw new Error(`write failed for ${instance}`);
          }
          return (async () => {
            activeWrites += 1;
            maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
            await new Promise((resolve) =>
              setTimeout(resolve, index === 5 ? 0 : 2)
            );
            activeWrites -= 1;
            settledCount += 1;
            if (index === 5) {
              throw new Error(`write failed for ${instance}`);
            }
            return { spec, instance, data };
          })();
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    assert(maxActiveWrites <= 10, "failed batch exceeded concurrency bound");
    assert(started.length === 10, "a later write batch started after failure");
    assert(
      settledCount === 10,
      "method rejected before started writes settled",
    );
    assert(activeWrites === 0, "writes remained active after method rejection");
    assert(
      message.includes("task-2"),
      "failure was not selected in deterministic input order",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("model upgrade chain reaches the current version", () => {
  assert(model.version === "2026.07.28.1", "model version was not bumped");
  assert(
    model.upgrades.some((upgrade) => upgrade.toVersion === model.version),
    "upgrade chain does not reach the model version",
  );
});
