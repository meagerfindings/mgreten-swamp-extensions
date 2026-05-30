/**
 * Import local 3D model files into a Manyfold library directory and optionally trigger a scan.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Supported filename matching modes for import planning. */
export const ModelFileExtensions: readonly string[] = [
  ".3mf",
  ".stl",
  ".obj",
  ".step",
  ".stp",
  ".amf",
  ".ply",
  ".zip",
  ".7z",
  ".rar",
  ".gcode",
  ".bgcode",
  ".ctb",
  ".lys",
  ".chitubox",
  ".goo",
];

const GlobalArgsSchema = z.object({
  manyfoldBaseUrl: z.string().url().optional().describe(
    "Base URL for Manyfold, used only when calling the API scan endpoint.",
  ),
  apiToken: z.string().optional().describe(
    "Bearer token or vault expression for Manyfold API calls. Not needed for filesystem imports.",
  ),
  defaultLibraryPath: z.string().optional().describe(
    "Default destination library path visible to this runner, such as a mounted Manyfold models directory.",
  ),
  defaultExtensions: z.array(z.string()).default([...ModelFileExtensions])
    .describe(
      "File extensions to include when scanning a source tree.",
    ),
});

const ImportSummarySchema = z.object({
  sourcePath: z.string(),
  destinationPath: z.string(),
  mode: z.enum(["copy", "move", "hardlink", "symlink"]),
  dryRun: z.boolean(),
  scannedFiles: z.number(),
  plannedFiles: z.number(),
  importedFiles: z.number(),
  skippedFiles: z.number(),
  failedFiles: z.number(),
  totalBytes: z.number(),
  startedAt: z.string(),
  finishedAt: z.string(),
  scanTriggered: z.boolean(),
  failures: z.array(z.object({
    path: z.string(),
    error: z.string(),
  })),
}).passthrough();

type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

type ImportMode = "copy" | "move" | "hardlink" | "symlink";

type ImportArgs = {
  sourcePath: string;
  destinationPath?: string;
  mode?: ImportMode;
  dryRun?: boolean;
  overwrite?: boolean;
  extensions?: string[];
  preserveRelativePaths?: boolean;
  stripSourceRoot?: boolean;
  triggerScan?: boolean;
  scanEndpoint?: string;
};

type FilePlan = {
  source: string;
  destination: string;
  size: number;
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

function normalizeExtensions(extensions: string[]): Set<string> {
  return new Set(
    extensions.map((ext) =>
      ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`
    ),
  );
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function dirname(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return path.startsWith("/") ? `/${parts.join("/")}` : parts.join("/");
}

function joinPath(...parts: string[]): string {
  const joined = parts
    .filter((part) => part.length > 0)
    .join("/")
    .replaceAll(/\/+/g, "/");
  return parts[0]?.startsWith("/") ? `/${joined.replace(/^\/+/, "")}` : joined;
}

function relativePath(root: string, path: string): string {
  const cleanRoot = root.replace(/\/+$/, "");
  return path.startsWith(`${cleanRoot}/`)
    ? path.slice(cleanRoot.length + 1)
    : basename(path);
}

async function collectFiles(
  sourcePath: string,
  destinationPath: string,
  extensions: Set<string>,
  preserveRelativePaths: boolean,
): Promise<FilePlan[]> {
  const rootInfo = await Deno.stat(sourcePath);
  const plans: FilePlan[] = [];

  async function visit(path: string): Promise<void> {
    const info = await Deno.stat(path);
    if (info.isDirectory) {
      for await (const entry of Deno.readDir(path)) {
        if (entry.name.startsWith(".")) continue;
        await visit(joinPath(path, entry.name));
      }
      return;
    }

    if (!info.isFile) return;
    const ext = `.${basename(path).split(".").at(-1)?.toLowerCase() ?? ""}`;
    if (!extensions.has(ext)) return;
    const rel = preserveRelativePaths && rootInfo.isDirectory
      ? relativePath(sourcePath, path)
      : basename(path);
    plans.push({
      source: path,
      destination: joinPath(destinationPath, rel),
      size: info.size,
    });
  }

  await visit(sourcePath);
  return plans;
}

async function importFile(
  plan: FilePlan,
  mode: ImportMode,
  overwrite: boolean,
): Promise<"imported" | "skipped"> {
  if (await pathExists(plan.destination)) {
    if (!overwrite) return "skipped";
    await Deno.remove(plan.destination);
  }
  await Deno.mkdir(dirname(plan.destination), { recursive: true });
  if (mode === "copy") await Deno.copyFile(plan.source, plan.destination);
  if (mode === "move") await Deno.rename(plan.source, plan.destination);
  if (mode === "hardlink") await Deno.link(plan.source, plan.destination);
  if (mode === "symlink") await Deno.symlink(plan.source, plan.destination);
  return "imported";
}

async function triggerScan(
  baseUrl: string | undefined,
  token: string | undefined,
  endpoint: string,
): Promise<boolean> {
  if (!baseUrl) return false;
  const url = new URL(endpoint, baseUrl).toString();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) {
    headers.Authorization = token.startsWith("Bearer ")
      ? token
      : `Bearer ${token}`;
  }
  const response = await fetch(url, { method: "POST", headers });
  return response.ok || response.status === 202 || response.status === 204;
}

/** Swamp model for importing files into a Manyfold-accessible library path. */
export const model = {
  type: "@mgreten/manyfold-importer",
  version: "2026.05.30.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    importSummary: {
      description: "Summary of a Manyfold filesystem import run",
      schema: ImportSummarySchema,
      lifetime: "30d" as const,
      garbageCollection: 100,
    },
  },
  methods: {
    importDirectory: {
      description:
        "Copy, move, hardlink, or symlink supported model files into a Manyfold library directory",
      arguments: z.object({
        sourcePath: z.string().describe(
          "Source file or directory to import from.",
        ),
        destinationPath: z.string().optional().describe(
          "Destination Manyfold library path. Defaults to globalArgs.defaultLibraryPath.",
        ),
        mode: z.enum(["copy", "move", "hardlink", "symlink"]).default("copy")
          .describe("How files should be imported."),
        dryRun: z.boolean().default(true).describe(
          "Plan the import without changing files.",
        ),
        overwrite: z.boolean().default(false).describe(
          "Replace destination files if they already exist.",
        ),
        extensions: z.array(z.string()).optional().describe(
          "Extensions to include. Defaults to globalArgs.defaultExtensions.",
        ),
        preserveRelativePaths: z.boolean().default(true).describe(
          "Keep source subdirectory structure under the destination.",
        ),
        triggerScan: z.boolean().default(false).describe(
          "Call a Manyfold scan endpoint after import. Endpoint varies by Manyfold version.",
        ),
        scanEndpoint: z.string().default("/api/v0/libraries/scan").describe(
          "Relative API endpoint used when triggerScan is true.",
        ),
      }),
      execute: async (
        args: ImportArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: Record<string, unknown>[] }> => {
        const startedAt = new Date().toISOString();
        const destinationPath = args.destinationPath ??
          context.globalArgs.defaultLibraryPath;
        if (!destinationPath) {
          throw new Error(
            "destinationPath or globalArgs.defaultLibraryPath is required",
          );
        }
        const mode = args.mode ?? "copy";
        const dryRun = args.dryRun ?? true;
        const extensions = normalizeExtensions(
          args.extensions ?? context.globalArgs.defaultExtensions,
        );
        const plans = await collectFiles(
          args.sourcePath,
          destinationPath,
          extensions,
          args.preserveRelativePaths ?? true,
        );
        let importedFiles = 0;
        let skippedFiles = 0;
        let failedFiles = 0;
        const failures: Array<{ path: string; error: string }> = [];

        context.logger.info("Planned {count} files for Manyfold import", {
          count: plans.length,
        });

        if (!dryRun) {
          for (const plan of plans) {
            try {
              const result = await importFile(
                plan,
                mode,
                args.overwrite ?? false,
              );
              if (result === "imported") importedFiles += 1;
              else skippedFiles += 1;
            } catch (err) {
              failedFiles += 1;
              failures.push({
                path: plan.source,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        const scanTriggered = !dryRun && (args.triggerScan ?? false)
          ? await triggerScan(
            context.globalArgs.manyfoldBaseUrl,
            context.globalArgs.apiToken,
            args.scanEndpoint ?? "/api/v0/libraries/scan",
          )
          : false;

        const summary = {
          sourcePath: args.sourcePath,
          destinationPath,
          mode,
          dryRun,
          scannedFiles: plans.length,
          plannedFiles: plans.length,
          importedFiles,
          skippedFiles: dryRun ? plans.length : skippedFiles,
          failedFiles,
          totalBytes: plans.reduce((sum, file) => sum + file.size, 0),
          startedAt,
          finishedAt: new Date().toISOString(),
          scanTriggered,
          failures,
        };

        const handle = await context.writeResource(
          "importSummary",
          `import-${Date.now()}`,
          summary,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
