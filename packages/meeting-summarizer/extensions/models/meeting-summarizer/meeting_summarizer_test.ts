/** Tests for the meeting-summarizer model.
 *
 * Ollama is never contacted: `globalThis.fetch` is replaced with a recorder
 * that returns canned responses, so the chunking, prompt assembly, merge, and
 * `<think>` stripping are observable through the captured request bodies.
 * All transcript and note text is synthetic.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  // deno-lint-ignore no-import-prefix
} from "jsr:@std/assert@1";
import { model } from "./meeting_summarizer.ts";

interface Written {
  spec: string;
  name: string;
  data: Record<string, unknown>;
}

function fakeContext(globalArgs: Record<string, unknown> = {}) {
  const written: Written[] = [];
  const logs: string[] = [];
  const context = {
    globalArgs: model.globalArguments.parse(globalArgs),
    logger: {
      info: (msg: string) => logs.push(msg),
      warn: (msg: string) => logs.push(`warn:${msg}`),
    },
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ spec, name, data });
      return Promise.resolve({ handle: `${spec}/${name}` });
    },
  };
  return { context, written, logs };
}

interface Call {
  url: string;
  body: {
    model: string;
    prompt: string;
    stream: boolean;
    think: boolean;
    options: { temperature: number };
  };
}

/** Replace fetch for the duration of `fn`; responses are served in order. */
async function withFakeOllama<T>(
  responses: Array<{ status?: number; body: unknown }>,
  fn: (calls: Call[]) => Promise<T>,
): Promise<T> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
    });
    const r = responses[i++] ?? { status: 599, body: "unexpected call" };
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return Promise.resolve(new Response(text, { status: r.status ?? 200 }));
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const CHUNK_PROMPT_HEAD =
  "You are summarizing a meeting transcript into a Granola-style note.";
const MERGE_PROMPT_HEAD = "You are merging N partial summaries";

Deno.test("global arguments apply documented defaults", () => {
  assertEquals(model.globalArguments.parse({}), {
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "qwen3.6:35b-a3b-nvfp4",
    chunkTokens: 2500,
    overlapTokens: 200,
  });
  assert(!model.globalArguments.safeParse({ chunkTokens: "big" }).success);
  assert(!model.methods.summarize.arguments.safeParse({}).success);
});

Deno.test("summarize single chunk: speaker labels, skips blanks, strips <think>", async () => {
  const transcript = JSON.stringify({
    segments: [
      { text: "  Let's ship the widget on Tuesday. ", speaker: "Speaker A" },
      { text: "   " },
      { text: "Agreed." },
    ],
  });
  const { context, written } = fakeContext({
    ollamaUrl: "http://fake-ollama.test",
    ollamaModel: "synthetic:1b",
  });

  await withFakeOllama(
    [{
      body: { response: "<think>hmm\nplan</think>\n# TL;DR\nShip Tuesday." },
    }],
    async (calls) => {
      await model.methods.summarize.execute(
        { transcriptJson: transcript, instanceName: "standup" },
        context,
      );
      assertEquals(calls.length, 1);
      assertEquals(calls[0].url, "http://fake-ollama.test/api/generate");
      assertEquals(calls[0].body.model, "synthetic:1b");
      assertEquals(calls[0].body.stream, false);
      assertEquals(calls[0].body.think, false);
      assertEquals(calls[0].body.options, { temperature: 0.2 });
      assert(calls[0].body.prompt.startsWith(CHUNK_PROMPT_HEAD));
      assert(
        calls[0].body.prompt.endsWith(
          "Transcript follows:\n\n[Speaker A]: Let's ship the widget on Tuesday. Agreed.",
        ),
      );
    },
  );

  assertEquals(written.length, 1);
  assertEquals(written[0].spec, "summary");
  assertEquals(written[0].name, "standup");
  assertEquals(written[0].data.markdown, "# TL;DR\nShip Tuesday.");
  assertEquals(written[0].data.model, "synthetic:1b");
  assertEquals(written[0].data.chunkCount, 1);
  assertEquals(typeof written[0].data.durationMs, "number");
});

Deno.test("summarize splits at the token boundary with overlap and merges partials", async () => {
  // Each segment is "[A]: w1 w2 w3" = 4 words -> round(4 * 1.3) = 5 tokens.
  // chunkTokens=10: two segments fit exactly (10 is not > 10), the third
  // overflows. overlapTokens=5 carries exactly the last segment forward.
  const transcript = JSON.stringify({
    segments: [
      { text: "alpha widget ships", speaker: "A" },
      { text: "bravo gadget waits", speaker: "A" },
      { text: "charlie gizmo tests", speaker: "A" },
    ],
  });
  const { context, written, logs } = fakeContext({
    chunkTokens: 10,
    overlapTokens: 5,
  });

  await withFakeOllama(
    [
      { body: { response: "PARTIAL ONE" } },
      { body: { response: "<think>x</think>PARTIAL TWO" } },
      { body: { response: "MERGED NOTE" } },
    ],
    async (calls) => {
      await model.methods.summarize.execute(
        { transcriptJson: transcript },
        context,
      );
      assertEquals(calls.length, 3);
      assert(
        calls[0].body.prompt.endsWith(
          "\n\n[A]: alpha widget ships [A]: bravo gadget waits",
        ),
      );
      assert(
        calls[1].body.prompt.endsWith(
          "\n\n[A]: bravo gadget waits [A]: charlie gizmo tests",
        ),
      );
      assert(calls[2].body.prompt.startsWith(MERGE_PROMPT_HEAD));
      assert(
        calls[2].body.prompt.endsWith(
          "Partial summaries follow:\n\n" +
            "[partial chunk 1/2]\nPARTIAL ONE\n\n---\n\n[partial chunk 2/2]\nPARTIAL TWO",
        ),
      );
    },
  );

  assertEquals(written[0].name, "latest");
  assertEquals(written[0].data.markdown, "MERGED NOTE");
  assertEquals(written[0].data.chunkCount, 2);
  assertEquals(logs.slice(0, 4), [
    "3 segments → 2 chunk(s)",
    "Chunk 1/2 (~10 tok)",
    "Chunk 2/2 (~10 tok)",
    "Merging 2 partials",
  ]);
});

Deno.test("summarize rejects invalid JSON, empty transcripts, and Ollama errors", async () => {
  await withFakeOllama(
    [{ status: 500, body: "synthetic overload" }],
    async (calls) => {
      const { context, written } = fakeContext();
      await assertRejects(
        () =>
          model.methods.summarize.execute({ transcriptJson: "{nope" }, context),
        Error,
        "transcriptJson is not valid JSON",
      );
      await assertRejects(
        () =>
          model.methods.summarize.execute(
            {
              transcriptJson: JSON.stringify({ segments: [{ text: " " }, {}] }),
            },
            context,
          ),
        Error,
        "No transcript content to summarize",
      );
      assertEquals(calls.length, 0);
      await assertRejects(
        () =>
          model.methods.summarize.execute(
            {
              transcriptJson: JSON.stringify({
                segments: [{ text: "Ship it." }],
              }),
            },
            context,
          ),
        Error,
        "Ollama error (500): synthetic overload",
      );
      assertEquals(calls.length, 1);
      assertEquals(written, []);
    },
  );
});

Deno.test("combine_notes strips the leading H1 and demotes analysis H1/H2 to H3", async () => {
  const { context, written } = fakeContext();
  await model.methods.combine_notes.execute(
    {
      notesMarkdown: "\n# Widget Sync\n\n- Ship Tuesday\n- Ask Bob\n",
      analysisMarkdown:
        "# TL;DR\nShip it.\n## Decisions\n- Tuesday\n### Detail\nkept",
      notesName: "2026-01-02 Widget Sync",
      analysisName: "2026-01-02 Widget Sync Analysis",
    },
    context,
  );

  assertEquals(written.length, 1);
  assertEquals(written[0].spec, "combined");
  assertEquals(written[0].name, "2026-01-02 Widget Sync");
  assertEquals(written[0].data.notesName, "2026-01-02 Widget Sync");
  assertEquals(
    written[0].data.analysisName,
    "2026-01-02 Widget Sync Analysis",
  );
  assertEquals(
    written[0].data.markdown,
    `# 2026-01-02 Widget Sync - Combined Notes

**Related:** [[2026-01-02 Widget Sync]] · [[2026-01-02 Widget Sync Analysis]]

This document preserves the original handwritten notes and adds the automated
analysis from the meeting recording.

---

## Handwritten Notes

- Ship Tuesday
- Ask Bob

---

## Automated Meeting Analysis

### TL;DR
Ship it.
### Decisions
- Tuesday
### Detail
kept

---

## Personal Observations

- Add any corrections, context, or follow-up thoughts here after reviewing both
  sources.

## Next Steps

- Review the action items above and move the confirmed follow-ups into your task
  system.
`,
  );
});

Deno.test("combine_notes uses explicit title/instanceName and keeps non-leading H1s", async () => {
  const { context, written } = fakeContext();
  await model.methods.combine_notes.execute(
    {
      notesMarkdown: "Intro line\n# Not Leading\nbody",
      analysisMarkdown: "plain",
      notesName: "n",
      analysisName: "a",
      title: "Custom Title",
      instanceName: "inst",
    },
    context,
  );
  const md = written[0].data.markdown as string;
  assert(md.startsWith("# Custom Title - Combined Notes\n"));
  assertStringIncludes(
    md,
    "## Handwritten Notes\n\nIntro line\n# Not Leading\nbody\n\n---",
  );
  assertEquals(written[0].name, "inst");
});

Deno.test("write_note creates nested dirs and reports UTF-8 byte count", async () => {
  const root = await Deno.makeTempDir({ prefix: "meeting-summarizer-test-" });
  try {
    const outputDir = `${root}/notes/2026`;
    const markdown = "# Café sync\n";
    const { context, written } = fakeContext();
    const result = await model.methods.write_note.execute(
      { markdown, outputDir, filename: "cafe.md" },
      context,
    );

    assertEquals(await Deno.readTextFile(`${outputDir}/cafe.md`), markdown);
    assertEquals(written, [{
      spec: "noteFile",
      name: "cafe.md",
      data: {
        filePath: `${outputDir}/cafe.md`,
        filename: "cafe.md",
        outputDir,
        byteCount: 13, // "é" is two bytes in UTF-8; 12 chars -> 13 bytes
      },
    }]);
    assertEquals(result, { dataHandles: [{ handle: "noteFile/cafe.md" }] });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
