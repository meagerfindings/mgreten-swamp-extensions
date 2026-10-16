/**
 * Deterministic local publication of explicitly selected Markdown content.
 * Python performs parsing; this model owns previews, guarded writes and verification.
 * @module
 */
import { z } from "npm:zod@4";
import { dirname, isAbsolute, join, resolve } from "node:path";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const RelativeDirectory = z.string().regex(
  /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/,
);
const GlobalArgs = z.object({
  siteTitle: z.string().min(1).max(200).default("Notes"),
  outputDir: RelativeDirectory.default("posts").describe(
    "Repository-relative post directory; no traversal or symlinks",
  ),
  templatePath: z.string().min(1).optional().describe(
    "Trusted UTF-8 HTML template; absolute or repo-relative. Omit for the bundled semantic HTML template",
  ),
  pythonExecutable: z.string().min(1).default("python3").describe(
    "Python executable, not a shell command; must have the pinned packages installed",
  ),
});
const Metadata = z.object({
  title: z.string().min(1).max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) &&
      date.toISOString().startsWith(value);
  }, "Use a real calendar date"),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  excerpt: z.string().min(1).max(1000),
  series: z.string().min(1).max(200).optional(),
  seriesOrder: z.number().int().optional(),
});
const Rendered = z.object({
  metadata: Metadata,
  htmlBody: z.string().min(1),
  renderer: z.string().min(1),
});
const SourceArgs = z.object({
  sourcePath: z.string().min(1).describe(
    "Absolute or repo-relative .md file with YAML metadata and blog:content:start/end markers",
  ),
});
const WriteArgs = SourceArgs.extend({
  expectedRenderHash: Hash.describe(
    "Exact hash from the preview you inspected, not an automatically fetched latest hash",
  ),
  operation: z.enum(["create", "update"]).describe(
    "Create refuses overwrite; update requires an existing post. Neither deploys",
  ),
});
const VerifyArgs = SourceArgs.extend({
  expectedHtmlHash: Hash.describe(
    "Exact htmlHash from the reviewed preview or completed write",
  ),
});
const Artifact = z.object({
  metadata: Metadata,
  sourceHash: Hash,
  htmlHash: Hash,
  renderer: z.string(),
  outputPath: z.string(),
});
const Preview = Artifact.extend({ renderHash: Hash, previewPath: z.string() });

type Context = {
  repoDir: string;
  globalArgs: z.infer<typeof GlobalArgs>;
  extensionFile: (path: string) => string;
  signal?: AbortSignal;
  logger: {
    info: (message: string, properties?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<unknown>;
};
type Result = { dataHandles: unknown[] };

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

async function readSmall(path: string, limit = 1024 * 1024): Promise<string> {
  const stat = await Deno.stat(path);
  if (!stat.isFile || stat.size > limit) {
    throw new Error("Expected a regular file within the size limit");
  }
  const bytes = await Deno.readFile(path);
  if (bytes.length > limit) throw new Error("File grew beyond the size limit");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    bytes,
  );
}

// Check every existing component, not just realPath(target): missing targets
// beneath symlinked parents must also be refused. Repo root may itself be a symlink.
async function safePath(repoDir: string, relative: string): Promise<string> {
  let path = await Deno.realPath(repoDir);
  for (const component of relative.split("/")) {
    if (
      !component || component === "." || component === ".." ||
      component.includes("\\")
    ) {
      throw new Error("Unsafe output path");
    }
    path = join(path, component);
    try {
      if ((await Deno.lstat(path)).isSymlink) {
        throw new Error("Output paths must not contain symlinks");
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return path;
}

async function readExisting(path: string): Promise<string | null> {
  try {
    return await readSmall(path, 8 * 1024 * 1024);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function render(
  source: string,
  context: Context,
): Promise<z.infer<typeof Rendered>> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(context.signal ? [context.signal] : []),
  ]);
  signal.throwIfAborted();
  const child = new Deno.Command(context.globalArgs.pythonExecutable, {
    args: ["-I", "-B", context.extensionFile("assets/renderer.py")],
    cwd: context.repoDir,
    signal,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  // Drain output while writing so a full pipe cannot deadlock the subprocess.
  const [output, input] = await Promise.allSettled([
    child.output(),
    (async () => {
      try {
        await writer.write(
          new TextEncoder().encode(JSON.stringify({ source })),
        );
      } finally {
        await writer.close();
      }
    })(),
  ]);
  if (output.status === "rejected") throw output.reason;
  if (!output.value.success) {
    throw new Error(
      `Markdown renderer failed: ${
        new TextDecoder().decode(output.value.stderr).trim()
      }`,
    );
  }
  if (input.status === "rejected") throw input.reason;
  // Do not include parser output or schema values in errors: metadata may be private.
  try {
    return Rendered.parse(
      JSON.parse(new TextDecoder().decode(output.value.stdout)),
    );
  } catch {
    throw new Error(
      "Invalid publication metadata: require title, date, slug and excerpt; see the documented limits",
    );
  }
}

async function prepare(args: z.infer<typeof SourceArgs>, context: Context) {
  context.signal?.throwIfAborted();
  const config = GlobalArgs.parse(context.globalArgs);
  const sourcePath = isAbsolute(args.sourcePath)
    ? args.sourcePath
    : resolve(context.repoDir, args.sourcePath);
  if (!sourcePath.endsWith(".md")) throw new Error("Choose a .md source file");
  const source = await readSmall(sourcePath);
  const rendered = await render(source, { ...context, globalArgs: config });
  const templatePath = config.templatePath
    ? resolve(context.repoDir, config.templatePath)
    : context.extensionFile("templates/page.html.txt");
  const template = await readSmall(templatePath);
  if (template.split("{{body}}").length !== 2) {
    throw new Error("Template must contain exactly one {{body}} token");
  }
  const tokens: Record<string, string> = {
    body: rendered.htmlBody,
    siteTitle: escapeHtml(config.siteTitle),
    ...Object.fromEntries(
      Object.entries(rendered.metadata).map((
        [key, value],
      ) => [key, escapeHtml(String(value))]),
    ),
    series: escapeHtml(rendered.metadata.series ?? ""),
    seriesOrder: escapeHtml(String(rendered.metadata.seriesOrder ?? "")),
  };
  // One pass: token-like prose is never treated as another template instruction.
  const html = template.replace(/\{\{([^{}]+)\}\}/g, (_match, key: string) => {
    if (!Object.hasOwn(tokens, key)) {
      throw new Error(
        "Unknown template token; see README for supported tokens",
      );
    }
    return tokens[key];
  });
  const outputPath = `${config.outputDir}/${rendered.metadata.slug}/index.html`;
  const target = await safePath(context.repoDir, outputPath);
  const previousHtml = await readExisting(target);
  const artifact = Artifact.parse({
    metadata: rendered.metadata,
    sourceHash: await hash(source),
    htmlHash: await hash(html),
    renderer: rendered.renderer,
    outputPath,
  });
  const renderHash = await hash(JSON.stringify({
    artifact,
    template,
    config,
    previousHtml,
    rendererSourceHash: await hash(
      await readSmall(context.extensionFile("assets/renderer.py")),
    ),
    version: model.version,
    target,
  }));
  return { artifact, html, renderHash, previousHtml, target };
}

async function atomicWrite(
  path: string,
  html: string,
  createOnly: boolean,
): Promise<void> {
  const temporary = await Deno.makeTempFile({
    dir: dirname(path),
    prefix: ".markdown-blog-",
  });
  let moved = false;
  try {
    await Deno.writeTextFile(temporary, html);
    await Deno.chmod(temporary, 0o644);
    if (createOnly) {
      // Atomic no-replace on the same filesystem; never truncate an existing post.
      await Deno.link(temporary, path);
    } else {
      await Deno.rename(temporary, path);
      moved = true;
    }
  } finally {
    if (!moved) await Deno.remove(temporary);
  }
}

/** Local post renderer. No network, Git, image generation, or deployment actions. */
export const model = {
  type: "@mgreten/markdown-blog",
  version: "2026.10.15.1",
  globalArguments: GlobalArgs,
  resources: {
    preview: {
      description: "Public metadata, immutable preview path and fingerprints",
      schema: Preview,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    post: {
      description: "Written public post metadata, path and content hash",
      schema: Artifact,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    verification: {
      description:
        "Post verified against the pinned HTML hash and current Markdown/template",
      schema: Artifact,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    preview: {
      description:
        "Render a local preview without changing posts. Inspect previewPath and retain its renderHash and htmlHash before writing",
      arguments: SourceArgs,
      execute: async (
        args: z.infer<typeof SourceArgs>,
        context: Context,
      ): Promise<Result> => {
        context.logger.info("Rendering Markdown preview");
        const prepared = await prepare(SourceArgs.parse(args), context);
        const previewPath =
          `.generated/markdown-blog/${prepared.renderHash}/index.html`;
        const path = await safePath(context.repoDir, previewPath);
        await Deno.mkdir(dirname(path), { recursive: true });
        await safePath(context.repoDir, previewPath);
        context.signal?.throwIfAborted();
        const existing = await readExisting(path);
        if (existing !== null && existing !== prepared.html) {
          throw new Error("Preview was modified; refusing to overwrite it");
        }
        if (existing === null) await atomicWrite(path, prepared.html, true);
        const handle = await context.writeResource(
          "preview",
          `preview-${prepared.artifact.metadata.slug}`,
          Preview.parse({
            ...prepared.artifact,
            renderHash: prepared.renderHash,
            previewPath,
          }),
        );
        context.logger.info("Preview ready at {path}", { path: previewPath });
        return { dataHandles: [handle] };
      },
    },
    write: {
      description:
        "Write exactly the reviewed render to a local post. Reject stale previews and unintended overwrites. Does not build listings, commit, push or deploy",
      arguments: WriteArgs,
      execute: async (
        args: z.infer<typeof WriteArgs>,
        context: Context,
      ): Promise<Result> => {
        const input = WriteArgs.parse(args);
        context.logger.info("Preparing hash-checked local post write");
        const prepared = await prepare(input, context);
        if (prepared.renderHash !== input.expectedRenderHash) {
          throw new Error(
            "Source, template, configuration, renderer or target changed; preview and review again",
          );
        }
        const preview = await safePath(
          context.repoDir,
          `.generated/markdown-blog/${prepared.renderHash}/index.html`,
        );
        if (await readExisting(preview) !== prepared.html) {
          throw new Error(
            "Reviewed preview is missing or was modified; preview and review again",
          );
        }
        if (
          (input.operation === "create") !== (prepared.previousHtml === null)
        ) {
          throw new Error(
            "Create requires an absent post; update requires an existing post",
          );
        }
        await Deno.mkdir(dirname(prepared.target), { recursive: true });
        await safePath(context.repoDir, prepared.artifact.outputPath);
        const lockPath = `${prepared.target}.markdown-blog.lock`;
        let lock: Deno.FsFile;
        try {
          lock = await Deno.open(lockPath, { createNew: true, write: true });
        } catch (error) {
          if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
          throw new Error(
            "Post is locked by another write; if a process crashed, confirm it stopped before removing the adjacent .markdown-blog.lock file",
          );
        }
        try {
          if (await readExisting(prepared.target) !== prepared.previousHtml) {
            throw new Error(
              "Post changed during write; preview and review again",
            );
          }
          context.signal?.throwIfAborted();
          await atomicWrite(
            prepared.target,
            prepared.html,
            input.operation === "create",
          );
        } finally {
          lock.close();
          await Deno.remove(lockPath);
        }
        const handle = await context.writeResource(
          "post",
          `post-${prepared.artifact.metadata.slug}`,
          prepared.artifact,
        );
        context.logger.info("Wrote local post at {path}", {
          path: prepared.artifact.outputPath,
        });
        return { dataHandles: [handle] };
      },
    },
    verify: {
      description:
        "Fail unless the local post matches both expectedHtmlHash and the current source/template render. Does not verify remote deployment, links or images",
      arguments: VerifyArgs,
      execute: async (
        args: z.infer<typeof VerifyArgs>,
        context: Context,
      ): Promise<Result> => {
        const input = VerifyArgs.parse(args);
        context.logger.info("Verifying local post bytes");
        const prepared = await prepare(input, context);
        if (
          prepared.artifact.htmlHash !== input.expectedHtmlHash ||
          prepared.previousHtml !== prepared.html
        ) {
          throw new Error(
            "Verification failed: post is missing or source, template or HTML differs from the pinned render",
          );
        }
        const handle = await context.writeResource(
          "verification",
          `verification-${prepared.artifact.metadata.slug}`,
          prepared.artifact,
        );
        context.logger.info("Verified local post at {path}", {
          path: prepared.artifact.outputPath,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
