import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { model } from "./markdown_blog.ts";

// Match the site's integration-test style without adding a testing dependency.
async function fixture() {
  const repoDir = await Deno.makeTempDir({ prefix: "markdown-blog-test-" });
  const resources = new Map<string, unknown>();
  const context = {
    repoDir,
    globalArgs: model.globalArguments.parse({
      siteTitle: 'Notes & "Things"',
      outputDir: "public/articles",
    }),
    extensionFile: (path: string) =>
      fileURLToPath(new URL(path, import.meta.url)),
    logger: { info() {} },
    writeResource: (spec: string, name: string, data: unknown) => {
      const schema =
        model.resources[spec as keyof typeof model.resources].schema;
      assert.deepEqual(schema.parse(data), data);
      resources.set(name, data);
      return Promise.resolve({ name });
    },
  };
  const source = await Deno.readTextFile(
    new URL("examples/post.md", import.meta.url),
  );
  await Deno.writeTextFile(`${repoDir}/draft.md`, source);
  const preview = async () => {
    await model.methods.preview.execute({ sourcePath: "draft.md" }, context);
    return model.resources.preview.schema.parse(
      resources.get("preview-a-small-publishing-routine"),
    );
  };
  return { repoDir, context, source, preview };
}

Deno.test("preview/write/verify preserve exact public bytes and reject stale snapshots", async () => {
  const f = await fixture();
  try {
    const p = await f.preview();
    const html = await Deno.readTextFile(`${f.repoDir}/${p.previewPath}`);
    assert.deepEqual(await f.preview(), p);
    assert.match(
      html,
      /<h2 id="section-three-deliberate-steps">Three deliberate steps<\/h2>/,
    );
    assert.match(html, /<table>/);
    assert.match(html, /class="language-bash"/);
    assert.match(html, /Notes &amp; &quot;Things&quot;/);
    assert.doesNotMatch(html, /Private|privateStatus|Draft workspace/);
    await assert.rejects(
      Deno.stat(`${f.repoDir}/${p.outputPath}`),
      Deno.errors.NotFound,
    );
    const write = (
      renderHash: string,
      operation: "create" | "update" = "create",
    ) =>
      model.methods.write.execute({
        sourcePath: "draft.md",
        expectedRenderHash: renderHash,
        operation,
      }, f.context);
    await assert.rejects(write(p.renderHash, "update"), /requires/);
    await Deno.writeTextFile(
      `${f.repoDir}/draft.md`,
      f.source.replace("different jobs", "separate tasks"),
    );
    await assert.rejects(write(p.renderHash), /changed/);
    await Deno.writeTextFile(`${f.repoDir}/draft.md`, f.source);
    await write(p.renderHash);
    assert.equal(await Deno.readTextFile(`${f.repoDir}/${p.outputPath}`), html);
    const verify = () =>
      model.methods.verify.execute({
        sourcePath: "draft.md",
        expectedHtmlHash: p.htmlHash,
      }, f.context);
    await verify();
    const existing = await f.preview();
    await assert.rejects(write(existing.renderHash), /requires/);
    await Deno.writeTextFile(`${f.repoDir}/${p.outputPath}`, `\uFEFF${html}`);
    await assert.rejects(verify(), /Verification failed/);
    await assert.rejects(write(existing.renderHash, "update"), /changed/);
    const replacement = await f.preview();
    await write(replacement.renderHash, "update");
    await verify();
    await Deno.writeTextFile(
      `${f.repoDir}/draft.md`,
      f.source.replace("different jobs", "separate tasks"),
    );
    await assert.rejects(verify(), /Verification failed/);
    const changed = await f.preview();
    await write(changed.renderHash, "update");
    assert.match(
      await Deno.readTextFile(`${f.repoDir}/${p.outputPath}`),
      /separate tasks/,
    );
  } finally {
    await Deno.remove(f.repoDir, { recursive: true });
  }
});

Deno.test("templates and output targets are pinned; symlink escapes and edited previews fail closed", async () => {
  const f = await fixture();
  try {
    f.context.globalArgs.templatePath = "custom.html";
    const template =
      "<title>{{title}}</title><main>{{body}}</main><footer>{{siteTitle}}</footer>";
    await Deno.writeTextFile(`${f.repoDir}/custom.html`, template);
    const p = await f.preview();
    const write = () =>
      model.methods.write.execute({
        sourcePath: "draft.md",
        expectedRenderHash: p.renderHash,
        operation: "create",
      }, f.context);
    await Deno.writeTextFile(`${f.repoDir}/custom.html`, template + "\n");
    await assert.rejects(write(), /changed/);
    await Deno.writeTextFile(`${f.repoDir}/custom.html`, template);
    f.context.globalArgs.outputDir = "elsewhere";
    await assert.rejects(write(), /changed/);
    f.context.globalArgs.outputDir = "public/articles";
    await Deno.writeTextFile(`${f.repoDir}/${p.previewPath}`, "edited preview");
    await assert.rejects(write(), /modified/);
    await assert.rejects(f.preview(), /modified/);
    await Deno.symlink(f.repoDir, `${f.repoDir}/linked`);
    f.context.globalArgs.outputDir = "linked/articles";
    await assert.rejects(f.preview(), /symlinks/);
    f.context.globalArgs.outputDir = "../escape";
    await assert.rejects(f.preview());
    f.context.globalArgs.outputDir = "public/articles";
    await Deno.writeTextFile(
      `${f.repoDir}/custom.html`,
      "{{unknown}} {{body}}",
    );
    await assert.rejects(f.preview(), /Unknown template/);
    await Deno.writeTextFile(`${f.repoDir}/custom.html`, "missing body");
    await assert.rejects(f.preview(), /exactly one/);
  } finally {
    await Deno.remove(f.repoDir, { recursive: true });
  }
});

Deno.test("unsafe Markdown fails without publication, while literal code and escaped HTML survive", async () => {
  const f = await fixture();
  const wrap = (body: string) =>
    f.source.replace(
      /(?<=<!-- blog:content:start -->)[\s\S]*(?=<!-- blog:content:end -->)/,
      `\n${body}\n`,
    );
  try {
    for (
      const source of [
        wrap("[bad](javascript:alert%281%29)"),
        wrap("![bad](data:image/svg+xml;base64,AAAA)"),
        wrap("[private](../notes.md)"),
        wrap("[bad](//example.com/)"),
        wrap("[[Private note]]"),
        wrap("%%hidden%%"),
        wrap("> [!note]\n> private"),
        wrap("# Duplicate page title"),
        wrap("```{.python #id}\npass\n```"),
        f.source.replace(
          "slug: a-small-publishing-routine",
          "slug: ../../escape",
        ),
        f.source.replace("2026-10-15", "2026-02-30"),
        f.source.replace("excerpt:", "title: Duplicate\nexcerpt:"),
        f.source.replace(
          "title: A Small Publishing Routine",
          "title: &a Alias\nother: *a",
        ),
        f.source.replace("<!-- blog:content:end -->", ""),
        "x".repeat(1024 * 1024 + 1),
      ]
    ) {
      await Deno.writeTextFile(`${f.repoDir}/draft.md`, source);
      await assert.rejects(f.preview());
      await assert.rejects(
        Deno.stat(`${f.repoDir}/public`),
        Deno.errors.NotFound,
      );
    }
    await Deno.writeTextFile(
      `${f.repoDir}/draft.md`,
      wrap(
        "`[[literal]]` and {{title}}\n\n<script>alert(1)</script>\n\n```diagram\nA -> B\n```",
      ),
    );
    const p = await f.preview();
    const html = await Deno.readTextFile(`${f.repoDir}/${p.previewPath}`);
    assert.match(html, /<code>\[\[literal\]\]<\/code>/);
    assert.match(html, /and \{\{title\}\}/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /class="language-text"/);
  } finally {
    await Deno.remove(f.repoDir, { recursive: true });
  }
});
