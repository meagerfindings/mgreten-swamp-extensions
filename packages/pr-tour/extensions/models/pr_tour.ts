/**
 * `@mgreten/pr-tour` turns a pull request into a guided code tour, in the
 * spirit of Graphite's Code Tours: an ordered list of stops that follows the
 * change's logic rather than its files, each stop showing pieces of the diff
 * with a short narrative of what changed and why. One file, and even one
 * hunk, can be split into pieces that appear at different stops.
 *
 * Determinism boundary: plain code fetches the PR and splits its diff into
 * hunks with stable ids (h1…hN, in diff order) and numbered lines. The agent
 * only decides the order of stops, which line ranges of which hunks each stop
 * shows, and the prose around them. It never writes code, so the diff a
 * reviewer sees on a tour is always the real one. A validator checks the
 * agent's pieces cover every line of every hunk exactly once (in a stop or in
 * the skim bucket) and retries once with the problems listed before failing.
 *
 * The agent runs read-only, through an `@mgreten/cli-agent` instance, in a
 * detached worktree of the target repo at the PR's head SHA, so it can read
 * the code around each hunk rather than the diff alone. The worktree is
 * removed when the method finishes.
 *
 * Tours are keyed by head SHA (`tour-<pr>-<sha12>`): asking again for the
 * same SHA reuses the stored tour, and a push makes it a new tour. The
 * `@mgreten/pr-tour-report` report renders each tour as an HTML page.
 *
 * @module
 */

import { z } from "npm:zod@4";

const HOME = Deno.env.get("HOME") ?? "";
const CLI_AGENT_TYPE = "@mgreten/cli-agent";

/** Expand a leading `~/` so settings can be written the way people type paths. */
export function expandHome(path: string): string {
  return path === "~"
    ? HOME
    : path.startsWith("~/")
    ? `${HOME}${path.slice(1)}`
    : path;
}

/** A CSS custom property name, with or without its leading `--`. */
const ThemeVarName = z.string().regex(
  /^(--)?[a-z][a-z0-9-]*$/,
  "Theme token names are CSS custom property names such as accent or --font-ui",
);
/** A CSS value that cannot close the declaration, its rule, or the style tag. */
const ThemeVarValue = z.string().regex(
  /^[^<>{};]*$/,
  "Theme token values cannot contain < > { } or ;",
);

/**
 * Settings read by `@mgreten/pr-tour-report`. They are global arguments of
 * the model, because swamp hands a report its model's global arguments.
 */
export const ReportSettingsSchema = z.object({
  /** Directory the tour pages are written to; serve it to open tours in a browser. */
  pagesDir: z.string().default("~/.pr-tour/pages"),
  /**
   * URL the pages directory is served at, such as `http://localhost:8000`.
   * Only used to print a page link after a build; empty prints the file path.
   */
  pageBaseUrl: z.string().default(""),
  /** localStorage key that remembers light or dark mode; share it to keep pages in step. */
  themeStorageKey: z.string().default("pr-tour:theme"),
  /**
   * CSS custom property overrides, by mode, on top of the built-in Synthwave
   * dark and GitHub-style light themes, such as `{dark: {accent: "#ff9e64"}}`.
   * See the README for the token names.
   */
  theme: z.object({
    dark: z.record(ThemeVarName, ThemeVarValue).default({}),
    light: z.record(ThemeVarName, ThemeVarValue).default({}),
  }).default({ dark: {}, light: {} }),
});

/** Report settings after defaults are applied. */
export type ReportSettings = z.infer<typeof ReportSettingsSchema>;

/** Global arguments of `@mgreten/pr-tour`: the repository, the agent, and the report settings. */
export const GlobalArgsSchema = ReportSettingsSchema.extend({
  /** GitHub owner/repo the PRs live in, such as `octo-org/octo-repo`. */
  repoSlug: z.string().regex(
    /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/,
    "repoSlug is a GitHub owner/repo, such as octo-org/octo-repo",
  ),
  /** Local git checkout of repoSlug; tour worktrees are added from it. */
  repoPath: z.string().min(1),
  /** Remote in repoPath that points at repoSlug on GitHub; PR heads are fetched from it. */
  gitRemote: z.string().regex(
    /^[A-Za-z0-9][\w.\/-]*$/,
    "gitRemote is a git remote name, such as origin or upstream",
  ).default("origin"),
  /** Where per-tour worktrees are created (each is removed after its build). */
  worktreeRoot: z.string().default("~/.pr-tour/worktrees"),
  /** Name of the `@mgreten/cli-agent` instance that runs the tour agent. */
  cliAgentModel: z.string().default("cli-agent"),
  /** cli-agent provider, such as claude or codex; empty uses the instance's default. */
  agentProvider: z.string().default(""),
  /** Provider model id; empty uses the instance's default for the provider. */
  agentModel: z.string().default(""),
  /** Wall timeout for one agent attempt. */
  wallTimeoutMs: z.number().default(900_000),
  /** Hunk text beyond this many bytes is left out of the prompt (headers stay). */
  maxPromptDiffBytes: z.number().default(150_000),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const HunkSchema = z.object({
  id: z.string(),
  path: z.string(),
  /** Set when the file was renamed. */
  oldPath: z.string().optional(),
  status: z.enum(["added", "modified", "deleted", "renamed", "binary"]),
  /** The `@@ … @@` line, or "" for a file change with no text hunks. */
  header: z.string(),
  oldStart: z.number(),
  newStart: z.number(),
  /** The hunk body exactly as in the unified diff (lines keep their +/-/space prefix). */
  patch: z.string(),
  additions: z.number(),
  deletions: z.number(),
});

/** One hunk of the PR's diff, or one whole file change that has no text hunks. */
export type Hunk = z.infer<typeof HunkSchema>;

/** A line range of one hunk shown at a stop. */
const PieceSchema = z.object({
  hunkId: z.string(),
  /** First and last line of the hunk's patch, 1-based and inclusive. A hunk with no lines is 1-0. */
  from: z.number().int(),
  to: z.number().int(),
  /** Optional one-line note shown above the piece. */
  note: z.string().optional(),
});

/** A line range of one hunk, as placed at a stop or in the skim bucket. */
export type Piece = z.infer<typeof PieceSchema>;

const StopSchema = z.object({
  title: z.string(),
  narrative: z.string(),
  pieces: z.array(PieceSchema),
  /** Specific things a reviewer should check at this stop; piece is the 1-based index into pieces. */
  reviewFocus: z.array(z.object({ piece: z.number().int(), note: z.string() }))
    .default([]),
  risk: z.enum(["low", "medium", "high"]),
});

const TourSchema = z.object({
  repo: z.string(),
  prNumber: z.number(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  baseRef: z.string(),
  headRef: z.string(),
  headSha: z.string(),
  additions: z.number(),
  deletions: z.number(),
  builtAt: z.string(),
  provider: z.string(),
  model: z.string(),
  attempts: z.number(),
  /** Two or three sentences on what the PR does, for the top of the tour. */
  summary: z.string(),
  stops: z.array(StopSchema),
  skim: z.object({ pieces: z.array(PieceSchema), reason: z.string() }),
  hunks: z.array(HunkSchema),
});

/** A stored tour: the PR's metadata, its hunks, and the agent's stops. */
export type Tour = z.infer<typeof TourSchema>;

/** The part of a tour the agent writes, after normalization. */
export type AgentTour = {
  summary: string;
  stops: z.infer<typeof StopSchema>[];
  skim: { pieces: Piece[]; reason: string };
};

type CmdResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  code: number;
};

async function run(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<CmdResult> {
  // Only gh and git run here, with argument arrays and no shell; the README
  // lists both as prerequisites.
  // swamp-quality-ignore deno-command
  const output = await new Deno.Command(cmd, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  })
    .output();
  return {
    success: output.success,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    code: output.code,
  };
}

async function runOrThrow(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<string> {
  const result = await run(cmd, args, cwd);
  if (!result.success) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (exit ${result.code}): ${
        result.stderr.slice(0, 500)
      }`,
    );
  }
  return result.stdout;
}

/**
 * Split a unified diff (as printed by `gh pr diff`) into hunks with ids
 * h1…hN in diff order. A file change with no text hunks (binary, pure rename,
 * mode change, empty file) becomes one hunk with an empty header and patch,
 * so every changed file appears on the tour.
 */
export function parseUnifiedDiff(diff: string): Hunk[] {
  const hunks: Omit<Hunk, "id">[] = [];
  const lines = diff.split("\n");

  type FileState = {
    path: string;
    oldPath?: string;
    status: Hunk["status"];
    hunkCount: number;
  };
  let file: FileState | null = null;
  let current: Omit<Hunk, "id"> | null = null;
  let body: string[] = [];

  const flushHunk = () => {
    if (current) {
      // A trailing empty line is the diff's final newline, not hunk content.
      while (body.length > 0 && body[body.length - 1] === "") body.pop();
      current.patch = body.join("\n");
      hunks.push(current);
      file!.hunkCount++;
    }
    current = null;
    body = [];
  };
  const flushFile = () => {
    flushHunk();
    if (file && file.hunkCount === 0) {
      hunks.push({
        path: file.path,
        ...(file.oldPath ? { oldPath: file.oldPath } : {}),
        status: file.status,
        header: "",
        oldStart: 0,
        newStart: 0,
        patch: "",
        additions: 0,
        deletions: 0,
      });
    }
    file = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushFile();
      const match = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      file = {
        path: match?.[2] ?? line.slice(11),
        status: "modified",
        hunkCount: 0,
      };
      continue;
    }
    if (!file) continue;

    if (!current) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) {
        file.oldPath = line.slice("rename from ".length);
        file.status = "renamed";
      } else if (line.startsWith("rename to ")) {
        file.path = line.slice("rename to ".length);
      } else if (line.startsWith("Binary files ")) file.status = "binary";
      else if (line.startsWith("+++ ") && line !== "+++ /dev/null") {
        file.path = line.slice(4).replace(/^b\//, "");
      } else if (
        line.startsWith("--- ") && file.status === "deleted" &&
        line !== "--- /dev/null"
      ) {
        file.path = line.slice(4).replace(/^a\//, "");
      }
    }

    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      flushHunk();
      current = {
        path: file.path,
        ...(file.oldPath ? { oldPath: file.oldPath } : {}),
        status: file.status,
        header: line,
        oldStart: Number(header[1]),
        newStart: Number(header[2]),
        patch: "",
        additions: 0,
        deletions: 0,
      };
      continue;
    }
    if (current) {
      const hunk = current as Omit<Hunk, "id">;
      if (line.startsWith("+")) hunk.additions++;
      else if (line.startsWith("-")) hunk.deletions++;
      body.push(line);
    }
  }
  flushFile();

  return hunks.map((hunk, index) => ({ id: `h${index + 1}`, ...hunk }));
}

/** Number of lines in a hunk's patch; 0 for a file change with no text lines. */
export function hunkLineCount(hunk: Hunk): number {
  return hunk.patch ? hunk.patch.split("\n").length : 0;
}

/** One diff line of a piece with its old and new file line numbers. */
export type PieceLine = {
  kind: "add" | "del" | "ctx" | "meta";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

/** The lines of a piece with their file line numbers, for rendering. */
export function pieceLines(hunk: Hunk, from: number, to: number): PieceLine[] {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  const lines = (hunk.patch ? hunk.patch.split("\n") : []).map(
    (text): PieceLine => {
      if (text.startsWith("+")) {
        return { kind: "add", text, oldLine: null, newLine: newLine++ };
      }
      if (text.startsWith("-")) {
        return { kind: "del", text, oldLine: oldLine++, newLine: null };
      }
      if (text.startsWith("\\")) {
        return { kind: "meta", text, oldLine: null, newLine: null };
      }
      return { kind: "ctx", text, oldLine: oldLine++, newLine: newLine++ };
    },
  );
  return lines.slice(from - 1, to);
}

/**
 * Check that the agent's pieces cover every line of every hunk exactly once,
 * refer only to hunks and lines that exist, and that each review note points
 * at a piece of its stop. `lineCounts` maps hunk id to line count, in diff
 * order. Returns the problems found; an empty list means valid.
 */
export function validateTourCoverage(
  lineCounts: Record<string, number>,
  tour: AgentTour,
): string[] {
  const problems: string[] = [];
  const placed = new Map<
    string,
    Array<{ from: number; to: number; where: string }>
  >();

  if (tour.stops.length === 0) problems.push("The tour has no stops.");
  const places = [
    ...tour.stops.map((stop, i) => ({
      where: `stop ${i + 1}`,
      pieces: stop.pieces,
    })),
    { where: "skim", pieces: tour.skim.pieces },
  ];
  for (const { where, pieces } of places) {
    if (where !== "skim" && pieces.length === 0) {
      problems.push(`${where} has no pieces.`);
    }
    for (const piece of pieces) {
      const count = lineCounts[piece.hunkId];
      if (count === undefined) {
        problems.push(
          `${where} lists ${piece.hunkId}, which is not a hunk in this diff.`,
        );
        continue;
      }
      const inRange = count === 0
        ? piece.from === 1 && piece.to === 0
        : Number.isInteger(piece.from) && Number.isInteger(piece.to) &&
          1 <= piece.from &&
          piece.from <= piece.to && piece.to <= count;
      if (!inRange) {
        problems.push(
          count === 0
            ? `${where} gives lines for ${piece.hunkId}, which has no lines; place it whole.`
            : `${where} has ${piece.hunkId} lines ${piece.from}-${piece.to}, outside its lines 1-${count}.`,
        );
        continue;
      }
      if (!placed.has(piece.hunkId)) placed.set(piece.hunkId, []);
      placed.get(piece.hunkId)!.push({ from: piece.from, to: piece.to, where });
    }
  }
  tour.stops.forEach((stop, i) => {
    for (const focus of stop.reviewFocus) {
      if (
        !(Number.isInteger(focus.piece) && focus.piece >= 1 &&
          focus.piece <= stop.pieces.length)
      ) {
        problems.push(
          `stop ${
            i + 1
          } has a reviewFocus on piece ${focus.piece}, but the stop has ${stop.pieces.length} pieces.`,
        );
      }
    }
  });

  const missing: string[] = [];
  for (const [id, count] of Object.entries(lineCounts)) {
    const ranges = (placed.get(id) ?? []).sort((a, b) => a.from - b.from);
    if (ranges.length === 0) {
      missing.push(id);
      continue;
    }
    if (count === 0) {
      if (ranges.length > 1) {
        problems.push(
          `${id} appears in both ${ranges[0].where} and ${ranges[1].where}.`,
        );
      }
      continue;
    }
    let next = 1;
    let previous = "";
    for (const range of ranges) {
      if (range.from > next) {
        problems.push(
          `${id} lines ${next}-${range.from - 1} are not placed anywhere.`,
        );
      }
      if (range.from < next) {
        problems.push(
          `${id} lines ${range.from}-${
            Math.min(range.to, next - 1)
          } appear in both ${previous} and ${range.where}.`,
        );
      }
      if (range.to + 1 > next) {
        next = range.to + 1;
        previous = range.where;
      }
    }
    if (next <= count) {
      problems.push(`${id} lines ${next}-${count} are not placed anywhere.`);
    }
  }
  if (missing.length > 0) {
    problems.push(
      `These hunks are not placed anywhere: ${missing.join(", ")}.`,
    );
  }
  return problems;
}

/** The PR fields the tour prompt and the stored tour use. */
export type PrMeta = {
  title: string;
  body: string;
  url: string;
  author: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  additions: number;
  deletions: number;
};

async function fetchPr(
  g: GlobalArgs,
  prNumber: number,
): Promise<{ meta: PrMeta; diff: string }> {
  const view = JSON.parse(
    await runOrThrow("gh", [
      "pr",
      "view",
      String(prNumber),
      "-R",
      g.repoSlug,
      "--json",
      "title,body,url,author,baseRefName,headRefName,headRefOid,additions,deletions",
    ]),
  );
  const diff = await runOrThrow("gh", [
    "pr",
    "diff",
    String(prNumber),
    "-R",
    g.repoSlug,
  ]);
  return {
    meta: {
      title: view.title,
      body: view.body ?? "",
      url: view.url,
      author: view.author?.login ?? "",
      baseRef: view.baseRefName,
      headRef: view.headRefName,
      headSha: view.headRefOid,
      additions: view.additions ?? 0,
      deletions: view.deletions ?? 0,
    },
    diff,
  };
}

/**
 * The prompt that asks the agent for a tour: PR metadata, every hunk with
 * numbered lines (hunks past maxDiffBytes are listed without their lines),
 * and the rules and JSON shape of the answer.
 */
export function buildTourPrompt(
  meta: PrMeta,
  hunks: Hunk[],
  maxDiffBytes: number,
): string {
  let budget = maxDiffBytes;
  const hunkBlocks = hunks.map((hunk) => {
    const where = hunk.oldPath ? `${hunk.oldPath} → ${hunk.path}` : hunk.path;
    const head = `### ${hunk.id} — ${where} (${hunk.status}) ${hunk.header}`
      .trimEnd();
    if (!hunk.patch) return `${head}\n(no lines; place it whole)`;
    if (hunk.patch.length > budget) {
      return `${head}\n(${
        hunkLineCount(hunk)
      } lines omitted for size: +${hunk.additions} −${hunk.deletions}; ` +
        `read the file in the checkout, and place this hunk whole)`;
    }
    budget -= hunk.patch.length;
    const numbered = hunk.patch.split("\n").map((line, i) =>
      `${String(i + 1).padStart(4)}│${line}`
    ).join("\n");
    return `${head}\n\`\`\`\n${numbered}\n\`\`\``;
  }).join("\n\n");

  return `You are preparing a guided code tour of a pull request for a reviewer who has not seen it.
The reviewer reads the tour stop by stop: each stop's narrative sits beside the real diff lines it covers.

Your current directory is a read-only checkout of the PR at its head commit (${meta.headSha}).
Read the code around the hunks whenever it helps you explain them accurately.

PR #${meta.url.split("/").pop()}: ${meta.title}
Author: ${meta.author}
Branch: ${meta.headRef} → ${meta.baseRef}

PR description:
${meta.body.trim() || "(empty)"}

The diff is split into hunks with ids. Each hunk's lines are numbered 1, 2, 3… at the left of the │; these are
line numbers within the hunk, not file line numbers. Every line of every hunk must be placed exactly once,
in a stop or in skim, as pieces: {"hunk": "h7", "lines": "1-14"} shows lines 1 to 14 of h7, and
{"hunk": "h7"} with no lines shows the whole hunk.

${hunkBlocks}

How to build the tour:
- Follow the change's logic, not its files. Each stop is one step of that logic: where the behavior starts,
  the data or core rule it relies on, each place that uses it, and the tests that prove it. Order stops so
  understanding builds, and do not simply follow file order.
- Split hunks along that logic. A long hunk often holds several units (methods, test examples, blocks) that
  serve different steps: give each unit to the stop it serves, so the same file and even the same hunk
  appear at several stops. For example, a new file defining one method used at stop 2 and another used at
  stop 4 becomes two pieces, and a spec hunk whose examples test different stops is split by example.
  Before placing any hunk longer than about 20 lines whole, check which stop each of its units serves.
  Keep a hunk whole only when all of its units serve one step. Cut at the boundary between units, and keep
  a unit's blank line or closing "end" with it.
- Put a test piece at the stop whose code it verifies, after that code. Prefer 4 to 10 stops.
- Put lockfiles, generated files, schema dumps, snapshots, pure renames, and mechanical formatting in skim.
- title: at most 8 words, naming what the stop changes.
- narrative: 2 to 5 sentences in the code's own terms: what this step changes, why the PR needs it, and
  how it connects to the previous stop. State only what the diff and the code show.
- note: optional on a piece, one short line when its role is not obvious from the narrative.
- reviewFocus: 0 to 3 specific things to verify at this stop, each tied to a piece by its 1-based position
  in the stop's pieces, such as an edge case the code may miss or an assumption it relies on. Leave it
  empty rather than giving generic advice.
- risk: low, medium, or high, for how much careful review the stop needs.
- summary: 2 or 3 sentences on what the PR does overall.

Respond with exactly one fenced json code block and no other prose:
\`\`\`json
{
  "summary": "...",
  "stops": [
    {
      "title": "...",
      "narrative": "...",
      "pieces": [{"hunk": "h7", "lines": "1-14"}, {"hunk": "h2"}, {"hunk": "h19", "lines": "1-31", "note": "..."}],
      "reviewFocus": [{"piece": 1, "note": "..."}],
      "risk": "medium"
    }
  ],
  "skim": {"pieces": [{"hunk": "h9"}], "reason": "..."}
}
\`\`\``;
}

async function invokeAgent(
  g: GlobalArgs,
  context: MethodContext,
  prompt: string,
  cwd: string,
  tags: Record<string, string>,
): Promise<
  { parsed: Record<string, unknown>; provider: string; model: string }
> {
  const result = await context.runModel({
    definition: g.cliAgentModel,
    method: "invokeAndParse",
    arguments: {
      prompt,
      ...(g.agentProvider ? { provider: g.agentProvider } : {}),
      ...(g.agentModel ? { model: g.agentModel } : {}),
      cwd,
      tags,
      wallTimeoutMs: g.wallTimeoutMs,
      toolProfile: "readonly",
    },
  });
  if (!result.ok) {
    throw new Error(
      `cli-agent ${g.cliAgentModel} failed: ${
        result.error.message.slice(0, 500)
      }`,
    );
  }
  for (const handle of result.resources) {
    // attributes is left out of very large results; read the content then.
    let attributes = handle.attributes;
    if (!attributes) {
      const raw = await context.dataRepository.getContent(
        CLI_AGENT_TYPE,
        g.cliAgentModel,
        handle.name,
        handle.version,
      );
      attributes = raw ? JSON.parse(new TextDecoder().decode(raw)) : undefined;
    }
    const parsed = attributes?.parsedResponse;
    if (parsed && typeof parsed === "object") {
      return {
        parsed: parsed as Record<string, unknown>,
        provider: String(attributes?.provider ?? g.agentProvider),
        model: String(attributes?.model ?? g.agentModel),
      };
    }
  }
  throw new Error("cli-agent returned no parsed JSON response");
}

function toPiece(raw: unknown, lineCounts: Record<string, number>): Piece {
  const r = (typeof raw === "string" ? { hunk: raw } : raw ?? {}) as Record<
    string,
    unknown
  >;
  const hunkId = String(r.hunk ?? r.hunkId ?? "");
  let from = 1;
  let to = lineCounts[hunkId] ?? 0;
  if (r.lines !== undefined && r.lines !== null && r.lines !== "") {
    const match = String(r.lines).match(/^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/);
    from = match ? Number(match[1]) : NaN;
    to = match ? Number(match[2] ?? match[1]) : NaN;
  }
  return { hunkId, from, to, ...(r.note ? { note: String(r.note) } : {}) };
}

/** Normalize the agent's JSON into the stored shape; validateTourCoverage judges the result. */
export function toAgentTour(
  raw: Record<string, unknown>,
  lineCounts: Record<string, number>,
): AgentTour {
  const stops = Array.isArray(raw.stops) ? raw.stops : [];
  const skim = (raw.skim ?? {}) as Record<string, unknown>;
  const pieces = (list: unknown) =>
    Array.isArray(list) ? list.map((p) => toPiece(p, lineCounts)) : [];
  return {
    summary: String(raw.summary ?? ""),
    stops: stops.map((s: Record<string, unknown>) => ({
      title: String(s.title ?? ""),
      narrative: String(s.narrative ?? ""),
      pieces: pieces(s.pieces),
      reviewFocus: Array.isArray(s.reviewFocus)
        ? s.reviewFocus.map((f: Record<string, unknown>) => ({
          piece: Number(f?.piece),
          note: String(f?.note ?? ""),
        }))
        : [],
      risk:
        (["low", "medium", "high"].includes(String(s.risk))
          ? s.risk
          : "medium") as "low" | "medium" | "high",
    })),
    skim: { pieces: pieces(skim.pieces), reason: String(skim.reason ?? "") },
  };
}

async function withWorktree<T>(
  g: GlobalArgs,
  prNumber: number,
  headSha: string,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const repo = expandHome(g.repoPath);
  const root = expandHome(g.worktreeRoot);
  const path = `${root}/${prNumber}-${headSha.slice(0, 12)}`;
  await Deno.mkdir(root, { recursive: true });
  await runOrThrow("git", [
    "-C",
    repo,
    "fetch",
    "--quiet",
    g.gitRemote,
    `pull/${prNumber}/head`,
  ]);
  await run("git", ["-C", repo, "worktree", "remove", "--force", path]);
  await runOrThrow("git", [
    "-C",
    repo,
    "worktree",
    "add",
    "--quiet",
    "--detach",
    path,
    headSha,
  ]);
  try {
    return await fn(path);
  } finally {
    await run("git", ["-C", repo, "worktree", "remove", "--force", path]);
  }
}

/** A data handle as `runModel` returns it. */
type ResourceHandle = {
  name: string;
  version: number;
  attributes?: Record<string, unknown>;
};

/** The parts of swamp's method context that `build` uses. */
type MethodContext = {
  globalArgs: GlobalArgs;
  runModel: (options: {
    definition: string;
    method: string;
    arguments: Record<string, unknown>;
  }) => Promise<
    { ok: true; resources: ResourceHandle[] } | {
      ok: false;
      error: { message: string };
    }
  >;
  dataRepository: {
    getContent: (
      type: string,
      model: string,
      name: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
  readResource: (
    instanceName: string,
  ) => Promise<Record<string, unknown> | null>;
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

/**
 * The `@mgreten/pr-tour` model. Its one method, `build`, stores a tour of a
 * PR at its current head SHA; `@mgreten/pr-tour-report` renders it.
 */
export const model = {
  type: "@mgreten/pr-tour",
  version: "2026.11.10.1",
  globalArguments: GlobalArgsSchema,
  reports: ["@mgreten/pr-tour-report"],
  resources: {
    tour: {
      description:
        "A guided tour of one PR at one head SHA: ordered stops of real diff hunks with narrative.",
      schema: TourSchema,
      lifetime: "30d" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    build: {
      description:
        "Build a guided code tour of a PR at its current head SHA and store it as tour-<pr>-<sha12>. " +
        "Reuses an existing tour for the same SHA unless force is true. Read-only toward GitHub.",
      arguments: z.object({
        prNumber: z.number().int().positive(),
        force: z.boolean().default(false),
      }),
      execute: async (
        args: { prNumber: number; force?: boolean },
        context: MethodContext,
      ) => {
        const g = context.globalArgs;
        const { meta, diff } = await fetchPr(g, args.prNumber);
        const instanceName = `tour-${args.prNumber}-${
          meta.headSha.slice(0, 12)
        }`;

        const existing = args.force
          ? null
          : await context.readResource(instanceName);
        if (existing) {
          // Write the stored tour again so this run has a handle and the
          // page report renders it, without paying for another agent run.
          context.logger.info(
            "Tour {name} already exists for this head SHA; reusing it (force rebuilds)",
            {
              name: instanceName,
            },
          );
          return {
            dataHandles: [
              await context.writeResource("tour", instanceName, existing),
            ],
          };
        }

        const hunks = parseUnifiedDiff(diff);
        if (hunks.length === 0) {
          throw new Error(`PR #${args.prNumber} has no diff to tour`);
        }
        const lineCounts = Object.fromEntries(
          hunks.map((h) => [h.id, hunkLineCount(h)]),
        );
        const basePrompt = buildTourPrompt(meta, hunks, g.maxPromptDiffBytes);
        const tags = {
          workflow: "pr-tour",
          pr: String(args.prNumber),
          sha: meta.headSha.slice(0, 12),
        };

        const { agentTour, attempts, provider, model } = await withWorktree(
          g,
          args.prNumber,
          meta.headSha,
          async (cwd) => {
            let prompt = basePrompt;
            for (let attempt = 1; attempt <= 2; attempt++) {
              const { parsed: raw, provider, model } = await invokeAgent(
                g,
                context,
                prompt,
                cwd,
                tags,
              );
              const candidate = toAgentTour(raw, lineCounts);
              const problems = validateTourCoverage(lineCounts, candidate);
              if (problems.length === 0) {
                return {
                  agentTour: candidate,
                  attempts: attempt,
                  provider,
                  model,
                };
              }
              context.logger.warning(
                "Tour attempt {a} failed validation: {p}",
                {
                  a: attempt,
                  p: problems.join(" "),
                },
              );
              prompt =
                `${basePrompt}\n\nYour previous answer had these problems:\n- ${
                  problems.join("\n- ")
                }\n\n` +
                `Previous answer:\n\`\`\`json\n${
                  JSON.stringify(raw)
                }\n\`\`\`\n\nReturn the full corrected tour.`;
            }
            throw new Error(
              "The tour agent did not place every hunk line exactly once after 2 attempts",
            );
          },
        );

        const tour: Tour = {
          repo: g.repoSlug,
          prNumber: args.prNumber,
          title: meta.title,
          url: meta.url,
          author: meta.author,
          baseRef: meta.baseRef,
          headRef: meta.headRef,
          headSha: meta.headSha,
          additions: meta.additions,
          deletions: meta.deletions,
          builtAt: new Date().toISOString(),
          provider,
          model,
          attempts,
          summary: agentTour.summary,
          stops: agentTour.stops,
          skim: agentTour.skim,
          hunks,
        };
        const handle = await context.writeResource(
          "tour",
          instanceName,
          tour as unknown as Record<string, unknown>,
        );
        context.logger.info(
          "Built {name}: {s} stops, {p} pieces from {h} hunks, {k} skimmed",
          {
            name: instanceName,
            s: tour.stops.length,
            p: tour.stops.reduce((n, stop) => n + stop.pieces.length, 0),
            h: hunks.length,
            k: tour.skim.pieces.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
