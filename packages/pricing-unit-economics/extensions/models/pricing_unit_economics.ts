/**
 * Deterministic Swamp model for recommendation-only unit-economics summaries.
 * It validates caller-supplied evidence and writes one validated resource.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  evaluatePricingUnitEconomics,
  pricingUnitEconomicsOutputSchema,
  type PricingUnitEconomicsSummary,
} from "./_lib/pricing_unit_economics_contracts.ts";

/** Published model version. */
export const PRICING_UNIT_ECONOMICS_MODEL_VERSION = "2026.08.23.1" as const;

/** The model has no configured global arguments. */
export const globalArgumentsSchema = z.strictObject({});
const SafeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);

/** Arguments accepted by the deterministic summary method. */
export const summarizeArgumentsSchema = z.object({
  requestId: SafeId,
  input: z.unknown(),
});

function fail(message: string, details?: unknown): never {
  throw new TypeError(
    details === undefined ? message : `${message}: ${JSON.stringify(details)}`,
  );
}

/** Validate, transform, and freshness-check one unit-economics summary. */
export function summarizePricingUnitEconomics(
  input: unknown,
  evaluatedAt = new Date(),
): PricingUnitEconomicsSummary {
  const evaluated = evaluatePricingUnitEconomics(input);
  if (!evaluated.success) {
    fail("Invalid pricing/unit-economics summary", evaluated.diagnostics);
  }

  if (Date.parse(evaluated.value.evaluationTime) > evaluatedAt.getTime()) {
    fail("Future pricing/unit-economics evaluationTime is prohibited");
  }
  evaluated.value.observedCostProxies.forEach((proxy, index) => {
    if (evaluatedAt.getTime() >= Date.parse(proxy.source.expiresAt)) {
      fail(
        `Stale observed cost proxy at observedCostProxies.${index}.source.expiresAt`,
      );
    }
  });

  return pricingUnitEconomicsOutputSchema.parse(evaluated.value);
}

type WriteContext = {
  globalArgs: z.infer<typeof globalArgumentsSchema>;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
  now?: () => Date;
};

/** Swamp model definition with no API clients or effectful collaborators. */
export const model = {
  type: "@mgreten/pricing-unit-economics",
  version: PRICING_UNIT_ECONOMICS_MODEL_VERSION,
  globalArguments: globalArgumentsSchema,
  resources: {
    summary: {
      description:
        "Validated observed cost proxies and explicitly hypothetical revenue scenarios with zero authority",
      schema: pricingUnitEconomicsOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    summarize: {
      description:
        "Validate provenance, freshness, units, caveats, and thresholds, then persist a recommendation-only summary.",
      arguments: summarizeArgumentsSchema,
      execute: async (
        args: z.infer<typeof summarizeArgumentsSchema>,
        context: WriteContext,
      ) => {
        const summary = summarizePricingUnitEconomics(
          args.input,
          context.now?.() ?? new Date(),
        );
        const handle = await context.writeResource(
          "summary",
          `summary-${args.requestId}`,
          summary,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
