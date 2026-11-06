import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { model, ModelFileExtensions } from "./manyfold_importer.ts";

type Summary = Record<string, unknown> & {
  failures: Array<{ path: string; error: string }>;
};

function makeContext(globalArgs: Record<string, unknown> = {}) {
  const writes: Array<{ spec: string; instance: string; data: Summary }> = [];
  const logs: Array<{ msg: string; props?: Record<string, unknown> }> = [];
  const log = (msg: string, props?: Record<string, unknown>) => logs.push({ msg, props });
  return {
    writes,
    logs,
    context: {
      globalArgs: model.globalArguments.parse(globalArgs),
      logger: { info: log, warning: log, error: log },
      writeResource: (spec: string, instance: string, data: Record<string, unknown>) => {
        writes.push({ spec, instance, data: data as Summary });
        return Promise.resolve({ name: instance });
      },
    },
  };
}

/** Builds src/ with model files at mixed depths plus files that must be ignored. */
async function makeSourceTree(root: string): Promise<string> {
  const src = `${root}/src`;
  await Deno.mkdir(`${src}/sub/deep`, { recursive: true });
  await Deno.mkdir(`${src}/.hidden`, { recursive: true });
  await Deno.writeTextFile(`${src}/top.STL`, "abc"); // 3 bytes, upper-case ext
  await Deno.writeTextFile(`${src}/sub/part.3mf`, "12345"); // 5 bytes
  await Deno.writeTextFile(`${src}/sub/deep/print.gcode`, "1234567"); // 7 bytes
  await Deno.writeTextFile(`${src}/readme.txt`, "ignored");
  await Deno.writeTextFile(`${src}/.secret.stl`, "hidden file");
  await Deno.writeTextFile(`${src}/.hidden/inner.stl`, "hidden dir");
  return src;
}

type FetchCall = { url: string; init: RequestInit };

async function withFetch<T>(
  respond: (call: FetchCall) => Response,
  fn: (calls: FetchCall[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return Promise.resolve(respond(call));
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("global arguments default extensions and validate the base URL", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.defaultExtensions, [...ModelFileExtensions]);
  assert(parsed.defaultExtensions.includes(".stl"));
  assertThrows(() => model.globalArguments.parse({ manyfoldBaseUrl: "not a url" }));
  const args = model.methods.importDirectory.arguments.parse({ sourcePath: "/x" });
  assertEquals(args.mode, "copy");
  assertEquals(args.dryRun, true);
  assertEquals(args.overwrite, false);
  assertThrows(() =>
    model.methods.importDirectory.arguments.parse({ sourcePath: "/x", mode: "rsync" })
  );
});

Deno.test("importDirectory dry run plans matching files without touching the destination", async () => {
  const root = await Deno.makeTempDir();
  try {
    const src = await makeSourceTree(root);
    const dest = `${root}/library`;
    const { context, writes, logs } = makeContext({ defaultLibraryPath: dest });
    await model.methods.importDirectory.execute({ sourcePath: src }, context);

    assertEquals(await exists(dest), false);
    assertEquals(writes[0].spec, "importSummary");
    assert(writes[0].instance.startsWith("import-"));
    const summary = model.resources.importSummary.schema.parse(writes[0].data);
    assertEquals(summary.destinationPath, dest);
    assertEquals(summary.dryRun, true);
    assertEquals(summary.plannedFiles, 3);
    assertEquals(summary.importedFiles, 0);
    assertEquals(summary.skippedFiles, 3);
    assertEquals(summary.totalBytes, 15);
    assertEquals(summary.scanTriggered, false);
    assertEquals(logs[0].props, { count: 3 });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("importDirectory copies with relative paths, honours explicit extensions, and skips existing", async () => {
  const root = await Deno.makeTempDir();
  try {
    const src = await makeSourceTree(root);
    const dest = `${root}/library`;
    const first = makeContext();
    await model.methods.importDirectory.execute({
      sourcePath: src,
      destinationPath: dest,
      dryRun: false,
      extensions: ["stl", "GCODE"],
    }, first.context);
    const s1 = first.writes[0].data;
    assertEquals([s1.importedFiles, s1.skippedFiles, s1.failedFiles], [2, 0, 0]);
    assertEquals(await Deno.readTextFile(`${dest}/top.STL`), "abc");
    assertEquals(await Deno.readTextFile(`${dest}/sub/deep/print.gcode`), "1234567");
    assertEquals(await exists(`${dest}/sub/part.3mf`), false);
    assertEquals(await exists(`${src}/top.STL`), true); // copy leaves the source

    // Second run: existing destination is skipped unless overwrite is set.
    await Deno.writeTextFile(`${src}/top.STL`, "changed");
    const second = makeContext();
    await model.methods.importDirectory.execute({
      sourcePath: src,
      destinationPath: dest,
      dryRun: false,
      extensions: ["stl"],
    }, second.context);
    assertEquals([second.writes[0].data.importedFiles, second.writes[0].data.skippedFiles], [0, 1]);
    assertEquals(await Deno.readTextFile(`${dest}/top.STL`), "abc");

    const third = makeContext();
    await model.methods.importDirectory.execute({
      sourcePath: src,
      destinationPath: dest,
      dryRun: false,
      overwrite: true,
      extensions: ["stl"],
    }, third.context);
    assertEquals(third.writes[0].data.importedFiles, 1);
    assertEquals(await Deno.readTextFile(`${dest}/top.STL`), "changed");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("importDirectory flattens paths and moves files when asked", async () => {
  const root = await Deno.makeTempDir();
  try {
    const src = await makeSourceTree(root);
    const dest = `${root}/flat`;
    const { context, writes } = makeContext();
    await model.methods.importDirectory.execute({
      sourcePath: src,
      destinationPath: dest,
      dryRun: false,
      mode: "move",
      preserveRelativePaths: false,
    }, context);
    assertEquals(writes[0].data.importedFiles, 3);
    const names = [];
    for await (const entry of Deno.readDir(dest)) names.push(entry.name);
    assertEquals(names.sort(), ["part.3mf", "print.gcode", "top.STL"]);
    assertEquals(await exists(`${src}/sub/part.3mf`), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("importDirectory requires a destination", async () => {
  const { context, writes } = makeContext();
  await assertRejects(
    () => model.methods.importDirectory.execute({ sourcePath: "/nonexistent" }, context),
    Error,
    "destinationPath or globalArgs.defaultLibraryPath is required",
  );
  assertEquals(writes.length, 0);
});

Deno.test("importDirectory triggers a scan with a bearer token only on real runs", async () => {
  const root = await Deno.makeTempDir();
  try {
    const src = await makeSourceTree(root);
    const globals = {
      manyfoldBaseUrl: "https://manyfold.example.com/ignored-path",
      apiToken: "fake-token",
    };
    await withFetch(() => new Response(null, { status: 202 }), async (calls) => {
      const dry = makeContext(globals);
      await model.methods.importDirectory.execute(
        { sourcePath: src, destinationPath: `${root}/d1`, triggerScan: true },
        dry.context,
      );
      assertEquals(calls.length, 0);
      assertEquals(dry.writes[0].data.scanTriggered, false);

      const real = makeContext(globals);
      await model.methods.importDirectory.execute(
        { sourcePath: src, destinationPath: `${root}/d2`, triggerScan: true, dryRun: false },
        real.context,
      );
      assertEquals(calls.length, 1);
      assertEquals(calls[0].url, "https://manyfold.example.com/api/v0/libraries/scan");
      assertEquals(calls[0].init.method, "POST");
      assertEquals(calls[0].init.headers, {
        Accept: "application/json",
        Authorization: "Bearer fake-token",
      });
      assertEquals(real.writes[0].data.scanTriggered, true);
    });

    await withFetch(() => new Response("boom", { status: 500 }), async (calls) => {
      const failing = makeContext({ ...globals, apiToken: "Bearer already-prefixed" });
      await model.methods.importDirectory.execute(
        {
          sourcePath: src,
          destinationPath: `${root}/d3`,
          triggerScan: true,
          dryRun: false,
          scanEndpoint: "/custom/scan",
        },
        failing.context,
      );
      assertEquals(calls[0].url, "https://manyfold.example.com/custom/scan");
      assertEquals(
        (calls[0].init.headers as Record<string, string>).Authorization,
        "Bearer already-prefixed",
      );
      assertEquals(failing.writes[0].data.scanTriggered, false);
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("uploadFile dry run records the plan without any HTTP call", async () => {
  const root = await Deno.makeTempDir();
  try {
    const file = `${root}/part.stl`;
    await Deno.writeTextFile(file, "solid x");
    await withFetch(() => new Response(null, { status: 500 }), async (calls) => {
      const { context, writes } = makeContext({ apiToken: "fake-token" });
      await model.methods.uploadFile.execute(
        { sourcePath: file, uploadUrl: "https://manyfold.example.com/upload" },
        context,
      );
      assertEquals(calls.length, 0);
      const s = model.resources.importSummary.schema.parse(writes[0].data);
      assert(writes[0].instance.startsWith("upload-"));
      assertEquals(s.operation, "uploadFile");
      assertEquals(s.dryRun, true);
      assertEquals([s.uploadedFiles, s.importedFiles, s.skippedFiles], [0, 0, 1]);
      assertEquals(s.totalBytes, 7);
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("uploadFile posts multipart form data and records success or failure", async () => {
  const root = await Deno.makeTempDir();
  try {
    const file = `${root}/part.stl`;
    await Deno.writeTextFile(file, "solid x");
    await withFetch(
      () =>
        new Response("{}", {
          status: 201,
          headers: { location: "https://manyfold.example.com/models/9" },
        }),
      async (calls) => {
        const { context, writes } = makeContext({ apiToken: "fake-token" });
        await model.methods.uploadFile.execute(
          {
            sourcePath: file,
            uploadUrl: "https://manyfold.example.com/upload",
            uploadFieldName: "upload[file]",
            dryRun: false,
          },
          context,
        );
        assertEquals(calls[0].url, "https://manyfold.example.com/upload");
        assertEquals(calls[0].init.method, "POST");
        assertEquals(
          (calls[0].init.headers as Record<string, string>).Authorization,
          "Bearer fake-token",
        );
        const form = calls[0].init.body as FormData;
        const blob = form.get("upload[file]") as File;
        assertEquals(blob.name, "part.stl");
        assertEquals(await blob.text(), "solid x");
        assertEquals(form.get("filename"), "part.stl");
        assertEquals(form.get("size"), "7");
        const s = writes[0].data;
        assertEquals(s.uploadResponses, [{
          source: file,
          status: 201,
          location: "https://manyfold.example.com/models/9",
        }]);
        assertEquals([s.uploadedFiles, s.importedFiles, s.skippedFiles, s.failedFiles], [
          1,
          1,
          0,
          0,
        ]);
      },
    );

    await withFetch(() => new Response("quota exceeded", { status: 413 }), async () => {
      const { context, writes } = makeContext();
      await model.methods.uploadFile.execute(
        { sourcePath: file, uploadUrl: "https://manyfold.example.com/upload", dryRun: false },
        context,
      );
      const s = writes[0].data;
      assertEquals([s.uploadedFiles, s.failedFiles], [0, 1]);
      assertEquals(s.failures, [{
        path: file,
        error: "Upload failed with HTTP 413: quota exceeded",
      }]);
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("uploadFile rejects directories as the source", async () => {
  const root = await Deno.makeTempDir();
  try {
    const { context } = makeContext();
    await assertRejects(
      () =>
        model.methods.uploadFile.execute(
          { sourcePath: root, uploadUrl: "https://manyfold.example.com/upload" },
          context,
        ),
      Error,
      "sourcePath must be a file",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
