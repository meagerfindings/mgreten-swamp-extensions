/**
 * `@mgreten/meeting-summarizer` — turn a Whisper transcript into a
 * Granola-style meeting note using a local Ollama LLM.
 *
 * Handles chunking (greedy segment-boundary splits at ~2500 tokens with
 * 200-token overlap) and multi-chunk merging automatically.  Works with any
 * Ollama-compatible model.  Pure TypeScript — no Python, no subprocess.
 *
 * Methods:
 *   `summarize`      — transcript JSON → Granola markdown
 *   `combine_notes`  — handwritten note + analysis → Combined Notes markdown
 */
import { z } from "npm:zod@4";

// ── Prompt templates ──────────────────────────────────────────────────────────

const CHUNK_PROMPT =
  `You are summarizing a meeting transcript into a Granola-style note.

The transcript is provided after this prompt. Read all of it before writing the
summary. Keep the meeting's own terminology. Do not invent facts. If something
isn't clear from the transcript, say so or write [unknown] rather than guessing.

Lines may be prefixed with a speaker label like [SPEAKER_00]: or [Alice]:.
When attributing decisions and action items, use the exact speaker label that
spoke them. If a segment has no label, treat the speaker as [unknown].

Output ONLY the markdown below — no preamble, no closing remarks.

# TL;DR

One short paragraph (2–4 sentences) capturing what the meeting was about and
what changed because of it. If nothing actually changed, say so.

## Key Discussion Points

Bulleted list. Group related points. Each bullet is one idea, one sentence
where possible. Skip small talk.

## Decisions

Bulleted list of decisions actually made (not just discussed). For each:
what was decided, and — if stated — who decided or who's accountable. If
nothing was decided, write - None.

## Action Items

Bulleted list. Each item:
- [Owner] short imperative description — due: <date or "unspecified">

If owner wasn't named, use [unknown]. If no action items, write - None.

## Open Questions

Bulleted list of things raised but not resolved. If none, write - None.

---

Transcript follows:`;

const MERGE_PROMPT =
  `You are merging N partial summaries of the same meeting into one final
Granola-style note. Each partial is wrapped with [partial chunk i/N].
Adjacent chunks overlap — dedupe that overlap.

Rules:
- Combine same-topic items into a single bullet.
- De-duplicate decisions and action items across partials.
- Preserve owners and deadlines EXACTLY as written. Owners may be speaker
  labels like [SPEAKER_00] or [Alice] — keep them verbatim. If partials
  disagree on owner or date for the same item, list both with a [?] marker.
- Keep the meeting's terminology. Do not invent facts. Use [unknown] rather
  than guessing.
- If a section is empty across all partials, write - None.

Output ONLY the markdown below — no preamble, no closing remarks.

# TL;DR

One short paragraph (2–4 sentences) capturing what the meeting was about and
what changed because of it. If nothing actually changed, say so.

## Key Discussion Points

Bulleted list. Group related points. Each bullet is one idea, one sentence
where possible.

## Decisions

Bulleted list of decisions actually made (not just discussed). For each:
what was decided, and — if stated — who decided or who's accountable. If
nothing was decided, write - None.

## Action Items

Bulleted list. Each item:

- [Owner] short imperative description — due: <date or "unspecified">

If owner wasn't named, use [unknown]. If no action items, write - None.

## Open Questions

Bulleted list of things raised but not resolved. If none, write - None.

---

Partial summaries follow:`;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Rough token estimator — word count × 1.3. No tiktoken dependency. */
function estimateTokens(text: string): number {
  return Math.round(text.split(/\s+/).filter(Boolean).length * 1.3);
}

/** Return segment text, optionally prefixed with [Speaker]: */
function segText(seg: Record<string, unknown>): string {
  const text = ((seg.text as string) ?? "").trim();
  if (!text) return "";
  const spk = seg.speaker as string | undefined;
  return spk ? `[${spk}]: ${text}` : text;
}

/** Greedy chunker on segment boundaries with token overlap. */
function chunkSegments(
  segments: Record<string, unknown>[],
  chunkTokens: number,
  overlapTokens: number,
): string[] {
  const chunks: string[] = [];
  let cur: string[] = [];
  let curTokens = 0;

  for (const seg of segments) {
    const t = segText(seg);
    if (!t) continue;
    const tTokens = estimateTokens(t);
    if (curTokens + tTokens > chunkTokens && cur.length > 0) {
      chunks.push(cur.join(" "));
      // overlap tail from end of previous chunk
      const tail: string[] = [];
      let tailTokens = 0;
      for (let i = cur.length - 1; i >= 0; i--) {
        const st = estimateTokens(cur[i]);
        if (tailTokens + st > overlapTokens) break;
        tail.unshift(cur[i]);
        tailTokens += st;
      }
      cur = [...tail];
      curTokens = tailTokens;
    }
    cur.push(t);
    curTokens += tTokens;
  }
  if (cur.length > 0) chunks.push(cur.join(" "));
  return chunks;
}

/** Strip <think>…</think> reasoning traces some models emit inline. */
function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
}

/** POST a prompt + body to Ollama's /api/generate endpoint. */
async function callOllama(
  ollamaUrl: string,
  ollamaModel: string,
  prompt: string,
  body: string,
  timeoutMs = 3_600_000,
): Promise<string> {
  const resp = await fetch(`${ollamaUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ollamaModel,
      prompt: `${prompt}\n\n${body}`,
      stream: false,
      think: false,
      options: { temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    throw new Error(`Ollama error (${resp.status}): ${await resp.text()}`);
  }
  // deno-lint-ignore no-explicit-any
  const json = (await resp.json()) as any;
  return stripThink((json.response as string) ?? "");
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const GlobalArgsSchema = z.object({
  ollamaUrl: z
    .string()
    .default("http://localhost:11434")
    .describe("Ollama API base URL"),
  ollamaModel: z
    .string()
    .default("qwen3.6:35b-a3b-nvfp4")
    .describe("Ollama model tag to use for summarization"),
  chunkTokens: z
    .number()
    .default(2500)
    .describe("Max tokens per transcript chunk before splitting"),
  overlapTokens: z
    .number()
    .default(200)
    .describe("Token overlap between adjacent chunks"),
});

const SummaryResourceSchema = z.object({
  markdown: z.string().describe("Granola-style meeting note in markdown"),
  model: z.string().describe("Ollama model used"),
  chunkCount: z.number().describe("Number of transcript chunks processed"),
  durationMs: z.number().describe("Total LLM time in milliseconds"),
});

const CombinedResourceSchema = z.object({
  markdown: z.string().describe(
    "Combined handwritten + automated notes in markdown",
  ),
  notesName: z.string().describe("Stem of the handwritten notes file"),
  analysisName: z.string().describe("Stem of the analysis file"),
});

const NoteFileResourceSchema = z.object({
  filePath: z.string().describe("Absolute path of the written file"),
  filename: z.string().describe("Filename with extension"),
  outputDir: z.string().describe("Directory the file was written to"),
  byteCount: z.number().describe("File size in bytes"),
});

// ── Model export ──────────────────────────────────────────────────────────────

/**
 * Meeting summarizer model — chunks a Whisper transcript and summarizes it
 * into a Granola-style note via Ollama.  See module doc for full details.
 */
export const model = {
  type: "@mgreten/meeting-summarizer",
  version: "2026.05.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    summary: {
      description: "Granola-style meeting summary markdown",
      schema: SummaryResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    combined: {
      description: "Combined handwritten + automated meeting notes markdown",
      schema: CombinedResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    noteFile: {
      description: "Metadata for a meeting note written to disk",
      schema: NoteFileResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    summarize: {
      description:
        "Chunk a Whisper transcript and summarize it into a Granola-style note via Ollama",
      arguments: z.object({
        transcriptJson: z
          .string()
          .describe(
            "Whisper JSON transcript content (output of mlx-whisper or pyannote-diarizer)",
          ),
        instanceName: z
          .string()
          .optional()
          .describe("Resource instance name"),
      }),
      execute: async (
        args: { transcriptJson: string; instanceName?: string },
        // deno-lint-ignore no-explicit-any
        context: any,
      ) => {
        const { ollamaUrl, ollamaModel, chunkTokens, overlapTokens } =
          context.globalArgs;
        const start = Date.now();

        let data: { segments?: Record<string, unknown>[] };
        try {
          data = JSON.parse(args.transcriptJson);
        } catch (err) {
          throw new Error(`transcriptJson is not valid JSON: ${err}`);
        }
        const segments = data.segments ?? [];
        const chunks = chunkSegments(segments, chunkTokens, overlapTokens);

        context.logger.info(
          `${segments.length} segments → ${chunks.length} chunk(s)`,
        );

        if (chunks.length === 0) {
          throw new Error("No transcript content to summarize");
        }

        let markdown: string;

        if (chunks.length === 1) {
          markdown = await callOllama(
            ollamaUrl,
            ollamaModel,
            CHUNK_PROMPT,
            chunks[0],
          );
        } else {
          const partials: string[] = [];
          for (let i = 0; i < chunks.length; i++) {
            context.logger.info(
              `Chunk ${i + 1}/${chunks.length} (~${
                estimateTokens(chunks[i])
              } tok)`,
            );
            const out = await callOllama(
              ollamaUrl,
              ollamaModel,
              CHUNK_PROMPT,
              chunks[i],
            );
            partials.push(`[partial chunk ${i + 1}/${chunks.length}]\n${out}`);
          }
          context.logger.info(`Merging ${partials.length} partials`);
          markdown = await callOllama(
            ollamaUrl,
            ollamaModel,
            MERGE_PROMPT,
            partials.join("\n\n---\n\n"),
          );
        }

        const durationMs = Date.now() - start;
        context.logger.info(`Done in ${durationMs}ms`);

        const name = args.instanceName ?? "latest";
        const handle = await context.writeResource("summary", name, {
          markdown,
          model: ollamaModel,
          chunkCount: chunks.length,
          durationMs,
        });

        return { dataHandles: [handle] };
      },
    },

    combine_notes: {
      description:
        "Combine an existing handwritten Obsidian note with the automated analysis markdown",
      arguments: z.object({
        notesMarkdown: z
          .string()
          .describe("Content of the existing handwritten meeting note"),
        analysisMarkdown: z
          .string()
          .describe("Generated analysis markdown (output of summarize method)"),
        notesName: z
          .string()
          .describe("Stem of the handwritten notes file (for [[wikilinks]])"),
        analysisName: z
          .string()
          .describe("Stem of the analysis file (for [[wikilinks]])"),
        title: z.string().optional().describe("Title for the combined note"),
        instanceName: z
          .string()
          .optional()
          .describe("Resource instance name"),
      }),
      execute: async (
        args: {
          notesMarkdown: string;
          analysisMarkdown: string;
          notesName: string;
          analysisName: string;
          title?: string;
          instanceName?: string;
        },
        // deno-lint-ignore no-explicit-any
        context: any,
      ) => {
        const title = args.title ?? args.notesName;

        // Strip leading H1 from handwritten notes (it becomes the combined title)
        const notesBody = args.notesMarkdown
          .trimStart()
          .replace(/^# .*?\n(\n+)?/, "")
          .trim();

        // Normalize analysis heading levels to H3 so they nest under the H2 sections
        const analysisBody = args.analysisMarkdown
          .trim()
          .replace(/^#{1,2}\s+/gm, "### ");

        const markdown = `# ${title} - Combined Notes

**Related:** [[${args.notesName}]] · [[${args.analysisName}]]

This document preserves the original handwritten notes and adds the automated
analysis from the meeting recording.

---

## Handwritten Notes

${notesBody}

---

## Automated Meeting Analysis

${analysisBody}

---

## Personal Observations

- Add any corrections, context, or follow-up thoughts here after reviewing both
  sources.

## Next Steps

- Review the action items above and move the confirmed follow-ups into your task
  system.
`;

        context.logger.info(
          `Combined "${args.notesName}" + "${args.analysisName}"`,
        );

        const name = args.instanceName ?? args.notesName;
        const handle = await context.writeResource("combined", name, {
          markdown,
          notesName: args.notesName,
          analysisName: args.analysisName,
        });

        return { dataHandles: [handle] };
      },
    },

    write_note: {
      description: "Write a meeting note markdown string to a file on disk",
      arguments: z.object({
        markdown: z.string().describe("Markdown content to write"),
        outputDir: z.string().describe(
          "Directory to write the file (created if needed)",
        ),
        filename: z.string().describe("Filename including .md extension"),
        instanceName: z.string().optional().describe("Resource instance name"),
      }),
      execute: async (
        args: {
          markdown: string;
          outputDir: string;
          filename: string;
          instanceName?: string;
        },
        // deno-lint-ignore no-explicit-any
        context: any,
      ) => {
        await Deno.mkdir(args.outputDir, { recursive: true });
        const filePath = `${args.outputDir}/${args.filename}`;
        await Deno.writeTextFile(filePath, args.markdown);
        const byteCount = new TextEncoder().encode(args.markdown).length;
        context.logger.info(`Wrote ${byteCount} bytes → ${filePath}`);

        const name = args.instanceName ?? args.filename;
        const handle = await context.writeResource("noteFile", name, {
          filePath,
          filename: args.filename,
          outputDir: args.outputDir,
          byteCount,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
