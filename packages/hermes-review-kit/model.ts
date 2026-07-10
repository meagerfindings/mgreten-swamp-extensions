/**
 * Hermes review collector model.
 *
 * Scans recent Hermes sessions and nearby repo activity, then writes a compact
 * JSON summary for nightly review and publishability checks.
 *
 * @module
 */
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  repoDir: z.string().default("."),
  sessionDir: z.string().default("/opt/data/.hermes/sessions"),
  timezone: z.string().default("UTC"),
  lookbackHours: z.number().int().positive().default(24),
  maxSessions: z.number().int().positive().default(10),
  maxFiles: z.number().int().positive().default(20),
});

const SessionSummarySchema = z.object({
  sessionId: z.string(),
  sessionStart: z.string().optional(),
  lastUpdated: z.string().optional(),
  messageCount: z.number().int(),
  userRequests: z.array(z.string()),
  assistantResponses: z.array(z.string()),
  topics: z.array(z.string()),
});

const FileSummarySchema = z.object({
  path: z.string(),
  mtime: z.string(),
});

const ReviewSummarySchema = z.object({
  generatedAt: z.string(),
  timezone: z.string(),
  lookbackHours: z.number().int(),
  windowStart: z.string(),
  windowEnd: z.string(),
  sessionCount: z.number().int(),
  fileCount: z.number().int(),
  sessions: z.array(SessionSummarySchema),
  recentFiles: z.array(FileSummarySchema),
  reusablePatterns: z.array(z.string()),
  publishableIdeas: z.array(z.string()),
  approvalNeeded: z.array(z.string()),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
type ReviewSummary = z.infer<typeof ReviewSummarySchema>;

type SessionFile = {
  session_id?: string;
  session_start?: string;
  last_updated?: string;
  message_count?: number;
  messages?: Array<{ role?: string; content?: string }>;
};

const KEYWORDS: Array<[RegExp, string]> = [
  [/\bcron\b/i, "cron"],
  [/\bworkflow\b/i, "workflow"],
  [/\breport\b/i, "report"],
  [/\bextension\b/i, "extension"],
  [/\bmodel\b/i, "model"],
  [/\bpublish/i, "publish"],
  [/\breview\b/i, "review"],
  [/\bharmony\b/i, "harmony"],
  [/\bhermes\b/i, "hermes"],
];

function truncate(text: string, limit = 260): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function parseDateTime(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatIso(date: Date): string {
  return date.toISOString();
}

function extractTopics(texts: string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const [pattern, label] of KEYWORDS) {
      if (pattern.test(text)) found.add(label);
    }
  }
  return [...found].sort();
}

async function walkRecentFiles(
  root: string,
  cutoffMs: number,
  maxFiles: number,
): Promise<Array<{ path: string; mtime: string }>> {
  const results: Array<{ path: string; mtime: string }> = [];
  const roots = [
    `${root}/extensions`,
    `${root}/models`,
    `${root}/workflows`,
    `${root}/scripts`,
    `${root}/.agents`,
    `${root}/.hermes`,
  ];
  const rootFiles = ["AGENTS.md", "CLAUDE.md", ".hermes/config.yaml"];
  const skipDirs = new Set([
    ".git",
    "node_modules",
    ".swamp/cache",
    ".swamp/bundles",
    ".swamp/pulled-extensions",
  ]);

  async function scanPath(path: string): Promise<void> {
    try {
      const stat = await Deno.stat(path);
      if (stat.isFile && stat.mtime && stat.mtime.getTime() >= cutoffMs) {
        results.push({ path, mtime: stat.mtime.toISOString() });
        return;
      }
      if (!stat.isDirectory) return;
    } catch {
      return;
    }

    const entries: Deno.DirEntry[] = [];
    try {
      for await (const entry of Deno.readDir(path)) entries.push(entry);
    } catch {
      return;
    }

    for (const entry of entries) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory) {
        if (skipDirs.has(entry.name)) continue;
        await scanPath(child);
        continue;
      }
      if (!entry.isFile) continue;
      try {
        const stat = await Deno.stat(child);
        if (!stat.mtime) continue;
        if (stat.mtime.getTime() < cutoffMs) continue;
        results.push({ path: child, mtime: stat.mtime.toISOString() });
      } catch {
        continue;
      }
    }
  }

  for (const file of rootFiles) {
    await scanPath(`${root}/${file}`);
  }
  for (const dir of roots) {
    await scanPath(dir);
  }

  results.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return results.slice(0, maxFiles);
}

function summarizeSession(
  session: SessionFile,
  raw: Record<string, unknown>,
): z.infer<typeof SessionSummarySchema> {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const userRequests = messages
    .filter((m) => m?.role === "user" && typeof m?.content === "string")
    .map((m) => truncate(String(m.content)))
    .filter(Boolean)
    .slice(0, 5);
  const assistantResponses = messages
    .filter((m) => m?.role === "assistant" && typeof m?.content === "string")
    .map((m) => truncate(String(m.content)))
    .filter(Boolean);
  const lastResponse = assistantResponses.slice(-1);
  const topics = extractTopics([...userRequests, ...lastResponse]);
  return {
    sessionId: String(raw.session_id ?? session.session_id ?? "unknown"),
    sessionStart: session.session_start,
    lastUpdated: session.last_updated,
    messageCount: Number(session.message_count ?? messages.length),
    userRequests,
    assistantResponses: lastResponse,
    topics,
  };
}

/** Model for collecting Hermes review inputs from local files. */
export const model = {
  type: "@mgreten/hermes-review-collector",
  version: "2026.07.10.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    summary: {
      description: "Daily Hermes review summary",
      schema: ReviewSummarySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    collect: {
      description:
        "Collect recent Hermes sessions and nearby repo changes into one summary",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const cfg = context.globalArgs as GlobalArgs;
        const now = new Date();
        const windowEnd = now;
        const windowStart = new Date(
          now.getTime() - cfg.lookbackHours * 60 * 60 * 1000,
        );
        const cutoffMs = windowStart.getTime();
        const sessions: z.infer<typeof SessionSummarySchema>[] = [];

        try {
          for await (const entry of Deno.readDir(cfg.sessionDir)) {
            if (!entry.isFile || !entry.name.endsWith(".json")) continue;
            const path = `${cfg.sessionDir}/${entry.name}`;
            let parsed: SessionFile;
            try {
              parsed = JSON.parse(await Deno.readTextFile(path));
            } catch {
              continue;
            }
            const lastUpdated = parseDateTime(parsed.last_updated);
            const sessionStart = parseDateTime(parsed.session_start);
            const stamp = lastUpdated ?? sessionStart;
            if (!stamp || stamp.getTime() < cutoffMs) continue;
            sessions.push(
              summarizeSession(
                parsed,
                parsed as unknown as Record<string, unknown>,
              ),
            );
          }
        } catch (error) {
          context.logger.warning(
            "Could not scan session directory {dir}: {error}",
            {
              dir: cfg.sessionDir,
              error: String(error),
            },
          );
        }

        sessions.sort((a, b) => {
          const aTime =
            parseDateTime(a.lastUpdated ?? a.sessionStart ?? "")?.getTime() ??
              0;
          const bTime =
            parseDateTime(b.lastUpdated ?? b.sessionStart ?? "")?.getTime() ??
              0;
          return bTime - aTime;
        });

        const selectedSessions = sessions.slice(0, cfg.maxSessions);
        const recentFiles = await walkRecentFiles(
          cfg.repoDir,
          cutoffMs,
          cfg.maxFiles,
        );
        const fileCount = recentFiles.length;

        const allText = [
          ...selectedSessions.flatMap((
            s,
          ) => [...s.userRequests, ...s.assistantResponses]),
          ...recentFiles.map((f) => f.path),
        ];
        const reusablePatterns = Array.from(
          new Set([
            ...(allText.some((t) => /cron/i.test(t))
              ? ["cron scheduling / validation"]
              : []),
            ...(allText.some((t) => /workflow/i.test(t))
              ? ["workflow orchestration"]
              : []),
            ...(allText.some((t) => /report/i.test(t))
              ? ["reporting / summaries"]
              : []),
            ...(allText.some((t) => /publish/i.test(t))
              ? ["publishable extension packaging"]
              : []),
          ]),
        ).sort();

        const publishableIdeas = Array.from(
          new Set([
            ...(allText.some((t) => /harmony/i.test(t))
              ? ["Harmony support review pack"]
              : []),
            ...(allText.some((t) => /hermes/i.test(t))
              ? ["Hermes daily review workflow + report"]
              : []),
            ...(allText.some((t) => /cron/i.test(t))
              ? ["Cron spec builder / validator"]
              : []),
          ]),
        ).sort();

        const approvalNeeded = Array.from(
          new Set([
            "Should this be published publicly under @mgreten?",
            "Should the collector include more aggressive file scanning outside /opt/data/swamp-hub?",
            "Should the morning brief deliver to Discord or remain local until the workflow is stable?",
          ]),
        ).sort();

        const summary: ReviewSummary = {
          generatedAt: formatIso(now),
          timezone: cfg.timezone,
          lookbackHours: cfg.lookbackHours,
          windowStart: formatIso(windowStart),
          windowEnd: formatIso(windowEnd),
          sessionCount: selectedSessions.length,
          fileCount,
          sessions: selectedSessions,
          recentFiles,
          reusablePatterns,
          publishableIdeas,
          approvalNeeded,
        };

        const handle = await context.writeResource("summary", "daily", summary);
        context.logger.info(
          "Collected {count} sessions and {files} files for Hermes review",
          {
            count: selectedSessions.length,
            files: fileCount,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
