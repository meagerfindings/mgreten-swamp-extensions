/**
 * Deterministic public-safe reflective drafting.
 *
 * This model converts only caller-supplied narrative components into a
 * structured draft. It does not read conversations, files, memories,
 * credentials, or network services; it does not publish anything.
 *
 * Automated redaction is a safeguard, not proof that a draft is safe to share.
 * Callers must supply known sensitive terms and complete manual review.
 *
 * @module
 */
import { z } from "npm:zod@4";

const RedactionSchema = z.object({
  category: z.string(),
  count: z.number().int().min(1),
  replacement: z.string(),
});

const DraftSchema = z.object({
  generatedAt: z.iso.datetime(),
  title: z.string(),
  thesis: z.string(),
  publicDraft: z.string(),
  reusableLesson: z.string(),
  redactions: z.array(RedactionSchema),
  manualReview: z.array(z.string()),
  limitations: z.array(z.string()),
});

const GlobalArgsSchema = z.object({
  redactionLabel: z.string().min(3).max(80).default("[redacted]"),
});

const DraftArgumentsSchema = z.object({
  title: z.string().min(3).max(180),
  thesis: z.string().min(10).max(600),
  journey: z.string().min(20).max(20_000),
  lesson: z.string().min(10).max(4_000),
  sensitiveTerms: z.array(z.string().min(1).max(200)).max(100).default([]),
});

type DraftArguments = z.infer<typeof DraftArgumentsSchema>;
type Redaction = z.infer<typeof RedactionSchema>;
type Draft = z.infer<typeof DraftSchema>;

type DraftContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: {
    info: (message: string, attributes: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Draft,
  ) => Promise<unknown>;
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redact(
  source: string,
  label: string,
  sensitiveTerms: string[],
): { text: string; redactions: Redaction[] } {
  let text = source;
  const counts = new Map<string, number>();
  const apply = (
    pattern: RegExp,
    category: string,
    replacement: string,
  ): void => {
    text = text.replace(pattern, () => {
      counts.set(category, (counts.get(category) ?? 0) + 1);
      return replacement;
    });
  };

  for (
    const term of [...new Set(sensitiveTerms)].sort((a, b) =>
      b.length - a.length
    )
  ) {
    apply(
      new RegExp(escapeRegex(term), "gi"),
      "caller-supplied sensitive term",
      label,
    );
  }
  apply(
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
    "credential-like value",
    label,
  );
  apply(
    /https?:\/\/[^\s/]+\.ts\.net(?:\/[^\s]*)?/gi,
    "private tailnet URL",
    label,
  );
  apply(/\b(?:localhost|[a-z0-9-]+\.local)\b/gi, "private hostname", label);
  apply(
    /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})\b/g,
    "private IP address",
    label,
  );
  apply(
    /(?<![\w.-])\/(?:[\w.-]+\/){2,}[\w.-]*/g,
    "absolute filesystem path",
    label,
  );

  return {
    text,
    redactions: [...counts.entries()].map(([category, count]) => ({
      category,
      count,
      replacement: label,
    })),
  };
}

function combineRedactions(redactions: Redaction[]): Redaction[] {
  const combined = new Map<string, Redaction>();
  for (const item of redactions) {
    const prior = combined.get(item.category);
    combined.set(item.category, {
      ...item,
      count: (prior?.count ?? 0) + item.count,
    });
  }
  return [...combined.values()].sort((a, b) =>
    a.category.localeCompare(b.category)
  );
}

/** Model definition for generating a structured, review-required public draft. */
export const model = {
  type: "@mgreten/public-safe-draft",
  version: "2026.07.24.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    current: {
      description:
        "The latest structured public-safe draft produced by this model",
      schema: DraftSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  methods: {
    draft: {
      description:
        "Build a public-safe reflective draft from caller-supplied narrative components",
      arguments: DraftArgumentsSchema,
      execute: async (args: DraftArguments, context: DraftContext) => {
        context.logger.info("Creating public-safe draft", {
          title: args.title,
        });
        const journey = redact(
          args.journey,
          context.globalArgs.redactionLabel,
          args.sensitiveTerms,
        );
        const lesson = redact(
          args.lesson,
          context.globalArgs.redactionLabel,
          args.sensitiveTerms,
        );
        const thesis = redact(
          args.thesis,
          context.globalArgs.redactionLabel,
          args.sensitiveTerms,
        );
        const output: Draft = {
          generatedAt: new Date().toISOString(),
          title: args.title,
          thesis: thesis.text,
          publicDraft:
            `# ${args.title}\n\n${thesis.text}\n\n## The journey\n\n${journey.text}\n\n## The reusable lesson\n\n${lesson.text}\n\n## Before publication\n\nReview the draft against the privacy checklist below; automated redaction is a safeguard, not proof of safety.`,
          reusableLesson: lesson.text,
          redactions: combineRedactions([
            ...journey.redactions,
            ...lesson.redactions,
            ...thesis.redactions,
          ]),
          manualReview: [
            "Confirm that names, organizations, locations, and dates are appropriate for the intended audience.",
            "Confirm that no private repository, hostname, device identifier, credential, or personal detail remains in context.",
            "Confirm that the thesis and reusable lesson remain accurate after redaction.",
          ],
          limitations: [
            "This model only transforms text provided to this method.",
            "Pattern matching cannot identify every sensitive detail or determine whether context is publishable.",
            "No publication, file write, network request, or source lookup is performed.",
          ],
        };
        const handle = await context.writeResource(
          "current",
          "current",
          output,
        );
        context.logger.info("Created public-safe draft", {
          title: args.title,
          redactionCategories: output.redactions.length,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
