/**
 * Source-family adapters for packet enrichment.
 *
 * These helpers inspect fetched HTML/text and add neutral, reusable hints for
 * common public-record source families used by the candidate research models.
 *
 * @module
 */

export interface SourcePacketEnrichmentInput {
  url?: string;
  sourceName: string;
  body: string;
}

export interface SourcePacketEnrichment {
  title?: string;
  excerpt?: string;
  notes?: string;
  publishedAt?: string;
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

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isHtml(body: string): boolean {
  return /<\s*(html|head|body|div|p|a|h1|meta|title|section|article)\b/i.test(body);
}

function extractAttr(tag: string, attr: string): string | undefined {
  const match = tag.match(new RegExp(`${attr}=(?:"([^"]*)"|'([^']*)'|([^\s>]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function extractMetaContent(body: string, names: string[]): string | undefined {
  const metaTagMatches = body.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTagMatches) {
    const name = extractAttr(tag, "name") ?? extractAttr(tag, "property") ?? extractAttr(tag, "itemprop");
    if (!name) continue;
    if (!names.includes(name.toLowerCase())) continue;
    const content = extractAttr(tag, "content");
    if (content) return normalizeWhitespace(stripHtml(content));
  }
  return undefined;
}

function extractTitleFromBody(body: string): string | undefined {
  const ogTitle = extractMetaContent(body, ["og:title", "twitter:title"]);
  if (ogTitle) return ogTitle;

  const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    return normalizeWhitespace(stripHtml(titleMatch[1]));
  }

  const h1Match = body.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match?.[1]) {
    return normalizeWhitespace(stripHtml(h1Match[1]));
  }

  return undefined;
}

function extractPublishedAt(body: string): string | undefined {
  const candidates = [
    extractMetaContent(body, ["article:published_time", "og:updated_time", "article:modified_time", "date", "dc.date"]),
  ].filter(Boolean) as string[];
  const timeMatch = body.match(/<time\b[^>]*datetime=(?:"([^"]+)"|'([^']+)')/i);
  if (timeMatch?.[1] || timeMatch?.[2]) {
    candidates.push(timeMatch[1] ?? timeMatch[2] ?? "");
  }
  return candidates.find((value) => /\d{4}/.test(value));
}

function excerptFromParagraphs(body: string, maxChars: number = 260): string | undefined {
  const paragraphMatches = body.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) ?? [];
  for (const paragraph of paragraphMatches) {
    const text = normalizeWhitespace(stripHtml(paragraph));
    if (text.length >= 60) {
      return text.length <= maxChars ? text : `${text.slice(0, maxChars).trim()}…`;
    }
  }
  return undefined;
}

function excerptFromText(body: string, maxChars: number = 260): string {
  const text = normalizeWhitespace(stripHtml(body));
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trim()}…`;
}

function keywordSnippet(body: string, keywords: RegExp[], maxChars: number = 260): string | undefined {
  const text = normalizeWhitespace(stripHtml(body));
  for (const keyword of keywords) {
    const match = text.match(keyword);
    if (!match || match.index === undefined) continue;
    const start = Math.max(0, match.index - 90);
    const end = Math.min(text.length, match.index + Math.max(match[0].length, 140));
    const snippet = text.slice(start, end).replace(/^.*?[.:;]\s+/, "").trim();
    if (snippet) {
      return snippet.length <= maxChars ? snippet : `${snippet.slice(0, maxChars).trim()}…`;
    }
  }
  return undefined;
}

function detectFamily(url: string | undefined, body: string): string | undefined {
  const haystack = `${url ?? ""}\n${body}`.toLowerCase();
  if (haystack.includes("ballotpedia.org")) return "Ballotpedia";
  if (haystack.includes("fec.gov") || haystack.includes("api.open.fec.gov")) return "FEC";
  if (haystack.includes("sos.state.co.us") || haystack.includes("coloradosos.gov") || haystack.includes("tracer.sos.colorado.gov") || haystack.includes("historicalelectiondata.coloradosos.gov")) {
    return "Colorado Secretary of State";
  }
  if (haystack.includes("coloradojudicial.gov") || haystack.includes("ccjd.colorado.gov") || haystack.includes("judicialperformance.colorado.gov")) {
    return "Colorado judicial";
  }
  return undefined;
}

function buildBallotpediaEnrichment(body: string): SourcePacketEnrichment {
  const title = extractTitleFromBody(body);
  const excerpt =
    keywordSnippet(body, [/candidate profile/i, /judge profile/i, /election results/i, /ballotpedia/i]) ??
    excerptFromParagraphs(body) ??
    excerptFromText(body);
  return {
    title,
    excerpt,
    publishedAt: extractPublishedAt(body),
    notes: "Source family: Ballotpedia candidate/judge page; intro/summary text extracted when available.",
  };
}

function buildColoradoSosEnrichment(body: string): SourcePacketEnrichment {
  const title = extractTitleFromBody(body);
  const excerpt =
    keywordSnippet(body, [/candidate filing/i, /election results/i, /ballot access/i, /campaign finance/i, /tracer/i]) ??
    excerptFromParagraphs(body) ??
    excerptFromText(body);
  return {
    title,
    excerpt,
    publishedAt: extractPublishedAt(body),
    notes: "Source family: Colorado Secretary of State election/filing page; filing, results, or finance context summarized when present.",
  };
}

function buildFecEnrichment(body: string, url?: string): SourcePacketEnrichment {
  const title = extractTitleFromBody(body);
  const isApiDocs = /api\.open\.fec\.gov/i.test(url ?? "") || /developer/i.test(`${title ?? ""}\n${body}`);
  const excerpt =
    keywordSnippet(
      body,
      isApiDocs
        ? [/endpoint/i, /response/i, /parameters?/i, /fields?/i, /examples?/i]
        : [/candidate overview/i, /committee overview/i, /candidate id/i, /committee id/i, /filings?/i],
    ) ??
    excerptFromParagraphs(body) ??
    excerptFromText(body);
  return {
    title,
    excerpt,
    publishedAt: extractPublishedAt(body),
    notes: isApiDocs
      ? "Source family: FEC API docs page; endpoint and field references summarized when available."
      : "Source family: FEC candidate/committee page; filing and committee context extracted when available.",
  };
}

function buildColoradoJudicialEnrichment(body: string): SourcePacketEnrichment {
  const title = extractTitleFromBody(body);
  const excerpt =
    keywordSnippet(
      body,
      [/retention recommendation/i, /performance evaluation/i, /judicial discipline/i, /complaint/i, /censure/i, /reversal/i, /sentencing/i],
    ) ??
    excerptFromParagraphs(body) ??
    excerptFromText(body);
  return {
    title,
    excerpt,
    publishedAt: extractPublishedAt(body),
    notes: "Source family: Colorado judicial performance or discipline page; retention, evaluation, or discipline context extracted when available.",
  };
}

/**
 * Inspect a fetched body and return neutral enrichment hints for the packet.
 */
export function adaptSourcePacket(input: SourcePacketEnrichmentInput): SourcePacketEnrichment {
  const body = input.body ?? "";
  const family = detectFamily(input.url, body);
  if (!family) {
    return {
      title: extractTitleFromBody(body),
      excerpt: isHtml(body) ? excerptFromParagraphs(body) ?? excerptFromText(body) : excerptFromText(body),
      publishedAt: extractPublishedAt(body),
      notes: `Source: ${input.sourceName}; generic HTML/text enrichment applied.`,
    };
  }

  switch (family) {
    case "Ballotpedia":
      return buildBallotpediaEnrichment(body);
    case "Colorado Secretary of State":
      return buildColoradoSosEnrichment(body);
    case "FEC":
      return buildFecEnrichment(body, input.url);
    case "Colorado judicial":
      return buildColoradoJudicialEnrichment(body);
    default:
      return {
        title: extractTitleFromBody(body),
        excerpt: isHtml(body) ? excerptFromParagraphs(body) ?? excerptFromText(body) : excerptFromText(body),
        publishedAt: extractPublishedAt(body),
      };
  }
}
