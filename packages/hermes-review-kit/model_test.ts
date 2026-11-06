import { assert, assertEquals, assertThrows } from "@std/assert";
import { parse } from "@std/yaml";
import { model } from "./model.ts";
import { report } from "./review_report.ts";

type Logged = {
  level: string;
  message: string;
  props?: Record<string, unknown>;
};
type Written = { spec: string; name: string; data: Record<string, unknown> };

function makeContext(globalArgs: Record<string, unknown>) {
  const writes: Written[] = [];
  const logs: Logged[] = [];
  const context = {
    globalArgs: model.globalArguments.parse(globalArgs),
    logger: {
      info: (message: string, props?: Record<string, unknown>) =>
        logs.push({ level: "info", message, props }),
      warning: (message: string, props?: Record<string, unknown>) =>
        logs.push({ level: "warning", message, props }),
    },
    writeResource: (spec: string, name: string, data: unknown) => {
      writes.push({ spec, name, data: data as Record<string, unknown> });
      return Promise.resolve({ name });
    },
  };
  return { context, writes, logs };
}

const HOUR_MS = 60 * 60 * 1000;

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * HOUR_MS).toISOString();
}

async function writeFileWithAge(path: string, ageHours: number) {
  await Deno.writeTextFile(path, "synthetic\n");
  const when = new Date(Date.now() - ageHours * HOUR_MS);
  await Deno.utime(path, when, when);
}

Deno.test("global arguments apply documented defaults and reject non-positive limits", () => {
  assertEquals(model.globalArguments.parse({}), {
    repoDir: ".",
    sessionDir: "/opt/data/.hermes/sessions",
    timezone: "UTC",
    lookbackHours: 24,
    maxSessions: 10,
    maxFiles: 20,
  });
  assertThrows(() => model.globalArguments.parse({ lookbackHours: 0 }));
  assertThrows(() => model.globalArguments.parse({ maxSessions: 1.5 }));
});

Deno.test("collect keeps sessions inside the window, newest first, capped by maxSessions", async () => {
  const sessionDir = await Deno.makeTempDir();
  const repoDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${sessionDir}/old.json`,
      JSON.stringify({
        session_id: "s-old",
        last_updated: hoursAgo(5),
        messages: [{ role: "user", content: "cron outside window" }],
      }),
    );
    await Deno.writeTextFile(
      `${sessionDir}/mid.json`,
      JSON.stringify({
        session_id: "s-mid",
        session_start: hoursAgo(2),
        messages: [
          { role: "user", content: "Please   build a\nworkflow" },
          { role: "assistant", content: "first answer" },
          { role: "assistant", content: "Final report ready" },
        ],
      }),
    );
    await Deno.writeTextFile(
      `${sessionDir}/new.json`,
      JSON.stringify({
        session_id: "s-new",
        last_updated: hoursAgo(1),
        message_count: 42,
        messages: [{ role: "user", content: "talk about hermes" }],
      }),
    );
    await Deno.writeTextFile(
      `${sessionDir}/newest.json`,
      JSON.stringify({ session_id: "s-newest", last_updated: hoursAgo(0.5) }),
    );
    await Deno.writeTextFile(`${sessionDir}/broken.json`, "{not json");
    await Deno.writeTextFile(
      `${sessionDir}/notes.txt`,
      JSON.stringify({ session_id: "s-txt", last_updated: hoursAgo(0.1) }),
    );

    const { context, writes, logs } = makeContext({
      sessionDir,
      repoDir,
      lookbackHours: 3,
      maxSessions: 3,
      timezone: "America/Denver",
    });
    const result = await model.methods.collect.execute({}, context);

    assertEquals(result, { dataHandles: [{ name: "daily" }] });
    assertEquals(writes.length, 1);
    assertEquals(writes[0].spec, "summary");
    assertEquals(writes[0].name, "daily");
    const summary = model.resources.summary.schema.parse(writes[0].data);
    assertEquals(summary.timezone, "America/Denver");
    assertEquals(summary.lookbackHours, 3);
    assertEquals(
      Date.parse(summary.windowEnd) - Date.parse(summary.windowStart),
      3 * HOUR_MS,
    );
    assertEquals(summary.sessions.map((s) => s.sessionId), [
      "s-newest",
      "s-new",
      "s-mid",
    ]);
    assertEquals(summary.sessionCount, 3);

    const mid = summary.sessions[2];
    assertEquals(mid.messageCount, 3);
    assertEquals(mid.userRequests, ["Please build a workflow"]);
    assertEquals(mid.assistantResponses, ["Final report ready"]);
    assertEquals(mid.topics, ["report", "workflow"]);

    const newer = summary.sessions[1];
    assertEquals(newer.messageCount, 42);
    assertEquals(newer.topics, ["hermes"]);
    assertEquals(newer.assistantResponses, []);

    assertEquals(summary.reusablePatterns, [
      "reporting / summaries",
      "workflow orchestration",
    ]);
    assertEquals(summary.publishableIdeas, [
      "Hermes daily review workflow + report",
    ]);
    assertEquals(summary.approvalNeeded.length, 3);
    assertEquals(logs.at(-1)?.props, { count: 3, files: 0 });
  } finally {
    await Deno.remove(sessionDir, { recursive: true });
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("collect truncates long user requests to 260 chars and keeps at most five", async () => {
  const sessionDir = await Deno.makeTempDir();
  const repoDir = await Deno.makeTempDir();
  try {
    const messages = [
      { role: "user", content: "x".repeat(300) },
      ...Array.from(
        { length: 6 },
        (_, i) => ({ role: "user", content: `ask ${i}` }),
      ),
    ];
    await Deno.writeTextFile(
      `${sessionDir}/a.json`,
      JSON.stringify({
        session_id: "s-long",
        last_updated: hoursAgo(1),
        messages,
      }),
    );
    const { context, writes } = makeContext({ sessionDir, repoDir });
    await model.methods.collect.execute({}, context);
    const session =
      model.resources.summary.schema.parse(writes[0].data).sessions[0];
    assertEquals(session.userRequests.length, 5);
    assertEquals(session.userRequests[0], `${"x".repeat(259)}…`);
    assertEquals(session.userRequests[4], "ask 3");
    assertEquals(session.messageCount, 7);
  } finally {
    await Deno.remove(sessionDir, { recursive: true });
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("collect lists recent repo files only from watched roots, skips old and node_modules", async () => {
  const sessionDir = await Deno.makeTempDir();
  const repoDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${repoDir}/workflows`);
    await Deno.mkdir(`${repoDir}/extensions/node_modules`, { recursive: true });
    await Deno.mkdir(`${repoDir}/other`);
    await writeFileWithAge(`${repoDir}/AGENTS.md`, 1);
    await writeFileWithAge(`${repoDir}/workflows/cron-job.yaml`, 2);
    await writeFileWithAge(`${repoDir}/workflows/stale.yaml`, 30);
    await writeFileWithAge(`${repoDir}/extensions/node_modules/dep.ts`, 1);
    await writeFileWithAge(`${repoDir}/other/ignored.ts`, 1);

    const { context, writes } = makeContext({
      sessionDir,
      repoDir,
      lookbackHours: 24,
    });
    await model.methods.collect.execute({}, context);
    const summary = model.resources.summary.schema.parse(writes[0].data);
    assertEquals(summary.recentFiles.map((f) => f.path), [
      `${repoDir}/AGENTS.md`,
      `${repoDir}/workflows/cron-job.yaml`,
    ]);
    assertEquals(summary.fileCount, 2);
    // File paths feed pattern detection: "cron" and the "workflows/" dir count.
    assertEquals(summary.reusablePatterns, [
      "cron scheduling / validation",
      "workflow orchestration",
    ]);
    assertEquals(summary.publishableIdeas, ["Cron spec builder / validator"]);

    const capped = makeContext({ sessionDir, repoDir, maxFiles: 1 });
    await model.methods.collect.execute({}, capped.context);
    const cappedSummary = model.resources.summary.schema.parse(
      capped.writes[0].data,
    );
    assertEquals(cappedSummary.recentFiles.map((f) => f.path), [
      `${repoDir}/AGENTS.md`,
    ]);
  } finally {
    await Deno.remove(sessionDir, { recursive: true });
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("collect counts .hermes/config.yaml once although it is both a root file and under .hermes/", async () => {
  const repoDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${repoDir}/.hermes`);
    await writeFileWithAge(`${repoDir}/.hermes/config.yaml`, 1);
    await writeFileWithAge(`${repoDir}/.hermes/notes.md`, 2);
    const { context, writes } = makeContext({
      sessionDir: `${repoDir}/none`,
      repoDir,
    });
    await model.methods.collect.execute({}, context);
    const summary = model.resources.summary.schema.parse(writes[0].data);
    assertEquals(summary.recentFiles.map((f) => f.path), [
      `${repoDir}/.hermes/config.yaml`,
      `${repoDir}/.hermes/notes.md`,
    ]);
    assertEquals(summary.fileCount, 2);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("collect warns and still writes an empty summary when the session dir is missing", async () => {
  const repoDir = await Deno.makeTempDir();
  try {
    const sessionDir = `${repoDir}/does-not-exist`;
    const { context, writes, logs } = makeContext({ sessionDir, repoDir });
    await model.methods.collect.execute({}, context);
    const warning = logs.find((l) => l.level === "warning");
    assert(warning);
    assertEquals(warning.props?.dir, sessionDir);
    const summary = model.resources.summary.schema.parse(writes[0].data);
    assertEquals(summary.sessionCount, 0);
    assertEquals(summary.reusablePatterns, []);
    assertEquals(summary.publishableIdeas, []);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("daily review workflow wires the collector method, its inputs, and the report", async () => {
  const workflow = parse(
    await Deno.readTextFile(
      new URL("./workflows/hermes-daily-review.yaml", import.meta.url),
    ),
  ) as {
    reports: { require: string[] };
    inputs: { properties: Record<string, unknown> };
    jobs: Array<{
      steps: Array<{
        name: string;
        task: {
          type: string;
          modelType?: string;
          methodName?: string;
          inputs?: Record<string, string>;
          expr?: string;
        };
      }>;
    }>;
  };

  assertEquals(workflow.reports.require, [report.name]);
  const steps = workflow.jobs.flatMap((j) => j.steps);
  const methodSteps = steps.filter((s) => s.task.type === "model_method");
  assertEquals(methodSteps.length, 1);
  for (const step of methodSteps) {
    assertEquals(step.task.modelType, model.type);
    assert(
      step.task.methodName! in model.methods,
      `unknown method ${step.task.methodName}`,
    );
    const globalKeys = Object.keys(model.globalArguments.shape);
    for (const key of Object.keys(step.task.inputs ?? {})) {
      assert(globalKeys.includes(key), `input ${key} is not a global argument`);
      assert(key in workflow.inputs.properties, `input ${key} not declared`);
    }
  }
  // The report locates the collector by step name; the assert step reads the
  // "daily" instance the collector writes.
  assert(steps.some((s) => s.name === "collect"));
  const assertStep = steps.find((s) => s.task.type === "assert");
  assert(assertStep?.task.expr?.includes(`"daily"`));
});
