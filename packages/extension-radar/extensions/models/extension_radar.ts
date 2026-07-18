/**
 * Preference-driven discovery and ranking for Swamp extension registry exports.
 *
 * The model intentionally does not scrape, install, or publish extensions. It
 * evaluates a normalized registry-search export supplied by the caller and
 * persists a transparent report that can be inspected with Swamp data commands.
 *
 * @module
 */
import { z } from "npm:zod@4";

const ExtensionSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  repository: z.string().url().nullable().optional(),
  repositoryVerified: z.boolean().nullable().optional(),
  repositoryVerifiedUrl: z.string().url().nullable().optional(),
  latestVersion: z.string().optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  platforms: z.array(z.string()).default([]),
  labels: z.array(z.string()).default([]),
  contentTypes: z.array(z.string()).default([]),
});

const GlobalArgsSchema = z.object({
  interests: z.array(z.string().min(1)).default([
    "homelab",
    "home assistant",
    "docker",
    "monitoring",
    "security",
    "obsidian",
    "todoist",
    "nfc",
    "android",
    "media",
    "automation",
  ]),
  excludeTerms: z.array(z.string().min(1)).default([
    "aws",
    "gcp",
    "azure",
  ]),
  freshnessDays: z.number().int().positive().max(365).default(14),
  maxResults: z.number().int().positive().max(20).default(5),
});

const CandidateSchema = ExtensionSchema.extend({
  score: z.number().int(),
  reasons: z.array(z.string()),
  caveats: z.array(z.string()),
  freshness: z.enum(["new", "recent", "older", "unknown"]),
});

const ReportSchema = z.object({
  generatedAt: z.string().datetime(),
  sourceAsOf: z.string().datetime(),
  sourceCount: z.number().int().nonnegative(),
  includedCount: z.number().int().nonnegative(),
  interests: z.array(z.string()),
  freshnessDays: z.number().int().positive(),
  candidates: z.array(CandidateSchema),
  markdown: z.string(),
});

type Extension = z.infer<typeof ExtensionSchema>;
type Candidate = z.infer<typeof CandidateSchema>;
type Settings = z.infer<typeof GlobalArgsSchema>;

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function relativeDays(date: Date, now: Date): number {
  return Math.floor((now.getTime() - date.getTime()) / 86_400_000);
}

/** Return searchable registry text without accessing external systems. */
export function searchableText(extension: Extension): string {
  return [
    extension.name,
    extension.description,
    ...extension.labels,
    ...extension.contentTypes,
  ].join(" ").toLowerCase();
}

/** Score one normalized registry entry with explainable, bounded rules. */
export function rankExtension(
  extension: Extension,
  settings: Settings,
  now: Date,
): Candidate | null {
  const text = searchableText(extension);
  if (settings.excludeTerms.some((term) => text.includes(term.toLowerCase()))) {
    return null;
  }

  let score = 0;
  const reasons: string[] = [];
  const caveats: string[] = [];
  const matchedInterests = settings.interests.filter((interest) =>
    text.includes(interest.toLowerCase())
  );
  if (matchedInterests.length === 0) return null;

  const uniqueMatches = [...new Set(matchedInterests)].slice(0, 3);
  score += uniqueMatches.length * 2;
  reasons.push(`Matches: ${uniqueMatches.join(", ")}`);

  const created = parseDate(extension.createdAt);
  const updated = parseDate(extension.updatedAt);
  const newestSignal = created ?? updated;
  let freshness: Candidate["freshness"] = "unknown";
  if (newestSignal) {
    const ageDays = relativeDays(newestSignal, now);
    if (ageDays <= settings.freshnessDays) {
      score += 3;
      freshness = "new";
      reasons.push(`Registry entry is within ${settings.freshnessDays} days`);
    } else if (ageDays <= settings.freshnessDays * 4) {
      score += 1;
      freshness = "recent";
    } else {
      freshness = "older";
    }
  } else {
    caveats.push("No registry timestamp was supplied");
  }

  if (extension.repositoryVerified === true) {
    score += 2;
    reasons.push("Repository is registry-verified");
  } else if (extension.repository) {
    score += 1;
    caveats.push("Repository is not registry-verified");
  } else {
    caveats.push("No public repository URL was supplied");
  }

  if (extension.description.trim().length < 80) {
    caveats.push("Short description; inspect source before installing");
  }
  if (extension.contentTypes.length === 0) {
    caveats.push("Registry did not declare extension content types");
  }

  return { ...extension, score, reasons, caveats, freshness };
}

/** Render a compact Markdown report without claiming that candidates are vetted. */
export function renderReport(
  candidates: Candidate[],
  sourceCount: number,
  settings: Settings,
  asOf: Date,
): string {
  const header = [
    "# Swamp Extension Radar",
    "",
    `- **Registry entries evaluated:** ${sourceCount}`,
    `- **Interest terms:** ${settings.interests.join(", ")}`,
    `- **Freshness window:** ${settings.freshnessDays} days`,
    `- **Source timestamp:** ${asOf.toISOString()}`,
    "",
  ];
  if (candidates.length === 0) {
    return [
      ...header,
      "No candidates met the configured interest and freshness rules.",
    ].join("\n");
  }

  const blocks = candidates.map((candidate, index) => {
    const source = candidate.repositoryVerifiedUrl ?? candidate.repository ??
      "No public source URL";
    return [
      `## ${index + 1}. ${candidate.name} — ${candidate.score} points`,
      "",
      candidate.description || "No description supplied by the registry.",
      "",
      `- **Why it surfaced:** ${candidate.reasons.join("; ")}`,
      `- **Freshness:** ${candidate.freshness}`,
      `- **Version:** ${candidate.latestVersion ?? "not supplied"}`,
      `- **Source:** ${source}`,
      `- **Caveats:** ${
        candidate.caveats.length
          ? candidate.caveats.join("; ")
          : "Review fit and permissions before installing"
      }`,
    ].join("\n");
  });
  return [
    ...header,
    ...blocks,
    "",
    "_This ranking is a discovery aid, not an installation recommendation or a security review._",
  ].join("\n");
}

/** Model definition for transparent ranking of registry-search exports. */
export const model = {
  type: "@mgreten/extension-radar",
  version: "2026.07.18.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    report: {
      description: "Ranked extension discovery report with Markdown rendering",
      schema: ReportSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    analyze: {
      description:
        "Rank a normalized Swamp registry search export using transparent preferences",
      arguments: z.object({
        extensions: z.array(ExtensionSchema).min(1),
        asOf: z.string().datetime().optional(),
      }),
      execute: async (args, context) => {
        const settings = GlobalArgsSchema.parse(context.globalArgs);
        context.logger.info("Ranking {count} extension entries", {
          count: args.extensions.length,
        });
        const asOf = parseDate(args.asOf) ?? new Date();
        const candidates = args.extensions
          .map((extension) => rankExtension(extension, settings, asOf))
          .filter((candidate): candidate is Candidate => candidate !== null)
          .sort((left, right) =>
            right.score - left.score || left.name.localeCompare(right.name)
          )
          .slice(0, settings.maxResults);
        const report = {
          generatedAt: new Date().toISOString(),
          sourceAsOf: asOf.toISOString(),
          sourceCount: args.extensions.length,
          includedCount: candidates.length,
          interests: settings.interests,
          freshnessDays: settings.freshnessDays,
          candidates,
          markdown: renderReport(
            candidates,
            args.extensions.length,
            settings,
            asOf,
          ),
        };
        const handle = await context.writeResource("report", "current", report);
        context.logger.info(
          "Extension ranking complete: {included}/{source} candidates",
          {
            included: candidates.length,
            source: args.extensions.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
