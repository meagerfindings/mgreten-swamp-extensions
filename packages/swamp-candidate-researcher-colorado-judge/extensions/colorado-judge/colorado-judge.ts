/**
 * Colorado judge research model.
 *
 * Surfaces retention, discipline, sentencing-pattern, and public-safety signals
 * when the source record supports them. Stays neutral in presentation.
 *
 * @module
 */

import { z } from "npm:zod@4";

// ── Shared schemas ───────────────────────────────────────────────────────────

/** Source classification kind. */
const SourceKindSchema = z.enum([
  "official",
  "candidate",
  "neutral",
  "advocacy",
  "news",
  "court",
  "filing",
  "analysis",
  "unknown",
]);

/** Jurisdiction for a source or research subject. */
const JurisdictionSchema = z.enum(["colorado", "federal", "other"]);

/** Office type for a research subject. */
const OfficeTypeSchema = z.enum([
  "candidate",
  "judge",
  "ballot-issue",
  "other",
]);

/** Issue lens for filtering source selection. */
const IssueLensSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
});

/** Source URL, kind, and fetch configuration for one research source. */
const SourceSpecSchema = z.object({
  name: z.string().min(1),
  kind: SourceKindSchema.default("unknown"),
  url: z.string().url().optional(),
  queryHint: z.string().optional(),
  jurisdiction: JurisdictionSchema.optional(),
  notes: z.string().optional(),
  enabled: z.boolean().default(true),
});

/** A fully-resolved research plan for one subject, jurisdiction, and office type. */
const ResearchPlanSchema = z.object({
  subject: z.string().min(1),
  jurisdiction: JurisdictionSchema,
  officeType: OfficeTypeSchema,
  audience: z.string().default("informed-voter"),
  reportTone: z.string().default("neutral"),
  issueLenses: z.array(IssueLensSchema).default([]),
  sourcePriority: z.array(SourceKindSchema).default([
    "official",
    "neutral",
    "news",
    "advocacy",
  ]),
  sourceSpecs: z.array(SourceSpecSchema).default([]),
  researchQuestions: z.array(z.string()).default([]),
  redFlagSignals: z.array(z.string()).default([]),
});

/** Normalized packet for one fetched or cited source. */
const SourcePacketSchema = z.object({
  subject: z.string().min(1),
  sourceName: z.string().min(1),
  kind: SourceKindSchema,
  url: z.string().url().optional(),
  jurisdiction: JurisdictionSchema.optional(),
  title: z.string().optional(),
  publishedAt: z.string().optional(),
  fetchedAt: z.string(),
  accessStatus: z.enum(["fetched", "blocked", "not-fetched", "error"]),
  excerpt: z.string(),
  notes: z.string().optional(),
});

/** Synthesized voter brief for a judge or candidate. */
const ResearchBriefSchema = z.object({
  subject: z.string().min(1),
  jurisdiction: JurisdictionSchema,
  officeType: OfficeTypeSchema,
  audience: z.string().default("informed-voter"),
  reportTone: z.string().default("neutral"),
  verdict: z.string().optional(),
  summary: z.string(),
  strongestSupport: z.array(z.string()).default([]),
  strongestConcerns: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  sourceCount: z.number().int().nonnegative().default(0),
  sourceKinds: z.array(SourceKindSchema).default([]),
  generatedAt: z.string(),
});

// ── Types ────────────────────────────────────────────────────────────────────

type SourceKind = z.infer<typeof SourceKindSchema>;
type Jurisdiction = z.infer<typeof JurisdictionSchema>;
type IssueLens = z.infer<typeof IssueLensSchema>;
type SourceSpec = z.infer<typeof SourceSpecSchema>;
type ResearchPlan = z.infer<typeof ResearchPlanSchema>;
type SourcePacket = z.infer<typeof SourcePacketSchema>;
type ResearchBrief = z.infer<typeof ResearchBriefSchema>;

// ── Method input schemas ─────────────────────────────────────────────────────

/** Plan input for Colorado judge research. */
const PlanInputSchema = z.object({
  /** Full name of the judge. */
  subject: z.string().min(1),
  /** Optional issue lenses (e.g. "public safety", "sentencing patterns"). */
  issueLenses: z.array(z.string()).default([]),
  /** Intended audience framing. Defaults to "informed-voter". */
  audience: z.string().default("informed-voter"),
  /** Desired tone. Defaults to "neutral". */
  reportTone: z.string().default("neutral"),
});

/** Collection input for Colorado judge research. */
const CollectInputSchema = z.object({
  /** Full name of the judge being researched. */
  subject: z.string().min(1),
  /** Sources to fetch; typically the output of the plan method. */
  sources: z.array(SourceSpecSchema).min(1),
  /** Per-source HTTP timeout in milliseconds. Defaults to 15000. */
  fetchTimeoutMs: z.number().int().positive().max(60000).default(15000),
});

/** Synthesis input for Colorado judge research. */
const SynthesizeInputSchema = z.object({
  /** Full name of the judge being briefed. */
  subject: z.string().min(1),
  /** Source packets collected by the collect method. */
  packets: z.array(SourcePacketSchema).min(1),
  /** Optional one-sentence bottom-line verdict for the voter. */
  verdict: z.string().optional(),
  /** Neutral summary of the collected findings. */
  summary: z.string().min(1),
  /** Top supporting data points from the sources. */
  strongestSupport: z.array(z.string()).default([]),
  /** Top concern signals from the sources. */
  strongestConcerns: z.array(z.string()).default([]),
  /** Questions the sources could not answer. */
  openQuestions: z.array(z.string()).default([]),
  /** Intended audience framing. Defaults to "informed-voter". */
  audience: z.string().default("informed-voter"),
  /** Desired tone. Defaults to "neutral". */
  reportTone: z.string().default("neutral"),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "item";
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeWs(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractAttr(tag: string, attr: string): string | undefined {
  const match = tag.match(
    new RegExp(`${attr}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function extractMetaContent(body: string, names: string[]): string | undefined {
  const tags = body.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const name = extractAttr(tag, "name") ?? extractAttr(tag, "property") ??
      extractAttr(tag, "itemprop");
    if (!name || !names.includes(name.toLowerCase())) continue;
    const content = extractAttr(tag, "content");
    if (content) return normalizeWs(stripHtml(content));
  }
  return undefined;
}

function extractTitle(body: string): string | undefined {
  const og = extractMetaContent(body, ["og:title", "twitter:title"]);
  if (og) return og;
  const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) return normalizeWs(stripHtml(titleMatch[1]));
  const h1 = body.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1?.[1]) return normalizeWs(stripHtml(h1[1]));
  return undefined;
}

function extractPublishedAt(body: string): string | undefined {
  const candidates = [
    extractMetaContent(body, [
      "article:published_time",
      "og:updated_time",
      "article:modified_time",
      "date",
      "dc.date",
    ]),
  ].filter(Boolean) as string[];
  const timeMatch = body.match(/<time\b[^>]*datetime=(?:"([^"]+)"|'([^']+)')/i);
  if (timeMatch?.[1] || timeMatch?.[2]) {
    candidates.push(timeMatch[1] ?? timeMatch[2] ?? "");
  }
  return candidates.find((v) => /\d{4}/.test(v));
}

function excerptFromParagraphs(
  body: string,
  maxChars = 260,
): string | undefined {
  const paras = body.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) ?? [];
  for (const p of paras) {
    const text = normalizeWs(stripHtml(p));
    if (text.length >= 60) {
      return text.length <= maxChars
        ? text
        : `${text.slice(0, maxChars).trim()}…`;
    }
  }
  return undefined;
}

function excerptFromText(body: string, maxChars = 260): string {
  const text = normalizeWs(stripHtml(body));
  return text.length <= maxChars ? text : `${text.slice(0, maxChars).trim()}…`;
}

function keywordSnippet(
  body: string,
  keywords: RegExp[],
  maxChars = 260,
): string | undefined {
  const text = normalizeWs(stripHtml(body));
  for (const kw of keywords) {
    const match = text.match(kw);
    if (!match || match.index === undefined) continue;
    const start = Math.max(0, match.index - 90);
    const end = Math.min(
      text.length,
      match.index + Math.max(match[0].length, 140),
    );
    const snippet = text.slice(start, end).replace(/^.*?[.:;]\s+/, "").trim();
    if (snippet) {
      return snippet.length <= maxChars
        ? snippet
        : `${snippet.slice(0, maxChars).trim()}…`;
    }
  }
  return undefined;
}

function isHtml(body: string): boolean {
  return /<\s*(html|head|body|div|p|a|h1|meta|title|section|article)\b/i.test(
    body,
  );
}

function detectFamily(
  url: string | undefined,
  body: string,
): string | undefined {
  const hay = `${url ?? ""}\n${body}`.toLowerCase();
  if (hay.includes("ballotpedia.org")) return "Ballotpedia";
  if (hay.includes("fec.gov") || hay.includes("api.open.fec.gov")) return "FEC";
  if (
    hay.includes("sos.state.co.us") || hay.includes("coloradosos.gov") ||
    hay.includes("tracer.sos.colorado.gov") ||
    hay.includes("historicalelectiondata.coloradosos.gov")
  ) return "ColoradoSOS";
  if (
    hay.includes("coloradojudicial.gov") || hay.includes("ccjd.colorado.gov") ||
    hay.includes("judicialperformance.colorado.gov")
  ) return "ColoradoJudicial";
  return undefined;
}

interface Enrichment {
  title?: string;
  excerpt?: string;
  notes?: string;
  publishedAt?: string;
}

function adaptPacket(
  url: string | undefined,
  sourceName: string,
  body: string,
): Enrichment {
  const family = detectFamily(url, body);
  if (family === "Ballotpedia") {
    return {
      title: extractTitle(body),
      excerpt: keywordSnippet(body, [
        /candidate profile/i,
        /judge profile/i,
        /election results/i,
        /ballotpedia/i,
      ]) ?? excerptFromParagraphs(body) ?? excerptFromText(body),
      publishedAt: extractPublishedAt(body),
      notes: "Source family: Ballotpedia candidate/judge page.",
    };
  }
  if (family === "ColoradoSOS") {
    return {
      title: extractTitle(body),
      excerpt: keywordSnippet(body, [
        /candidate filing/i,
        /election results/i,
        /ballot access/i,
        /campaign finance/i,
        /tracer/i,
      ]) ?? excerptFromParagraphs(body) ?? excerptFromText(body),
      publishedAt: extractPublishedAt(body),
      notes: "Source family: Colorado Secretary of State election/filing page.",
    };
  }
  if (family === "ColoradoJudicial") {
    return {
      title: extractTitle(body),
      excerpt: keywordSnippet(body, [
        /retention recommendation/i,
        /performance evaluation/i,
        /judicial discipline/i,
        /complaint/i,
        /censure/i,
        /reversal/i,
        /sentencing/i,
      ]) ?? excerptFromParagraphs(body) ?? excerptFromText(body),
      publishedAt: extractPublishedAt(body),
      notes: "Source family: Colorado judicial performance or discipline page.",
    };
  }
  return {
    title: extractTitle(body),
    excerpt: isHtml(body)
      ? excerptFromParagraphs(body) ?? excerptFromText(body)
      : excerptFromText(body),
    publishedAt: extractPublishedAt(body),
    notes: `Source: ${sourceName}; generic enrichment applied.`,
  };
}

// ── Source pack ──────────────────────────────────────────────────────────────

function appendUnique(...groups: SourceSpec[][]): SourceSpec[] {
  const seen = new Set<string>();
  const result: SourceSpec[] = [];
  for (const group of groups) {
    for (const s of group) {
      const key = [s.name, s.url ?? "", s.queryHint ?? "", s.jurisdiction ?? ""]
        .join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(s);
    }
  }
  return result;
}

function buildColoradoJudgeSourceSpecs(
  subject: string,
  issueLenses: Array<string | IssueLens> = [],
): SourceSpec[] {
  const lensNames = new Set(
    issueLenses.map((l) => (typeof l === "string" ? l : l.name).toLowerCase()),
  );
  const issueSpecs: SourceSpec[] = [];
  if (lensNames.has("public safety") || lensNames.has("sentencing")) {
    issueSpecs.push({
      name: "Colorado Sentencing Data",
      kind: "official",
      url: "https://www.courts.state.co.us/Administration/Statistics.cfm",
      jurisdiction: "colorado",
      enabled: true,
    });
  }
  return appendUnique(
    [
      {
        name: "Colorado judicial branch homepage",
        kind: "official",
        url: "https://www.coloradojudicial.gov/",
        jurisdiction: "colorado",
        notes: "Official judicial branch and judge biographies",
        enabled: true,
      },
      {
        name: "Colorado judicial branch search",
        kind: "official",
        url: "https://www.coloradojudicial.gov/search",
        jurisdiction: "colorado",
        notes: "Search official opinions, notices, and branch materials",
        enabled: true,
      },
      {
        name: "Colorado Commission on Judicial Discipline",
        kind: "official",
        url: "https://ccjd.colorado.gov/",
        jurisdiction: "colorado",
        notes: "Discipline and misconduct materials",
        enabled: true,
      },
      {
        name: "Colorado judicial performance overview",
        kind: "official",
        url: "https://judicialperformance.colorado.gov/",
        jurisdiction: "colorado",
        notes: "Judicial performance evaluations and retention recommendations",
        enabled: true,
      },
      {
        name: "Colorado judge lookup",
        kind: "official",
        jurisdiction: "colorado",
        queryHint:
          `Search the Colorado Judicial Branch for ${subject}, including biography, assignments, opinions, retention history, and evaluation records.`,
        enabled: true,
      },
    ],
    [
      {
        name: "Ballotpedia judge profile",
        kind: "neutral",
        jurisdiction: "colorado",
        queryHint:
          `Search Ballotpedia for ${subject} and the relevant Colorado judicial race or retention page.`,
        enabled: true,
      },
      {
        name: "Retention and performance materials",
        kind: "neutral",
        jurisdiction: "colorado",
        queryHint:
          `Locate Colorado judicial performance or retention materials for ${subject} and review the latest evaluation packet.`,
        enabled: true,
      },
    ],
    issueSpecs,
  );
}

// ── Research plan builder ─────────────────────────────────────────────────────

function buildColoradoJudgePlan(
  subject: string,
  issueLenses: Array<string | IssueLens> = [],
): ResearchPlan {
  const lensObjects = issueLenses.map((l) =>
    typeof l === "string" ? { name: l, enabled: true } : l
  );
  return {
    subject,
    jurisdiction: "colorado",
    officeType: "judge",
    audience: "informed-voter",
    reportTone: "neutral",
    issueLenses: lensObjects,
    sourcePriority: ["official", "neutral", "news", "advocacy"],
    sourceSpecs: buildColoradoJudgeSourceSpecs(subject, issueLenses),
    researchQuestions: [
      "What is the candidate's or judge's actual on-record position or ruling history?",
      "What are the strongest official, neutral, and opposing-source facts?",
      "What changed most recently, and what is still unresolved?",
      "Are there retention, discipline, reversal, or sentencing-pattern signals that should be surfaced neutrally?",
    ],
    redFlagSignals: [
      "negative retention recommendation",
      "formal discipline or complaint history",
      "public safety controversy",
      "sentencing or release pattern concerns supported by records or reputable reporting",
    ],
  };
}

// ── Research brief builder ────────────────────────────────────────────────────

function buildResearchBrief(input: {
  subject: string;
  jurisdiction: Jurisdiction;
  officeType: "judge";
  audience?: string;
  reportTone?: string;
  packets: SourcePacket[];
  verdict?: string;
  summary: string;
  strongestSupport?: string[];
  strongestConcerns?: string[];
  openQuestions?: string[];
}): ResearchBrief {
  return {
    subject: input.subject,
    jurisdiction: input.jurisdiction,
    officeType: input.officeType,
    audience: input.audience ?? "informed-voter",
    reportTone: input.reportTone ?? "neutral",
    verdict: input.verdict,
    summary: input.summary,
    strongestSupport: input.strongestSupport ?? [],
    strongestConcerns: input.strongestConcerns ?? [],
    openQuestions: input.openQuestions ?? [],
    sourceCount: input.packets.length,
    sourceKinds: Array.from(
      new Set(input.packets.map((p) => p.kind)),
    ) as SourceKind[],
    generatedAt: new Date().toISOString(),
  };
}

// ── Source collector ─────────────────────────────────────────────────────────

async function fetchPage(
  url: string,
  timeoutMs: number,
): Promise<{ body: string; accessStatus: SourcePacket["accessStatus"] }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; swamp-candidate-researcher/1.0)",
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: ctrl.signal,
    });
    return {
      body: await res.text(),
      accessStatus: res.ok ? "fetched" : "error",
    };
  } catch (error) {
    return {
      body: error instanceof Error ? error.message : String(error),
      accessStatus: "blocked",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function collectSourcePackets(input: {
  subject: string;
  sources: SourceSpec[];
  fetchTimeoutMs?: number;
  writeResource?: (
    type: "packet",
    name: string,
    value: SourcePacket,
  ) => Promise<string>;
}): Promise<{ packets: SourcePacket[]; dataHandles: string[] }> {
  const packets: SourcePacket[] = [];
  const dataHandles: string[] = [];
  const timeoutMs = input.fetchTimeoutMs ?? 15000;

  for (const source of input.sources) {
    if (!source.enabled) continue;
    const fetchedAt = new Date().toISOString();
    if (!source.url) {
      const packet: SourcePacket = {
        subject: input.subject,
        sourceName: source.name,
        kind: source.kind,
        jurisdiction: source.jurisdiction,
        fetchedAt,
        accessStatus: "not-fetched",
        excerpt: source.queryHint ?? source.notes ??
          "Source requires a query or manual follow-up.",
        notes: source.notes,
      };
      packets.push(packet);
      if (input.writeResource) {
        dataHandles.push(
          await input.writeResource(
            "packet",
            slugify(`${input.subject}-${source.name}`),
            packet,
          ),
        );
      }
      continue;
    }
    const { body, accessStatus } = await fetchPage(source.url, timeoutMs);
    const enrichment = adaptPacket(source.url, source.name, body);
    const packet: SourcePacket = {
      subject: input.subject,
      sourceName: source.name,
      kind: source.kind,
      url: source.url,
      jurisdiction: source.jurisdiction,
      title: enrichment.title,
      publishedAt: enrichment.publishedAt,
      fetchedAt,
      accessStatus,
      excerpt: enrichment.excerpt ?? excerptFromText(body),
      notes: enrichment.notes ?? source.notes,
    };
    packets.push(packet);
    if (input.writeResource) {
      dataHandles.push(
        await input.writeResource(
          "packet",
          slugify(`${input.subject}-${source.name}`),
          packet,
        ),
      );
    }
  }

  return { packets, dataHandles };
}

// ── Model export ─────────────────────────────────────────────────────────────

/** Colorado judge research model. */
export const model = {
  type: "@mgreten/judge-research-colorado",
  version: "2026.07.16.1",
  globalArguments: z.object({}),
  resources: {
    plan: {
      description:
        "Colorado judge research plan with retention and discipline signals.",
      schema: ResearchPlanSchema,
      lifetime: "infinite",
      garbageCollection: 25,
    },
    packet: {
      description: "Colorado judge source packet.",
      schema: SourcePacketSchema,
      lifetime: "infinite",
      garbageCollection: 25,
    },
    brief: {
      description: "Colorado judge briefing summary.",
      schema: ResearchBriefSchema,
      lifetime: "infinite",
      garbageCollection: 25,
    },
  },
  methods: {
    plan: {
      description: "Build a Colorado judge research plan.",
      arguments: PlanInputSchema,
      execute: async (
        args: z.infer<typeof PlanInputSchema>,
        context: {
          writeResource: (
            type: string,
            name: string,
            value: unknown,
          ) => Promise<string>;
        },
      ) => {
        const plan = buildColoradoJudgePlan(args.subject, args.issueLenses);
        const handle = await context.writeResource(
          "plan",
          slugify(args.subject),
          plan,
        );
        return { dataHandles: [handle], plan };
      },
    },
    collect: {
      description:
        "Collect Colorado judicial source pages into normalized source packets.",
      arguments: CollectInputSchema,
      execute: async (
        args: z.infer<typeof CollectInputSchema>,
        context: {
          writeResource?: (
            type: string,
            name: string,
            value: unknown,
          ) => Promise<string>;
        },
      ) => {
        return await collectSourcePackets({
          subject: args.subject,
          sources: args.sources,
          fetchTimeoutMs: args.fetchTimeoutMs,
          writeResource: context.writeResource as
            | ((
              type: "packet",
              name: string,
              value: SourcePacket,
            ) => Promise<string>)
            | undefined,
        });
      },
    },
    synthesize: {
      description: "Store a neutral Colorado judicial briefing packet.",
      arguments: SynthesizeInputSchema,
      execute: async (
        args: z.infer<typeof SynthesizeInputSchema>,
        context: {
          writeResource: (
            type: string,
            name: string,
            value: unknown,
          ) => Promise<string>;
        },
      ) => {
        const brief = buildResearchBrief({
          subject: args.subject,
          jurisdiction: "colorado",
          officeType: "judge",
          audience: args.audience,
          reportTone: args.reportTone,
          packets: args.packets,
          verdict: args.verdict,
          summary: args.summary,
          strongestSupport: args.strongestSupport,
          strongestConcerns: args.strongestConcerns,
          openQuestions: args.openQuestions,
        });
        const briefHandle = await context.writeResource(
          "brief",
          slugify(args.subject),
          brief,
        );
        return { dataHandles: [briefHandle], brief };
      },
    },
  },
};
