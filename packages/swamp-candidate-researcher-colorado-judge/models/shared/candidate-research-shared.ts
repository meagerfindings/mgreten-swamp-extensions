/**
 * Shared schemas, source helpers, and report-formatting utilities for the
 * candidate-researcher extensions.
 *
 * @module
 */

import { z } from "npm:zod@4";

export const SourceKindSchema = z.enum([
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

export const JurisdictionSchema = z.enum(["colorado", "federal", "other"]);
export const OfficeTypeSchema = z.enum(["candidate", "judge", "ballot-issue", "other"]);

export const IssueLensSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
});

export const SourceSpecSchema = z.object({
  name: z.string().min(1),
  kind: SourceKindSchema.default("unknown"),
  url: z.string().url().optional(),
  queryHint: z.string().optional(),
  jurisdiction: JurisdictionSchema.optional(),
  notes: z.string().optional(),
  enabled: z.boolean().default(true),
});

export const ResearchPlanSchema = z.object({
  subject: z.string().min(1),
  jurisdiction: JurisdictionSchema,
  officeType: OfficeTypeSchema,
  audience: z.string().default("informed-voter"),
  reportTone: z.string().default("neutral"),
  issueLenses: z.array(IssueLensSchema).default([]),
  sourcePriority: z.array(SourceKindSchema).default(["official", "neutral", "news", "advocacy"]),
  sourceSpecs: z.array(SourceSpecSchema).default([]),
  researchQuestions: z.array(z.string()).default([]),
  redFlagSignals: z.array(z.string()).default([]),
});

export const SourcePacketSchema = z.object({
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

export const ResearchBriefSchema = z.object({
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

export type SourceKind = z.infer<typeof SourceKindSchema>;
export type Jurisdiction = z.infer<typeof JurisdictionSchema>;
export type OfficeType = z.infer<typeof OfficeTypeSchema>;
export type IssueLens = z.infer<typeof IssueLensSchema>;
export type SourceSpec = z.infer<typeof SourceSpecSchema>;
export type ResearchPlan = z.infer<typeof ResearchPlanSchema>;
export type SourcePacket = z.infer<typeof SourcePacketSchema>;
export type ResearchBrief = z.infer<typeof ResearchBriefSchema>;

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "item";
}

export function stripHtml(value: string): string {
  const withoutScripts = value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  return withoutScripts.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function makeExcerpt(value: string, maxChars: number = 800): string {
  const cleaned = stripHtml(value);
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars).trim()}…`;
}

export function extractTitle(value: string): string | undefined {
  const titleMatch = value.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    return stripHtml(titleMatch[1]);
  }
  const firstLine = stripHtml(value).split(/\s{2,}|\n/).find(Boolean);
  return firstLine || undefined;
}

export function buildResearchPlan(input: {
  subject: string;
  jurisdiction: Jurisdiction;
  officeType: OfficeType;
  audience?: string;
  reportTone?: string;
  issueLenses?: Array<string | IssueLens>;
  sourcePriority?: SourceKind[];
  sourceSpecs?: SourceSpec[];
  redFlagSignals?: string[];
}): ResearchPlan {
  const issueLenses = (input.issueLenses ?? []).map((lens) =>
    typeof lens === "string" ? { name: lens, enabled: true } : lens
  );
  const researchQuestions = [
    "What is the candidate or judge actually on the record saying or doing?",
    "What are the strongest official, neutral, and opposing-source facts?",
    "What changed most recently, and what is still unresolved?",
  ];
  if (input.officeType === "judge") {
    researchQuestions.push("Are there retention, discipline, reversal, or sentencing-pattern signals that should be surfaced neutrally?");
  }
  if (issueLenses.some((lens) => lens.name.toLowerCase() === "homeschooling")) {
    researchQuestions.push("What does the subject say about parental control, school choice, and homeschool regulation?");
  }
  return {
    subject: input.subject,
    jurisdiction: input.jurisdiction,
    officeType: input.officeType,
    audience: input.audience ?? "informed-voter",
    reportTone: input.reportTone ?? "neutral",
    issueLenses,
    sourcePriority: input.sourcePriority ?? ["official", "neutral", "news", "advocacy"],
    sourceSpecs: input.sourceSpecs ?? [],
    researchQuestions,
    redFlagSignals: input.redFlagSignals ?? [],
  };
}

export function buildSourcePacket(input: {
  subject: string;
  sourceName: string;
  kind: SourceKind;
  url?: string;
  jurisdiction?: Jurisdiction;
  fetchedAt: string;
  body: string;
  notes?: string;
  publishedAt?: string;
  accessStatus?: SourcePacket["accessStatus"];
}): SourcePacket {
  const title = extractTitle(input.body);
  return {
    subject: input.subject,
    sourceName: input.sourceName,
    kind: input.kind,
    url: input.url,
    jurisdiction: input.jurisdiction,
    title,
    publishedAt: input.publishedAt,
    fetchedAt: input.fetchedAt,
    accessStatus: input.accessStatus ?? "fetched",
    excerpt: makeExcerpt(input.body),
    notes: input.notes,
  };
}

export function buildResearchBrief(input: {
  subject: string;
  jurisdiction: Jurisdiction;
  officeType: OfficeType;
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
    sourceKinds: Array.from(new Set(input.packets.map((packet) => packet.kind))),
    generatedAt: new Date().toISOString(),
  };
}

export function renderMarkdownReport(brief: ResearchBrief, packets: SourcePacket[]): string {
  const sections = [
    `# ${brief.subject}`,
    `- Jurisdiction: ${brief.jurisdiction}`,
    `- Office type: ${brief.officeType}`,
    `- Audience: ${brief.audience}`,
    `- Tone: ${brief.reportTone}`,
    `- Sources reviewed: ${brief.sourceCount}`,
    brief.verdict ? `- Bottom line: ${brief.verdict}` : undefined,
    `## Summary\n\n${brief.summary}`,
    brief.strongestSupport.length ? `## Strongest support\n\n${brief.strongestSupport.map((item) => `- ${item}`).join("\n")}` : undefined,
    brief.strongestConcerns.length ? `## Strongest concerns\n\n${brief.strongestConcerns.map((item) => `- ${item}`).join("\n")}` : undefined,
    brief.openQuestions.length ? `## Open questions\n\n${brief.openQuestions.map((item) => `- ${item}`).join("\n")}` : undefined,
    `## Source packets\n\n${packets.map((packet) => [
      `### ${packet.sourceName}`,
      `- Kind: ${packet.kind}`,
      packet.url ? `- URL: ${packet.url}` : undefined,
      packet.title ? `- Title: ${packet.title}` : undefined,
      packet.publishedAt ? `- Published: ${packet.publishedAt}` : undefined,
      `- Access: ${packet.accessStatus}`,
      `- Excerpt: ${packet.excerpt}`,
    ].filter(Boolean).join("\n")).join("\n\n")}`,
  ].filter(Boolean);
  return sections.join("\n\n");
}

export function buildIssueSourceSpecs(issueLenses: Array<string | IssueLens>): SourceSpec[] {
  const names = new Set(issueLenses.map((lens) => (typeof lens === "string" ? lens : lens.name).toLowerCase()));
  const sources: SourceSpec[] = [];
  if (names.has("abortion")) {
    sources.push(
      { name: "Guttmacher Institute", kind: "advocacy", url: "https://www.guttmacher.org/", notes: "Policy and research lens" },
      { name: "SBA Pro-Life America", kind: "advocacy", url: "https://sbaprolife.org/", notes: "Pro-life advocacy lens" },
    );
  }
  if (names.has("homeschooling")) {
    sources.push(
      { name: "CHEC Colorado Homeschool Freedom", kind: "advocacy", url: "https://chec.org/colorado-homeschool-freedom/", jurisdiction: "colorado", notes: "Conservative homeschool/personal-rights lens" },
      { name: "HSLDA", kind: "advocacy", url: "https://hslda.org/", notes: "Homeschool defense and legal support" },
      { name: "CRHE", kind: "advocacy", url: "https://responsiblehomeschooling.org/", notes: "Critical homeschool research lens" },
    );
  }
  if (names.has("second amendment") || names.has("2a") || names.has("gun rights")) {
    sources.push(
      { name: "NRA-ILA", kind: "advocacy", url: "https://www.nraila.org/", notes: "Gun-rights lens" },
      { name: "Giffords", kind: "advocacy", url: "https://giffords.org/", notes: "Gun-safety lens" },
    );
  }
  if (names.has("free speech")) {
    sources.push(
      { name: "FIRE", kind: "advocacy", url: "https://www.thefire.org/", notes: "Free-speech and due-process lens" },
      { name: "ACLU", kind: "advocacy", url: "https://www.aclu.org/", notes: "Civil-liberties lens" },
    );
  }
  return sources;
}

export function buildColoradoCandidatePlan(subject: string, issueLenses: Array<string | IssueLens> = []): ResearchPlan {
  return buildResearchPlan({
    subject,
    jurisdiction: "colorado",
    officeType: "candidate",
    sourcePriority: ["official", "neutral", "news", "advocacy"],
    sourceSpecs: [
      {
        name: "Colorado Secretary of State elections hub",
        kind: "official",
        url: "https://www.sos.state.co.us/pubs/elections/main.html",
        jurisdiction: "colorado",
        notes: "Official Colorado elections landing page",
      },
      {
        name: "Colorado SOS campaign finance / TRACER",
        kind: "official",
        url: "https://tracer.sos.colorado.gov/PublicSite/homepage.aspx",
        jurisdiction: "colorado",
        notes: "Campaign finance and disclosures",
      },
      {
        name: "Colorado election results and data",
        kind: "official",
        url: "https://www.coloradosos.gov/pubs/elections/resultsData.html",
        jurisdiction: "colorado",
        notes: "Historical results and election data",
      },
      {
        name: "Colorado Historical Election Data",
        kind: "official",
        url: "https://historicalelectiondata.coloradosos.gov/eng/",
        jurisdiction: "colorado",
        notes: "Historical election database",
      },
    ].concat(buildIssueSourceSpecs(issueLenses)),
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
  });
}

export function buildFederalCandidatePlan(subject: string, issueLenses: Array<string | IssueLens> = []): ResearchPlan {
  return buildResearchPlan({
    subject,
    jurisdiction: "federal",
    officeType: "candidate",
    sourcePriority: ["official", "neutral", "news", "advocacy"],
    sourceSpecs: [
      {
        name: "FEC campaign finance data",
        kind: "official",
        url: "https://www.fec.gov/data/",
        jurisdiction: "federal",
        notes: "Federal campaign finance data hub",
      },
      {
        name: "FEC bulk data",
        kind: "official",
        url: "https://www.fec.gov/data/browse-data/?tab=bulk-data",
        jurisdiction: "federal",
        notes: "Bulk downloads and data tables",
      },
      {
        name: "OpenFEC API docs",
        kind: "official",
        url: "https://api.open.fec.gov/developers/",
        jurisdiction: "federal",
        notes: "API documentation",
      },
    ].concat(buildIssueSourceSpecs(issueLenses)),
    researchQuestions: [
      "What is the candidate's federal office, committee structure, and filing footprint?",
      "What do official federal records and candidate statements show?",
      "What issues are most likely to matter to the user's decision?",
      "What is the strongest mainstream reporting on the candidate?",
    ],
    redFlagSignals: [
      "federal campaign finance irregularities",
      "ethics or legal actions",
      "controversial public statements with direct evidence",
    ],
  });
}

export function buildColoradoJudgePlan(subject: string, issueLenses: Array<string | IssueLens> = []): ResearchPlan {
  return buildResearchPlan({
    subject,
    jurisdiction: "colorado",
    officeType: "judge",
    sourcePriority: ["official", "neutral", "news", "advocacy"],
    sourceSpecs: [
      {
        name: "Colorado judicial branch homepage",
        kind: "official",
        url: "https://www.coloradojudicial.gov/",
        jurisdiction: "colorado",
        notes: "Official judicial branch and judge biographies",
      },
      {
        name: "Colorado judicial branch search",
        kind: "official",
        url: "https://www.coloradojudicial.gov/search",
        jurisdiction: "colorado",
        notes: "Search official opinions, notices, and branch materials",
      },
      {
        name: "Colorado Commission on Judicial Discipline",
        kind: "official",
        url: "https://ccjd.colorado.gov/",
        jurisdiction: "colorado",
        notes: "Discipline and misconduct materials",
      },
      {
        name: "Colorado judicial performance overview",
        kind: "official",
        url: "https://judicialperformance.colorado.gov/",
        jurisdiction: "colorado",
        notes: "Judicial performance evaluations and retention recommendations",
      },
    ].concat(buildIssueSourceSpecs(issueLenses)),
    researchQuestions: [
      "What is the judge's court, appointment history, and term/retention status?",
      "What do performance commissions or retention materials say?",
      "Are there discipline findings, complaints, or public controversies?",
      "Are there sentencing, release, or reversal patterns worth surfacing neutrally?",
    ],
    redFlagSignals: [
      "negative retention recommendation",
      "formal discipline or complaint history",
      "public safety controversy",
      "sentencing or release pattern concerns supported by records or reputable reporting",
    ],
  });
}
