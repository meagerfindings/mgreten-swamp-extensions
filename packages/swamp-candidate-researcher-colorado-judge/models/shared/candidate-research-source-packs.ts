/**
 * Shared source-pack builders for candidate and judicial research.
 *
 * These helpers keep source selection neutral and reusable. They prefer
 * authoritative, machine-fetchable sources when possible and fall back to
 * query/manual-follow-up entries when the public record is not directly
 * fetchable from a stable URL.
 *
 * @module
 */

import type {
  IssueLens,
  Jurisdiction,
  OfficeType,
  SourceKind,
  SourceSpec,
} from "./candidate-research-shared.ts";

function normalizeIssueLensNames(issueLenses: Array<string | IssueLens>): Set<string> {
  return new Set(issueLenses.map((lens) => (typeof lens === "string" ? lens : lens.name).toLowerCase()));
}

function createSourceSpec(input: {
  name: string;
  kind: SourceKind;
  url?: string;
  jurisdiction?: Jurisdiction;
  queryHint?: string;
  notes?: string;
  enabled?: boolean;
}): SourceSpec {
  return {
    name: input.name,
    kind: input.kind,
    url: input.url,
    jurisdiction: input.jurisdiction,
    queryHint: input.queryHint,
    notes: input.notes,
    enabled: input.enabled ?? true,
  };
}

function appendUniqueSourceSpecs(...groups: SourceSpec[][]): SourceSpec[] {
  const seen = new Set<string>();
  const result: SourceSpec[] = [];
  for (const group of groups) {
    for (const source of group) {
      const key = [source.name, source.url ?? "", source.queryHint ?? "", source.jurisdiction ?? ""].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(source);
    }
  }
  return result;
}

function manualFollowUpSource(input: {
  name: string;
  kind: SourceKind;
  jurisdiction?: Jurisdiction;
  queryHint: string;
  notes?: string;
}): SourceSpec {
  return createSourceSpec({
    name: input.name,
    kind: input.kind,
    jurisdiction: input.jurisdiction,
    queryHint: input.queryHint,
    notes: input.notes ?? "Manual follow-up required; no stable machine-fetchable URL was provided.",
  });
}

function officialSource(input: {
  name: string;
  url: string;
  jurisdiction?: Jurisdiction;
  notes?: string;
}): SourceSpec {
  return createSourceSpec({
    name: input.name,
    kind: "official",
    url: input.url,
    jurisdiction: input.jurisdiction,
    notes: input.notes,
  });
}

function neutralSource(input: {
  name: string;
  url?: string;
  jurisdiction?: Jurisdiction;
  queryHint?: string;
  notes?: string;
}): SourceSpec {
  return createSourceSpec({
    name: input.name,
    kind: "neutral",
    url: input.url,
    jurisdiction: input.jurisdiction,
    queryHint: input.queryHint,
    notes: input.notes,
  });
}

function candidateSource(input: {
  name: string;
  url?: string;
  jurisdiction?: Jurisdiction;
  queryHint?: string;
  notes?: string;
}): SourceSpec {
  return createSourceSpec({
    name: input.name,
    kind: "candidate",
    url: input.url,
    jurisdiction: input.jurisdiction,
    queryHint: input.queryHint,
    notes: input.notes,
  });
}

function officialLookupSource(input: {
  name: string;
  jurisdiction: Jurisdiction;
  queryHint: string;
  notes?: string;
}): SourceSpec {
  return manualFollowUpSource({
    name: input.name,
    kind: "official",
    jurisdiction: input.jurisdiction,
    queryHint: input.queryHint,
    notes: input.notes,
  });
}

function neutralLookupSource(input: {
  name: string;
  jurisdiction?: Jurisdiction;
  queryHint: string;
  notes?: string;
}): SourceSpec {
  return manualFollowUpSource({
    name: input.name,
    kind: "neutral",
    jurisdiction: input.jurisdiction,
    queryHint: input.queryHint,
    notes: input.notes,
  });
}

function campaignLookupSource(input: {
  name: string;
  jurisdiction?: Jurisdiction;
  queryHint: string;
  notes?: string;
}): SourceSpec {
  return manualFollowUpSource({
    name: input.name,
    kind: "candidate",
    jurisdiction: input.jurisdiction,
    queryHint: input.queryHint,
    notes: input.notes,
  });
}

/**
 * Balanced source suggestions for issue-specific research lenses.
 */
export function buildIssueSourceSpecs(issueLenses: Array<string | IssueLens>): SourceSpec[] {
  const names = normalizeIssueLensNames(issueLenses);
  const sources: SourceSpec[] = [];

  if (names.has("abortion")) {
    sources.push(
      neutralSource({
        name: "Guttmacher Institute",
        url: "https://www.guttmacher.org/",
        notes: "Policy and research lens",
      }),
      neutralSource({
        name: "SBA Pro-Life America",
        url: "https://sbaprolife.org/",
        notes: "Pro-life advocacy lens",
      }),
    );
  }

  if (names.has("homeschooling")) {
    sources.push(
      neutralSource({
        name: "CHEC Colorado Homeschool Freedom",
        url: "https://chec.org/colorado-homeschool-freedom/",
        jurisdiction: "colorado",
        notes: "Homeschool policy and parental-rights lens",
      }),
      neutralSource({
        name: "HSLDA",
        url: "https://hslda.org/",
        notes: "Homeschool defense and legal-support lens",
      }),
      neutralSource({
        name: "CRHE",
        url: "https://responsiblehomeschooling.org/",
        notes: "Critical homeschool research lens",
      }),
    );
  }

  if (names.has("second amendment") || names.has("2a") || names.has("gun rights")) {
    sources.push(
      neutralSource({
        name: "NRA-ILA",
        url: "https://www.nraila.org/",
        notes: "Gun-rights lens",
      }),
      neutralSource({
        name: "Giffords",
        url: "https://giffords.org/",
        notes: "Gun-safety lens",
      }),
    );
  }

  if (names.has("free speech")) {
    sources.push(
      neutralSource({
        name: "FIRE",
        url: "https://www.thefire.org/",
        notes: "Free-speech and due-process lens",
      }),
      neutralSource({
        name: "ACLU",
        url: "https://www.aclu.org/",
        notes: "Civil-liberties lens",
      }),
    );
  }

  return sources;
}

/**
 * Colorado candidate source pack.
 */
export function buildColoradoCandidateSourceSpecs(
  subject: string,
  issueLenses: Array<string | IssueLens> = [],
): SourceSpec[] {
  return appendUniqueSourceSpecs(
    [
      officialSource({
        name: "Colorado Secretary of State elections hub",
        url: "https://www.sos.state.co.us/pubs/elections/main.html",
        jurisdiction: "colorado",
        notes: "Official Colorado elections landing page",
      }),
      officialSource({
        name: "Colorado SOS campaign finance / TRACER",
        url: "https://tracer.sos.colorado.gov/PublicSite/homepage.aspx",
        jurisdiction: "colorado",
        notes: "Campaign finance and disclosures",
      }),
      officialSource({
        name: "Colorado election results and data",
        url: "https://www.coloradosos.gov/pubs/elections/resultsData.html",
        jurisdiction: "colorado",
        notes: "Historical results and election data",
      }),
      officialSource({
        name: "Colorado Historical Election Data",
        url: "https://historicalelectiondata.coloradosos.gov/eng/",
        jurisdiction: "colorado",
        notes: "Historical election database",
      }),
      officialLookupSource({
        name: "Colorado candidate filing lookup",
        jurisdiction: "colorado",
        queryHint: `Search Colorado Secretary of State filing and candidate records for ${subject}.`,
        notes: "Use when a direct filing URL is not available or the filing record is form-driven.",
      }),
    ],
    [
      neutralLookupSource({
        name: "Ballotpedia candidate profile",
        jurisdiction: "colorado",
        queryHint: `Search Ballotpedia for ${subject} and the relevant Colorado office or district.`,
        notes: "Neutral reference source; candidate page is usually found via site search.",
      }),
      campaignLookupSource({
        name: "Official campaign website",
        jurisdiction: "colorado",
        queryHint: `Locate the candidate's official campaign website for ${subject} and review platform, endorsements, and disclosures.`,
        notes: "Primary candidate-controlled source; use the candidate's own materials if one exists.",
      }),
    ],
    buildIssueSourceSpecs(issueLenses),
  );
}

/**
 * Federal candidate source pack.
 */
export function buildFederalCandidateSourceSpecs(
  subject: string,
  issueLenses: Array<string | IssueLens> = [],
): SourceSpec[] {
  return appendUniqueSourceSpecs(
    [
      officialSource({
        name: "FEC campaign finance data",
        url: "https://www.fec.gov/data/",
        jurisdiction: "federal",
        notes: "Federal campaign finance data hub",
      }),
      officialSource({
        name: "FEC candidate data",
        url: "https://www.fec.gov/data/candidates/",
        jurisdiction: "federal",
        notes: "Candidate lookup and filing summaries",
      }),
      officialSource({
        name: "FEC committee data",
        url: "https://www.fec.gov/data/committees/",
        jurisdiction: "federal",
        notes: "Committee lookup and filing summaries",
      }),
      officialSource({
        name: "FEC bulk data",
        url: "https://www.fec.gov/data/browse-data/?tab=bulk-data",
        jurisdiction: "federal",
        notes: "Bulk downloads and data tables",
      }),
      officialSource({
        name: "OpenFEC API docs",
        url: "https://api.open.fec.gov/developers/",
        jurisdiction: "federal",
        notes: "API documentation and field references",
      }),
      officialLookupSource({
        name: "FEC candidate filing lookup",
        jurisdiction: "federal",
        queryHint: `Search FEC records for ${subject}, candidate filings, committee IDs, and disbursement history.`,
        notes: "Use when a direct candidate or committee URL is not already known.",
      }),
    ],
    [
      neutralLookupSource({
        name: "Ballotpedia candidate profile",
        jurisdiction: "federal",
        queryHint: `Search Ballotpedia for ${subject} and the relevant federal office.`,
        notes: "Neutral reference source; candidate page is usually found via site search.",
      }),
      campaignLookupSource({
        name: "Official campaign website",
        jurisdiction: "federal",
        queryHint: `Locate the candidate's official campaign website for ${subject} and review platform, endorsements, and disclosures.`,
        notes: "Primary candidate-controlled source; use the candidate's own materials if one exists.",
      }),
    ],
    buildIssueSourceSpecs(issueLenses),
  );
}

/**
 * Colorado judge source pack.
 */
export function buildColoradoJudgeSourceSpecs(
  subject: string,
  issueLenses: Array<string | IssueLens> = [],
): SourceSpec[] {
  return appendUniqueSourceSpecs(
    [
      officialSource({
        name: "Colorado judicial branch homepage",
        url: "https://www.coloradojudicial.gov/",
        jurisdiction: "colorado",
        notes: "Official judicial branch and judge biographies",
      }),
      officialSource({
        name: "Colorado judicial branch search",
        url: "https://www.coloradojudicial.gov/search",
        jurisdiction: "colorado",
        notes: "Search official opinions, notices, and branch materials",
      }),
      officialSource({
        name: "Colorado Commission on Judicial Discipline",
        url: "https://ccjd.colorado.gov/",
        jurisdiction: "colorado",
        notes: "Discipline and misconduct materials",
      }),
      officialSource({
        name: "Colorado judicial performance overview",
        url: "https://judicialperformance.colorado.gov/",
        jurisdiction: "colorado",
        notes: "Judicial performance evaluations and retention recommendations",
      }),
      officialLookupSource({
        name: "Colorado judge lookup",
        jurisdiction: "colorado",
        queryHint: `Search the Colorado Judicial Branch for ${subject}, including biography, assignments, opinions, retention history, and evaluation records.`,
        notes: "Use when the judge-specific landing page is not already known.",
      }),
    ],
    [
      neutralLookupSource({
        name: "Ballotpedia judge profile",
        jurisdiction: "colorado",
        queryHint: `Search Ballotpedia for ${subject} and the relevant Colorado judicial race or retention page.`,
        notes: "Neutral reference source; candidate page is usually found via site search.",
      }),
      neutralLookupSource({
        name: "Retention and performance materials",
        jurisdiction: "colorado",
        queryHint: `Locate Colorado judicial performance or retention materials for ${subject} and review the latest evaluation packet.`,
        notes: "Manual follow-up if a direct evaluation PDF or page is not exposed by a stable URL.",
      }),
    ],
    buildIssueSourceSpecs(issueLenses),
  );
}

/**
 * Generic source pack builder used by the public model entrypoints.
 */
export function buildSourcePack(input: {
  subject: string;
  jurisdiction: Jurisdiction;
  officeType: OfficeType;
  issueLenses?: Array<string | IssueLens>;
}): SourceSpec[] {
  if (input.jurisdiction === "colorado" && input.officeType === "candidate") {
    return buildColoradoCandidateSourceSpecs(input.subject, input.issueLenses ?? []);
  }
  if (input.jurisdiction === "federal" && input.officeType === "candidate") {
    return buildFederalCandidateSourceSpecs(input.subject, input.issueLenses ?? []);
  }
  if (input.jurisdiction === "colorado" && input.officeType === "judge") {
    return buildColoradoJudgeSourceSpecs(input.subject, input.issueLenses ?? []);
  }

  return appendUniqueSourceSpecs(
    [
      manualFollowUpSource({
        name: "Primary official records lookup",
        kind: "official",
        jurisdiction: input.jurisdiction,
        queryHint: `Search authoritative records for ${input.subject} in ${input.jurisdiction} (${input.officeType}).`,
        notes: "Fallback source pack for unhandled jurisdiction / office combinations.",
      }),
    ],
    buildIssueSourceSpecs(input.issueLenses ?? []),
  );
}

export type { SourceSpec } from "./candidate-research-shared.ts";
