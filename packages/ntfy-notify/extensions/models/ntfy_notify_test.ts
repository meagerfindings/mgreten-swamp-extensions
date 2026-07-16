/** Regression tests for ntfy model schemas and defaults. */

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { model } from "./ntfy_notify.ts";

const sendArguments = model.methods.send.arguments;
const notificationSchema = model.resources.notification.schema;

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
