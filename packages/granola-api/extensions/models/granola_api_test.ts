import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createModel, GlobalArgsSchema } from "./granola_api.ts";

const IDS = ["a", "b", "c"].map((letter) => `not_${letter.repeat(14)}`);
const UUIDS = [
  "123e4567-e89b-42d3-a456-426614174000",
  "223e4567-e89b-42d3-a456-426614174001",
  "323e4567-e89b-42d3-a456-426614174002",
];
const ARGS = {
  createdAfter: "2026-10-26T00:00:00-06:00",
  existingFiles: [] as string[],
  maxMeetings: 10,
};
function detail(id: string) {
  const i = IDS.indexOf(id);
  return {
    id,
    title: "REST meeting",
    web_url: `https://notes.granola.ai/d/${UUIDS[i]}`,
    created_at: "2026-10-27T03:12:00Z",
    deleted_at: null,
    calendar_event: { scheduled_start_time: "2026-10-27T00:45:00Z" },
    attendees: [{ name: "Ada", email: "ada@example.com" }],
    summary_markdown: "## Enhanced\n\n**Keep** <literal> & markup",
    summary_text: "plain summary",
    private_notes_markdown: i === 2 ? "" : null,
    private_notes_text: i === 2 ? "" : null,
  };
}
function context(withKey = true) {
  const writes: Array<Record<string, unknown>> = [];
  return {
    writes,
    value: {
      globalArgs: GlobalArgsSchema.parse(
        withKey ? { apiKey: "fake-test-token" } : {},
      ),
      logger: { info: () => {} },
      writeResource: (
        _spec: string,
        _name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push(data);
        return Promise.resolve({ name: "result" });
      },
    },
  };
}

Deno.test("REST preserves identity, both paginations, Denver dates, private-notes semantics and idempotent replay", async () => {
  let transcriptCalls = 0;
  const request: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    assertEquals(url.origin, "https://public-api.granola.ai");
    assertEquals(
      new Headers(init?.headers).get("Authorization"),
      "Bearer fake-test-token",
    );
    let body: unknown;
    if (url.pathname === "/v1/notes") {
      assertEquals(
        url.searchParams.get("created_after"),
        "2026-10-26T06:00:00Z",
      );
      body = url.searchParams.has("cursor")
        ? {
          notes: IDS.map((id) => ({ id, deleted_at: null })),
          hasMore: false,
          cursor: null,
        }
        : { notes: [], hasMore: true, cursor: "second" };
    } else if (url.pathname.endsWith("/transcript")) {
      transcriptCalls++;
      body = url.pathname.includes(IDS[2])
        ? { transcript: [], hasMore: false, cursor: null }
        : url.searchParams.has("cursor")
        ? {
          transcript: [{
            speaker: { source: "microphone", diarization_label: "Speaker B" },
            text: "Omega",
          }],
          hasMore: false,
          cursor: null,
        }
        : {
          transcript: [{
            speaker: { source: "speaker", attribution: "me" },
            text: "Alpha <literal>",
          }],
          hasMore: true,
          cursor: "tail",
        };
    } else body = detail(url.pathname.split("/").at(-1)!);
    return Promise.resolve(Response.json(body));
  };
  const rest = createModel(request);
  const ctx = context();
  await rest.methods.syncApiMeetings.execute({
    ...ARGS,
    existingFiles: [`Granola/old ${UUIDS[0].toUpperCase()}.md`],
  }, ctx.value);
  const notes = ctx.writes[0].notes as Array<Record<string, string>>;
  assertEquals(notes.map((n) => n.meetingId), UUIDS.slice(1));
  assertEquals(notes[0].date, "2026-10-26");
  assertEquals(notes[0].time, "18:45");
  assertEquals(notes[0].summary, "## Enhanced\n\n**Keep** <literal> & markup");
  assertEquals(
    notes[0].privateNotes,
    "Private notes unavailable through this API key.",
  );
  assertEquals(notes[1].privateNotes, "No private notes provided.");
  assertEquals(notes[0].transcript, "Me: Alpha <literal>\nSpeaker B: Omega");
  assertEquals(
    notes[1].transcript,
    "No transcript is stored for this meeting.",
  );
  assertEquals(
    notes[0].dailyLink,
    `- 18:45 - [[Granola/2026-10-26 REST meeting ${UUIDS[1]}|REST meeting]]`,
  );
  const replay = context();
  const callsBefore = transcriptCalls;
  await rest.methods.syncApiMeetings.execute({
    ...ARGS,
    existingFiles: UUIDS.map((id) => `Granola/existing ${id}.md`),
  }, replay.value);
  assertEquals(replay.writes[0].notes, []);
  assertEquals(transcriptCalls, callsBefore);
});

Deno.test("REST fails closed on unauthorized, malformed, ambiguous identity and incomplete transcript results", async () => {
  for (
    const failure of [
      "unauthorized",
      "invalid-json",
      "cursor",
      "wrong-id",
      "web-url",
      "transcript",
      "transcript-cursor",
    ]
  ) {
    const request: typeof fetch = (input) => {
      const url = new URL(String(input));
      if (failure === "unauthorized") {
        return Promise.resolve(
          new Response("do-not-log-this-secret", { status: 401 }),
        );
      }
      if (failure === "invalid-json") {
        return Promise.resolve(new Response("do-not-log-this-secret"));
      }
      if (url.pathname === "/v1/notes") {
        return Promise.resolve(Response.json({
          notes: failure === "cursor" ? [] : [{ id: IDS[0], deleted_at: null }],
          hasMore: failure === "cursor",
          cursor: failure === "cursor" ? "stuck" : null,
        }));
      }
      if (url.pathname.endsWith("/transcript")) {
        return Promise.resolve(
          failure === "transcript-cursor"
            ? Response.json({ transcript: [], hasMore: true, cursor: "stuck" })
            : new Response("do-not-log-this-secret", { status: 404 }),
        );
      }
      return Promise.resolve(Response.json({
        ...detail(IDS[0]),
        ...(failure === "wrong-id" ? { id: IDS[1] } : {}),
        ...(failure === "web-url"
          ? { web_url: "https://notes.granola.ai/d/not_a_uuid" }
          : {}),
      }));
    };
    const ctx = context();
    const error = await assertRejects(() =>
      createModel(request).methods.syncApiMeetings.execute(ARGS, ctx.value)
    );
    assertEquals(String(error).includes("do-not-log-this-secret"), false);
    assertEquals(ctx.writes, []);
  }
});

Deno.test("REST requires a vault key and retries rate limits", async () => {
  await assertRejects(
    () =>
      createModel().methods.syncApiMeetings.execute(ARGS, context(false).value),
    Error,
    "requires a vault-backed apiKey",
  );
  let attempts = 0;
  const request: typeof fetch = () =>
    Promise.resolve(
      ++attempts === 1
        ? new Response("limited", {
          status: 429,
          headers: { "Retry-After": "0" },
        })
        : Response.json({ notes: [], hasMore: false, cursor: null }),
    );
  const ctx = context();
  await createModel(request).methods.syncApiMeetings.execute(ARGS, ctx.value);
  assertEquals(ctx.writes[0].notes, []);
  assertEquals(attempts, 2);
});
