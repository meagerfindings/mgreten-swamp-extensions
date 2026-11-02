import { deepStrictEqual as equal, ok, rejects } from "node:assert/strict";
import { model, Packet } from "./election_packet.ts";
import { model as pdf } from "./election_pdf.ts";

async function fixture() {
  return Packet.parse(
    JSON.parse(
      await Deno.readTextFile(
        new URL("../../examples/election-packet.json", import.meta.url),
      ),
    ).packet,
  );
}
function context() {
  const written: Record<string, unknown> = {};
  return {
    written,
    writeResource: (spec: string, name: string, value: unknown) => {
      const schemas = model.resources;
      schemas[spec as keyof typeof schemas].schema.parse(value);
      written[spec] = value;
      return Promise.resolve({ name });
    },
  };
}

Deno.test("prepare resets research; render preserves ballot order, adjacent positions and distinct judicial remedies", async () => {
  const packet = await fixture();
  const ctx = context();
  await model.methods.prepare.execute({
    ballot: packet.ballot,
    asOf: packet.asOf,
    sources: packet.sources,
  }, ctx);
  const draft = Packet.parse(ctx.written.draft);
  equal(draft.subjects.map((s) => s.id), [
    "council-b",
    "council-a",
    "measure-1",
    "judge-1",
  ]);
  ok(draft.subjects.every((s) => !s.reviewed));
  await rejects(
    () => model.methods.render.execute({ packet: draft }, ctx),
    /research pending/,
  );
  await model.methods.render.execute({ packet }, ctx);
  const doc = ctx.written.document as {
    markdown: string;
    html: string;
    appendixMarkdown: string;
    unknowns: number;
  };
  ok(doc.markdown.indexOf("Candidate B") < doc.markdown.indexOf("Candidate A"));
  ok(
    doc.markdown.indexOf("Example Civic Association: oppose") >
      doc.markdown.indexOf("Example Measure 1"),
  );
  ok(
    doc.markdown.indexOf("Example Civic Association: oppose") <
      doc.markdown.indexOf("Judicial retention overview"),
  );
  ok(doc.markdown.includes("Example Governor in 2020; took office in 2021"));
  ok(!doc.markdown.includes("Example v. Example"));
  ok(doc.appendixMarkdown.includes("remedy: new trial"));
  ok(doc.appendixMarkdown.includes("Not an acquittal or release order"));
  ok(doc.appendixMarkdown.includes("allegation:"));
  ok(!doc.appendixMarkdown.includes("Council — Example Candidate B |"));
  equal(doc.unknowns, 1);
});

Deno.test("audit catches omissions, wrong kinds, missing citations and 30-day / 55-word boundaries", async () => {
  const ctx = context();
  const run = async (packet: Awaited<ReturnType<typeof fixture>>) => {
    await model.methods.audit.execute({ packet }, ctx);
    return ctx.written.audit as { ready: boolean; issues: string[] };
  };
  const packet = await fixture();
  packet.sources[0].accessed = "2026-10-03";
  packet.subjects[0].summary.text = Array(55).fill("word").join(" ");
  equal((await run(packet)).ready, true);
  packet.sources[0].accessed = "2026-10-02";
  packet.subjects[0].summary.text += " word";
  packet.subjects[0].summary.sources = [];
  packet.subjects = packet.subjects.filter((s) => s.id !== "council-b");
  packet.ballot.items[3].kind = "candidate";
  const { issues, ready } = await run(packet);
  equal(ready, false);
  for (
    const fragment of [
      "over 30 days",
      "55 words",
      "citation required",
      "missing ballot item",
      "not matched",
    ]
  ) {
    ok(issues.some((s) => s.includes(fragment)), fragment);
  }
  await rejects(
    () => model.methods.render.execute({ packet }, ctx),
    /not ready/,
  );
  const unknown = await fixture();
  unknown.subjects[0].summary.sources = ["missing"];
  ok(
    (await run(unknown)).issues.some((s) =>
      s.includes("unknown source missing")
    ),
  );
  unknown.subjects.push(unknown.subjects[0]);
  unknown.ballot.style.confirmed = false;
  ok((await run(unknown)).issues.some((s) => s.includes("Duplicate subject")));
  ok((await run(unknown)).issues.some((s) => s.includes("unconfirmed")));
});

Deno.test("strict public-evidence inputs reject voter fields and private attachment URLs; HTML treats prose as text", async () => {
  const packet = await fixture();
  equal(
    Packet.safeParse({ ...packet, voterPreferences: "private marker" }).success,
    false,
  );
  equal(Packet.safeParse({ ...packet, votes: [] }).success, false);
  equal(
    Packet.safeParse({
      ...packet,
      subjects: [{ ...packet.subjects[0], myVote: "yes" }],
    }).success,
    false,
  );
  const privateUrl = structuredClone(packet);
  privateUrl.sources[0].url =
    "https://ampcode.com/user-content/attachments/private-file.pdf";
  equal(Packet.safeParse(privateUrl).success, false);
  packet.subjects[0].summary.text =
    '<script>alert("x")</script> | [link](https://example.org)';
  const ctx = context();
  await model.methods.render.execute({ packet }, ctx);
  const doc = ctx.written.document as { html: string; markdown: string };
  ok(!doc.html.includes("<script>"));
  ok(doc.html.includes("&lt;script&gt;"));
  ok(doc.markdown.includes("\\|"));
});

Deno.test("PDF export refuses existing files, traversal and symlink descendants before rendering", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  try {
    const packet = await fixture();
    const ctx = { ...context(), globalArgs: { outputRoot: root } };
    await Deno.writeTextFile(`${root}/existing.pdf`, "preserve original");
    await rejects(
      () => pdf.methods.export.execute({ packet, outputStem: "existing" }, ctx),
      /overwrite/,
    );
    equal(await Deno.readTextFile(`${root}/existing.pdf`), "preserve original");
    await rejects(() =>
      pdf.methods.export.execute({ packet, outputStem: "../escape" }, ctx)
    );
    await Deno.symlink(root, `${root}/link`);
    await rejects(
      () =>
        pdf.methods.export.execute({ packet, outputStem: "link/escape" }, ctx),
      /symlinks/,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
