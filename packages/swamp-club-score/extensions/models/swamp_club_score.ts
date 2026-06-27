// Swamp, an Automation Framework Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify it under the terms
// of the GNU Affero General Public License version 3 as published by the Free
// Software Foundation, with the Swamp Extension and Definition Exception (found in
// the "COPYING-EXCEPTION" file).
//
// Swamp is distributed in the hope that it will be useful, but WITHOUT ANY
// WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
// PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License along
// with Swamp. If not, see <https://www.gnu.org/licenses/>.

import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  username: z.string().min(1).default("mgreten"),
  swampClubUrl: z.string().url().default("https://swamp.club"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

type LeaderboardRow = {
  rank: number;
  username: string;
  score: number;
  scoreLabel: string;
  tierName: string;
  tierScore: number;
  isTargetUser: boolean;
};

type LeaderboardBoard = {
  name: string;
  found: boolean;
  rows: LeaderboardRow[];
};

type TopBucket = {
  name: string;
  score: number;
  scoreLabel: string;
};

type Snapshot = {
  username: string;
  profileUrl: string;
  fetchedAt: string;
  score: number;
  scoreLabel: string;
  rank: number | null;
  tierName: string;
  tierScore: number;
  activeDays: number | null;
  activeYear: number | null;
  streakDays: number | null;
  joinedText: string | null;
  bio: string | null;
  topBuckets: TopBucket[];
  leaderboards: Record<string, LeaderboardBoard>;
};

const LeaderboardRowSchema = z.object({
  rank: z.number(),
  username: z.string(),
  score: z.number(),
  scoreLabel: z.string(),
  tierName: z.string(),
  tierScore: z.number(),
  isTargetUser: z.boolean(),
});

const LeaderboardBoardSchema = z.object({
  name: z.string(),
  found: z.boolean(),
  rows: z.array(LeaderboardRowSchema),
});

const TopBucketSchema = z.object({
  name: z.string(),
  score: z.number(),
  scoreLabel: z.string(),
});

const SnapshotSchema = z.object({
  username: z.string(),
  profileUrl: z.string().url(),
  fetchedAt: z.string(),
  score: z.number(),
  scoreLabel: z.string(),
  rank: z.number().nullable(),
  tierName: z.string(),
  tierScore: z.number(),
  activeDays: z.number().nullable(),
  activeYear: z.number().nullable(),
  streakDays: z.number().nullable(),
  joinedText: z.string().nullable(),
  bio: z.string().nullable(),
  topBuckets: z.array(TopBucketSchema),
  leaderboards: z.record(LeaderboardBoardSchema),
});

function cleanText(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCompactNumber(input: string): number {
  const trimmed = input.trim().replace(/,/g, "");
  const match = trimmed.match(/^-?(\d+(?:\.\d+)?)([kKmM])?/);
  if (!match) return 0;
  const numeric = Number(match[1]);
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : 1;
  return Number.isFinite(numeric) ? Math.round(numeric * multiplier) : 0;
}

function extractMatch(html: string, regex: RegExp): string | null {
  const match = html.match(regex);
  return match?.[1] ?? null;
}

function extractNumber(html: string, regex: RegExp): number | null {
  const text = extractMatch(html, regex);
  if (!text) return null;
  const value = parseCompactNumber(text);
  return Number.isFinite(value) ? value : null;
}

function extractLeaderboardBoard(
  boardName: string,
  data: unknown,
  targetUsername: string,
): LeaderboardBoard {
  const raw = data as {
    boards?: Record<string, { rows?: unknown[]; entries?: unknown[] }>;
    leaderboard?: Record<string, { rows?: unknown[]; entries?: unknown[] }>;
  };

  const boards = (raw.boards ?? raw.leaderboard ?? {}) as Record<
    string,
    { rows?: unknown[]; entries?: unknown[] }
  >;
  const maybeBoard = boards[boardName];

  const rows = (maybeBoard?.rows ?? maybeBoard?.entries ?? []) as Array<{
    rank?: number;
    username?: string;
    score?: number;
    pts?: number;
    points?: number;
    tierName?: string;
    tierScore?: number;
  }>;

  return {
    name: boardName,
    found: Array.isArray(rows) && rows.length > 0,
    rows: rows
      .filter((row) => typeof row.username === "string")
      .map((row) => ({
        rank: Number(row.rank ?? 0),
        username: row.username ?? "",
        score: Number(row.score ?? row.pts ?? row.points ?? 0),
        scoreLabel: String(row.score ?? row.pts ?? row.points ?? 0),
        tierName: String(row.tierName ?? ""),
        tierScore: Number(row.tierScore ?? 0),
        isTargetUser: row.username === targetUsername,
      }))
      .sort((a, b) => a.rank - b.rank),
  };
}

function extractLeaderboardRow(
  boardHtml: string,
  targetUsername: string,
): LeaderboardRow | null {
  const rowMatch = boardHtml.match(
    /<a[^>]+href="\/u\/([^\"]+)"[\s\S]*?<span class="font-mono text-hud-code text-hud-muted tabular-nums">(\d+)<\/span>[\s\S]*?<span class="font-mono text-hud-label text-white tabular-nums">([^<]+)<\/span>[\s\S]*?<span class="font-mono text-hud-code text-white tabular-nums">([^<]+)<\/span>/,
  );
  if (!rowMatch) return null;
  const username = rowMatch[1];
  const rank = Number(rowMatch[2]);
  const scoreLabel = rowMatch[3];
  const tierText = rowMatch[4];
  const tierMatch = tierText.match(/^(.+?)\s*\(([^)]+)\)$/);
  const tierName = tierMatch?.[1] ?? tierText;
  const tierScore = tierMatch ? parseCompactNumber(tierMatch[2]) : 0;
  return {
    rank,
    username,
    score: parseCompactNumber(scoreLabel),
    scoreLabel,
    tierName,
    tierScore,
    isTargetUser: username === targetUsername,
  };
}

function parseTopBuckets(html: string): TopBucket[] {
  const sectionStart = html.indexOf("Show full breakdown");
  if (sectionStart < 0) return [];
  const sectionEnd = html.indexOf("</details>", sectionStart);
  const section = html.slice(
    sectionStart,
    sectionEnd > sectionStart ? sectionEnd : undefined,
  );

  const buckets: TopBucket[] = [];
  const re =
    /<div data-frsh-key="([a-z0-9_-]+)" class="bg-black\/40 border border-white\/\[(?:0\.06|10)\] px-3 py-2">[\s\S]*?<span class="font-mono text-hud-code text-white tabular-nums"(?: style="color:#39ff14;")?>([^<]+)<\/span>/g;
  for (const match of section.matchAll(re)) {
    buckets.push({
      name: match[1],
      scoreLabel: match[2],
      score: parseCompactNumber(match[2]),
    });
  }
  return buckets.sort((a, b) => b.score - a.score).slice(0, 10);
}

function parseProfileHtml(html: string): {
  score: number;
  scoreLabel: string;
  rank: number | null;
  tierName: string;
  tierScore: number;
  activeDays: number | null;
  activeYear: number | null;
  streakDays: number | null;
  joinedText: string | null;
  bio: string | null;
  topBuckets: TopBucket[];
} {
  const scoreLabel = extractMatch(
    html,
    /<span class="font-mono text-hud-body text-white font-bold tabular-nums">([^<]+)<\/span>/,
  ) ??
    "0";
  const score = parseCompactNumber(scoreLabel);

  const rank = extractNumber(
    html,
    /<span class="font-mono text-hud-micro uppercase tracking-\[0\.18em\] text-hud-muted tabular-nums">#?(\d+)<\/span>/,
  );

  const tierMatch = html.match(
    /<div class="text-2xl font-bold text-white">\s*([^<]+?)\s*<\/div>[\s\S]*?<div class="font-mono text-hud-label text-white tabular-nums">([^<]+)<\/div>/,
  );
  const tierName = tierMatch?.[1]?.trim() ?? "";
  const tierScore = tierMatch ? parseCompactNumber(tierMatch[2]) : 0;

  const activeDaysMatch = html.match(/(\d+) active days in (\d{4})/);
  const activeDays = activeDaysMatch ? Number(activeDaysMatch[1]) : null;
  const activeYear = activeDaysMatch ? Number(activeDaysMatch[2]) : null;
  const streakDays = extractNumber(html, /aria-label="(\d+) day streak"/);

  const joinedText = extractMatch(html, /joined ([^<]+?)\s*<\/span>/);
  const bio = cleanText(
    extractMatch(html, /<p class="text-hud-muted">([\s\S]*?)<\/p>/) ?? "",
  ) || null;

  return {
    score,
    scoreLabel,
    rank: rank ?? null,
    tierName,
    tierScore,
    activeDays,
    activeYear,
    streakDays,
    joinedText,
    bio,
    topBuckets: parseTopBuckets(html),
  };
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`request failed for ${url}: ${res.status}`);
  }
  return await res.text();
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`request failed for ${url}: ${res.status}`);
  }
  return await res.json();
}

/**
 * Read-only model that fetches a public Swamp Club profile snapshot and
 * normalizes the score, leaderboard, and top visible bucket data.
 */
export const model = {
  type: "@mgreten/swamp-club-score",
  version: "2026.06.27.3",
  globalArguments: GlobalArgsSchema,
  resources: {
    snapshot: {
      description: "Latest normalized Swamp Club profile snapshot",
      schema: SnapshotSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    leaderboards: {
      description: "Leaderboard lookup payloads for the current user",
      schema: z.record(LeaderboardBoardSchema),
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    topBuckets: {
      description: "Top visible score buckets from the profile breakdown",
      schema: z.object({ items: z.array(TopBucketSchema) }),
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    sync: {
      description:
        "Fetch the public Swamp Club profile page and leaderboard lookup for the configured user",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
            warning: (msg: string, props: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            instanceName: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const username = context.globalArgs.username;
        const baseUrl = context.globalArgs.swampClubUrl.replace(/\/+$/, "");
        const profileUrl = `${baseUrl}/u/${encodeURIComponent(username)}`;
        const lookupUrl = `${baseUrl}/api/v1/leaderboard/locate?q=${
          encodeURIComponent(username)
        }`;

        const [profileHtml, leaderboardData] = await Promise.all([
          fetchText(profileUrl),
          fetchJson(lookupUrl).catch((err) => {
            context.logger.warning("leaderboard lookup failed: {error}", {
              error: String(err),
            });
            return null;
          }),
        ]);

        const profile = parseProfileHtml(profileHtml);
        const snapshot: Snapshot = {
          username,
          profileUrl,
          fetchedAt: new Date().toISOString(),
          ...profile,
          leaderboards: {},
        };

        const leaderboards: Record<string, LeaderboardBoard> = {};
        if (leaderboardData && typeof leaderboardData === "object") {
          const raw = leaderboardData as Record<string, unknown>;
          const boardNames = Object.keys(raw.boards ?? raw.leaderboard ?? {});
          for (const boardName of boardNames) {
            leaderboards[boardName] = extractLeaderboardBoard(
              boardName,
              leaderboardData,
              username,
            );
          }
          if (boardNames.length === 0) {
            const maybeRow = extractLeaderboardRow(profileHtml, username);
            if (maybeRow) {
              leaderboards.profile = {
                name: "profile",
                found: true,
                rows: [maybeRow],
              };
            }
          }
        }

        snapshot.leaderboards = leaderboards;

        const targetRow = Object.values(leaderboards)
          .flatMap((board) => board.rows)
          .find((row) => row.isTargetUser);
        if (targetRow) {
          snapshot.score = targetRow.score;
          snapshot.scoreLabel = targetRow.scoreLabel;
          snapshot.rank = targetRow.rank;
          snapshot.tierName = targetRow.tierName || snapshot.tierName;
          snapshot.tierScore = targetRow.tierScore || snapshot.tierScore;
        }

        const handles = [];
        handles.push(
          await context.writeResource("snapshot", "current-snapshot", snapshot),
        );
        handles.push(
          await context.writeResource(
            "leaderboards",
            "current-leaderboards",
            leaderboards,
          ),
        );
        handles.push(
          await context.writeResource("topBuckets", "current-top-buckets", {
            items: profile.topBuckets,
          }),
        );

        context.logger.info("Fetched Swamp Club profile for {username}", {
          username,
          score: snapshot.score,
          rank: snapshot.rank,
          topBucket: profile.topBuckets[0]?.name ?? null,
        });

        return { dataHandles: handles };
      },
    },
  },
};
