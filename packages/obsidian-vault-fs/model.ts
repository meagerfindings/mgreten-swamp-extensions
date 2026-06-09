/**
 * Filesystem-first Obsidian vault model for headless Swamp automation.
 *
 * This model intentionally avoids the desktop Obsidian CLI. It operates on a
 * mounted vault directory with path-safety checks, writes structured Swamp data
 * artifacts for each operation, and is designed for deterministic agent,
 * cron, and workflow use from containers or servers.
 *
 * @module
 */
import { z } from "npm:zod@4";

const DEFAULT_VAULT_ROOT = "/vault";

const GlobalArgsSchema = z.object({
  vaultRoot: z.string().default(DEFAULT_VAULT_ROOT),
  defaultFileMode: z.number().int().default(0o664),
  defaultDirectoryMode: z.number().int().default(0o775),
  blockDotObsidian: z.boolean().default(true),
});

const ScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const PropertyMapSchema = z.record(z.string(), ScalarSchema);

const NoteContentSchema = z.object({
  file: z.string(),
  absolutePath: z.string(),
  size: z.number().int(),
  modifiedAt: z.string().optional(),
  content: z.string(),
});

const WriteResultSchema = z.object({
  file: z.string(),
  absolutePath: z.string(),
  action: z.enum(["created", "updated", "appended", "unchanged"]),
  bytes: z.number().int(),
  timestamp: z.string(),
});

const FileInfoSchema = z.object({
  file: z.string(),
  absolutePath: z.string(),
  exists: z.boolean(),
  isFile: z.boolean().optional(),
  isDirectory: z.boolean().optional(),
  size: z.number().int().optional(),
  modifiedAt: z.string().optional(),
});

const FileListSchema = z.object({
  folder: z.string(),
  absolutePath: z.string(),
  recursive: z.boolean(),
  ext: z.string().optional(),
  files: z.array(FileInfoSchema),
  count: z.number().int(),
  timestamp: z.string(),
});

const SearchMatchSchema = z.object({
  file: z.string(),
  absolutePath: z.string(),
  line: z.number().int(),
  text: z.string(),
});

const SearchResultsSchema = z.object({
  query: z.string(),
  folder: z.string(),
  regex: z.boolean(),
  caseSensitive: z.boolean(),
  matches: z.array(SearchMatchSchema),
  count: z.number().int(),
  truncated: z.boolean(),
  timestamp: z.string(),
});

const PropertiesResultSchema = z.object({
  file: z.string(),
  absolutePath: z.string(),
  properties: PropertyMapSchema,
  action: z.enum(["read", "updated"]),
  timestamp: z.string(),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
type Scalar = z.infer<typeof ScalarSchema>;

type FileInfo = z.infer<typeof FileInfoSchema>;
type SearchMatch = z.infer<typeof SearchMatchSchema>;

type DataHandle = unknown;

interface ModelContext {
  globalArgs: GlobalArgs;
  logger?: {
    info?: (message: string, fields?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    attributes: Record<string, unknown>,
  ) => Promise<DataHandle>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeSegments(path: string): string[] {
  const segments: string[] = [];
  for (const raw of path.split("/")) {
    if (!raw || raw === ".") continue;
    if (raw === "..") {
      if (segments.length === 0) {
        throw new Error(`Path escapes vault root: ${path}`);
      }
      segments.pop();
      continue;
    }
    segments.push(raw);
  }
  return segments;
}

function resolveVaultPath(
  cfg: GlobalArgs,
  requestedPath: string,
  options: { allowDotObsidian?: boolean } = {},
): { absolutePath: string; vaultRelativePath: string } {
  const vaultRoot = trimTrailingSlash(cfg.vaultRoot);
  const normalizedVaultRoot = "/" + normalizeSegments(vaultRoot).join("/");
  let relativeCandidate: string;

  if (requestedPath.startsWith("/")) {
    const normalizedRequested = "/" +
      normalizeSegments(requestedPath).join("/");
    if (
      normalizedRequested !== normalizedVaultRoot &&
      !normalizedRequested.startsWith(`${normalizedVaultRoot}/`)
    ) {
      throw new Error(
        `Path is outside vault root. vaultRoot=${normalizedVaultRoot} requested=${normalizedRequested}`,
      );
    }
    relativeCandidate = normalizedRequested.slice(normalizedVaultRoot.length)
      .replace(/^\//, "");
  } else {
    relativeCandidate = requestedPath.replace(/^\/+/, "");
  }

  const relativeSegments = normalizeSegments(relativeCandidate);
  if (
    cfg.blockDotObsidian && !options.allowDotObsidian &&
    relativeSegments.some((segment) => segment === ".obsidian")
  ) {
    throw new Error(
      "Refusing to operate on .obsidian internals unless allowDotObsidian=true",
    );
  }

  const vaultRelativePath = relativeSegments.join("/");
  const absolutePath = vaultRelativePath
    ? `${normalizedVaultRoot}/${vaultRelativePath}`
    : normalizedVaultRoot;
  return { absolutePath, vaultRelativePath };
}

async function chmodQuietly(path: string, mode: number): Promise<void> {
  try {
    await Deno.chmod(path, mode);
  } catch (_err) {
    // Some mounted filesystems or platforms do not support chmod from Deno.
  }
}

async function ensureParentDir(path: string, mode: number): Promise<void> {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return;
  const parent = path.slice(0, idx);
  await Deno.mkdir(parent, { recursive: true, mode });
  await chmodQuietly(parent, mode);
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

async function statInfo(
  absolutePath: string,
  vaultRelativePath: string,
): Promise<FileInfo> {
  try {
    const stat = await Deno.stat(absolutePath);
    return {
      file: vaultRelativePath,
      absolutePath,
      exists: true,
      isFile: stat.isFile,
      isDirectory: stat.isDirectory,
      size: stat.size,
      modifiedAt: stat.mtime?.toISOString(),
    };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return { file: vaultRelativePath, absolutePath, exists: false };
    }
    throw err;
  }
}

async function* walkFiles(
  root: string,
  recursive: boolean,
): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(root)) {
    const path = `${root}/${entry.name}`;
    if (entry.isFile) {
      yield path;
    } else if (entry.isDirectory && recursive) {
      yield* walkFiles(path, recursive);
    }
  }
}

function relativeFromRoot(vaultRoot: string, absolutePath: string): string {
  const root = trimTrailingSlash(vaultRoot);
  return absolutePath.startsWith(`${root}/`)
    ? absolutePath.slice(root.length + 1)
    : absolutePath;
}

function scalarToYaml(value: Scalar): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (/^[A-Za-z0-9_./:@# -]+$/.test(value) && value.trim() === value) {
    return value;
  }
  return JSON.stringify(value);
}

function parseFrontmatter(content: string): {
  properties: Record<string, Scalar>;
  body: string;
  hasFrontmatter: boolean;
} {
  if (!content.startsWith("---\n")) {
    return { properties: {}, body: content, hasFrontmatter: false };
  }
  const end = content.indexOf("\n---", 4);
  if (end < 0) return { properties: {}, body: content, hasFrontmatter: false };
  const raw = content.slice(4, end).trimEnd();
  const body = content.slice(end + 4).replace(/^\n/, "");
  const properties: Record<string, Scalar> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.trim();
    if (value === "true") properties[key] = true;
    else if (value === "false") properties[key] = false;
    else if (value === "null") properties[key] = null;
    else if (/^-?\d+(?:\.\d+)?$/.test(value)) properties[key] = Number(value);
    else properties[key] = value.replace(/^['\"]|['\"]$/g, "");
  }
  return { properties, body, hasFrontmatter: true };
}

function renderFrontmatter(
  properties: Record<string, Scalar>,
  body: string,
): string {
  const lines = Object.entries(properties)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}: ${scalarToYaml(value)}`);
  return `---\n${lines.join("\n")}\n---\n${
    body.startsWith("\n") ? "" : "\n"
  }${body}`;
}

function buildSearchMatcher(
  query: string,
  regex: boolean,
  caseSensitive: boolean,
): (line: string) => boolean {
  if (regex) {
    const flags = caseSensitive ? "" : "i";
    const compiled = new RegExp(query, flags);
    return (line) => compiled.test(line);
  }
  const needle = caseSensitive ? query : query.toLowerCase();
  return (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
}

/** Filesystem-based Obsidian vault model for deterministic automation. */
export const model = {
  type: "@mgreten/obsidian-vault-fs",
  version: "2026.06.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    note: {
      description: "Read Obsidian note content",
      schema: NoteContentSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    writeResult: {
      description: "Result of a write/append/frontmatter update",
      schema: WriteResultSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
    fileInfo: {
      description: "Filesystem metadata for one vault path",
      schema: FileInfoSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    fileList: {
      description: "Listed vault files",
      schema: FileListSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    searchResults: {
      description: "Full-text search matches across markdown files",
      schema: SearchResultsSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    properties: {
      description: "Parsed or updated note frontmatter properties",
      schema: PropertiesResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    read: {
      description: "Read a vault-relative or in-vault absolute markdown file.",
      arguments: z.object({
        file: z.string(),
        allowDotObsidian: z.boolean().default(false),
      }),
      execute: async (
        args: { file: string; allowDotObsidian: boolean },
        context: ModelContext,
      ) => {
        const cfg = context.globalArgs as GlobalArgs;
        context.logger?.info?.("Reading Obsidian note {file}", {
          file: args.file,
        });
        const { absolutePath, vaultRelativePath } = resolveVaultPath(
          cfg,
          args.file,
          {
            allowDotObsidian: args.allowDotObsidian,
          },
        );
        const content = await Deno.readTextFile(absolutePath);
        const stat = await Deno.stat(absolutePath);
        const handle = await context.writeResource(
          "note",
          vaultRelativePath.replaceAll("/", "_"),
          {
            file: vaultRelativePath,
            absolutePath,
            size: stat.size,
            modifiedAt: stat.mtime?.toISOString(),
            content,
          },
        );
        context.logger?.info?.("Read Obsidian note {file}", {
          file: vaultRelativePath,
        });
        return { dataHandles: [handle] };
      },
    },
    write: {
      description:
        "Create or overwrite a vault file with explicit overwrite protection.",
      arguments: z.object({
        file: z.string(),
        content: z.string(),
        overwrite: z.boolean().default(false),
        allowDotObsidian: z.boolean().default(false),
      }),
      execute: async (
        args: {
          file: string;
          content: string;
          overwrite: boolean;
          allowDotObsidian: boolean;
        },
        context: ModelContext,
      ) => {
        const cfg = context.globalArgs as GlobalArgs;
        context.logger?.info?.("Writing Obsidian note {file}", {
          file: args.file,
        });
        const { absolutePath, vaultRelativePath } = resolveVaultPath(
          cfg,
          args.file,
          {
            allowDotObsidian: args.allowDotObsidian,
          },
        );
        const existing = await readTextIfExists(absolutePath);
        if (existing !== null && !args.overwrite) {
          throw new Error(
            `Refusing to overwrite existing note without overwrite=true: ${vaultRelativePath}`,
          );
        }
        await ensureParentDir(absolutePath, cfg.defaultDirectoryMode);
        await Deno.writeTextFile(absolutePath, args.content);
        await chmodQuietly(absolutePath, cfg.defaultFileMode);
        const handle = await context.writeResource(
          "writeResult",
          vaultRelativePath.replaceAll("/", "_"),
          {
            file: vaultRelativePath,
            absolutePath,
            action: existing === null
              ? "created"
              : existing === args.content
              ? "unchanged"
              : "updated",
            bytes: new TextEncoder().encode(args.content).byteLength,
            timestamp: nowIso(),
          },
        );
        context.logger?.info?.("Wrote Obsidian note {file}", {
          file: vaultRelativePath,
        });
        return { dataHandles: [handle] };
      },
    },
    append: {
      description:
        "Append markdown text to a vault file, creating it if needed.",
      arguments: z.object({
        file: z.string(),
        content: z.string(),
        separator: z.string().default("\n"),
        allowDotObsidian: z.boolean().default(false),
      }),
      execute: async (
        args: {
          file: string;
          content: string;
          separator: string;
          allowDotObsidian: boolean;
        },
        context: ModelContext,
      ) => {
        const cfg = context.globalArgs as GlobalArgs;
        context.logger?.info?.("Appending Obsidian note {file}", {
          file: args.file,
        });
        const { absolutePath, vaultRelativePath } = resolveVaultPath(
          cfg,
          args.file,
          {
            allowDotObsidian: args.allowDotObsidian,
          },
        );
        const existing = await readTextIfExists(absolutePath);
        await ensureParentDir(absolutePath, cfg.defaultDirectoryMode);
        const next = existing === null || existing.length === 0
          ? args.content
          : `${existing}${args.separator}${args.content}`;
        await Deno.writeTextFile(absolutePath, next);
        await chmodQuietly(absolutePath, cfg.defaultFileMode);
        const handle = await context.writeResource(
          "writeResult",
          `append-${vaultRelativePath.replaceAll("/", "_")}`,
          {
            file: vaultRelativePath,
            absolutePath,
            action: "appended",
            bytes: new TextEncoder().encode(args.content).byteLength,
            timestamp: nowIso(),
          },
        );
        context.logger?.info?.("Appended Obsidian note {file}", {
          file: vaultRelativePath,
        });
        return { dataHandles: [handle] };
      },
    },
    stat: {
      description: "Return filesystem metadata for a vault path.",
      arguments: z.object({
        file: z.string(),
        allowDotObsidian: z.boolean().default(false),
      }),
      execute: async (
        args: { file: string; allowDotObsidian: boolean },
        context: ModelContext,
      ) => {
        const cfg = context.globalArgs as GlobalArgs;
        const { absolutePath, vaultRelativePath } = resolveVaultPath(
          cfg,
          args.file,
          {
            allowDotObsidian: args.allowDotObsidian,
          },
        );
        const info = await statInfo(absolutePath, vaultRelativePath);
        const handle = await context.writeResource(
          "fileInfo",
          vaultRelativePath.replaceAll("/", "_") || "vault-root",
          info,
        );
        return { dataHandles: [handle] };
      },
    },
    list: {
      description:
        "List files under a vault folder, optionally recursively and by extension.",
      arguments: z.object({
        folder: z.string().default(""),
        recursive: z.boolean().default(false),
        ext: z.string().default("md"),
        limit: z.number().int().positive().default(100),
        allowDotObsidian: z.boolean().default(false),
      }),
      execute: async (
        args: {
          folder: string;
          recursive: boolean;
          ext: string;
          limit: number;
          allowDotObsidian: boolean;
        },
        context: ModelContext,
      ) => {
        const cfg = context.globalArgs as GlobalArgs;
        context.logger?.info?.("Listing Obsidian folder {folder}", {
          folder: args.folder,
        });
        const { absolutePath, vaultRelativePath } = resolveVaultPath(
          cfg,
          args.folder,
          {
            allowDotObsidian: args.allowDotObsidian,
          },
        );
        const suffix = args.ext ? `.${args.ext.replace(/^\./, "")}` : "";
        const files: FileInfo[] = [];
        for await (const filePath of walkFiles(absolutePath, args.recursive)) {
          if (suffix && !filePath.endsWith(suffix)) continue;
          const relative = relativeFromRoot(
            trimTrailingSlash(cfg.vaultRoot),
            filePath,
          );
          files.push(await statInfo(filePath, relative));
          if (files.length >= args.limit) break;
        }
        const payload = {
          folder: vaultRelativePath,
          absolutePath,
          recursive: args.recursive,
          ext: args.ext,
          files,
          count: files.length,
          timestamp: nowIso(),
        };
        const handle = await context.writeResource(
          "fileList",
          vaultRelativePath.replaceAll("/", "_") || "vault-root",
          payload,
        );
        context.logger?.info?.("Listed {count} Obsidian files", {
          count: files.length,
        });
        return { dataHandles: [handle] };
      },
    },
    search: {
      description: "Search markdown files under a vault folder.",
      arguments: z.object({
        query: z.string(),
        folder: z.string().default(""),
        regex: z.boolean().default(false),
        caseSensitive: z.boolean().default(false),
        limit: z.number().int().positive().default(50),
        allowDotObsidian: z.boolean().default(false),
      }),
      execute: async (
        args: {
          query: string;
          folder: string;
          regex: boolean;
          caseSensitive: boolean;
          limit: number;
          allowDotObsidian: boolean;
        },
        context: ModelContext,
      ) => {
        const cfg = context.globalArgs as GlobalArgs;
        context.logger?.info?.("Searching Obsidian vault folder {folder}", {
          folder: args.folder,
        });
        const { absolutePath, vaultRelativePath } = resolveVaultPath(
          cfg,
          args.folder,
          {
            allowDotObsidian: args.allowDotObsidian,
          },
        );
        const matcher = buildSearchMatcher(
          args.query,
          args.regex,
          args.caseSensitive,
        );
        const matches: SearchMatch[] = [];
        let truncated = false;
        for await (const filePath of walkFiles(absolutePath, true)) {
          if (!filePath.endsWith(".md")) continue;
          const text = await Deno.readTextFile(filePath);
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (!matcher(lines[i])) continue;
            matches.push({
              file: relativeFromRoot(
                trimTrailingSlash(cfg.vaultRoot),
                filePath,
              ),
              absolutePath: filePath,
              line: i + 1,
              text: lines[i],
            });
            if (matches.length >= args.limit) {
              truncated = true;
              break;
            }
          }
          if (truncated) break;
        }
        const handle = await context.writeResource("searchResults", "main", {
          query: args.query,
          folder: vaultRelativePath,
          regex: args.regex,
          caseSensitive: args.caseSensitive,
          matches,
          count: matches.length,
          truncated,
          timestamp: nowIso(),
        });
        context.logger?.info?.("Found {count} Obsidian matches", {
          count: matches.length,
        });
        return { dataHandles: [handle] };
      },
    },
    properties: {
      description:
        "Read YAML frontmatter scalar properties from a markdown file.",
      arguments: z.object({
        file: z.string(),
        allowDotObsidian: z.boolean().default(false),
      }),
      execute: async (
        args: { file: string; allowDotObsidian: boolean },
        context: ModelContext,
      ) => {
        const cfg = context.globalArgs as GlobalArgs;
        const { absolutePath, vaultRelativePath } = resolveVaultPath(
          cfg,
          args.file,
          {
            allowDotObsidian: args.allowDotObsidian,
          },
        );
        const text = await Deno.readTextFile(absolutePath);
        const parsed = parseFrontmatter(text);
        const handle = await context.writeResource(
          "properties",
          vaultRelativePath.replaceAll("/", "_"),
          {
            file: vaultRelativePath,
            absolutePath,
            properties: parsed.properties,
            action: "read",
            timestamp: nowIso(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    setProperties: {
      description:
        "Merge scalar YAML frontmatter properties into a markdown file.",
      arguments: z.object({
        file: z.string(),
        properties: PropertyMapSchema,
        allowDotObsidian: z.boolean().default(false),
      }),
      execute: async (
        args: {
          file: string;
          properties: Record<string, Scalar>;
          allowDotObsidian: boolean;
        },
        context: ModelContext,
      ) => {
        const cfg = context.globalArgs as GlobalArgs;
        context.logger?.info?.("Updating Obsidian properties for {file}", {
          file: args.file,
        });
        const { absolutePath, vaultRelativePath } = resolveVaultPath(
          cfg,
          args.file,
          {
            allowDotObsidian: args.allowDotObsidian,
          },
        );
        const text = await Deno.readTextFile(absolutePath);
        const parsed = parseFrontmatter(text);
        const properties = { ...parsed.properties, ...args.properties };
        const next = renderFrontmatter(properties, parsed.body);
        await Deno.writeTextFile(absolutePath, next);
        await chmodQuietly(absolutePath, cfg.defaultFileMode);
        const propsHandle = await context.writeResource(
          "properties",
          vaultRelativePath.replaceAll("/", "_"),
          {
            file: vaultRelativePath,
            absolutePath,
            properties,
            action: "updated",
            timestamp: nowIso(),
          },
        );
        const writeHandle = await context.writeResource(
          "writeResult",
          `properties-${vaultRelativePath.replaceAll("/", "_")}`,
          {
            file: vaultRelativePath,
            absolutePath,
            action: "updated",
            bytes: new TextEncoder().encode(next).byteLength,
            timestamp: nowIso(),
          },
        );
        context.logger?.info?.("Updated Obsidian properties for {file}", {
          file: vaultRelativePath,
        });
        return { dataHandles: [propsHandle, writeHandle] };
      },
    },
  },
};
