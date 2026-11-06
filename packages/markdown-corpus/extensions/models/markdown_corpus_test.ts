import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { model } from "./markdown_corpus.ts";

type Corpus = ReturnType<typeof model.resources.corpus.schema.parse>;

function makeContext(globalArgs: Record<string, unknown>) {
  const writes: Array<{ spec: string; instance: string; data: unknown }> = [];
  const logs: Array<{ msg: string; props?: Record<string, unknown> }> = [];
  return {
    writes,
    logs,
    context: {
      globalArgs: model.globalArguments.parse(globalArgs),
      writeResource: (spec: string, instance: string, data: unknown) => {
        writes.push({ spec, instance, data });
        return Promise.resolve({ name: instance });
      },
      logger: {
        info: (msg: string, props?: Record<string, unknown>) => logs.push({ msg, props }),
      },
    },
  };
}

async function ingest(globalArgs: Record<string, unknown>) {
  const ctx = makeContext(globalArgs);
  const result = await model.methods.ingest.execute({}, ctx.context);
  return {
    ...ctx,
    result,
    corpus: model.resources.corpus.schema.parse(ctx.writes[0].data) as Corpus,
  };
}

/** A small corpus with dated, undated, nested, and non-markdown files. */
async function makeCorpus(): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${dir}/2026-01-05-notes.md`,
    [
      "# Weekly Notes",
      "## Blockers",
      "##### too deep",
      "#nospace",
      "Shipped #1234 and #12 and PR 890, PR5555.",
      "Tickets ENG-42, OPS-7, ENG-42 again, eng-9, TOOLONG-1.",
      "Blocked on review; BLOCKED again.",
    ].join("\n"),
  );
  await Deno.writeTextFile(
    `${dir}/2025_12_30 retro.md`,
    "### Retro\nNothing blocked.\nShipped the thing.",
  );
  await Deno.writeTextFile(`${dir}/Standup-misc.md`, "standup words here");
  await Deno.writeTextFile(`${dir}/2026-02-01.txt`, "not markdown");
  await Deno.mkdir(`${dir}/2026`);
  await Deno.writeTextFile(`${dir}/2026/2026-03-01-nested.md`, "nested shipped");
  return dir;
}

Deno.test("global arguments require a directory and apply defaults", () => {
  assertThrows(() => model.globalArguments.parse({}));
  assertEquals(model.globalArguments.parse({ directory: "/notes" }), {
    directory: "/notes",
    datePrefixes: [],
    nameContains: [],
    signalKeywords: [],
    maxBodyChars: 4000,
    recursive: false,
  });
});

Deno.test("ingest extracts headings, refs, dates and word counts per file", async () => {
  const dir = await makeCorpus();
  try {
    const { corpus, writes, result } = await ingest({ directory: dir });
    assertEquals(result, { dataHandles: [{ name: "current" }] });
    assertEquals(writes[0].spec, "corpus");
    assertEquals(writes[0].instance, "current");
    // Top level only; .txt ignored; sorted by inferred date, then filename.
    assertEquals(corpus.files.map((f) => f.file), [
      "2025_12_30 retro.md",
      "2026-01-05-notes.md",
      "Standup-misc.md",
    ]);
    const [retro, notes, standup] = corpus.files;
    assertEquals(retro.inferredDate, "2025-12-30");
    assertEquals(retro.headings, ["Retro"]);
    assertEquals(standup.inferredDate, null);
    assertEquals(standup.wordCount, 3);
    assertEquals(notes.headings, ["Weekly Notes", "Blockers"]);
    assertEquals(notes.prRefs, ["#1234", "#890", "#5555"]);
    assertEquals(notes.ticketRefs, ["ENG-42", "OPS-7"]);
    assertEquals(corpus.fileCount, 3);
    assertEquals(corpus.totalWords, corpus.files.reduce((s, f) => s + f.wordCount, 0));
    assertEquals(corpus.dateRange, { earliest: "2025-12-30", latest: "2026-01-05" });
    assertEquals(corpus.directory, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ingest filters by date prefix and case-insensitive name substring", async () => {
  const dir = await makeCorpus();
  try {
    const byPrefix = await ingest({ directory: dir, datePrefixes: ["2026-01"] });
    assertEquals(byPrefix.corpus.files.map((f) => f.file), ["2026-01-05-notes.md"]);

    const byName = await ingest({
      directory: dir,
      datePrefixes: ["2026-01"],
      nameContains: ["STANDUP", "retro"],
    });
    assertEquals(byName.corpus.files.map((f) => f.file), [
      "2025_12_30 retro.md",
      "2026-01-05-notes.md",
      "Standup-misc.md",
    ]);

    const nameOnly = await ingest({ directory: dir, nameContains: ["retro"] });
    assertEquals(nameOnly.corpus.files.map((f) => f.file), ["2025_12_30 retro.md"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ingest descends into subdirectories only when recursive, using relative paths", async () => {
  const dir = await makeCorpus();
  try {
    // Without recursion the nested 2026-03 note is invisible, so nothing matches.
    await assertRejects(
      () => ingest({ directory: dir, datePrefixes: ["2026-03"] }),
      Error,
      "No markdown files matched",
    );

    const deep = await ingest({ directory: `${dir}/`, datePrefixes: ["2026-03"], recursive: true });
    assertEquals(deep.corpus.files.map((f) => [f.file, f.inferredDate]), [
      ["2026/2026-03-01-nested.md", "2026-03-01"],
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ingest records signal hits per line and sorts rollups by count", async () => {
  const dir = await makeCorpus();
  try {
    const { corpus, logs } = await ingest({
      directory: dir,
      signalKeywords: ["Shipped", "blocked", "absent"],
    });
    // Directory iteration order is unspecified, so compare as a sorted set.
    // Matching is case-insensitive, the original keyword casing is reported, and
    // a line with the keyword twice ("Blocked ... BLOCKED") yields one hit.
    const key = (h: { keyword: string; file: string; line: string }) =>
      `${h.keyword}|${h.file}|${h.line}`;
    assertEquals(corpus.signalHits.map(key).sort(), [
      "Shipped|2025_12_30 retro.md|Shipped the thing.",
      "Shipped|2026-01-05-notes.md|Shipped #1234 and #12 and PR 890, PR5555.",
      "blocked|2025_12_30 retro.md|Nothing blocked.",
      "blocked|2026-01-05-notes.md|Blocked on review; BLOCKED again.",
    ]);
    assertEquals(corpus.signalRollups.map((r) => [r.keyword, r.count, r.files.sort()]), [
      ["Shipped", 2, ["2025_12_30 retro.md", "2026-01-05-notes.md"]],
      ["blocked", 2, ["2025_12_30 retro.md", "2026-01-05-notes.md"]],
      ["absent", 0, []],
    ]);
    assertEquals(logs[0].props?.h, 4);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ingest truncates bodies to maxBodyChars", async () => {
  const dir = await makeCorpus();
  try {
    const { corpus } = await ingest({ directory: dir, nameContains: ["standup"], maxBodyChars: 7 });
    assertEquals(corpus.files[0].body, "standup");
    assertEquals(corpus.files[0].wordCount, 3);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ingest throws without writing when no markdown files match", async () => {
  const dir = await makeCorpus();
  try {
    const { context, writes } = makeContext({
      directory: dir,
      datePrefixes: ["1999"],
      nameContains: ["nope"],
    });
    await assertRejects(
      () => model.methods.ingest.execute({}, context),
      Error,
      `No markdown files matched in ${dir} (datePrefixes=1999 nameContains=nope)`,
    );
    assertEquals(writes.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
