/** Regression tests for ntfy model schemas and defaults. */

import {
  assertEquals,
  assertFalse,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import { model } from "./ntfy_notify.ts";

const sendArguments = model.methods.send.arguments;
const notificationSchema = model.resources.notification.schema;
const outboxArguments = model.methods.sendOutboxTransport.arguments;

function testContext(logs: unknown[], writes: Record<string, unknown>[]) {
  const log = (message: string, properties?: Record<string, unknown>) => {
    logs.push({ message, properties });
  };
  return {
    globalArgs: { ntfyUrl: "https://ntfy.example.com", defaultTopic: "alerts" },
    logger: { info: log, warning: log, error: log },
    writeResource: (
      _specName: string,
      _instanceName: string,
      data: Record<string, unknown>,
    ) => {
      writes.push(data);
      return Promise.resolve({ dataName: "notification" });
    },
  };
}

async function withFetch(
  replacement: typeof fetch,
  operation: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
  try {
    await operation();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("global arguments default to the public ntfy service", () => {
  assertEquals(model.globalArguments.parse({ defaultTopic: "deployments" }), {
    ntfyUrl: "https://ntfy.sh",
    defaultTopic: "deployments",
  });
});

Deno.test("global arguments require a default topic", () => {
  assertThrows(() => model.globalArguments.parse({}));
});

Deno.test("send arguments apply priority 3 and preserve optional payload fields", () => {
  assertEquals(
    sendArguments.parse({
      title: "Deploy complete",
      message: "Production is healthy",
      tags: ["white_check_mark", "rocket"],
      actions: [{
        action: "view",
        label: "Open dashboard",
        url: "https://example.test/dashboard",
      }],
    }),
    {
      title: "Deploy complete",
      message: "Production is healthy",
      priority: 3,
      tags: ["white_check_mark", "rocket"],
      actions: [{
        action: "view",
        label: "Open dashboard",
        url: "https://example.test/dashboard",
      }],
    },
  );
});

Deno.test("send arguments accept priority boundaries", () => {
  const base = { title: "Alert", message: "Body" };
  assertEquals(sendArguments.parse({ ...base, priority: 1 }).priority, 1);
  assertEquals(sendArguments.parse({ ...base, priority: 5 }).priority, 5);
});

Deno.test("send arguments reject priorities outside the ntfy range", () => {
  const base = { title: "Alert", message: "Body" };
  assertThrows(() => sendArguments.parse({ ...base, priority: 0 }));
  assertThrows(() => sendArguments.parse({ ...base, priority: 6 }));
});

Deno.test("notification resource validates a complete delivery record", () => {
  const record = {
    topic: "deployments",
    title: "Deploy complete",
    message: "Production is healthy",
    priority: 4,
    tags: ["rocket"],
    sentAt: "2026-07-16T12:00:00.000Z",
    httpStatus: 200,
    success: true,
  };
  assertEquals(notificationSchema.parse(record), record);
});

Deno.test("notification resource rejects invalid delivery priority and success type", () => {
  const record = {
    topic: "deployments",
    title: "Deploy complete",
    message: "Production is healthy",
    priority: 4,
    sentAt: "2026-07-16T12:00:00.000Z",
    httpStatus: 200,
    success: true,
  };
  assertThrows(() => notificationSchema.parse({ ...record, priority: 9 }));
  assertThrows(() => notificationSchema.parse({ ...record, success: "yes" }));
});

Deno.test("outbox transport maps a successful generic send to ntfy", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const writes: Record<string, unknown>[] = [];
  const logs: unknown[] = [];

  await withFetch((input, init) => {
    requests.push({ url: String(input), init });
    return Promise.resolve(new Response("ok", { status: 200 }));
  }, async () => {
    const result = await model.methods.sendOutboxTransport.execute({
      payload: { title: "Build passed", message: "main is green" },
      idempotencyKey: "build-42",
      options: { topic: "build alerts", priority: 4, tags: ["check"] },
    }, testContext(logs, writes));

    assertEquals(result, { dataHandles: [{ dataName: "notification" }] });
  });

  assertEquals(requests.length, 1);
  assertEquals(requests[0].url, "https://ntfy.example.com/build%20alerts");
  assertEquals(requests[0].init?.body, "main is green");
  assertEquals(
    (requests[0].init?.headers as Record<string, string>).Title,
    "Build passed",
  );
  assertEquals(writes[0].success, true);
  assertEquals(writes[0].httpStatus, 200);
});

Deno.test("outbox transport throws before writing on an ntfy HTTP failure", async () => {
  const writes: Record<string, unknown>[] = [];
  await withFetch(
    () => Promise.resolve(new Response("rate limited", { status: 429 })),
    async () => {
      await assertRejects(
        () =>
          model.methods.sendOutboxTransport.execute({
            payload: { title: "Build", message: "failed" },
            idempotencyKey: "build-43",
            options: {},
          }, testContext([], writes)),
        Error,
        "HTTP 429",
      );
    },
  );
  assertEquals(writes, []);
});

Deno.test("outbox transport keeps payload and idempotency key out of logs", async () => {
  const logs: unknown[] = [];
  await withFetch(() => Promise.resolve(new Response("ok")), async () => {
    await model.methods.sendOutboxTransport.execute({
      payload: { title: "private-title", message: "private-message" },
      idempotencyKey: "private-key",
      options: {},
    }, testContext(logs, []));
  });
  const serializedLogs = JSON.stringify(logs);
  assertFalse(serializedLogs.includes("private-title"));
  assertFalse(serializedLogs.includes("private-message"));
  assertFalse(serializedLogs.includes("private-key"));
});

Deno.test("outbox transport rejects malformed payloads and unbounded options", () => {
  const valid = {
    payload: { title: "Alert", message: "Body" },
    idempotencyKey: "alert-1",
    options: {},
  };
  assertThrows(() => outboxArguments.parse({ ...valid, extra: true }));
  assertThrows(() =>
    outboxArguments.parse({
      ...valid,
      payload: { ...valid.payload, secret: "must not pass through" },
    })
  );
  assertThrows(() =>
    outboxArguments.parse({
      ...valid,
      options: { tags: Array(21).fill("tag") },
    })
  );
  assertThrows(() =>
    outboxArguments.parse({
      ...valid,
      options: { priority: 6 },
    })
  );
});

Deno.test("outbox transport tolerates runtime-injected model configuration", () => {
  const parsed = outboxArguments.parse({
    payload: { title: "Alert", message: "Body" },
    idempotencyKey: "alert-1",
    options: {},
    ntfyUrl: "https://ntfy.example.com",
    defaultTopic: "alerts",
  });
  assertEquals(parsed.ntfyUrl, "https://ntfy.example.com");
  assertEquals(parsed.defaultTopic, "alerts");
});

Deno.test("outbox transport replay sends again because ntfy deduplication is unavailable", async () => {
  let requests = 0;
  const args = {
    payload: { title: "Replay", message: "Same message" },
    idempotencyKey: "same-key",
    options: {},
  };
  await withFetch(() => {
    requests += 1;
    return Promise.resolve(new Response("ok"));
  }, async () => {
    await model.methods.sendOutboxTransport.execute(args, testContext([], []));
    await model.methods.sendOutboxTransport.execute(args, testContext([], []));
  });
  assertEquals(requests, 2);
});
