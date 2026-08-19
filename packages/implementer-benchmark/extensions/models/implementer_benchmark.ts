/**
 * Deterministic, bounded benchmark harness for comparing coding implementers.
 *
 * @module implementer_benchmark
 */
// deno-lint-ignore-file no-explicit-any
import { z } from "npm:zod@4";
import {
  getFixture,
  TASK_IDS,
  type TaskId,
} from "./implementer_benchmark_fixtures.ts";

const SAFE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const PROVIDERS = ["claude", "codex", "gemini", "opencode"] as const;
const MAX_CAPTURE = 128 * 1024;
const DEFAULT_MAX_PACKET_BYTES = 32 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_CHANGED_LINES = 150;
const PACKET_VERSION = "implementer-packet-v2";

const CandidateSchema = z.object({
  id: z.string().regex(SAFE_SLUG),
  provider: z.enum(PROVIDERS),
  model: z.string().min(1).max(200),
  effortLevel: z.string().regex(SAFE_SLUG).default("default"),
});
/** A provider/model configuration evaluated by a benchmark suite. */
export type Candidate = z.infer<typeof CandidateSchema>;

const GlobalArgsSchema = z.object({
  workspaceRoot: z.string().default("/tmp/implementer-benchmark-runs"),
  swampPath: z.string().default("swamp"),
  nodePath: z.string().default("node"),
  bubblewrapPath: z.string().default("/usr/bin/bwrap"),
  agentModelName: z.string().regex(SAFE_SLUG).default("benchmark-agent"),
});

const RunInputsSchema = z.object({
  suiteId: z.string().regex(SAFE_SLUG).optional(),
  taskIds: z.array(z.enum(TASK_IDS)).min(1).max(TASK_IDS.length).default([
    ...TASK_IDS,
  ]),
  candidates: z.array(CandidateSchema).min(1).max(12).default([{
    id: "qwen-local",
    provider: "opencode",
    model: "ollama/qwen3.6:35b-a3b-coding-nvfp4",
    effortLevel: "default",
  }]),
  wallTimeoutMs: z.number().int().min(1_000).max(1_800_000).default(180_000),
  maxPacketBytes: z.number().int().min(1_024).max(128 * 1024).default(
    DEFAULT_MAX_PACKET_BYTES,
  ),
  maxOutputBytes: z.number().int().min(1_024).max(256 * 1024).default(
    DEFAULT_MAX_OUTPUT_BYTES,
  ),
  maxChangedLines: z.number().int().min(1).max(1_000).default(
    DEFAULT_MAX_CHANGED_LINES,
  ),
}).superRefine((value, context) => {
  if (new Set(value.taskIds).size !== value.taskIds.length) {
    context.addIssue({
      code: "custom",
      path: ["taskIds"],
      message: "taskIds must be unique",
    });
  }
  const candidateIds = value.candidates.map((candidate) => candidate.id);
  if (new Set(candidateIds).size !== candidateIds.length) {
    context.addIssue({
      code: "custom",
      path: ["candidates"],
      message: "candidate ids must be unique",
    });
  }
});

/** Exhaustive benchmark case outcomes, ordered for stable summaries. */
export const CASE_STATUSES = [
  "pass",
  "cancelled",
  "timeout",
  "invocation_error",
  "response_error",
  "budget_exceeded",
  "no_change",
  "scope_violation",
  "test_failure",
  "infrastructure_error",
] as const;
/** One terminal outcome for a benchmark case. */
export type CaseStatus = typeof CASE_STATUSES[number];

const TokensSchema = z.object({
  input: z.number().default(0),
  output: z.number().default(0),
  cacheRead: z.number().default(0),
  cacheWrite: z.number().default(0),
  total: z.number().default(0),
  reasoning: z.number().default(0),
}).partial().default({});
const CaseResultSchema = z.object({
  suiteId: z.string(),
  candidateId: z.string(),
  effortLevel: z.string(),
  taskId: z.enum(TASK_IDS),
  status: z.enum(CASE_STATUSES),
  requiresIndependentReview: z.literal(true),
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number(),
  invocation: z.object({
    invocationId: z.string().nullable(),
    provider: z.string(),
    model: z.string(),
    success: z.boolean(),
    timedOut: z.boolean(),
    durationMs: z.number(),
    tokens: TokensSchema,
    costUsd: z.number(),
    failureReason: z.string().nullable(),
  }),
  packetHash: z.string(),
  packetBytes: z.number(),
  outputBytes: z.number(),
  changedLines: z.number(),
  changedPaths: z.array(z.string()),
  disallowedPaths: z.array(z.string()),
  visibleTestsPassed: z.boolean(),
  hiddenTestsPassed: z.boolean(),
  evidenceRef: z.string(),
  failureMessage: z.string().nullable(),
});
/** Persisted result and evidence pointers for one candidate/task pair. */
export type CaseResult = z.infer<typeof CaseResultSchema>;

const SummarySchema = z.object({
  suiteId: z.string(),
  completedAt: z.string(),
  totalCases: z.number(),
  counts: z.record(z.string(), z.number()),
  totalDurationMs: z.number(),
  totalTokens: z.number(),
  totalReportedCostUsd: z.number(),
  totalPacketBytes: z.number(),
  totalOutputBytes: z.number(),
  totalChangedLines: z.number(),
  candidates: z.array(z.object({
    id: z.string(),
    provider: z.string(),
    model: z.string(),
    effortLevel: z.string(),
    totalCases: z.number(),
  })),
  resultReferences: z.array(z.string()),
  requiresIndependentReview: z.literal(true),
});
type SuiteSummary = z.infer<typeof SummarySchema>;

/** A portable subprocess invocation request used by the harness. */
export type CommandRequest = {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  clearEnv?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
};
/** Bounded subprocess output and termination state. */
export type CommandResult = {
  code: number;
  success: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
};
/** Injectable subprocess runner used by production and tests. */
export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;

const InvocationSchema = z.object({
  invocationId: z.string(),
  provider: z.string(),
  model: z.string(),
  success: z.boolean(),
  timedOut: z.boolean().default(false),
  durationMs: z.number().default(0),
  tokens: TokensSchema,
  costUsd: z.number().default(0),
  failureReason: z.string().nullable().default(null),
  outputBytes: z.number().default(0),
  parsedResponse: z.unknown().optional(),
});

async function boundedStream(
  stream: ReadableStream<Uint8Array> | null,
  limit = MAX_CAPTURE,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size < limit) {
        const part = value.subarray(0, limit - size);
        chunks.push(part);
        size += part.length;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(output);
}

/** Runs a subprocess with bounded capture, timeout, and cancellation support. */
export const denoCommandRunner: CommandRunner = async (request) => {
  if (request.signal?.aborted) {
    return {
      code: 130,
      success: false,
      stdout: "",
      stderr: "cancelled before spawn",
      timedOut: false,
      cancelled: true,
    };
  }
  const useProcessGroup = Deno.build.os === "linux";
  const child = new Deno.Command(
    useProcessGroup ? "/usr/bin/setsid" : request.command,
    {
      args: useProcessGroup ? [request.command, ...request.args] : request.args,
      cwd: request.cwd,
      env: request.env,
      clearEnv: request.clearEnv,
      stdout: "piped",
      stderr: "piped",
    },
  ).spawn();
  let timedOut = false;
  let cancelled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (reason: "timeout" | "cancel") => {
    if (reason === "timeout") timedOut = true;
    else cancelled = true;
    try {
      if (useProcessGroup) Deno.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      return;
    }
    killTimer = setTimeout(() => {
      try {
        if (useProcessGroup) Deno.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* already exited */ }
      child.stdout.cancel().catch(() => {});
      child.stderr.cancel().catch(() => {});
    }, 2_000);
  };
  const timer = request.timeoutMs
    ? setTimeout(() => terminate("timeout"), request.timeoutMs)
    : undefined;
  const onAbort = () => terminate("cancel");
  request.signal?.addEventListener("abort", onAbort, { once: true });
  if (request.signal?.aborted) terminate("cancel");
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.status,
      boundedStream(child.stdout),
      boundedStream(child.stderr),
    ]);
    return {
      code: status.code,
      success: status.success,
      stdout,
      stderr,
      timedOut,
      cancelled,
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    request.signal?.removeEventListener("abort", onAbort);
  }
};

/** Extracts the first complete JSON object from potentially noisy text. */
export function extractFirstJsonObject(
  text: string,
): Record<string, unknown> | null {
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < text.length; end++) {
      const char = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, end + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed;
          }
        } catch { /* continue searching */ }
        break;
      }
    }
  }
  return null;
}

function extractRunEnvelope(text: string): Record<string, unknown> | null {
  let remaining = text;
  while (remaining.length > 0) {
    const object = extractFirstJsonObject(remaining);
    if (!object) return null;
    if (Array.isArray(object.dataArtifacts)) return object;
    const serialized = JSON.stringify(object);
    const index = remaining.indexOf(serialized);
    remaining = index >= 0
      ? remaining.slice(index + serialized.length)
      : remaining.slice(remaining.indexOf("{") + 1);
  }
  return null;
}

/** Validates that a benchmark workspace is absolute and outside the host repo. */
export function validateWorkspace(
  workspaceRoot: string,
  repoDir: string,
): string {
  const root = normalizeAbsolute(workspaceRoot);
  const repo = normalizeAbsolute(repoDir);
  if (root === repo || root.startsWith(`${repo}/`)) {
    throw new Error("workspaceRoot must be outside the host repository");
  }
  return root;
}

function normalizeAbsolute(path: string): string {
  if (!path.startsWith("/")) throw new Error("path must be absolute");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** Validates and returns a filesystem-safe suite identifier. */
export function validateSuiteId(value: string): string {
  if (!SAFE_SLUG.test(value)) throw new Error("invalid suiteId");
  return value;
}
function generatedSuiteId(): string {
  return `suite-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${
    crypto.randomUUID().slice(0, 8)
  }`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function resolveExecutable(command: string): Promise<string> {
  if (command.startsWith("/")) return command;
  if (command.includes("/")) {
    throw new Error("executable paths must be absolute");
  }
  for (const directory of (Deno.env.get("PATH") ?? "").split(":")) {
    if (!directory) continue;
    const path = `${directory}/${command}`;
    try {
      const stat = await Deno.stat(path);
      if (stat.isFile) return path;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  throw new Error(`executable not found on PATH: ${command}`);
}

async function writeFixture(root: string, taskId: TaskId): Promise<void> {
  const fixture = getFixture(taskId);
  await Deno.mkdir(root, { recursive: true });
  for (const [relative, content] of Object.entries(fixture.files)) {
    const path = `${root}/${relative}`;
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(path, content);
  }
}

/** Builds the deterministic visible packet supplied to a candidate. */
export function buildTaskPacket(taskId: TaskId): string {
  const fixture = getFixture(taskId);
  const files = Object.fromEntries(
    Object.entries(fixture.files)
      .filter(([path]) => path !== "PROMPT.md")
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return JSON.stringify({
    packetVersion: PACKET_VERSION,
    taskId,
    task: fixture.prompt,
    acceptanceCriteria: [
      "Return complete replacement contents for every changed file.",
      "Change only allowedPaths.",
      "Do not use tools, inspect a repository, or request more context.",
      "Keep the implementation minimal and compatible with the supplied tests.",
    ],
    allowedPaths: [...fixture.allowedPaths],
    files,
    outputContract: {
      files: Object.fromEntries(
        fixture.allowedPaths.map((path) => [
          path,
          "complete replacement file content",
        ]),
      ),
    },
  });
}

/** Returns the lowercase SHA-256 digest of UTF-8 text. */
export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

/** Validates a candidate response against the exact allowed-file contract. */
export function parseFileResponse(
  value: unknown,
  allowedPaths: readonly string[],
): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const files = (value as Record<string, unknown>).files;
  if (!files || typeof files !== "object" || Array.isArray(files)) return null;
  const entries = Object.entries(files);
  if (entries.length === 0) return null;
  if (
    entries.some(([path, content]) =>
      !allowedPaths.includes(path) || typeof content !== "string"
    )
  ) return null;
  return Object.fromEntries(entries as [string, string][]);
}

function invocationFromEnvelope(
  envelope: Record<string, unknown> | null,
): Record<string, any> | null {
  const artifacts = envelope?.dataArtifacts;
  if (!Array.isArray(artifacts)) return null;
  const artifact = artifacts.find((item: any) =>
    typeof item?.name === "string" && item.name.startsWith("invocation-")
  );
  const parsed = InvocationSchema.safeParse(artifact?.attributes);
  return parsed.success ? parsed.data : null;
}

/** Normalizes changed paths and identifies changes outside the allowed scope. */
export function classifyChangedPaths(
  paths: string[],
  allowed: readonly string[],
): { changedPaths: string[]; disallowedPaths: string[] } {
  const clean = [
    ...new Set(paths.filter(Boolean).map((path) => path.replaceAll("\\", "/"))),
  ].sort();
  return {
    changedPaths: clean,
    disallowedPaths: clean.filter((path) =>
      path.startsWith("/") || path.includes("../") || !allowed.includes(path)
    ),
  };
}

/** Classifies a case with deterministic failure precedence. */
export function classifyStatus(
  input: {
    infrastructureError?: boolean;
    cancelled?: boolean;
    timedOut: boolean;
    invocationSuccess: boolean;
    responseValid?: boolean;
    budgetExceeded?: boolean;
    changedPaths: string[];
    disallowedPaths: string[];
    visiblePassed: boolean;
    hiddenPassed: boolean;
  },
): CaseStatus {
  if (input.infrastructureError) return "infrastructure_error";
  if (input.cancelled) return "cancelled";
  if (input.timedOut) return "timeout";
  if (!input.invocationSuccess) return "invocation_error";
  if (input.budgetExceeded) return "budget_exceeded";
  if (input.responseValid === false) return "response_error";
  if (input.changedPaths.length === 0) return "no_change";
  if (input.disallowedPaths.length > 0) return "scope_violation";
  if (!input.visiblePassed || !input.hiddenPassed) return "test_failure";
  return "pass";
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function bounded(value: string, limit = 24 * 1024): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= limit) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, middle)).length <= limit - 16) {
      low = middle;
    } else high = middle - 1;
  }
  return `${value.slice(0, low)}\n[truncated]`;
}
function git(
  runner: CommandRunner,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<CommandResult> {
  return runner({ command: "git", args: ["-C", cwd, ...args], cwd, signal });
}

function sandboxedNodeRequest(options: {
  bubblewrapPath: string;
  nodePath: string;
  caseDir: string;
  hiddenDir: string;
  testPaths: string[];
  hidden: boolean;
  signal?: AbortSignal;
}): CommandRequest {
  const {
    bubblewrapPath,
    nodePath,
    caseDir,
    hiddenDir,
    testPaths,
    hidden,
    signal,
  } = options;
  const nodeDir = nodePath.slice(0, nodePath.lastIndexOf("/"));
  const hiddenMount = hidden ? ["--ro-bind", hiddenDir, "/hidden"] : [];
  return {
    command: bubblewrapPath,
    args: [
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/lib",
      "/lib",
      "--ro-bind-try",
      "/lib64",
      "/lib64",
      "--ro-bind",
      nodeDir,
      "/runtime",
      "--ro-bind",
      caseDir,
      "/workspace",
      ...hiddenMount,
      "--chdir",
      hidden ? "/hidden" : "/workspace",
      "--setenv",
      "HOME",
      "/tmp",
      "--setenv",
      "TMPDIR",
      "/tmp",
      "--setenv",
      "TZ",
      "UTC",
      "--setenv",
      "LANG",
      "C",
      "--setenv",
      "CANDIDATE_ROOT",
      "/workspace",
      "/runtime/node",
      "--test",
      "--test-reporter=tap",
      "--test-concurrency=1",
      ...testPaths,
    ],
    cwd: hidden ? hiddenDir : caseDir,
    env: {},
    clearEnv: true,
    timeoutMs: 30_000,
    signal,
  };
}

async function preflight(options: {
  suiteDir: string;
  repoDir: string;
  nodePath: string;
  bubblewrapPath: string;
  swampPath: string;
  agentModelName: string;
  signal?: AbortSignal;
  runner: CommandRunner;
}): Promise<void> {
  const {
    suiteDir,
    repoDir,
    nodePath,
    bubblewrapPath,
    swampPath,
    agentModelName,
    signal,
    runner,
  } = options;
  const agent = await runner({
    command: swampPath,
    args: ["model", "get", agentModelName, "--json"],
    cwd: repoDir,
    timeoutMs: 30_000,
    signal,
  });
  const agentEnvelope = extractFirstJsonObject(agent.stdout);
  if (!agent.success || !agentEnvelope || "error" in agentEnvelope) {
    throw new Error(
      `agent model preflight failed: ${
        bounded(agent.stderr || agent.stdout, 2_000)
      }`,
    );
  }

  const caseDir = `${suiteDir}/.preflight/workspace`;
  const hiddenDir = `${suiteDir}/.preflight/hidden`;
  await Deno.mkdir(`${caseDir}/test`, { recursive: true });
  await Deno.mkdir(hiddenDir, { recursive: true });
  await Deno.writeTextFile(
    `${caseDir}/test/smoke.test.js`,
    "// sandbox preflight\n",
  );
  try {
    const sandbox = await runner(sandboxedNodeRequest({
      bubblewrapPath,
      nodePath,
      caseDir,
      hiddenDir,
      testPaths: ["/workspace/test/smoke.test.js"],
      hidden: false,
      signal,
    }));
    if (!sandbox.success) {
      throw new Error(
        `sandbox preflight failed: ${
          bounded(sandbox.stderr || sandbox.stdout, 2_000)
        }`,
      );
    }
  } finally {
    await Deno.remove(`${suiteDir}/.preflight`, { recursive: true });
  }
}

async function runCase(
  options: {
    suiteId: string;
    suiteDir: string;
    repoDir: string;
    nodePath: string;
    bubblewrapPath: string;
    swampPath: string;
    agentModelName: string;
    candidate: Candidate;
    taskId: TaskId;
    wallTimeoutMs: number;
    maxPacketBytes: number;
    maxOutputBytes: number;
    maxChangedLines: number;
    signal?: AbortSignal;
    runner: CommandRunner;
  },
): Promise<{ result: CaseResult; evidence: string }> {
  const {
    suiteId,
    suiteDir,
    repoDir,
    nodePath,
    bubblewrapPath,
    swampPath,
    agentModelName,
    candidate,
    taskId,
    wallTimeoutMs,
    maxPacketBytes,
    maxOutputBytes,
    maxChangedLines,
    signal,
    runner,
  } = options;
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const caseDir = `${suiteDir}/cases/${candidate.id}/${taskId}`;
  const hiddenDir = `${suiteDir}/.hidden/${candidate.id}-${taskId}`;
  const fixture = getFixture(taskId);
  let invocation: Record<string, any> | null = null;
  let invocationResult: CommandResult | null = null;
  let packetHash = "";
  let packetBytes = 0;
  let outputBytes = 0;
  let changedLines = 0;
  let responseValid = false;
  let budgetExceeded = false;
  let changedPaths: string[] = [];
  let disallowedPaths: string[] = [];
  let visiblePassed = false;
  let hiddenPassed = false;
  let failureMessage: string | null = null;
  let infrastructureError = false;
  let visible = "";
  let hidden = "";
  let diff = "";
  let statusText = "";
  try {
    await writeFixture(caseDir, taskId);
    for (
      const args of [
        ["init", "-q"],
        ["config", "user.name", "benchmark"],
        ["config", "user.email", "benchmark@example.invalid"],
        ["add", "."],
        ["commit", "-qm", "fixture"],
      ]
    ) {
      const output = await git(runner, caseDir, args, signal);
      if (!output.success) {
        throw new Error(`git baseline failed: ${output.stderr}`);
      }
    }
    const baseline = await git(runner, caseDir, ["rev-parse", "HEAD"], signal);
    if (!baseline.success) throw new Error("git baseline identity failed");
    const base = baseline.stdout.trim();
    const packet = buildTaskPacket(taskId);
    packetBytes = new TextEncoder().encode(packet).length;
    packetHash = await sha256(packet);
    if (packetBytes > maxPacketBytes) {
      budgetExceeded = true;
      throw new Error(
        `packet budget exceeded: ${packetBytes} > ${maxPacketBytes}`,
      );
    }
    const agentDir = `${suiteDir}/agents/${candidate.id}/${taskId}`;
    await Deno.mkdir(agentDir, { recursive: true });
    const input = {
      prompt:
        `Implement the exact task packet below. Use no tools and do not inspect the filesystem. Return only one JSON object matching outputContract, with complete file contents and no markdown.\n\n${packet}`,
      provider: candidate.provider,
      model: candidate.model,
      cwd: agentDir,
      tags: {
        benchmark: PACKET_VERSION,
        suite: suiteId,
        task: taskId,
        candidate: candidate.id,
        effortLevel: candidate.effortLevel,
        packetHash,
      },
      wallTimeoutMs,
      toolProfile: "readonly",
      sandboxMode: "auto",
      sandboxRequired: true,
    };
    invocationResult = await runner({
      command: swampPath,
      args: [
        "model",
        "method",
        "run",
        agentModelName,
        "invokeAndParse",
        "--input",
        JSON.stringify(input),
        "--json",
        "--skip-reports",
      ],
      cwd: repoDir,
      env: {
        ...Deno.env.toObject(),
        PATH: `${nodePath.slice(0, nodePath.lastIndexOf("/"))}:${
          Deno.env.get("PATH") ?? ""
        }`,
      },
      timeoutMs: wallTimeoutMs + 30_000,
      signal,
    });
    const envelope = extractRunEnvelope(invocationResult.stdout);
    invocation = invocationFromEnvelope(envelope);
    outputBytes = number(invocation?.outputBytes);
    if (outputBytes > maxOutputBytes) budgetExceeded = true;
    const replacements = parseFileResponse(
      invocation?.parsedResponse,
      fixture.allowedPaths,
    );
    responseValid = replacements !== null;
    if (
      invocationResult.success && invocation?.success && !budgetExceeded &&
      replacements
    ) {
      for (const [relative, content] of Object.entries(replacements)) {
        await Deno.writeTextFile(`${caseDir}/${relative}`, content);
      }
    }
    if (signal?.aborted) {
      throw new DOMException("benchmark cancelled", "AbortError");
    }
    await Deno.mkdir(hiddenDir, { recursive: true });
    const verifierPath = `${hiddenDir}/${taskId}.test.js`;
    await Deno.writeTextFile(verifierPath, fixture.hiddenVerifier);
    const visibleTestPaths = Object.keys(fixture.files)
      .filter((path) => path.startsWith("test/") && path.endsWith(".js"))
      .map((path) => `/workspace/${path}`);
    if (visibleTestPaths.length === 0) {
      throw new Error("fixture has no visible tests");
    }
    const visibleResult = await runner(
      sandboxedNodeRequest({
        bubblewrapPath,
        nodePath,
        caseDir,
        hiddenDir,
        testPaths: visibleTestPaths,
        hidden: false,
        signal,
      }),
    );
    visiblePassed = visibleResult.success;
    visible = `${visibleResult.stdout}\n${visibleResult.stderr}`;
    const hiddenResult = await runner(
      sandboxedNodeRequest({
        bubblewrapPath,
        nodePath,
        caseDir,
        hiddenDir,
        testPaths: [`/hidden/${taskId}.test.js`],
        hidden: true,
        signal,
      }),
    );
    hiddenPassed = hiddenResult.success;
    hidden = `${hiddenResult.stdout}\n${hiddenResult.stderr}`;
    const [names, untracked, diffResult, statusResult, numstatResult] =
      await Promise.all([
        git(runner, caseDir, ["diff", "--name-only", "HEAD~0", "--"], signal),
        git(
          runner,
          caseDir,
          ["ls-files", "--others", "--exclude-standard"],
          signal,
        ),
        git(runner, caseDir, ["diff", "--binary", "HEAD~0", "--"], signal),
        git(runner, caseDir, ["status", "--short"], signal),
        git(runner, caseDir, ["diff", "--numstat", "HEAD", "--"], signal),
      ]);
    // Compare against the trusted pre-invocation object id, so rewritten commits remain visible.
    const currentHead = await git(
      runner,
      caseDir,
      ["rev-parse", "HEAD"],
      signal,
    );
    const committedNames = await git(runner, caseDir, [
      "diff",
      "--name-only",
      base,
      "HEAD",
      "--",
    ], signal);
    const committedDiff = await git(runner, caseDir, [
      "diff",
      "--binary",
      base,
      "HEAD",
      "--",
    ], signal);
    const ignored = await git(runner, caseDir, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
    ], signal);
    if (
      ![
        names,
        untracked,
        ignored,
        diffResult,
        statusResult,
        numstatResult,
        currentHead,
        committedNames,
        committedDiff,
      ].every((item) => item.success)
    ) {
      changedPaths = [".git"];
      disallowedPaths = [".git"];
      throw new Error("git integrity inspection failed");
    }
    if (currentHead.stdout.trim() !== base) {
      changedPaths.push(".git");
      disallowedPaths.push(".git");
    }
    const classified = classifyChangedPaths([
      ...changedPaths,
      ...names.stdout.split("\n"),
      ...committedNames.stdout.split("\n"),
      ...untracked.stdout.split("\n"),
      ...ignored.stdout.split("\n"),
    ], fixture.allowedPaths);
    changedPaths = classified.changedPaths;
    disallowedPaths = classified.disallowedPaths;
    diff = `${committedDiff.stdout}\n${diffResult.stdout}`;
    statusText = statusResult.stdout;
    changedLines = numstatResult.stdout.trim().split("\n").filter(Boolean)
      .reduce((sum, line) => {
        const [added, deleted] = line.split("\t");
        return sum + (Number(added) || 0) + (Number(deleted) || 0);
      }, 0);
    if (changedLines > maxChangedLines) budgetExceeded = true;
  } catch (error) {
    infrastructureError = !budgetExceeded;
    failureMessage = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await Deno.remove(hiddenDir, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        infrastructureError = true;
        failureMessage ??= "hidden verifier cleanup failed";
      }
    }
  }
  const timedOut = invocationResult?.timedOut === true ||
    invocation?.timedOut === true;
  const cancelled = invocationResult?.cancelled === true ||
    signal?.aborted === true;
  const invocationSuccess = invocationResult?.success === true &&
    invocation?.success === true;
  const status = classifyStatus({
    infrastructureError,
    cancelled,
    timedOut,
    invocationSuccess,
    responseValid,
    budgetExceeded,
    changedPaths,
    disallowedPaths,
    visiblePassed,
    hiddenPassed,
  });
  const tokens = invocation?.tokens && typeof invocation.tokens === "object"
    ? invocation.tokens
    : {};
  const evidence = JSON.stringify(
    {
      suiteId,
      candidateId: candidate.id,
      effortLevel: candidate.effortLevel,
      taskId,
      status,
      packetHash,
      packetBytes,
      outputBytes,
      changedLines,
      invocationExitCode: invocationResult?.code ?? null,
      invocationStdout: bounded(invocationResult?.stdout ?? ""),
      invocationStderr: bounded(invocationResult?.stderr ?? ""),
      changedPaths,
      disallowedPaths,
      gitStatus: bounded(statusText),
      diff: bounded(diff),
      visibleTests: bounded(visible),
      hiddenTests: bounded(hidden),
    },
    null,
    2,
  );
  return {
    result: {
      suiteId,
      candidateId: candidate.id,
      effortLevel: candidate.effortLevel,
      taskId,
      status,
      requiresIndependentReview: true,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      invocation: {
        invocationId: typeof invocation?.invocationId === "string"
          ? invocation.invocationId
          : null,
        provider: typeof invocation?.provider === "string"
          ? invocation.provider
          : candidate.provider,
        model: typeof invocation?.model === "string"
          ? invocation.model
          : candidate.model,
        success: invocationSuccess,
        timedOut,
        durationMs: number(invocation?.durationMs),
        tokens,
        costUsd: number(invocation?.costUsd),
        failureReason: typeof invocation?.failureReason === "string"
          ? invocation.failureReason
          : null,
      },
      packetHash,
      packetBytes,
      outputBytes,
      changedLines,
      changedPaths,
      disallowedPaths,
      visibleTestsPassed: visiblePassed,
      hiddenTestsPassed: hiddenPassed,
      evidenceRef: `evidence-${suiteId}-${candidate.id}-${taskId}`,
      failureMessage,
    },
    evidence,
  };
}

/** Aggregates case results into a deterministic suite summary. */
export function aggregateSummary(
  suiteId: string,
  results: CaseResult[],
  completedAt = new Date().toISOString(),
): SuiteSummary {
  const counts = Object.fromEntries(
    CASE_STATUSES.map((status) => [
      status,
      results.filter((result) => result.status === status).length,
    ]),
  );
  const candidates = [...new Set(results.map((result) => result.candidateId))]
    .map((candidateId) => {
      const candidateResults = results.filter((result) =>
        result.candidateId === candidateId
      );
      const first = candidateResults[0];
      return {
        id: candidateId,
        provider: first.invocation.provider,
        model: first.invocation.model,
        effortLevel: first.effortLevel,
        totalCases: candidateResults.length,
      };
    });
  return {
    suiteId,
    completedAt,
    totalCases: results.length,
    counts,
    totalDurationMs: results.reduce(
      (sum, result) => sum + result.durationMs,
      0,
    ),
    totalTokens: results.reduce(
      (sum, result) => sum + number(result.invocation.tokens.total),
      0,
    ),
    totalReportedCostUsd: results.reduce(
      (sum, result) => sum + result.invocation.costUsd,
      0,
    ),
    totalPacketBytes: results.reduce(
      (sum, result) => sum + result.packetBytes,
      0,
    ),
    totalOutputBytes: results.reduce(
      (sum, result) => sum + result.outputBytes,
      0,
    ),
    totalChangedLines: results.reduce(
      (sum, result) => sum + result.changedLines,
      0,
    ),
    candidates,
    resultReferences: results.map((result) =>
      `case-${suiteId}-${result.candidateId}-${result.taskId}`
    ),
    requiresIndependentReview: true as const,
  };
}

/** Runs candidates and tasks serially, persisting each result before continuing. */
export async function runBenchmarkSuite(
  rawInputs: z.input<typeof RunInputsSchema>,
  context: any,
  runner: CommandRunner = denoCommandRunner,
): Promise<{ dataHandles: any[] }> {
  const inputs = RunInputsSchema.parse(rawInputs);
  if (context.signal?.aborted) {
    throw new DOMException("benchmark cancelled before start", "AbortError");
  }
  const suiteId = validateSuiteId(inputs.suiteId ?? generatedSuiteId());
  const nodePath = await resolveExecutable(context.globalArgs.nodePath);
  const configuredRoot = validateWorkspace(
    context.globalArgs.workspaceRoot,
    context.repoDir,
  );
  await Deno.mkdir(configuredRoot, { recursive: true });
  const workspaceRoot = validateWorkspace(
    await Deno.realPath(configuredRoot),
    await Deno.realPath(context.repoDir),
  );
  const suiteDir = `${workspaceRoot}/${suiteId}`;
  if (await pathExists(suiteDir)) {
    throw new Error(`suite directory already exists: ${suiteDir}`);
  }
  try {
    await Deno.mkdir(suiteDir);
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) {
      throw new Error(`suite directory already exists: ${suiteDir}`);
    }
    throw error;
  }
  await preflight({
    suiteDir,
    repoDir: context.repoDir,
    nodePath,
    bubblewrapPath: context.globalArgs.bubblewrapPath,
    swampPath: context.globalArgs.swampPath,
    agentModelName: context.globalArgs.agentModelName,
    signal: context.signal,
    runner,
  });
  context.logger.info("Benchmark suite starting", {
    suiteId,
    candidates: inputs.candidates.length,
    tasks: inputs.taskIds.length,
  });
  const handles: any[] = [];
  const results: CaseResult[] = [];
  for (const candidate of inputs.candidates) {
    for (const taskId of inputs.taskIds) {
      if (context.signal?.aborted) {
        throw new DOMException("benchmark cancelled", "AbortError");
      }
      const { result, evidence } = await runCase({
        suiteId,
        suiteDir,
        repoDir: context.repoDir,
        nodePath,
        bubblewrapPath: context.globalArgs.bubblewrapPath,
        swampPath: context.globalArgs.swampPath,
        agentModelName: context.globalArgs.agentModelName,
        candidate,
        taskId,
        wallTimeoutMs: inputs.wallTimeoutMs,
        maxPacketBytes: inputs.maxPacketBytes,
        maxOutputBytes: inputs.maxOutputBytes,
        maxChangedLines: inputs.maxChangedLines,
        signal: context.signal,
        runner,
      });
      const tags = {
        suite: suiteId,
        candidate: candidate.id,
        effortLevel: candidate.effortLevel,
        task: taskId,
        status: result.status,
      };
      const evidenceHandle = await context.createFileWriter(
        "evidence",
        result.evidenceRef,
        { tags },
      ).writeText(evidence);
      handles.push(evidenceHandle);
      const resultName = `case-${suiteId}-${candidate.id}-${taskId}`;
      handles.push(
        await context.writeResource("caseResult", resultName, result, { tags }),
      );
      results.push(result);
      context.logger.info("Benchmark case completed", {
        suiteId,
        candidate: candidate.id,
        task: taskId,
        status: result.status,
      });
      if (context.signal?.aborted) {
        throw new DOMException("benchmark cancelled", "AbortError");
      }
    }
  }
  const summary = aggregateSummary(suiteId, results);
  handles.push(
    await context.writeResource("suiteSummary", `summary-${suiteId}`, summary, {
      tags: { suite: suiteId },
    }),
  );
  context.logger.info("Benchmark suite completed", {
    suiteId,
    totalCases: summary.totalCases,
  });
  return { dataHandles: handles };
}

/** Swamp model definition for the standalone implementer benchmark. */
export const model = {
  type: "@mgreten/implementer-benchmark",
  version: "2026.08.19.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    caseResult: {
      description: "Deterministic result for one candidate and synthetic task",
      schema: CaseResultSchema,
      lifetime: "365d" as const,
      garbageCollection: 5,
    },
    suiteSummary: {
      description: "Aggregate synthetic implementer benchmark suite result",
      schema: SummarySchema,
      lifetime: "365d" as const,
      garbageCollection: 20,
    },
  },
  files: {
    evidence: {
      description: "Bounded diff and test evidence for one benchmark case",
      contentType: "application/json",
      lifetime: "365d" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    runSuite: {
      description:
        "Serially run identical bounded context packets through candidate models and certify their returned file contents",
      arguments: RunInputsSchema,
      execute: (args: z.input<typeof RunInputsSchema>, context: any) =>
        runBenchmarkSuite(args, context),
    },
  },
};
