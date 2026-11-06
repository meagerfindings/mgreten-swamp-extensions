import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { model } from "./model.ts";

type Write = { spec: string; name: string; data: Record<string, unknown> };
type Log = { level: string; msg: string; props?: Record<string, unknown> };

const baseGlobals = {
  schedule: "0 23 * * *",
  model: { provider: "example-provider", model: "example-model-1" },
  prompt: "Summarize the synthetic fixture data.",
};

function makeContext(globalArgs: Record<string, unknown> = baseGlobals) {
  const writes: Write[] = [];
  const logs: Log[] = [];
  const log = (level: string) => (msg: string, props?: Record<string, unknown>) =>
    logs.push({ level, msg, props });
  const context = {
    globalArgs: model.globalArguments.parse(globalArgs),
    logger: { info: log("info"), warning: log("warning"), error: log("error") },
    writeResource: (spec: string, name: string, data: Record<string, unknown>) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  };
  return { context, writes, logs };
}

async function validate(expression: string) {
  const { context, writes, logs } = makeContext();
  const result = await model.methods.validate.execute({ expression }, context);
  assertEquals(writes.length, 1);
  assertEquals(result.dataHandles, [{ name: writes[0].name }]);
  return { write: writes[0], logs };
}

Deno.test("global args require pinned model and integer repeat", () => {
  const schema = model.globalArguments;
  assertEquals(schema.safeParse(baseGlobals).success, true);
  assertEquals(schema.safeParse({ ...baseGlobals, repeat: 1000 }).success, true);
  assertEquals(schema.safeParse({ ...baseGlobals, repeat: 1.5 }).success, false);
  assertEquals(
    schema.safeParse({ ...baseGlobals, model: { provider: "example-provider" } }).success,
    false,
  );
  const { prompt: _prompt, ...noPrompt } = baseGlobals;
  assertEquals(schema.safeParse(noPrompt).success, false);
});

Deno.test("validate accepts a 5-field expression and writes a valid result", async () => {
  const { write, logs } = await validate("0 23 * * *");
  assertEquals(write.spec, "validationResult");
  assertMatch(write.name, /^validate-\d+$/);
  assertEquals(write.data.valid, true);
  assertEquals(write.data.expression, "0 23 * * *");
  assertEquals(write.data.errors, []);
  assertEquals(write.data.suggestions, []);
  assertEquals(logs.some((l) => l.level === "warning"), false);
  assertEquals(model.resources.validationResult.schema.safeParse(write.data).success, true);
});

Deno.test("validate accepts every field at its upper and lower bound", async () => {
  assertEquals((await validate("59 23 31 12 7")).write.data.valid, true);
  assertEquals((await validate("0 0 1 1 0")).write.data.valid, true);
  assertEquals((await validate("*/15 0,12 1/2 ? *")).write.data.valid, true);
});

Deno.test("validate rejects each field one past its bound with a field-specific error", async () => {
  const cases: Array<[string, string]> = [
    ["60 0 * * *", `Field 0 (minute): "60" out of range 0-59`],
    ["0 24 * * *", `Field 1 (hour): "24" out of range 0-23`],
    ["0 0 0 * *", `Field 2 (day-of-month): "0" out of range 1-31`],
    ["0 0 32 * *", `Field 2 (day-of-month): "32" out of range 1-31`],
    ["0 0 * 13 *", `Field 3 (month): "13" out of range 1-12`],
    ["0 0 * * 8", `Field 4 (day-of-week (0,7 = Sunday)): "8" out of range 0-7`],
    ["0 0 * * mon", `Field 4 (day-of-week (0,7 = Sunday)): "mon" out of range 0-7`],
  ];
  for (const [expression, error] of cases) {
    const { write, logs } = await validate(expression);
    assertEquals(write.data.valid, false, expression);
    assertEquals(write.data.errors, [error], expression);
    assertEquals(logs.filter((l) => l.level === "warning").length, 1, expression);
  }
});

Deno.test("validate checks every comma-separated part", async () => {
  const { write } = await validate("0,30,61 * * * *");
  assertEquals(write.data.errors, [`Field 0 (minute): "61" out of range 0-59`]);
});

Deno.test("validate rejects @-shorthand with both syntax and field-count errors", async () => {
  const { write } = await validate("@daily");
  assertEquals(write.data.valid, false);
  assertEquals(write.data.errors, [
    `"@daily" uses @-syntax (e.g. @daily). Swamp requires 5-field expressions only.`,
    `Expected 5 fields, got 1: "@daily"`,
  ]);
  assertEquals((write.data.suggestions as string[]).length, 2);
});

Deno.test("validate rejects 4 and 6 field expressions", async () => {
  const four = await validate("0 0 * *");
  assertEquals(four.write.data.errors, [`Expected 5 fields, got 4: "0 0 * *"`]);
  assertEquals(four.write.data.suggestions, [
    "Use exactly 5 fields: minute hour day-of-month month day-of-week",
  ]);
  const six = await validate("0 0 0 * * *");
  assertEquals(six.write.data.errors, [`Expected 5 fields, got 6: "0 0 0 * * *"`]);
});

Deno.test("validate flags complex step expressions", async () => {
  const { write } = await validate("1-10/2 * * * *");
  assertEquals(write.data.errors, [
    `Field 0 (minute): complex step expression "1-10/2" may not be fully validated`,
  ]);
});

Deno.test("build writes a validated spec that passes the resource schema", async () => {
  const { context, writes } = makeContext({
    ...baseGlobals,
    repeat: 3,
    deliver: "origin",
    skills: ["skill-a", "skill-b"],
    context_from: ["job-1"],
  });
  const result = await model.methods.build.execute({}, context);
  assertEquals(writes.length, 1);
  const { spec, name, data } = writes[0];
  assertEquals([spec, name], ["cronSpec", "current"]);
  assertEquals(result.dataHandles, [{ name: "current" }]);
  assertMatch(data.jobId as string, /^[0-9a-f-]{36}$/);
  assertEquals(data.validated, true);
  assertEquals(data.schedule, "0 23 * * *");
  assertEquals(data.model, baseGlobals.model);
  assertEquals(data.prompt, baseGlobals.prompt);
  assertEquals(data.repeat, 3);
  assertEquals(data.deliver, "origin");
  assertEquals(data.skills, ["skill-a", "skill-b"]);
  assertEquals(data.context_from, ["job-1"]);
  assert(!isNaN(Date.parse(data.builtAt as string)));
  assertEquals(model.resources.cronSpec.schema.safeParse(data).success, true);
});

Deno.test("build throws on an invalid schedule and writes nothing", async () => {
  const { context, writes, logs } = makeContext({ ...baseGlobals, schedule: "@weekly" });
  const err = await assertRejects(() => model.methods.build.execute({}, context), Error);
  assertStringIncludes(err.message, `Invalid cron schedule "@weekly"`);
  assertStringIncludes(err.message, "uses @-syntax");
  assertEquals(writes.length, 0);
  assertEquals(logs.filter((l) => l.level === "error").length, 1);
});
