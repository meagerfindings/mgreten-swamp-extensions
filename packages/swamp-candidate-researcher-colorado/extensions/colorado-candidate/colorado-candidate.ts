/**
 * Colorado candidate research model.
 *
 * Provides Colorado-specific source priorities for neutral voter briefing
 * of candidates running for state office.
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

/** Synthesized voter brief for a candidate. */
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

/** Plan input for Colorado candidate research. */
const PlanInputSchema = z.object({
  /** Full name of the candidate. */
  subject: z.string().min(1),
  /** Optional issue lenses (e.g. "homeschooling", "second amendment"). */
  issueLenses: z.array(z.string()).default([]),
  /** Intended audience framing. Defaults to "informed-voter". */
  audience: z.string().default("informed-voter"),
  /** Desired tone. Defaults to "neutral". */
  reportTone: z.string().default("neutral"),
});

/** Collection input for Colorado candidate research. */
const CollectInputSchema = z.object({
  /** Full name of the candidate being researched. */
  subject: z.string().min(1),
  /** Sources to fetch; typically the output of the plan method. */
  sources: z.array(SourceSpecSchema).min(1),
  /** Per-source HTTP timeout in milliseconds. Defaults to 15000. */
  fetchTimeoutMs: z.number().int().positive().max(60000).default(15000),
});

/** Synthesis input for Colorado candidate research. */
const SynthesizeInputSchema = z.object({
  /** Full name of the candidate being briefed. */
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
        /election results/i,
        /ballotpedia/i,
      ]) ?? excerptFromParagraphs(body) ?? excerptFromText(body),
      publishedAt: extractPublishedAt(body),
      notes: "Source family: Ballotpedia candidate page.",
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

function buildIssueSourceSpecs(
  issueLenses: Array<string | IssueLens>,
): SourceSpec[] {
  const names = new Set(
    issueLenses.map((l) => (typeof l === "string" ? l : l.name).toLowerCase()),
  );
  const sources: SourceSpec[] = [];
  if (names.has("abortion")) {
    sources.push(
      {
        name: "Guttmacher Institute",
        kind: "neutral",
        url: "https://www.guttmacher.org/",
        notes: "Policy and research lens",
        enabled: true,
      },
      {
        name: "SBA Pro-Life America",
        kind: "neutral",
        url: "https://sbaprolife.org/",
        notes: "Pro-life advocacy lens",
        enabled: true,
      },
    );
  }
  if (names.has("homeschooling")) {
    sources.push(
      {
        name: "CHEC Colorado Homeschool Freedom",
        kind: "neutral",
        url: "https://chec.org/colorado-homeschool-freedom/",
        jurisdiction: "colorado",
        notes: "Homeschool policy and parental-rights lens",
        enabled: true,
      },
      {
        name: "HSLDA",
        kind: "neutral",
        url: "https://hslda.org/",
        notes: "Homeschool defense and legal-support lens",
        enabled: true,
      },
      {
        name: "CRHE",
        kind: "neutral",
        url: "https://responsiblehomeschooling.org/",
        notes: "Critical homeschool research lens",
        enabled: true,
      },
    );
  }
  if (
    names.has("second amendment") || names.has("2a") || names.has("gun rights")
  ) {
    sources.push(
      {
        name: "NRA-ILA",
        kind: "neutral",
        url: "https://www.nraila.org/",
        notes: "Gun-rights lens",
        enabled: true,
      },
      {
        name: "Giffords",
        kind: "neutral",
        url: "https://giffords.org/",
        notes: "Gun-safety lens",
        enabled: true,
      },
    );
  }
  if (names.has("free speech")) {
    sources.push(
      {
        name: "FIRE",
        kind: "neutral",
        url: "https://www.thefire.org/",
        notes: "Free-speech and due-process lens",
        enabled: true,
      },
      {
        name: "ACLU",
        kind: "neutral",
        url: "https://www.aclu.org/",
        notes: "Civil-liberties lens",
        enabled: true,
      },
    );
  }
  return sources;
}

function buildColoradoCandidateSourceSpecs(
  subject: string,
  issueLenses: Array<string | IssueLens> = [],
): SourceSpec[] {
  return appendUnique(
    [
      {
        name: "Colorado Secretary of State elections hub",
        kind: "official",
        url: "https://www.sos.state.co.us/pubs/elections/main.html",
        jurisdiction: "colorado",
        notes: "Official Colorado elections landing page",
        enabled: true,
      },
      {
        name: "Colorado SOS campaign finance / TRACER",
        kind: "official",
        url: "https://tracer.sos.colorado.gov/PublicSite/homepage.aspx",
        jurisdiction: "colorado",
        notes: "Campaign finance and disclosures",
        enabled: true,
      },
      {
        name: "Colorado election results and data",
        kind: "official",
        url: "https://www.coloradosos.gov/pubs/elections/resultsData.html",
        jurisdiction: "colorado",
        notes: "Historical results and election data",
        enabled: true,
      },
      {
        name: "Colorado Historical Election Data",
        kind: "official",
        url: "https://historicalelectiondata.coloradosos.gov/eng/",
        jurisdiction: "colorado",
        notes: "Historical election database",
        enabled: true,
      },
      {
        name: "Colorado candidate filing lookup",
        kind: "official",
        jurisdiction: "colorado",
        queryHint:
          `Search Colorado Secretary of State filing and candidate records for ${subject}.`,
        enabled: true,
      },
    ],
    [
      {
        name: "Ballotpedia candidate profile",
        kind: "neutral",
        jurisdiction: "colorado",
        queryHint:
          `Search Ballotpedia for ${subject} and the relevant Colorado office or district.`,
        enabled: true,
      },
      {
        name: "Official campaign website",
        kind: "candidate",
        jurisdiction: "colorado",
        queryHint:
          `Locate the candidate's official campaign website for ${subject} and review platform, endorsements, and disclosures.`,
        enabled: true,
      },
    ],
    buildIssueSourceSpecs(issueLenses),
  );
}

// ── Research plan builder ─────────────────────────────────────────────────────

function buildColoradoCandidatePlan(
  subject: string,
  issueLenses: Array<string | IssueLens> = [],
): ResearchPlan {
  const lensObjects = issueLenses.map((l) =>
    typeof l === "string" ? { name: l, enabled: true } : l
  );
  return {
    subject,
    jurisdiction: "colorado",
    officeType: "candidate",
    audience: "informed-voter",
    reportTone: "neutral",
    issueLenses: lensObjects,
    sourcePriority: ["official", "neutral", "news", "advocacy"],
    sourceSpecs: buildColoradoCandidateSourceSpecs(subject, issueLenses),
    researchQuestions: [
      "What office is the candidate actually seeking, and what is the filing/ballot status?",
      "What do official filings say about money, committees, and ballot eligibility?",
      "What are the strongest direct quotes or votes on the issues the user asked about?",
      "What is the best recent news coverage on the candidate?",
    ],
    redFlagSignals: [
      "campaign finance anomalies",
      "disqualifying filing problems",
      "official ethics or discipline concerns",
      "recent controversy with direct source support",
    ],
  };
}

// ── Research brief builder ────────────────────────────────────────────────────

function buildResearchBrief(input: {
  subject: string;
  jurisdiction: Jurisdiction;
  officeType: "candidate";
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

/** Colorado candidate research model. */
export const model = {
  type: "@mgreten/candidate-research-colorado",
  version: "2026.07.16.1",
  globalArguments: z.object({}),
  resources: {
    plan: {
      description: "Colorado-specific candidate research plan.",
      schema: ResearchPlanSchema,
      lifetime: "infinite",
      garbageCollection: 25,
    },
    packet: {
      description: "Colorado candidate source packet.",
      schema: SourcePacketSchema,
      lifetime: "infinite",
      garbageCollection: 25,
    },
    brief: {
      description: "Colorado candidate briefing summary.",
      schema: ResearchBriefSchema,
      lifetime: "infinite",
      garbageCollection: 25,
    },
  },
  methods: {
    plan: {
      description: "Build a Colorado candidate research plan.",
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
        const plan = buildColoradoCandidatePlan(args.subject, args.issueLenses);
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
        "Collect Colorado source pages into normalized source packets.",
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
      description: "Store a neutral Colorado candidate briefing packet.",
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
          officeType: "candidate",
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
