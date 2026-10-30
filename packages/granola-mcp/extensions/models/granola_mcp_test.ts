import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  createModel,
  escapeMarkdownInline,
  extractMeetingIds,
  GlobalArgsSchema,
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
const meeting = (id: string, title = "A &amp; B", body = "") =>
  `<meeting id="${id}" title="${title}" meeting_at="2026-10-27T00:45:00Z"><known_participants>Ada (ada@example.com), Bo (bo@example.com)</known_participants>${body}</meeting>`;
const envelope = (
  meetings: string[],
  pagination = '<pagination has_more="false" />',
) =>
  `<meetings_data count="${meetings.length}">${
    meetings.join("\n")
  }</meetings_data>\n${pagination}`;

function context() {
  const writes: Array<{ spec: string; data: Record<string, unknown> }> = [];
  return {
    writes,
    value: {
      globalArgs: GlobalArgsSchema.parse({}),
      logger: { info: () => {} },
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

Deno.test("strict meeting contracts and safe note paths preserve identity", () => {
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
  const note = normalizeMeeting({ ...detail(A), transcript: "Ada: Hello" });
  assertEquals(note.suggestedFile, `Granola/2026-08-07 Weekly Sync ${A}.md`);
  assertEquals(
    note.dailyLink,
    `- 09:30 - [[Granola/2026-08-07 Weekly Sync ${A}|Weekly \\| \\[Sync\\]]]`,
  );
});

Deno.test("legacy date-title filenames suppress migration duplicates", () => {
  const item = {
    meetingId: A,
    title: "Mat / Matt",
    date: "2026-08-06",
    attendees: [],
  };
  assertEquals(
    matchesExistingFile(item, [
      "Granola/2026-08-06 Mat _ Matt-2026-08-06_10-09-54.md",
    ]),
    true,
  );
  assertEquals(
    matchesExistingFile(item, ["Granola/2026-08-05 Mat _ Matt.md"]),
    false,
  );
});

Deno.test("direct sync follows both paginations, preserves Markdown, Denver dates and explicit absence", async () => {
  const summary =
    "# Enhanced\n\n- Preserve <literal> &amp; markup\n- Keep **detail**, not a synopsis.";
  const direct = createModel(() =>
    Promise.resolve({
      close: () => Promise.resolve(),
      call: (tool, args) => {
        if (tool === "list_meetings") {
          // A's UUID already exists, B is new on page two, C has no recording.
          return Promise.resolve(
            args.cursor === "second"
              ? envelope([
                meeting(B),
                meeting(C),
                meeting("423e4567-e89b-42d3-a456-426614174003"),
              ])
              : envelope(
                [meeting(A)],
                '<pagination has_more="true" next_cursor="second" />',
              ),
          );
        }
        if (tool === "get_meetings") {
          return Promise.resolve(envelope([
            meeting(
              B,
              "A &amp; B",
              `<private_notes status="provided">Keep <literal> & markup</private_notes><summary format="markdown">\n${summary}\n</summary>`,
            ),
            meeting(
              C,
              "Empty",
              '<private_notes status="empty" /><summary>123</summary>',
            ),
          ]));
        }
        if (args.meeting_id === C) {
          return Promise.resolve(
            JSON.stringify({
              id: C,
              transcript: null,
              transcript_unavailable: { reason: "no_transcript" },
            }),
          );
        }
        return Promise.resolve(JSON.stringify(
          args.offset === 12
            ? {
              id: B,
              transcript: "Bo: Goodbye.",
              truncated: false,
              offset: 12,
              total_chars: 24,
            }
            : {
              id: B,
              transcript: "Ada: Hello.\n",
              truncated: true,
              offset: 0,
              next_offset: 12,
              total_chars: 24,
            },
        ));
      },
    })
  );
  const mock = context();
  await direct.methods.syncMeetings.execute({
    timeRange: "this_week",
    existingFiles: [`Granola/${A}.md`],
    maxMeetings: 2,
  }, mock.value);
  const notes = mock.writes[0].data.notes as Array<Record<string, unknown>>;
  assertEquals(notes.map((note) => note.meetingId), [B, C]);
  assertEquals(notes[0].date, "2026-10-26");
  assertEquals(notes[0].time, "18:45");
  assertEquals(notes[0].summary, summary);
  assertEquals(notes[0].privateNotes, "Keep <literal> & markup");
  assertEquals(notes[1].summary, "123");
  assertEquals(notes[1].privateNotes, "No private notes provided.");
  assertEquals(notes[0].participants, [
    "Ada (ada@example.com)",
    "Bo (bo@example.com)",
  ]);
  assertEquals(notes[0].transcript, "Ada: Hello.\nBo: Goodbye.");
  assertEquals(
    notes[1].transcript,
    "No transcript is stored for this meeting.",
  );
  assertEquals(notes[0].suggestedFile, `Granola/2026-10-26 A & B ${B}.md`);
});

Deno.test("existing UUIDs and legacy names produce no new notes on replay", async () => {
  let startupFailures = 2;
  const direct = createModel(() => {
    if (startupFailures-- > 0) return Promise.reject(new Error("HTTP 503"));
    return Promise.resolve({
      close: () => Promise.resolve(),
      call: () =>
        Promise.resolve(envelope([meeting(A), meeting(B, "Mat / Matt")])),
    });
  });
  const mock = context();
  await direct.methods.syncMeetings.execute({
    timeRange: "this_week",
    existingFiles: [
      `Granola/${A.toUpperCase()}.md`,
      "Granola/2026-10-26 Mat _ Matt.md",
    ],
    maxMeetings: 10,
  }, mock.value);
  assertEquals(mock.writes.map((write) => write.data), [{ notes: [] }]);
});

Deno.test("failed, malformed and incomplete remote lists never publish empty success", async () => {
  for (
    const response of [
      new Error("HTTP 503"),
      '{"error":"unavailable"}',
      '<meetings_data count="1"></meetings_data><pagination has_more="false" />',
      envelope([], '<pagination has_more="true" />'),
    ]
  ) {
    const direct = createModel(() =>
      Promise.resolve({
        close: () => Promise.resolve(),
        call: () =>
          response instanceof Error
            ? Promise.reject(response)
            : Promise.resolve(response),
      })
    );
    const mock = context();
    await assertRejects(() =>
      direct.methods.listMeetings.execute(
        { timeRange: "this_week" },
        mock.value,
      )
    );
    assertEquals(mock.writes, []);
  }
});

Deno.test("wrong detail IDs and non-advancing transcripts publish nothing", async () => {
  const direct = createModel(() =>
    Promise.resolve({
      close: () => Promise.resolve(),
      call: (tool) =>
        Promise.resolve(
          tool === "get_meetings" ? envelope([meeting(B)]) : JSON.stringify({
            id: A,
            transcript: "Ada",
            offset: 0,
            truncated: true,
            next_offset: 0,
          }),
        ),
    })
  );
  const mock = context();
  await assertRejects(
    () => direct.methods.getMeetings.execute({ meetingIds: [A] }, mock.value),
    Error,
    "exactly match",
  );
  await assertRejects(
    () => direct.methods.getTranscript.execute({ meetingId: A }, mock.value),
    Error,
    "did not advance",
  );
  assertEquals(mock.writes, []);
});

Deno.test("argument bounds reject duplicates, over-ten sync, and invalid timeouts", () => {
  assertThrows(() =>
    model.methods.getMeetings.arguments.parse({
      meetingIds: [A, A.toUpperCase()],
    })
  );
  assertThrows(() =>
    model.methods.syncMeetings.arguments.parse({
      existingFiles: [],
      maxMeetings: 11,
    })
  );
  assertThrows(() => GlobalArgsSchema.parse({ wallTimeoutMs: 999 }));
  assertThrows(() => GlobalArgsSchema.parse({ idleTimeoutMs: 3_600_001 }));
  assertEquals(
    model.methods.listMeetings.arguments.parse({
      ...GlobalArgsSchema.parse({}),
      timeRange: "this_week",
    }),
    { timeRange: "this_week" },
  );
});
