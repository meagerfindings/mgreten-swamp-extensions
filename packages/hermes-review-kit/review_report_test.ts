import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { report } from "./review_report.ts";

type Handle = { specName: string; name: string; version: number };
type Step = {
  modelType: string;
  stepName: string;
  modelId: string;
  dataHandles: Handle[];
};

function makeContext(steps: Step[], content: unknown | null) {
  const reads: Array<[string, string, string, number]> = [];
  return {
    reads,
    context: {
      stepExecutions: steps,
      dataRepository: {
        getContent: (modelType: string, modelId: string, name: string, version: number) => {
          reads.push([modelType, modelId, name, version]);
          return Promise.resolve(
            content === null ? null : new TextEncoder().encode(JSON.stringify(content)),
          );
        },
      },
    },
  };
}

const summary = {
  generatedAt: "2026-01-02T05:00:00.000Z",
  timezone: "UTC",
  lookbackHours: 24,
  windowStart: "2026-01-01T05:00:00.000Z",
  windowEnd: "2026-01-02T05:00:00.000Z",
  sessionCount: 2,
  fileCount: 1,
  sessions: [
    {
      sessionId: "s-1",
      messageCount: 4,
      userRequests: ["build a cron"],
      assistantResponses: ["done"],
      topics: ["cron", "workflow"],
    },
    {
      sessionId: "s-2",
      messageCount: 0,
      userRequests: [],
      assistantResponses: [],
      topics: [],
    },
  ],
  recentFiles: [{ path: "/repo/AGENTS.md", mtime: "2026-01-01T12:00:00.000Z" }],
  reusablePatterns: ["cron scheduling / validation"],
  publishableIdeas: [],
  approvalNeeded: ["Publish?"],
};

const collector: Step = {
  modelType: "@mgreten/hermes-review-collector",
  stepName: "collect",
  modelId: "model-1",
  dataHandles: [
    { specName: "other", name: "noise", version: 9 },
    { specName: "summary", name: "daily", version: 3 },
  ],
};

Deno.test("report renders the summary handle selected by specName", async () => {
  const { context, reads } = makeContext(
    [{ modelType: "@x/other", stepName: "other", modelId: "m0", dataHandles: [] }, collector],
    summary,
  );
  const out = await report.execute(context);
  assertEquals(reads, [["@mgreten/hermes-review-collector", "model-1", "daily", 3]]);
  assertEquals(out.json, {
    windowStart: summary.windowStart,
    windowEnd: summary.windowEnd,
    timezone: "UTC",
    sessionCount: 2,
    fileCount: 1,
    reusablePatterns: ["cron scheduling / validation"],
    publishableIdeas: [],
    approvalNeeded: ["Publish?"],
  });
  const md = out.markdown;
  assertStringIncludes(md, "- **Window**: 2026-01-01T05:00:00.000Z → 2026-01-02T05:00:00.000Z");
  assertStringIncludes(md, "### s-1\n- **Messages**: 4\n- **Topics**: cron, workflow\n- **User request**: build a cron\n- **Assistant response**: done");
  assertStringIncludes(md, "### s-2\n- **Messages**: 0\n- **Topics**: none\n- **User request**: (no user message captured)\n- **Assistant response**: (no assistant response captured)");
  assertStringIncludes(md, "## Publishable ideas\n\n- None");
  assertStringIncludes(md, "## What is reusable\n\n- cron scheduling / validation");
  assertStringIncludes(md, "- /repo/AGENTS.md (2026-01-01T12:00:00.000Z)");
});

Deno.test("report finds the collector by step name and falls back to the first handle", async () => {
  const step: Step = {
    modelType: "@custom/collector",
    stepName: "collect",
    modelId: "m2",
    dataHandles: [{ specName: "anything", name: "first", version: 1 }],
  };
  const { context, reads } = makeContext(
    [step],
    { ...summary, sessions: [], sessionCount: 0, recentFiles: [] },
  );
  const out = await report.execute(context);
  assertEquals(reads, [["@custom/collector", "m2", "first", 1]]);
  assertStringIncludes(out.markdown, "No sessions were captured in the review window.");
  assertStringIncludes(out.markdown, "## Recent files\n\n- None");
});

Deno.test("report returns structured errors for missing step, handle, or content", async () => {
  const noStep = await report.execute(
    makeContext([{ ...collector, modelType: "@x/y", stepName: "z" }], summary).context,
  );
  assertEquals(noStep.json, { error: true, message: "No collector step output was found." });

  const noHandle = await report.execute(
    makeContext([{ ...collector, dataHandles: [] }], summary).context,
  );
  assertEquals(noHandle.json, {
    error: true,
    message: "Collector step produced no data handles.",
  });

  const noContent = await report.execute(makeContext([collector], null).context);
  assertEquals(noContent.json, { error: true, message: "Could not read collector output." });
  assertStringIncludes(noContent.markdown, "Could not read collector output: daily v3");
});

Deno.test("report rejects collector output that does not match the summary schema", async () => {
  const { context } = makeContext([collector], { ...summary, sessionCount: "two" });
  await assertRejects(() => report.execute(context));
});
