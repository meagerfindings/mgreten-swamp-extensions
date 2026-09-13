import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  buildDetailsPrompt,
  buildListPrompt,
  buildRetrievalPrompt,
  escapeMarkdownInline,
  extractMeetingIds,
  GlobalArgsSchema,
  GRANOLA_TOOLS,
  matchesExistingFile,
  MeetingDetailsResponseSchema,
  MeetingListResponseSchema,
  model,
  normalizeMeeting,
} from "./granola_mcp.ts";

const A = "123e4567-e89b-42d3-a456-426614174000";
const B = "223e4567-e89b-42d3-a456-426614174001";
const C = "323e4567-e89b-42d3-a456-426614174002";
const detail = (meetingId: string) => ({
  meetingId,
  title: "Weekly | [Sync]",
  date: "2026-08-07",
  time: "09:30",
  participants: ["Ada"],
  privateNotes: "Private",
  summary: "Summary",
});
const raw = (meetingId: string) => ({
  ...detail(meetingId),
  transcript: "Ada: Hello",
});

function context(
  responses: unknown[],
  overrides: Record<string, unknown> = {},
) {
  const calls: Array<Record<string, unknown>> = [];
  const writes: Array<{ spec: string; data: Record<string, unknown> }> = [];
  let index = 0;
  return {
    calls,
    writes,
    value: {
      globalArgs: GlobalArgsSchema.parse(overrides),
      logger: { info: () => {} },
      runModel: (options: Record<string, unknown>) => {
        calls.push(options);
        const current = index++;
        if (responses[current] instanceof Error) {
          return Promise.resolve({
            ok: false,
            error: { message: (responses[current] as Error).message },
          });
        }
        return Promise.resolve({
          ok: true,
          resources: [{ specName: "transcript", name: `wrong-${current}` }, {
            specName: "invocation",
            name: `right-${current}`,
          }],
        });
      },
      readModelData: (_model: string, spec: string) =>
        Promise.resolve(
          spec === "invocation"
            ? responses.map((response, i) => ({
              name: `right-${i}`,
              attributes: { success: true, parsedResponse: response },
            }))
            : [],
        ),
      writeResource: (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ spec, data });
        return Promise.resolve({ specName: spec, name });
      },
    },
  };
}

Deno.test("extract IDs, strict dates/times, uniqueness, and markdown escaping", () => {
  assertEquals(extractMeetingIds([`x-${A}.md`, `copy-${A.toUpperCase()}.md`]), [
    A,
  ]);
  assertThrows(() =>
    MeetingListResponseSchema.parse({
      meetings: [{ meetingId: A, title: " ", date: "2026-02-30" }],
    })
  );
  assertThrows(() =>
    MeetingDetailsResponseSchema.parse({
      meetings: [detail(A), { ...detail(A.toUpperCase()), time: "24:00" }],
    })
  );
  assertEquals(escapeMarkdownInline("a|[b]\nc"), "a\\|\\[b\\] c");
  const note = normalizeMeeting(raw(A));
  assertEquals(note.dailyLink.includes("|Weekly \\| \\[Sync\\]]]"), true);
  assertEquals(note.dailyLink.startsWith("- 09:30 - [[Granola/"), true);
  assertEquals(note.markdown.startsWith("# Weekly \\| \\[Sync\\]"), true);
});

Deno.test("legacy date-title filenames suppress migration duplicates", () => {
  const meeting = {
    meetingId: A,
    title: "Mat / Matt",
    date: "2026-08-06",
    attendees: [],
  };
  assertEquals(
    matchesExistingFile(meeting, [
      "Granola/2026-08-06 Mat _ Matt-2026-08-06_10-09-54.md",
    ]),
    true,
  );
  assertEquals(
    matchesExistingFile(meeting, ["Granola/2026-08-05 Mat _ Matt.md"]),
    false,
  );
});

Deno.test("list prompt uses exact tool and Granola snake_case arguments", () => {
  const prompt = buildListPrompt({
    timeRange: "this_week",
    workspaceOnly: true,
    involvement: { capturedByMe: true, listedAsParticipant: false },
  });
  assertEquals(
    prompt.includes("mcp__granola__list_meetings exactly once"),
    true,
  );
  assertEquals(
    prompt.includes(
      '{"time_range":"this_week","workspace_only":true,"involvement":{"captured_by_me":true,"listed_as_participant":false}}',
    ),
    true,
  );
});

Deno.test("detail prompts preserve Enhanced notes as summary", () => {
  for (const prompt of [buildDetailsPrompt([A]), buildRetrievalPrompt([A])]) {
    assertEquals(
      prompt.includes("complete user-visible Enhanced note to summary"),
      true,
    );
    assertEquals(prompt.includes("preserving its Markdown"), true);
    assertEquals(
      prompt.includes("do not replace it with a generated synopsis"),
      true,
    );
    assertEquals(
      prompt.includes("Map only explicitly private user notes to privateNotes"),
      true,
    );
  }
});

Deno.test("execute success forwards exact Amp controls, low default, timeouts, and chooses invocation handle", async () => {
  const mock = context([{ meetings: [detail(A)] }], {
    wallTimeoutMs: 45_000,
    idleTimeoutMs: 12_000,
  });
  await model.methods.getMeetings.execute(
    { meetingIds: [A] },
    mock.value as never,
  );
  const call = mock.calls[0] as {
    definition: string;
    method: string;
    arguments: Record<string, unknown>;
  };
  assertEquals(call.definition, "cli-agent");
  assertEquals(call.method, "invokeAndParse");
  assertEquals(call.arguments.provider, "amp");
  assertEquals(call.arguments.model, "low");
  assertEquals(call.arguments.toolAllowlist, [...GRANOLA_TOOLS]);
  assertEquals(call.arguments.toolProfile, "readonly");
  assertEquals(call.arguments.sandboxMode, "off");
  assertEquals(call.arguments.sandboxNetwork, "allow");
  assertEquals(call.arguments.wallTimeoutMs, 45_000);
  assertEquals(call.arguments.idleTimeoutMs, 12_000);
  assertEquals(mock.writes.length, 1);
});

Deno.test("child failure and malformed response produce zero writes", async () => {
  const failed = context([new Error("child failed")]);
  await assertRejects(
    () =>
      model.methods.listMeetings.execute(
        { timeRange: "this_week" },
        failed.value as never,
      ),
    Error,
    "child failed",
  );
  assertEquals(failed.writes.length, 0);
  const malformed = context([{
    meetings: [{ meetingId: A, title: "", date: "not-date" }],
  }]);
  await assertRejects(() =>
    model.methods.listMeetings.execute(
      { timeRange: "this_week" },
      malformed.value as never,
    )
  );
  assertEquals(malformed.writes.length, 0);
  const envelope = context([{ error: "private failure" }]);
  await assertRejects(
    () =>
      model.methods.listMeetings.execute(
        { timeRange: "this_week" },
        envelope.value as never,
      ),
    Error,
    "error envelope",
  );
  assertEquals(envelope.writes.length, 0);
});

Deno.test("sync makes no retrieval call when all listed IDs exist", async () => {
  const mock = context([{
    meetings: [{ meetingId: A, title: "Existing", attendees: [] }],
  }]);
  await model.methods.syncMeetings.execute({
    timeRange: "last_30_days",
    existingFiles: [`Granola/${A}.md`],
    maxMeetings: 10,
  }, mock.value as never);
  assertEquals(mock.calls.length, 1);
  assertEquals(mock.writes[0].data, { notes: [] });
});

Deno.test("sync deterministically bounds selection and enforces exact returned set", async () => {
  const listed = {
    meetings: [A, B, C].map((meetingId) => ({
      meetingId,
      title: meetingId,
      attendees: [],
    })),
  };
  const mock = context([listed, { meetings: [raw(B), raw(A)] }]);
  await model.methods.syncMeetings.execute({
    timeRange: "last_30_days",
    existingFiles: [],
    maxMeetings: 2,
  }, mock.value as never);
  assertEquals(mock.calls.length, 2);
  const secondPrompt = (mock.calls[1] as { arguments: { prompt: string } })
    .arguments.prompt;
  assertEquals(secondPrompt.includes(JSON.stringify([A, B])), true);
  assertEquals(secondPrompt.includes(C), false);
  assertEquals(mock.writes[0].data.notes instanceof Array, true);

  const missing = context([listed, { meetings: [raw(A)] }]);
  await assertRejects(
    () =>
      model.methods.syncMeetings.execute({
        timeRange: "last_30_days",
        existingFiles: [],
        maxMeetings: 2,
      }, missing.value as never),
    Error,
    "exactly match",
  );
  assertEquals(missing.writes.length, 0);
  const unexpected = context([listed, { meetings: [raw(A), raw(C)] }]);
  await assertRejects(
    () =>
      model.methods.syncMeetings.execute({
        timeRange: "last_30_days",
        existingFiles: [],
        maxMeetings: 2,
      }, unexpected.value as never),
    Error,
    "exactly match",
  );
  assertEquals(unexpected.writes.length, 0);
});

Deno.test("argument bounds reject duplicates, over-ten sync, and invalid timeouts", async () => {
  const mock = context([]);
  await assertRejects(() =>
    model.methods.getMeetings.execute(
      { meetingIds: [A, A.toUpperCase()] },
      mock.value as never,
    )
  );
  assertThrows(() =>
    model.methods.syncMeetings.arguments.parse({
      existingFiles: [],
      maxMeetings: 11,
    })
  );
  assertThrows(() => GlobalArgsSchema.parse({ wallTimeoutMs: 999 }));
  assertThrows(() => GlobalArgsSchema.parse({ idleTimeoutMs: 3_600_001 }));
});

Deno.test("method schemas strip Swamp's merged global arguments", () => {
  const merged = {
    ...GlobalArgsSchema.parse({ cwd: "/tmp/repo" }),
    timeRange: "this_week",
    involvement: { capturedByMe: true, listedAsParticipant: true },
  };
  assertEquals(model.methods.listMeetings.arguments.parse(merged), {
    timeRange: "this_week",
    involvement: { capturedByMe: true, listedAsParticipant: true },
  });
});
