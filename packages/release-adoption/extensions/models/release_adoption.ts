/**
 * Deterministic release-adoption campaign engine for swamp repositories.
 * Captures releases and CLI surfaces, inventories fleets, and persists an
 * agent-writable opportunity ledger.
 *
 * @module
 */

import { z } from "npm:zod@4";
import { parse as parseYaml } from "npm:yaml@2.8.0";
import type { DataHandle } from "jsr:@systeminit/swamp-testing@0.20260604.20";

const VERSION = "2026.07.27.4";
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_INVENTORY_FILE_BYTES = 1024 * 1024;

const GlobalArgsSchema = z.object({
  githubRepo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .default("swamp-club/swamp"),
  fleetRepos: z.array(z.object({ name: z.string(), path: z.string() })),
});
const CampaignSchema = z.object({
  id: z.string(),
  fromVersion: z.string(),
  toVersion: z.string(),
  phase: z.enum(["open", "scanned", "analyzing", "applying", "done"]),
  openedAt: z.iso.datetime(),
  notes: z.string().optional(),
});
const ReleaseSchema = z.object({
  tag: z.string(),
  name: z.string(),
  publishedAt: z.iso.datetime(),
  url: z.url(),
  body: z.string(),
});
const ReleaseNotesSchema = z.object({
  campaignId: z.string(),
  fromVersion: z.string(),
  toVersion: z.string(),
  releases: z.array(ReleaseSchema),
  fetchedAt: z.iso.datetime(),
});
const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema).max(100_000),
    z.record(z.string(), JsonValueSchema),
  ])
);
const CliOptionSchema = z.object({
  flags: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  collect: z.boolean().optional(),
}).passthrough();
const CliCommandSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    name: z.string(),
    description: z.string().optional(),
    arguments: z.array(JsonValueSchema).max(10_000).optional(),
    options: z.array(CliOptionSchema).max(10_000).optional(),
    subcommands: z.array(CliCommandSchema).max(10_000).optional(),
  }).passthrough()
);
const CliHelpSchema = z.object({
  version: z.string(),
  root: CliCommandSchema,
}).passthrough();
const CliSurfaceSchema = z.object({
  swampVersion: z.string(),
  capturedAt: z.iso.datetime(),
  schema: CliHelpSchema,
});
const OptionChangeSchema = z.object({
  command: z.string(),
  option: z.string(),
});
const SurfaceDiffSchema = z.object({
  fromVersion: z.string(),
  toVersion: z.string(),
  addedCommands: z.array(z.string()),
  removedCommands: z.array(z.string()),
  addedOptions: z.array(OptionChangeSchema),
  removedOptions: z.array(OptionChangeSchema),
  computedAt: z.iso.datetime(),
});
const WorkflowSchema = z.object({
  name: z.string(),
  jobCount: z.number(),
  taskTypes: z.array(z.string()),
});
const ScriptSchema = z.object({ file: z.string(), lines: z.array(z.number()) });
const InventoryWarningSchema = z.object({
  file: z.string(),
  error: z.string(),
});
const RepoInventorySchema = z.object({
  name: z.string(),
  path: z.string(),
  present: z.boolean(),
  error: z.string().optional(),
  warnings: z.array(InventoryWarningSchema),
  workflows: z.array(WorkflowSchema),
  models: z.array(z.string()),
  extensionModels: z.array(z.string()),
  reports: z.array(z.string()),
  swampInvokingScripts: z.array(ScriptSchema),
});
const FleetInventorySchema = z.object({
  campaignId: z.string().optional(),
  capturedAt: z.iso.datetime(),
  repos: z.array(RepoInventorySchema),
});
const OpportunitySchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  repo: z.string(),
  target: z.string(),
  feature: z.string(),
  proposal: z.string(),
  status: z.enum(["proposed", "applied", "skipped", "blocked"]),
  commit: z.union([z.url(), z.string().regex(/^[A-Fa-f0-9]+$/)]).optional(),
  notes: z.string().optional(),
  updatedAt: z.iso.datetime(),
});

const GitHubReleaseResponseSchema = z.array(z.unknown()).transform((entries) =>
  entries.flatMap((entry) => {
    const parsed = z.object({
      tag_name: z.string(),
      name: z.string().nullable().optional(),
      published_at: z.iso.datetime(),
      html_url: z.url(),
      body: z.string().nullable().optional(),
    }).safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  })
);

/** A release returned by the GitHub releases API. */
export interface GitHubRelease {
  /** Release tag. */
  tag_name: string;
  /** Display name. */
  name?: string | null;
  /** Publication timestamp. */
  published_at?: string | null;
  /** Public release URL. */
  html_url?: string | null;
  /** Markdown release body. */
  body?: string | null;
}

/** A normalized command surface used by the deterministic differ. */
export interface CommandSurface {
  /** Options keyed by fully-qualified command path. */
  commands: Map<string, Set<string>>;
}

/** A parsed workflow inventory summary. */
export interface WorkflowSummary {
  /** Workflow display or fallback filename. */
  name: string;
  /** Number of jobs in the workflow. */
  jobCount: number;
  /** Distinct model task types used by its steps. */
  taskTypes: string[];
}

/** Opportunity fields accepted by the pure upsert merge helper. */
export interface Opportunity {
  /** Stable ledger identifier. */
  id: string;
  /** Owning campaign identifier. */
  campaignId: string;
  /** Repository name. */
  repo: string;
  /** File, model, workflow, or other adoption target. */
  target: string;
  /** Release feature being adopted. */
  feature: string;
  /** Proposed adoption change. */
  proposal: string;
  /** Current outcome state. */
  status: "proposed" | "applied" | "skipped" | "blocked";
  /** Applying commit SHA or URL. */
  commit?: string;
  /** Operator notes. */
  notes?: string;
  /** Last update timestamp. */
  updatedAt: string;
}

/** Pure CLI surface delta. */
export interface SurfaceChanges {
  /** Newly available command paths. */
  addedCommands: string[];
  /** Removed command paths. */
  removedCommands: string[];
  /** Newly available options and their command paths. */
  addedOptions: Array<{ command: string; option: string }>;
  /** Removed options and their command paths. */
  removedOptions: Array<{ command: string; option: string }>;
}

interface CommandResult {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

interface MethodContext {
  globalArgs: Record<string, unknown>;
  logger: {
    info: (message: string, properties?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<DataHandle>;
  readResource?: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
}

/** Convert arbitrary identifiers into non-empty stable resource-name slugs. */
export function sanitizeName(value: string): string {
  const slug = value.replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return slug || "unnamed";
}

/** Parse a complete swamp CalVer tag into numeric comparison segments. */
export function parseCalVer(tag: string): number[] | null {
  const match = tag.match(/^v?(\d{8}(?:\.\d+)*)(?:-sha\.[A-Fa-f0-9]+)?$/);
  if (!match) return null;
  const segments = match[1].split(".").map(Number);
  return segments.every(Number.isSafeInteger) ? segments : null;
}

/** Compare numeric CalVer segments, treating omitted trailing segments as zero. */
export function compareCalVer(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/** Build a collision-resistant resource name from a readable identifier. */
export async function resourceName(
  prefix: string,
  rawId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(rawId),
  );
  const hash = [...new Uint8Array(digest)].slice(0, 4).map((value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
  return `${prefix}-${sanitizeName(rawId)}-${hash}`;
}

/** Return releases whose numeric CalVer lies in the inclusive range. */
export function filterReleasesInRange(
  releases: GitHubRelease[],
  fromVersion: string,
  toVersion: string,
): GitHubRelease[] {
  const from = parseCalVer(fromVersion);
  const to = parseCalVer(toVersion);
  if (!from || !to) {
    throw new Error(
      `release range endpoints must be complete CalVer tags: ${fromVersion} .. ${toVersion}`,
    );
  }
  if (compareCalVer(from, to) > 0) {
    throw new Error("release range start exceeds end");
  }
  return releases.filter((release) => {
    const version = parseCalVer(release.tag_name);
    return version !== null && compareCalVer(version, from) >= 0 &&
      compareCalVer(version, to) <= 0;
  });
}

/** Flatten a machine-readable swamp help tree into commands and options. */
export function flattenSurface(schema: unknown): CommandSurface {
  const commands = new Map<string, Set<string>>();
  const optionName = (option: unknown): string | undefined => {
    if (typeof option === "string") return option;
    if (!option || typeof option !== "object") return undefined;
    const item = option as Record<string, unknown>;
    const name = item.flags ?? item.name ?? item.long ?? item.flag;
    return typeof name === "string" ? name : undefined;
  };
  const walk = (node: unknown, parent: string): void => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const nodeName = typeof record.name === "string" ? record.name : "";
    const path = parent && nodeName
      ? `${parent} ${nodeName}`
      : nodeName || parent;
    if (path) {
      const options = new Set<string>();
      const rawOptions = [record.options, record.flags, record.globalOptions]
        .flatMap((value) => Array.isArray(value) ? value : []);
      for (const option of rawOptions) {
        const name = optionName(option);
        if (name) options.add(name);
      }
      commands.set(path, options);
    }
    const children = Array.isArray(record.commands)
      ? record.commands
      : Array.isArray(record.subcommands)
      ? record.subcommands
      : [];
    for (const child of children) walk(child, path);
  };
  if (Array.isArray(schema)) { for (const node of schema) walk(node, ""); }
  else if (schema && typeof schema === "object" && "root" in schema) {
    walk((schema as Record<string, unknown>).root, "");
  } else walk(schema, "");
  return { commands };
}

/** Compute command and option additions/removals between two help trees. */
export function diffSurfaces(
  fromSchema: unknown,
  toSchema: unknown,
): SurfaceChanges {
  const before = flattenSurface(fromSchema).commands;
  const after = flattenSurface(toSchema).commands;
  const beforeNames = new Set(before.keys());
  const afterNames = new Set(after.keys());
  const addedCommands = [...afterNames].filter((name) => !beforeNames.has(name))
    .sort();
  const removedCommands = [...beforeNames].filter((name) =>
    !afterNames.has(name)
  ).sort();
  const addedOptions: Array<{ command: string; option: string }> = [];
  const removedOptions: Array<{ command: string; option: string }> = [];
  for (const command of [...new Set([...beforeNames, ...afterNames])].sort()) {
    const oldOptions = before.get(command) ?? new Set<string>();
    const newOptions = after.get(command) ?? new Set<string>();
    for (const option of [...newOptions].sort()) {
      if (!oldOptions.has(option)) addedOptions.push({ command, option });
    }
    for (const option of [...oldOptions].sort()) {
      if (!newOptions.has(option)) removedOptions.push({ command, option });
    }
  }
  return { addedCommands, removedCommands, addedOptions, removedOptions };
}

/** Parse a swamp workflow YAML string into its inventory summary. */
export function parseWorkflowYaml(
  text: string,
  fallbackName: string,
): WorkflowSummary {
  const parsed = parseYaml(text) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("workflow is not a mapping");
  }
  const jobs = parsed.jobs && typeof parsed.jobs === "object"
    ? parsed.jobs as Record<string, unknown>
    : {};
  const taskTypes = new Set<string>();
  for (const job of Object.values(jobs)) {
    if (!job || typeof job !== "object") continue;
    const steps = (job as Record<string, unknown>).steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (!step || typeof step !== "object") continue;
      const item = step as Record<string, unknown>;
      const taskObject = item.task && typeof item.task === "object"
        ? item.task as Record<string, unknown>
        : null;
      const task = taskObject?.type ?? item.task ?? item.type ?? item.model;
      if (typeof task === "string") taskTypes.add(task);
    }
  }
  return {
    name: typeof parsed.name === "string" ? parsed.name : fallbackName,
    jobCount: Object.keys(jobs).length,
    taskTypes: [...taskTypes].sort(),
  };
}

/** Find one-based lines that invoke swamp workflow or model methods. */
export function scanScript(text: string): number[] {
  const pattern = /\bswamp\b.*\b(workflow run|model method run)\b/;
  return text.split(/\r?\n/).flatMap((line, index) =>
    pattern.test(line) ? [index + 1] : []
  );
}

/** Merge an opportunity update while preserving omitted existing fields. */
export function mergeOpportunity(
  existing: Opportunity | null,
  update: Omit<Opportunity, "status" | "updatedAt"> & {
    status?: Opportunity["status"];
  },
  updatedAt: string,
): Opportunity {
  return OpportunitySchema.parse({
    ...existing,
    ...update,
    status: update.status ?? existing?.status ?? "proposed",
    updatedAt,
  });
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  const child = new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const collect = async (
    stream: ReadableStream<Uint8Array>,
    limit: number,
  ): Promise<string> => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let captured = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (captured < limit) {
        const part = value.subarray(0, limit - captured);
        chunks.push(part);
        captured += part.length;
      }
    }
    const bytes = new Uint8Array(captured);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(bytes);
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch { /* process already exited */ }
  }, timeoutMs);
  const [status, stdout, stderr] = await Promise.all([
    child.status,
    collect(child.stdout, MAX_STDOUT_BYTES),
    collect(child.stderr, MAX_STDERR_BYTES),
  ]).finally(() => clearTimeout(timer));
  if (timedOut) {
    throw new Error(
      `${command} timed out after ${timeoutMs}ms; stderr: ${stderr}`,
    );
  }
  return {
    success: status.success,
    code: status.code,
    stdout,
    stderr,
  };
}

async function listFiles(path: string, pattern: RegExp): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(path)) {
      if (entry.isFile && pattern.test(entry.name)) names.push(entry.name);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return names.sort();
}

async function inventoryRepo(
  repo: { name: string; path: string },
): Promise<z.infer<typeof RepoInventorySchema>> {
  try {
    const stat = await Deno.stat(repo.path);
    if (!stat.isDirectory) throw new Error("path is not a directory");
    const workflows: WorkflowSummary[] = [];
    const warnings: Array<{ file: string; error: string }> = [];
    for (const file of await listFiles(`${repo.path}/workflows`, /\.ya?ml$/)) {
      const relativeFile = `workflows/${file}`;
      const fullPath = `${repo.path}/${relativeFile}`;
      try {
        const fileStat = await Deno.stat(fullPath);
        if (fileStat.size > MAX_INVENTORY_FILE_BYTES) {
          throw new Error(
            `file exceeds ${MAX_INVENTORY_FILE_BYTES} byte limit`,
          );
        }
        const text = await Deno.readTextFile(fullPath);
        workflows.push(parseWorkflowYaml(text, file.replace(/\.ya?ml$/, "")));
      } catch (error) {
        warnings.push({
          file: relativeFile,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const models: string[] = [];
    try {
      for await (const collective of Deno.readDir(`${repo.path}/models`)) {
        if (!collective.isDirectory) continue;
        for await (
          const name of Deno.readDir(`${repo.path}/models/${collective.name}`)
        ) {
          if (name.isDirectory) models.push(`${collective.name}/${name.name}`);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const extensionModels =
      (await listFiles(`${repo.path}/extensions/models`, /\.ts$/))
        .filter((name) => !name.endsWith("_test.ts")).map((name) =>
          name.replace(/\.ts$/, "")
        );
    const reports =
      (await listFiles(`${repo.path}/extensions/reports`, /\.ts$/))
        .filter((name) => !name.endsWith("_test.ts")).map((name) =>
          name.replace(/\.ts$/, "")
        );
    const swampInvokingScripts: Array<{ file: string; lines: number[] }> = [];
    for (const dir of ["bin", "scripts"]) {
      for (const file of await listFiles(`${repo.path}/${dir}`, /.*/)) {
        const relativeFile = `${dir}/${file}`;
        try {
          const fileStat = await Deno.stat(`${repo.path}/${relativeFile}`);
          if (fileStat.size > MAX_INVENTORY_FILE_BYTES) {
            throw new Error(
              `file exceeds ${MAX_INVENTORY_FILE_BYTES} byte limit`,
            );
          }
          const lines = scanScript(
            await Deno.readTextFile(`${repo.path}/${relativeFile}`),
          );
          if (lines.length) {
            swampInvokingScripts.push({ file: relativeFile, lines });
          }
        } catch (error) {
          warnings.push({
            file: relativeFile,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return RepoInventorySchema.parse({
      ...repo,
      present: true,
      warnings,
      workflows,
      models: models.sort(),
      extensionModels,
      reports,
      swampInvokingScripts,
    });
  } catch (error) {
    return RepoInventorySchema.parse({
      ...repo,
      present: false,
      error: error instanceof Error ? error.message : String(error),
      warnings: [],
      workflows: [],
      models: [],
      extensionModels: [],
      reports: [],
      swampInvokingScripts: [],
    });
  }
}

async function dependencyCheck(
  command: string,
  args: string[],
): Promise<{ pass: boolean; errors?: string[] }> {
  try {
    const result = await runCommand(command, args);
    return result.success ? { pass: true } : {
      pass: false,
      errors: [
        `${command} ${args.join(" ")} failed: ${
          result.stderr.trim() || `exit ${result.code}`
        }`,
      ],
    };
  } catch (error) {
    return {
      pass: false,
      errors: [
        `${command} is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }
}

/** Release-adoption campaign model export. */
export const model = {
  type: "@mgreten/release-adoption",
  version: VERSION,
  globalArguments: GlobalArgsSchema,
  resources: {
    campaign: {
      description: "Campaign state",
      schema: CampaignSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    releaseNotes: {
      description: "Release notes in the campaign range",
      schema: ReleaseNotesSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    cliSurface: {
      description: "Machine-readable swamp CLI surface",
      schema: CliSurfaceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    surfaceDiff: {
      description: "Deterministic CLI surface delta",
      schema: SurfaceDiffSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    fleetInventory: {
      description: "Fleet repository inventory",
      schema: FleetInventorySchema,
      lifetime: "90d" as const,
      garbageCollection: 20,
    },
    opportunity: {
      description: "Adoption opportunity ledger entry",
      schema: OpportunitySchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },
  checks: {
    "github-cli-authenticated": {
      description: "Require an installed and authenticated GitHub CLI",
      labels: ["live", "dependency"],
      appliesTo: ["fetch-release-notes"],
      execute: (): Promise<{ pass: boolean; errors?: string[] }> =>
        dependencyCheck("gh", ["auth", "status"]),
    },
    "swamp-cli-present": {
      description: "Require the swamp CLI for surface capture",
      labels: ["dependency"],
      appliesTo: ["capture-surface"],
      execute: (): Promise<{ pass: boolean; errors?: string[] }> =>
        dependencyCheck("swamp", ["--version"]),
    },
  },
  methods: {
    "open-campaign": {
      description: "Open a release-adoption campaign.",
      arguments: z.object({
        id: z.string(),
        fromVersion: z.string(),
        toVersion: z.string(),
        notes: z.string().optional(),
      }),
      execute: async (
        args: {
          id: string;
          fromVersion: string;
          toVersion: string;
          notes?: string;
        },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        context.logger.info("Opening campaign {campaignId}", {
          campaignId: args.id,
        });
        const campaignName = await resourceName("campaign", args.id);
        const existing = await context.readResource?.(campaignName);
        const handle = await context.writeResource(
          "campaign",
          campaignName,
          CampaignSchema.parse({
            ...existing,
            ...args,
            phase: "open",
            openedAt: existing?.openedAt ?? new Date().toISOString(),
            notes: args.notes ?? existing?.notes,
          }),
        );
        context.logger.info("Opened campaign {campaignId}", {
          campaignId: args.id,
        });
        return { dataHandles: [handle] };
      },
    },
    "fetch-release-notes": {
      description: "Fetch GitHub releases within an inclusive CalVer range.",
      arguments: z.object({
        campaignId: z.string(),
        fromVersion: z.string(),
        toVersion: z.string(),
      }),
      execute: async (
        args: { campaignId: string; fromVersion: string; toVersion: string },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        context.logger.info("Fetching releases for campaign {campaignId}", {
          campaignId: args.campaignId,
        });
        const globalArgs = GlobalArgsSchema.parse(context.globalArgs);
        const result = await runCommand("gh", [
          "api",
          `repos/${globalArgs.githubRepo}/releases`,
          "--paginate",
          "--jq",
          `.[] | select((.tag_name | sub("^v"; "") | split("-sha.")[0]) >= "${args.fromVersion}" and (.tag_name | sub("^v"; "") | split("-sha.")[0]) <= "${args.toVersion}") | {tag_name, name, published_at, html_url, body}`,
        ]);
        if (!result.success) {
          throw new Error(
            `gh release fetch failed (exit ${result.code}): ${result.stderr.trim()}`,
          );
        }
        let raw: GitHubRelease[];
        try {
          const entries = result.stdout.trim()
            ? result.stdout.trim().split("\n").map((line) => JSON.parse(line))
            : [];
          raw = GitHubReleaseResponseSchema.parse(entries);
        } catch (error) {
          throw new Error(
            `gh release fetch returned invalid JSON/shape: ${
              error instanceof Error ? error.message : String(error)
            }; stderr: ${result.stderr.trim() || "<empty>"}`,
          );
        }
        const releases = filterReleasesInRange(
          raw,
          args.fromVersion,
          args.toVersion,
        ).map((release) => ({
          tag: release.tag_name,
          name: release.name ?? release.tag_name,
          publishedAt: release.published_at!,
          url: release.html_url!,
          body: release.body ?? "",
        }));
        const handles = [
          await context.writeResource(
            "releaseNotes",
            await resourceName("notes", args.campaignId),
            ReleaseNotesSchema.parse({
              ...args,
              releases,
              fetchedAt: new Date().toISOString(),
            }),
          ),
        ];
        const campaignName = await resourceName("campaign", args.campaignId);
        const campaign = await context.readResource?.(campaignName);
        if (campaign) {
          handles.push(
            await context.writeResource(
              "campaign",
              campaignName,
              CampaignSchema.parse({ ...campaign, phase: "scanned" }),
            ),
          );
        }
        context.logger.info("Fetched {count} releases", {
          count: releases.length,
        });
        return { dataHandles: handles };
      },
    },
    "capture-surface": {
      description:
        "Capture the current swamp version and machine-readable help tree.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        context.logger.info("Capturing swamp CLI surface");
        const [versionResult, helpResult] = await Promise.all([
          runCommand("swamp", ["--version"]),
          runCommand("swamp", ["help"]),
        ]);
        if (!versionResult.success) {
          throw new Error(
            `swamp --version failed: ${versionResult.stderr.trim()}`,
          );
        }
        if (!helpResult.success) {
          throw new Error(`swamp help failed: ${helpResult.stderr.trim()}`);
        }
        let schema: z.infer<typeof CliHelpSchema>;
        try {
          schema = CliHelpSchema.parse(JSON.parse(helpResult.stdout));
        } catch (error) {
          throw new Error(
            `swamp help returned invalid JSON/shape: ${
              error instanceof Error ? error.message : String(error)
            }; stderr: ${helpResult.stderr.trim() || "<empty>"}`,
          );
        }
        const swampVersion = versionResult.stdout.match(
          /\d+(?:\.\d+)+(?:-sha\.[A-Za-z0-9]+)?/,
        )?.[0] ?? versionResult.stdout.trim();
        const handle = await context.writeResource(
          "cliSurface",
          `surface-${sanitizeName(swampVersion)}`,
          CliSurfaceSchema.parse({
            swampVersion,
            capturedAt: new Date().toISOString(),
            schema,
          }),
        );
        context.logger.info("Captured swamp CLI surface {version}", {
          version: swampVersion,
        });
        return { dataHandles: [handle] };
      },
    },
    "diff-surface": {
      description: "Diff two previously captured swamp CLI surfaces.",
      arguments: z.object({ fromVersion: z.string(), toVersion: z.string() }),
      execute: async (
        args: { fromVersion: string; toVersion: string },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        context.logger.info("Diffing swamp surfaces {from} to {to}", {
          from: args.fromVersion,
          to: args.toVersion,
        });
        const before = await context.readResource?.(
          `surface-${sanitizeName(args.fromVersion)}`,
        );
        const after = await context.readResource?.(
          `surface-${sanitizeName(args.toVersion)}`,
        );
        if (!before || !after) {
          throw new Error(
            `missing captured surface for ${
              !before ? args.fromVersion : args.toVersion
            }`,
          );
        }
        const diff = SurfaceDiffSchema.parse({
          ...args,
          ...diffSurfaces(before.schema, after.schema),
          computedAt: new Date().toISOString(),
        });
        const handle = await context.writeResource(
          "surfaceDiff",
          `diff-${sanitizeName(args.fromVersion)}--${
            sanitizeName(args.toVersion)
          }`,
          diff,
        );
        context.logger.info(
          "Computed surface diff with {commands} command changes",
          { commands: diff.addedCommands.length + diff.removedCommands.length },
        );
        return { dataHandles: [handle] };
      },
    },
    "inventory-fleet": {
      description:
        "Inventory all configured fleet repositories with isolated failures.",
      arguments: z.object({ campaignId: z.string().optional() }),
      execute: async (
        args: { campaignId?: string },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        context.logger.info("Inventorying {count} fleet repositories", {
          count: GlobalArgsSchema.parse(context.globalArgs).fleetRepos.length,
        });
        const globalArgs = GlobalArgsSchema.parse(context.globalArgs);
        const settled = await Promise.allSettled(
          globalArgs.fleetRepos.map(inventoryRepo),
        );
        const repos = settled.map((result, index) =>
          result.status === "fulfilled"
            ? result.value
            : RepoInventorySchema.parse({
              ...globalArgs.fleetRepos[index],
              present: false,
              error: String(result.reason),
              warnings: [],
              workflows: [],
              models: [],
              extensionModels: [],
              reports: [],
              swampInvokingScripts: [],
            })
        );
        const capturedAt = new Date().toISOString();
        const suffix = args.campaignId
          ? await resourceName("campaign", args.campaignId)
          : sanitizeName(capturedAt);
        const handle = await context.writeResource(
          "fleetInventory",
          `inventory-${suffix}`,
          FleetInventorySchema.parse({ ...args, capturedAt, repos }),
        );
        context.logger.info("Inventoried {present}/{total} repositories", {
          present: repos.filter((repo) => repo.present).length,
          total: repos.length,
        });
        return { dataHandles: [handle] };
      },
    },
    "record-opportunity": {
      description: "Create or merge an adoption opportunity ledger entry.",
      arguments: OpportunitySchema.omit({ updatedAt: true }).extend({
        status: OpportunitySchema.shape.status.optional(),
      }),
      execute: async (
        args: Omit<Opportunity, "status" | "updatedAt"> & {
          status?: Opportunity["status"];
        },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const name = await resourceName("opp", args.id);
        context.logger.info("Recording opportunity {opportunityId}", {
          opportunityId: args.id,
        });
        const existingRaw = await context.readResource?.(name);
        const existing = existingRaw
          ? OpportunitySchema.parse(existingRaw)
          : null;
        const merged = mergeOpportunity(
          existing,
          args,
          new Date().toISOString(),
        );
        const handle = await context.writeResource("opportunity", name, {
          ...merged,
        });
        context.logger.info(
          "Recorded opportunity {opportunityId} as {status}",
          { opportunityId: args.id, status: merged.status },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
