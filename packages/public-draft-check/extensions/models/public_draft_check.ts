/**
 * Deterministic disclosure checks for a candidate public draft.
 *
 * The model reports exact and pattern-based findings without rewriting the
 * draft or echoing matched text. A clear report only means that no configured
 * rule matched; semantic privacy review and human approval remain required.
 *
 * @module
 */
import { z } from "npm:zod@4";
import type {
  DataHandle,
  MethodContext,
  MethodResult,
} from "jsr:@systeminit/swamp-testing@0.20260604.20";

const MAX_REPORTED_LOCATIONS = 50;

const LocationSchema = z.object({
  line: z.number().int().min(1),
  column: z.number().int().min(1),
});

const FindingSchema = z.object({
  rule: z.string(),
  severity: z.enum(["block", "review"]),
  count: z.number().int().min(1),
  locations: z.array(LocationSchema),
  locationsTruncated: z.boolean(),
  message: z.string(),
});

const ReportSchema = z.object({
  status: z.enum(["clear", "review_required", "blocked"]),
  blockingRuleCount: z.number().int().min(0),
  reviewRuleCount: z.number().int().min(0),
  findings: z.array(FindingSchema),
  manualReviewRequired: z.literal(true),
  limitations: z.array(z.string()),
});

const GlobalArgsSchema: z.ZodObject<Record<string, never>> = z.object({});

const CheckArgumentsSchema = z.object({
  draft: z.string().min(1).max(100_000).meta({ sensitive: true }),
  sensitiveTerms: z.array(z.string().min(1).max(500)).max(200).default([])
    .meta({ sensitive: true }),
});

type CheckArguments = z.infer<typeof CheckArgumentsSchema>;
type Finding = z.infer<typeof FindingSchema>;
type Location = z.infer<typeof LocationSchema>;
type Report = z.infer<typeof ReportSchema>;

type CheckContext =
  & Omit<MethodContext<Record<string, unknown>>, "writeResource">
  & {
    writeResource: (
      specName: string,
      instanceName: string,
      data: Report,
    ) => Promise<DataHandle>;
  };

type Span = { start: number; end: number };

type Rule = {
  id: string;
  severity: "block" | "review";
  message: string;
  patterns?: RegExp[];
};

const RULES: Rule[] = [
  {
    id: "credential-like-value",
    severity: "block",
    message: "A credential-like assignment or authorization value remains.",
    patterns: [
      /\b(?:api[_-]?(?:key|token)|access[_-]?token|auth[_-]?token|client[_-]?secret|refresh[_-]?token|password|passwd|secret[_-]?access[_-]?key|aws[_-]?secret[_-]?access[_-]?key)\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;'\"]+)/gi,
      /\b(?:token|secret)\s*=\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;'\"]+)/gi,
      /\bauthorization\s*:\s*bearer\s+[^\s,;]+/gi,
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    ],
  },
  {
    id: "absolute-filesystem-path",
    severity: "review",
    message: "A common absolute filesystem path remains and needs review.",
    patterns: [
      /(?<![\w:/])\/(?:Users|home|root|private|var|etc|tmp|opt|srv|usr|dev|Library)(?:\/[^\s,;:]+)+/g,
      /\bfile:\/\/\/(?:[^\s,;:]+\/)*[^\s,;:]+/gi,
    ],
  },
  {
    id: "email-address",
    severity: "review",
    message: "An email address remains and needs review.",
    patterns: [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
  },
  {
    id: "uuid",
    severity: "review",
    message: "A UUID-like identifier remains and needs review.",
    patterns: [
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    ],
  },
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans.toSorted((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const span of sorted) {
    const prior = merged.at(-1);
    if (prior && span.start < prior.end) {
      prior.end = Math.max(prior.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function matchSpans(source: string, patterns: RegExp[]): Span[] {
  const spans: Span[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match.index !== undefined) {
        spans.push({ start: match.index, end: match.index + match[0].length });
      }
    }
  }
  return mergeSpans(spans);
}

function privateHostnameSpans(source: string): Span[] {
  const spans: Span[] = [];
  for (const match of source.matchAll(/\b[a-z0-9.-]+\b/gi)) {
    const hostname = match[0].toLowerCase();
    if (
      hostname === "localhost" || hostname.endsWith(".local") ||
      hostname.endsWith(".ts.net")
    ) {
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return mergeSpans(spans);
}

function privateIpSpans(source: string): Span[] {
  const spans: Span[] = [];
  for (const match of source.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    const octets = match[0].split(".").map(Number);
    if (octets.some((octet) => octet > 255)) continue;
    const [first, second] = octets;
    if (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    ) {
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return spans;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function locationAt(
  source: string,
  starts: number[],
  offset: number,
): Location {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  const lineIndex = high;
  return {
    line: lineIndex + 1,
    column: [...source.slice(starts[lineIndex], offset)].length + 1,
  };
}

function finding(
  source: string,
  starts: number[],
  rule: Rule,
  spans: Span[],
): Finding | undefined {
  if (spans.length === 0) return undefined;
  const reported = spans.slice(0, MAX_REPORTED_LOCATIONS);
  return {
    rule: rule.id,
    severity: rule.severity,
    count: spans.length,
    locations: reported.map((span) => locationAt(source, starts, span.start)),
    locationsTruncated: spans.length > reported.length,
    message: rule.message,
  };
}

/** Check a draft without returning or modifying its text. */
export function checkDraft(args: CheckArguments): Report {
  const findings: Finding[] = [];
  const starts = lineStarts(args.draft);
  const sensitivePatterns = [...new Set(args.sensitiveTerms)]
    .sort((a, b) => b.length - a.length)
    .map((term) => new RegExp(escapeRegex(term), "gi"));
  const sensitiveFinding = finding(
    args.draft,
    starts,
    {
      id: "caller-supplied-sensitive-term",
      severity: "block",
      message: "A caller-supplied sensitive term remains.",
    },
    matchSpans(args.draft, sensitivePatterns),
  );
  if (sensitiveFinding) findings.push(sensitiveFinding);

  for (const rule of RULES) {
    const matched = finding(
      args.draft,
      starts,
      rule,
      matchSpans(args.draft, rule.patterns!),
    );
    if (matched) findings.push(matched);
  }

  const privateHostnames = finding(
    args.draft,
    starts,
    {
      id: "private-hostname",
      severity: "block",
      message: "A localhost, .local, or Tailscale hostname remains.",
    },
    privateHostnameSpans(args.draft),
  );
  if (privateHostnames) findings.push(privateHostnames);

  const privateIps = finding(
    args.draft,
    starts,
    {
      id: "private-ip-address",
      severity: "block",
      message: "An RFC1918 private IPv4 address remains.",
    },
    privateIpSpans(args.draft),
  );
  if (privateIps) findings.push(privateIps);

  const ruleOrder = [
    "caller-supplied-sensitive-term",
    "credential-like-value",
    "private-hostname",
    "private-ip-address",
    "absolute-filesystem-path",
    "email-address",
    "uuid",
  ];
  findings.sort((a, b) => {
    const severity = Number(a.severity === "review") -
      Number(b.severity === "review");
    return severity || ruleOrder.indexOf(a.rule) - ruleOrder.indexOf(b.rule);
  });

  const blockingRuleCount =
    findings.filter((item) => item.severity === "block").length;
  const reviewRuleCount = findings.length - blockingRuleCount;
  return {
    status: blockingRuleCount > 0
      ? "blocked"
      : reviewRuleCount > 0
      ? "review_required"
      : "clear",
    blockingRuleCount,
    reviewRuleCount,
    findings,
    manualReviewRequired: true,
    limitations: [
      "A clear report only means that no configured deterministic rule matched.",
      "Semantic or contextual disclosures require independent agent and human review.",
      "The checker does not rewrite the draft or approve it for publication.",
    ],
  };
}

/** Model definition for deterministic public-draft disclosure checks. */
export const model = {
  type: "@mgreten/public-draft-check",
  version: "2026.07.24.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    report: {
      description: "The latest deterministic disclosure-check report",
      schema: ReportSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    check: {
      description:
        "Check a candidate public draft for configured and high-confidence disclosure indicators",
      arguments: CheckArgumentsSchema,
      execute: async (
        args: CheckArguments,
        context: CheckContext,
      ): Promise<MethodResult> => {
        context.logger.info("Checking candidate public draft", {});
        const report = checkDraft(args);
        const handle = await context.writeResource("report", "current", report);
        context.logger.info("Checked candidate public draft", {
          status: report.status,
          blockingRuleCount: report.blockingRuleCount,
          reviewRuleCount: report.reviewRuleCount,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
