/** Tests for the s3-site-deploy model.
 *
 * The model talks to S3 only through `S3Client#send`, so these tests replace
 * `S3Client.prototype.send` with an in-memory fake bucket and restore it
 * afterwards. No network or AWS credentials are used.
 *
 * Content-Type mapping is intentionally not asserted: the model passes the
 * whole relative path to `contentType()` (see the package test report).
 */

// deno-lint-ignore no-import-prefix
import { assertEquals, assertMatch, assertThrows } from "jsr:@std/assert@1";
// deno-lint-ignore no-import-prefix
import { crypto as stdCrypto } from "jsr:@std/crypto@1";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
// deno-lint-ignore no-import-prefix
} from "npm:@aws-sdk/client-s3@3.600.0";
import { model } from "./s3_site_deploy.ts";

type Written = { spec: string; name: string; data: Record<string, unknown> };

type SentCommand = {
  kind: "list" | "put" | "delete";
  input: Record<string, unknown>;
};

async function md5(text: string): Promise<string> {
  const buf = await stdCrypto.subtle.digest(
    "MD5",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Replace S3Client#send with a fake that serves list pages and records calls. */
async function withFakeS3<T>(
  listPages: Array<{
    Contents?: Array<{ Key: string; ETag: string }>;
    IsTruncated?: boolean;
    NextContinuationToken?: string;
  }>,
  fn: (sent: SentCommand[], clients: S3Client[]) => Promise<T>,
): Promise<T> {
  const sent: SentCommand[] = [];
  const clients: S3Client[] = [];
  const proto = S3Client.prototype as unknown as Record<string, unknown>;
  const hadOwn = Object.prototype.hasOwnProperty.call(proto, "send");
  const original = proto.send;
  let page = 0;
  proto.send = function (this: S3Client, command: unknown) {
    if (!clients.includes(this)) clients.push(this);
    if (command instanceof ListObjectsV2Command) {
      sent.push({ kind: "list", input: { ...command.input } });
      const result = listPages[page++];
      if (!result) throw new Error("unexpected extra ListObjectsV2 call");
      return Promise.resolve(result);
    }
    if (command instanceof PutObjectCommand) {
      sent.push({ kind: "put", input: { ...command.input } });
      return Promise.resolve({});
    }
    if (command instanceof DeleteObjectsCommand) {
      sent.push({ kind: "delete", input: { ...command.input } });
      return Promise.resolve({});
    }
    throw new Error(`unexpected command ${String(command)}`);
  };
  try {
    return await fn(sent, clients);
  } finally {
    if (hadOwn) proto.send = original;
    else delete proto.send;
  }
}

function makeContext(
  repoDir: string,
  globalArgs: Record<string, unknown>,
) {
  const written: Written[] = [];
  const noop = () => {};
  const context = {
    globalArgs: model.globalArguments.parse(globalArgs),
    repoDir,
    writeResource: (spec: string, name: string, data: unknown) => {
      written.push({ spec, name, data: data as Record<string, unknown> });
      return Promise.resolve({ spec, name });
    },
    logger: { info: noop, debug: noop, warning: noop, error: noop },
  };
  return { context, written };
}

async function writeSite(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "s3-site-deploy-test-" });
  for (const [rel, body] of Object.entries(files)) {
    const full = `${dir}/${rel}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, body);
  }
  return dir;
}

const putKeys = (sent: SentCommand[]) =>
  sent.filter((c) => c.kind === "put").map((c) => c.input.Key as string)
    .sort();

Deno.test("global arguments require bucket and apply documented defaults", () => {
  assertThrows(() => model.globalArguments.parse({}));
  assertEquals(model.globalArguments.parse({ bucket: "example-site" }), {
    bucket: "example-site",
    region: "us-east-1",
    accessKeyId: "",
    secretAccessKey: "",
    skipPaths: [],
  });
});

Deno.test("deploy uploads new and changed files, skips unchanged, deletes stale", async () => {
  const dir = await writeSite({
    "index.html": "<h1>home</h1>",
    "about.html": "<h1>about v2</h1>",
    "assets/app.js": "console.log(1);",
    "assets/docs/guide.txt": "nested docs dir is not top-level",
    // Always skipped: dot/underscore segments and swamp-managed dirs.
    ".env": "SECRET=synthetic",
    "assets/.cache/blob": "hidden",
    "assets/_draft.txt": "draft",
    "_layouts/base.html": "layout",
    "extensions/models/x.ts": "model",
    "models/m.yaml": "m",
    "workflows/w.yaml": "w",
    "vaults/v.yaml": "v",
    "manifest.yaml": "manifest",
    // Skipped via skipPaths (top-level only).
    "docs/readme.txt": "docs",
    "Makefile": "all:",
  });
  try {
    const unchangedEtag = `"${await md5("<h1>home</h1>")}"`;
    const staleAboutEtag = `"${await md5("<h1>about v1</h1>")}"`;
    await withFakeS3([{
      Contents: [
        { Key: "index.html", ETag: unchangedEtag },
        { Key: "about.html", ETag: staleAboutEtag },
        { Key: "old/page.html", ETag: '"0123"' },
        { Key: "removed.css", ETag: '"4567"' },
      ],
    }], async (sent) => {
      const { context, written } = makeContext(dir, {
        bucket: "example-site",
        region: "us-west-2",
        skipPaths: ["docs", "Makefile"],
      });
      const result = await model.methods.deploy.execute({}, context);

      assertEquals(putKeys(sent), [
        "about.html",
        "assets/app.js",
        "assets/docs/guide.txt",
      ]);
      const puts = Object.fromEntries(
        sent.filter((c) => c.kind === "put").map((c) => [c.input.Key, c.input]),
      );
      assertEquals(puts["about.html"].Bucket, "example-site");
      assertEquals(puts["about.html"].CacheControl, "no-cache");
      assertEquals(puts["assets/app.js"].CacheControl, "public, max-age=86400");
      assertEquals(
        new TextDecoder().decode(puts["assets/app.js"].Body as Uint8Array),
        "console.log(1);",
      );

      const deletes = sent.filter((c) => c.kind === "delete");
      assertEquals(deletes.length, 1);
      assertEquals(deletes[0].input, {
        Bucket: "example-site",
        Delete: {
          Objects: [{ Key: "old/page.html" }, { Key: "removed.css" }],
          Quiet: true,
        },
      });

      assertEquals(written.length, 1);
      assertEquals(written[0].spec, "deployment");
      assertEquals(written[0].name, "current");
      const { deployedAt, ...rest } = written[0].data;
      assertEquals(rest, {
        filesUploaded: 3,
        filesSkipped: 1,
        deletedFiles: 2,
        bucket: "example-site",
      });
      assertMatch(String(deployedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      model.resources.deployment.schema.parse(written[0].data);
      assertEquals(result, {
        dataHandles: [{ spec: "deployment", name: "current" }],
      });
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("deploy follows list pagination before deciding what changed", async () => {
  const dir = await writeSite({
    "a.html": "A",
    "b.html": "B",
  });
  try {
    await withFakeS3([
      {
        Contents: [{ Key: "a.html", ETag: `"${await md5("A")}"` }],
        IsTruncated: true,
        NextContinuationToken: "token-page-2",
      },
      {
        // Second page proves b.html is unchanged; without pagination it would
        // be re-uploaded.
        Contents: [{ Key: "b.html", ETag: `"${await md5("B")}"` }],
        IsTruncated: false,
      },
    ], async (sent) => {
      const { context, written } = makeContext(dir, { bucket: "example-site" });
      await model.methods.deploy.execute({}, context);

      const lists = sent.filter((c) => c.kind === "list");
      assertEquals(lists.map((c) => c.input), [
        { Bucket: "example-site", ContinuationToken: undefined },
        { Bucket: "example-site", ContinuationToken: "token-page-2" },
      ]);
      assertEquals(putKeys(sent), []);
      assertEquals(sent.filter((c) => c.kind === "delete").length, 0);
      assertEquals(written[0].data.filesUploaded, 0);
      assertEquals(written[0].data.filesSkipped, 2);
      assertEquals(written[0].data.deletedFiles, 0);
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stale object deletion is chunked at the 1000-key S3 limit", async () => {
  const dir = await writeSite({ "index.html": "home" });
  try {
    const stale = Array.from(
      { length: 1001 },
      (_, i) => ({ Key: `stale/${String(i).padStart(4, "0")}.html`, ETag: '"x"' }),
    );
    await withFakeS3([{ Contents: stale }], async (sent) => {
      const { context, written } = makeContext(dir, { bucket: "example-site" });
      await model.methods.deploy.execute({}, context);

      const deletes = sent.filter((c) => c.kind === "delete");
      const chunks = deletes.map((c) =>
        (c.input.Delete as { Objects: Array<{ Key: string }> }).Objects
      );
      assertEquals(chunks.map((c) => c.length), [1000, 1]);
      assertEquals(chunks[0][0].Key, "stale/0000.html");
      assertEquals(chunks[1][0].Key, "stale/1000.html");
      assertEquals(putKeys(sent), ["index.html"]);
      assertEquals(written[0].data.deletedFiles, 1001);
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("explicit credentials and region are passed to the S3 client", async () => {
  const dir = await writeSite({ "index.html": "home" });
  try {
    await withFakeS3([{ Contents: [] }], async (_sent, clients) => {
      const { context } = makeContext(dir, {
        bucket: "example-site",
        region: "eu-central-1",
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "synthetic-secret",
      });
      await model.methods.deploy.execute({}, context);

      assertEquals(clients.length, 1);
      const config = clients[0].config;
      assertEquals(await config.region(), "eu-central-1");
      const creds = await config.credentials();
      assertEquals(creds.accessKeyId, "AKIDEXAMPLE");
      assertEquals(creds.secretAccessKey, "synthetic-secret");
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("deployment resource schema rejects incomplete records", () => {
  const schema = model.resources.deployment.schema;
  assertThrows(() =>
    schema.parse({ filesUploaded: 1, filesSkipped: 0, bucket: "example-site" })
  );
  assertThrows(() =>
    schema.parse({
      filesUploaded: "1",
      filesSkipped: 0,
      deletedFiles: 0,
      deployedAt: "2026-01-01T00:00:00.000Z",
      bucket: "example-site",
    })
  );
});
