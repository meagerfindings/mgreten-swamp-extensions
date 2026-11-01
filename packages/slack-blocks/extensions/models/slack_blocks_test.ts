import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { GlobalArgsSchema, model, resolveChannel } from "./slack_blocks.ts";

Deno.test("GlobalArgsSchema: accepts a token and optional default channel", () => {
  assertEquals(GlobalArgsSchema.parse({ botToken: "xoxb-test" }), {
    botToken: "xoxb-test",
  });
  assertEquals(
    GlobalArgsSchema.parse({ botToken: "xoxb-test", defaultChannel: "C123" }),
    { botToken: "xoxb-test", defaultChannel: "C123" },
  );
});

Deno.test("GlobalArgsSchema: rejects missing and non-string tokens", () => {
  assertThrows(() => GlobalArgsSchema.parse({}));
  assertThrows(() => GlobalArgsSchema.parse({ botToken: 123 }));
});

Deno.test("resolveChannel: explicit channel takes precedence over fallback", () => {
  assertEquals(resolveChannel("C-explicit", "C-default"), "C-explicit");
});

Deno.test("resolveChannel: uses the configured fallback", () => {
  assertEquals(resolveChannel(undefined, "C-default"), "C-default");
});

Deno.test("resolveChannel: rejects calls without either channel", () => {
  assertThrows(
    () => resolveChannel(undefined, undefined),
    Error,
    "No channel",
  );
});

Deno.test("resolveChannel: empty explicit channel falls back", () => {
  assertEquals(resolveChannel("", "C-default"), "C-default");
});

Deno.test("send arguments: accepts Block Kit records and thread timestamp", () => {
  const parsed = model.methods.send.arguments.parse({
    text: "Deployment complete",
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "Done" } }],
    threadTs: "123.456",
  });
  assertEquals(parsed.blocks.length, 1);
  assertEquals(parsed.threadTs, "123.456");
});

Deno.test("send arguments: rejects missing accessibility fallback", () => {
  assertThrows(() => model.methods.send.arguments.parse({ blocks: [] }));
});

Deno.test("send arguments: rejects non-record blocks", () => {
  assertThrows(() =>
    model.methods.send.arguments.parse({ text: "fallback", blocks: ["section"] })
  );
});

Deno.test("sendWithFiles arguments: requires at least one file", () => {
  assertThrows(() =>
    model.methods.sendWithFiles.arguments.parse({
      text: "fallback",
      blocks: [],
      files: [],
    })
  );
});

Deno.test("sendWithFiles arguments: preserves complete file metadata", () => {
  const parsed = model.methods.sendWithFiles.arguments.parse({
    channel: "C123",
    text: "Report",
    blocks: [],
    files: [{
      path: "/tmp/report.txt",
      filename: "result.txt",
      title: "Result",
      altText: "Text report",
    }],
  });
  assertEquals(parsed.files[0], {
    path: "/tmp/report.txt",
    filename: "result.txt",
    title: "Result",
    altText: "Text report",
  });
});

Deno.test("resource schemas: enforce message and auth audit contracts", () => {
  const message = model.resources.slackMessage.schema.safeParse({
    channel: "C123",
    ts: "123.456",
    threadTs: null,
    text: "hello",
    blockCount: 1,
    fileCount: 0,
    fileIds: [],
    httpStatus: 200,
    success: true,
    slackError: null,
    sentAt: "2026-07-16T12:00:00.000Z",
  });
  assertEquals(message.success, true);
  assertEquals(
    model.resources.authCheck.schema.safeParse({ ok: true }).success,
    false,
  );
});
