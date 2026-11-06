/** Validate and persist aggregate-only product behavior summaries. @module */
import { z } from "npm:zod@4";
import {
  evaluateProductBehaviorSummary,
  expectedOutcomesSchema,
  type ProductBehaviorSummary,
  productBehaviorSummaryOutputSchema,
} from "./_lib/product_behavior_summary_contracts.ts";

/** Published model version. */
export const PRODUCT_BEHAVIOR_SUMMARY_MODEL_VERSION = "2026.08.23.1" as const;
/** Consumer-owned boundary for application-specific metric names. */
export const globalArgumentsSchema = z.strictObject({
  expectedOutcomes: expectedOutcomesSchema,
});
/** Method envelope; unknown merged global arguments are deliberately stripped. */
export const summarizeArgumentsSchema = z.object({ input: z.unknown() });

const identifierKey =
  /^(?:user|customer|account|person|email|phone|device|session)(?:_?id|_?identifier)?$/i;

function identifierPath(
  value: unknown,
  path = "input",
  visited = new WeakSet<object>(),
): string | undefined {
  if (Array.isArray(value)) {
    if (visited.has(value)) return undefined;
    visited.add(value);
    return value.map((item, index) =>
      identifierPath(item, `${path}.${index}`, visited)
    )
      .find(Boolean);
  }
  if (value === null || typeof value !== "object") return undefined;
  if (visited.has(value)) return undefined;
  visited.add(value);
  for (
    const [key, nested] of Object.entries(value as Record<string, unknown>)
  ) {
    if (identifierKey.test(key)) return `${path}.${key}`;
    const found = identifierPath(nested, `${path}.${key}`, visited);
    if (found) return found;
  }
  return undefined;
}

function fail(message: string, details?: unknown): never {
  throw new TypeError(
    details === undefined ? message : `${message}: ${JSON.stringify(details)}`,
  );
}

/** Evaluate a summary without writing it; invalid, identifying, or stale input fails closed. */
export function summarizeProductBehavior(
  input: unknown,
  expectedOutcomes: readonly string[],
  evaluatedAt = new Date(),
): ProductBehaviorSummary {
  const forbidden = identifierPath(input);
  if (forbidden) fail(`User-level identifier is prohibited at ${forbidden}`);
  const evaluated = evaluateProductBehaviorSummary(input, expectedOutcomes);
  if (!evaluated.success) {
    fail("Invalid product behavior summary", evaluated.diagnostics);
  }
  if (Date.parse(evaluated.value.generatedAt) > evaluatedAt.getTime()) {
    fail("Product behavior summary generatedAt cannot be in the future");
  }
  evaluated.value.metrics.forEach((metric, index) => {
    if (evaluatedAt.getTime() >= Date.parse(metric.freshness.expiresAt)) {
      fail(
        `Stale product behavior metric at metrics.${index}.freshness.expiresAt`,
      );
    }
  });
  return evaluated.value;
}

type WriteContext = {
  globalArgs: z.infer<typeof globalArgumentsSchema>;
  logger: {
    info: (message: string, properties?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    data: ProductBehaviorSummary,
  ) => Promise<unknown>;
  now?: () => Date;
};

/** Swamp model definition with no external clients or side-effect authority. */
export const model = {
  type: "@mgreten/product-behavior-summary",
  version: PRODUCT_BEHAVIOR_SUMMARY_MODEL_VERSION,
  globalArguments: globalArgumentsSchema,
  resources: {
    summary: {
      description:
        "Validated aggregate-only product behavior rates with zero side-effect authority",
      schema: productBehaviorSummaryOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    summarize: {
      description:
        "Validate aggregate metrics and persist only their deterministic privacy-safe summary.",
      arguments: summarizeArgumentsSchema,
      execute: async (
        args: z.infer<typeof summarizeArgumentsSchema>,
        context: WriteContext,
      ) => {
        context.logger.info("Summarizing product behavior metrics");
        const summary = summarizeProductBehavior(
          args.input,
          context.globalArgs.expectedOutcomes,
          context.now?.() ?? new Date(),
        );
        const handle = await context.writeResource(
          "summary",
          "current",
          summary,
        );
        context.logger.info("Persisted product behavior summary {summaryId}", {
          summaryId: summary.summaryId,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
