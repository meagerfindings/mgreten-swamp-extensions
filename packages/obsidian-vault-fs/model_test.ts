/** Tests for the obsidian-vault-fs model, run against a throwaway temp vault.
 *
 * Every note is synthetic text created by the test; no real vault is touched.
 */

// deno-lint-ignore no-import-prefix
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./model.ts";

interface Written {
  spec: string;
  name: string;
  data: Record<string, unknown>;
}

// deno-lint-ignore no-explicit-any
type AnyArgs = any;

async function withVault(
  fn: (
    vault: string,
    ctx: ReturnType<typeof fakeContext>,
  ) => Promise<void>,
  globalOverrides: Record<string, unknown> = {},
) {
  const parent = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "obsidian-vault-fs-test-" }),
  );
  const vault = `${parent}/vault`;
  await Deno.mkdir(vault);
  try {
    await fn(vault, fakeContext({ vaultRoot: vault, ...globalOverrides }));
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
}

function fakeContext(globalArgs: Record<string, unknown>) {
  const written: Written[] = [];
  const logs: Array<[string, Record<string, unknown> | undefined]> = [];
  const context = {
    globalArgs: model.globalArguments.parse(globalArgs),
    logger: {
      info: (msg: string, fields?: Record<string, unknown>) =>
        logs.push([msg, fields]),
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

type MethodName = keyof typeof model.methods;

/** Parse args through the method's Zod schema (applying defaults) and execute. */
function run(
  ctx: ReturnType<typeof fakeContext>,
  method: MethodName,
  args: Record<string, unknown>,
) {
  const m = model.methods[method];
  const parsed: AnyArgs = m.arguments.parse(args);
  return m.execute(parsed, ctx.context);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

Deno.test("global arguments apply documented defaults", () => {
  assertEquals(model.globalArguments.parse({}), {
    vaultRoot: "/vault",
    defaultFileMode: 0o664,
    defaultDirectoryMode: 0o775,
    blockDotObsidian: true,
  });
  assert(!model.globalArguments.safeParse({ defaultFileMode: 1.5 }).success);
  assert(
    !model.methods.setProperties.arguments.safeParse({
      file: "a.md",
      properties: { nested: { no: true } },
    }).success,
  );
  assert(!model.methods.list.arguments.safeParse({ limit: 0 }).success);
});

Deno.test("write creates nested notes, guards overwrite, and reports action", async () => {
  await withVault(async (vault, ctx) => {
    await run(ctx, "write", {
      file: "Meetings/2026/widget.md",
      content: "Speaker A: Let's ship the widget on Tuesday.",
    });
    assertEquals(
      await Deno.readTextFile(`${vault}/Meetings/2026/widget.md`),
      "Speaker A: Let's ship the widget on Tuesday.",
    );
    assertEquals(ctx.written[0].spec, "writeResult");
    assertEquals(ctx.written[0].name, "Meetings_2026_widget.md");
    assertEquals(ctx.written[0].data.file, "Meetings/2026/widget.md");
    assertEquals(
      ctx.written[0].data.absolutePath,
      `${vault}/Meetings/2026/widget.md`,
    );
    assertEquals(ctx.written[0].data.action, "created");
    assertEquals(ctx.written[0].data.bytes, 44);

    await assertRejects(
      () =>
        run(ctx, "write", { file: "Meetings/2026/widget.md", content: "x" }),
      Error,
      "Refusing to overwrite existing note without overwrite=true: Meetings/2026/widget.md",
    );
    assertEquals(
      await Deno.readTextFile(`${vault}/Meetings/2026/widget.md`),
      "Speaker A: Let's ship the widget on Tuesday.",
    );

    await run(ctx, "write", {
      file: "Meetings/2026/widget.md",
      content: "Speaker A: Let's ship the widget on Tuesday.",
      overwrite: true,
    });
    assertEquals(ctx.written[1].data.action, "unchanged");

    await run(ctx, "write", {
      file: "Meetings/2026/widget.md",
      content: "Café ☕",
      overwrite: true,
    });
    assertEquals(ctx.written[2].data.action, "updated");
    assertEquals(ctx.written[2].data.bytes, 9); // é=2 bytes, ☕=3 bytes
  });
});

Deno.test("read accepts vault-relative and in-vault absolute paths", async () => {
  await withVault(async (vault, ctx) => {
    await Deno.mkdir(`${vault}/Inbox`);
    await Deno.writeTextFile(
      `${vault}/Inbox/todo.md`,
      "- buy synthetic milk\n",
    );

    await run(ctx, "read", { file: "./Inbox/../Inbox/todo.md" });
    await run(ctx, "read", { file: `${vault}/Inbox/todo.md` });

    for (const w of ctx.written) {
      assertEquals(w.spec, "note");
      assertEquals(w.name, "Inbox_todo.md");
      assertEquals(w.data.file, "Inbox/todo.md");
      assertEquals(w.data.absolutePath, `${vault}/Inbox/todo.md`);
      assertEquals(w.data.content, "- buy synthetic milk\n");
      assertEquals(w.data.size, 21);
      assertEquals(typeof w.data.modifiedAt, "string");
    }
    assertEquals(ctx.written.length, 2);
  });
});

Deno.test("path traversal and out-of-vault absolute paths are rejected", async () => {
  await withVault(async (vault, ctx) => {
    const parent = vault.slice(0, vault.lastIndexOf("/"));
    await Deno.writeTextFile(`${parent}/outside.md`, "outside");
    await Deno.mkdir(`${parent}/vault-evil`);
    await Deno.writeTextFile(`${parent}/vault-evil/x.md`, "evil");

    await assertRejects(
      () => run(ctx, "read", { file: "../outside.md" }),
      Error,
      "Path escapes vault root: ../outside.md",
    );
    await assertRejects(
      () => run(ctx, "read", { file: "notes/../../outside.md" }),
      Error,
      "Path escapes vault root",
    );
    await assertRejects(
      () => run(ctx, "read", { file: `${vault}/../outside.md` }),
      Error,
      "Path is outside vault root",
    );
    // Sibling directory sharing the vault name as a prefix must not pass.
    await assertRejects(
      () => run(ctx, "read", { file: `${parent}/vault-evil/x.md` }),
      Error,
      "Path is outside vault root",
    );
    await assertRejects(
      () =>
        run(ctx, "write", {
          file: "../escaped.md",
          content: "should not land",
        }),
      Error,
      "Path escapes vault root",
    );
    await assertRejects(
      () => run(ctx, "append", { file: "a/../../escaped.md", content: "no" }),
      Error,
      "Path escapes vault root",
    );
    await assertRejects(
      () => run(ctx, "list", { folder: ".." }),
      Error,
      "Path escapes vault root",
    );
    assertEquals(await exists(`${parent}/escaped.md`), false);
    assertEquals(await Deno.readTextFile(`${parent}/outside.md`), "outside");
    assertEquals(ctx.written, []);

    // ".." that stays inside the vault is allowed and normalized.
    await run(ctx, "write", { file: "a/b/../c.md", content: "ok" });
    assertEquals(ctx.written[0].data.file, "a/c.md");
    assertEquals(await Deno.readTextFile(`${vault}/a/c.md`), "ok");
  });
});

Deno.test(".obsidian internals are blocked unless explicitly allowed", async () => {
  await withVault(async (vault, ctx) => {
    await Deno.mkdir(`${vault}/.obsidian`);
    await Deno.writeTextFile(`${vault}/.obsidian/app.json`, "{}");
    await assertRejects(
      () => run(ctx, "read", { file: ".obsidian/app.json" }),
      Error,
      "Refusing to operate on .obsidian internals",
    );
    await assertRejects(
      () => run(ctx, "read", { file: "x/../.obsidian/app.json" }),
      Error,
      "Refusing to operate on .obsidian internals",
    );
    await run(ctx, "read", {
      file: ".obsidian/app.json",
      allowDotObsidian: true,
    });
    assertEquals(ctx.written[0].data.content, "{}");
  });

  await withVault(async (vault, ctx) => {
    await Deno.mkdir(`${vault}/.obsidian`);
    await Deno.writeTextFile(`${vault}/.obsidian/app.json`, "{}");
    await run(ctx, "read", { file: ".obsidian/app.json" });
    assertEquals(ctx.written[0].data.file, ".obsidian/app.json");
  }, { blockDotObsidian: false });
});

Deno.test("list filters by extension, respects recursion and limit", async () => {
  await withVault(async (vault, ctx) => {
    await Deno.mkdir(`${vault}/Notes/Deep`, { recursive: true });
    await Deno.writeTextFile(`${vault}/root.md`, "r");
    await Deno.writeTextFile(`${vault}/Notes/a.md`, "a");
    await Deno.writeTextFile(`${vault}/Notes/b.txt`, "b");
    await Deno.writeTextFile(`${vault}/Notes/Deep/c.md`, "c");

    await run(ctx, "list", { folder: "Notes" });
    const flat = ctx.written[0];
    assertEquals(flat.spec, "fileList");
    assertEquals(flat.name, "Notes");
    assertEquals(flat.data.folder, "Notes");
    assertEquals(flat.data.recursive, false);
    assertEquals(flat.data.count, 1);
    const flatFiles = flat.data.files as Array<Record<string, unknown>>;
    assertEquals(flatFiles[0].file, "Notes/a.md");
    assertEquals(flatFiles[0].isFile, true);
    assertEquals(flatFiles[0].size, 1);

    await run(ctx, "list", { recursive: true });
    const all = ctx.written[1];
    assertEquals(all.name, "vault-root");
    assertEquals(
      (all.data.files as Array<{ file: string }>).map((f) => f.file).sort(),
      ["Notes/Deep/c.md", "Notes/a.md", "root.md"],
    );

    await run(ctx, "list", { folder: "Notes", ext: ".txt" });
    assertEquals(
      (ctx.written[2].data.files as Array<{ file: string }>).map((f) => f.file),
      ["Notes/b.txt"],
    );

    await run(ctx, "list", { recursive: true, ext: "", limit: 2 });
    assertEquals(ctx.written[3].data.count, 2);
  });
});

Deno.test("append creates then appends with separator", async () => {
  await withVault(async (vault, ctx) => {
    await run(ctx, "append", { file: "Log/daily.md", content: "first" });
    await run(ctx, "append", {
      file: "Log/daily.md",
      content: "second",
      separator: "\n---\n",
    });
    await run(ctx, "append", { file: "Log/daily.md", content: "third" });
    assertEquals(
      await Deno.readTextFile(`${vault}/Log/daily.md`),
      "first\n---\nsecond\nthird",
    );
    assertEquals(ctx.written[0].name, "append-Log_daily.md");
    assertEquals(ctx.written.map((w) => w.data.action), [
      "appended",
      "appended",
      "appended",
    ]);
    assertEquals(ctx.written[1].data.bytes, 6);
  });
});

Deno.test("search matches markdown lines case-insensitively, by regex, and truncates", async () => {
  await withVault(async (vault, ctx) => {
    await Deno.mkdir(`${vault}/Proj`);
    await Deno.writeTextFile(
      `${vault}/Proj/one.md`,
      "Widget kickoff\r\nnothing here\nship the WIDGET",
    );
    await Deno.writeTextFile(`${vault}/Proj/skip.txt`, "widget in txt");

    await run(ctx, "search", { query: "widget", folder: "Proj" });
    const r = ctx.written[0];
    assertEquals(r.spec, "searchResults");
    assertEquals(r.name, "main");
    assertEquals(r.data.count, 2);
    assertEquals(r.data.truncated, false);
    assertEquals(
      (r.data.matches as Array<Record<string, unknown>>).map((m) => [
        m.file,
        m.line,
        m.text,
      ]),
      [["Proj/one.md", 1, "Widget kickoff"], [
        "Proj/one.md",
        3,
        "ship the WIDGET",
      ]],
    );

    await run(ctx, "search", { query: "widget", caseSensitive: true });
    assertEquals(ctx.written[1].data.count, 0);

    await run(ctx, "search", { query: "^ship\\b", regex: true });
    assertEquals(ctx.written[2].data.count, 1);

    await run(ctx, "search", { query: "widget", limit: 1 });
    assertEquals(ctx.written[3].data.count, 1);
    assertEquals(ctx.written[3].data.truncated, true);
  });
});

Deno.test("properties parses scalar frontmatter; setProperties merges and renders sorted", async () => {
  await withVault(async (vault, ctx) => {
    await Deno.writeTextFile(
      `${vault}/meeting.md`,
      '---\ntitle: "Widget Sync"\ncount: 3\ndone: false\nowner: null\n---\nBody line\n',
    );

    await run(ctx, "properties", { file: "meeting.md" });
    assertEquals(ctx.written[0].spec, "properties");
    assertEquals(ctx.written[0].data.action, "read");
    assertEquals(ctx.written[0].data.properties, {
      title: "Widget Sync",
      count: 3,
      done: false,
      owner: null,
    });

    await run(ctx, "setProperties", {
      file: "meeting.md",
      properties: { done: true, attendees: "Ann, Bob", ratio: 0.5 },
    });
    // Keys sorted; values outside the safe charset (here a comma) are
    // JSON-quoted; a single blank line separates frontmatter from body.
    assertEquals(
      await Deno.readTextFile(`${vault}/meeting.md`),
      '---\nattendees: "Ann, Bob"\ncount: 3\ndone: true\nowner: null\nratio: 0.5\ntitle: Widget Sync\n---\n\nBody line\n',
    );
    assertEquals(ctx.written[1].data.action, "updated");
    assertEquals(ctx.written[1].data.properties, {
      title: "Widget Sync",
      count: 3,
      done: true,
      owner: null,
      attendees: "Ann, Bob",
      ratio: 0.5,
    });
    assertEquals(ctx.written[2].spec, "writeResult");
    assertEquals(ctx.written[2].name, "properties-meeting.md");

    // Round-trip: the rendered file parses back to the same properties.
    await run(ctx, "properties", { file: "meeting.md" });
    assertEquals(
      ctx.written[3].data.properties,
      ctx.written[1].data.properties,
    );

    // A note without frontmatter gains a block and keeps its body.
    await Deno.writeTextFile(`${vault}/plain.md`, "Just text\n");
    await run(ctx, "setProperties", {
      file: "plain.md",
      properties: { tag: "x" },
    });
    assertEquals(
      await Deno.readTextFile(`${vault}/plain.md`),
      "---\ntag: x\n---\n\nJust text\n",
    );
  });
});

Deno.test("stat reports existing files, directories, and missing paths", async () => {
  await withVault(async (vault, ctx) => {
    await Deno.writeTextFile(`${vault}/here.md`, "hi");
    await run(ctx, "stat", { file: "here.md" });
    await run(ctx, "stat", { file: "missing.md" });
    await run(ctx, "stat", { file: "" });

    assertEquals(ctx.written[0].data.exists, true);
    assertEquals(ctx.written[0].data.isFile, true);
    assertEquals(ctx.written[0].data.size, 2);
    assertEquals(ctx.written[1], {
      spec: "fileInfo",
      name: "missing.md",
      data: {
        file: "missing.md",
        absolutePath: `${vault}/missing.md`,
        exists: false,
      },
    });
    assertEquals(ctx.written[2].name, "vault-root");
    assertEquals(ctx.written[2].data.absolutePath, vault);
    assertEquals(ctx.written[2].data.isDirectory, true);
  });
});
