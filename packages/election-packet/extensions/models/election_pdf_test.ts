import { deepStrictEqual as equal, rejects } from "node:assert/strict";
import { Packet } from "./election_packet.ts";
import { model } from "./election_pdf.ts";

async function fixture() {
  return Packet.parse(
    JSON.parse(
      await Deno.readTextFile(
        new URL("../../examples/election-packet.json", import.meta.url),
      ),
    ).packet,
  );
}

Deno.test("PDF export refuses existing files, traversal and symlink descendants before rendering", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  try {
    const packet = await fixture();
    const ctx = {
      globalArgs: { outputRoot: root },
      writeResource: (_spec: string, name: string, data: unknown) => {
        model.resources.receipt.schema.parse(data);
        return Promise.resolve({ name });
      },
    };
    await Deno.writeTextFile(`${root}/existing.pdf`, "preserve original");
    await rejects(
      () =>
        model.methods.export.execute({ packet, outputStem: "existing" }, ctx),
      /overwrite/,
    );
    equal(await Deno.readTextFile(`${root}/existing.pdf`), "preserve original");
    await rejects(() =>
      model.methods.export.execute({ packet, outputStem: "../escape" }, ctx)
    );
    await Deno.symlink(root, `${root}/link`);
    await rejects(
      () =>
        model.methods.export.execute(
          { packet, outputStem: "link/escape" },
          ctx,
        ),
      /symlinks/,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("PDF export saves distinct documents and leaves no files when either renderer fails", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const originalPath = Deno.env.get("PATH");
  try {
    await Deno.mkdir(`${root}/bin`);
    await Deno.mkdir(`${root}/output`);
    Deno.env.set("PATH", `${root}/bin:${originalPath ?? ""}`);
    const packet = await fixture();
    const receipts: unknown[] = [];
    const ctx = {
      globalArgs: { outputRoot: `${root}/output` },
      writeResource: (_spec: string, name: string, data: unknown) => {
        receipts.push(model.resources.receipt.schema.parse(data));
        return Promise.resolve({ name });
      },
    };
    // A local renderer double exercises real stdin/stdout without downloading Python.
    await Deno.writeTextFile(
      `${root}/bin/uvx`,
      `#!/bin/sh
html=$(cat)
case "$html" in
  *"evidence appendix"*) printf '%s' '%PDF-appendix-fixture' ;;
  *) printf '%s' '%PDF-concise-fixture' ;;
esac
`,
      { mode: 0o755 },
    );
    await model.methods.export.execute({ packet, outputStem: "success" }, ctx);
    equal(
      await Deno.readTextFile(`${root}/output/success.pdf`),
      "%PDF-concise-fixture",
    );
    equal(
      await Deno.readTextFile(`${root}/output/success - Evidence.pdf`),
      "%PDF-appendix-fixture",
    );
    equal(receipts, [{
      files: [
        `${root}/output/success.pdf`,
        `${root}/output/success - Evidence.pdf`,
      ],
      renderer: "WeasyPrint 68.0",
    }]);
    for (const mode of ["first-failure", "appendix-failure", "invalid-pdf"]) {
      await Deno.writeTextFile(
        `${root}/bin/uvx`,
        `#!/bin/sh
html=$(cat)
case '${mode}' in
  first-failure) printf '%s' '%PDF-incomplete'; printf '%s' 'renderer unavailable' >&2; exit 1 ;;
  invalid-pdf) printf '%s' 'not a PDF'; exit 0 ;;
esac
case "$html" in
  *"evidence appendix"*) printf '%s' '%PDF-incomplete'; printf '%s' 'appendix failed' >&2; exit 1 ;;
  *) printf '%s' '%PDF-concise-fixture' ;;
esac
`,
      );
      await rejects(
        () => model.methods.export.execute({ packet, outputStem: mode }, ctx),
        /PDF export failed/,
      );
    }
    equal(
      [...Deno.readDirSync(`${root}/output`)].map((f) => f.name).sort(),
      ["success - Evidence.pdf", "success.pdf"],
    );
    equal(receipts.length, 1);
  } finally {
    if (originalPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", originalPath);
    await Deno.remove(root, { recursive: true });
  }
});
