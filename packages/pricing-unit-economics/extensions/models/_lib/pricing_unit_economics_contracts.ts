/**
 * Strict, deterministic contracts for recommendation-only unit economics.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Version of the public input and output contract. */
export const PRICING_UNIT_ECONOMICS_SCHEMA_VERSION = "1.0" as const;

const MAX_TEXT_LENGTH = 500;
const MAX_ITEMS = 100;
const text = z.string().trim().min(1).max(MAX_TEXT_LENGTH);
const timestamp = z.iso.datetime({ offset: true });
const amount = z.number().finite().nonnegative();
const currency = z.string().regex(
  /^[A-Z]{3}$/,
  "currency must be an ISO-style three-letter code",
);

const sourceSchema = z.strictObject({
  sourceId: text,
  system: text,
  resourceType: text,
  resourceId: text,
  resourceVersion: text,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  observedAt: timestamp,
  collectedAt: timestamp,
  asOf: timestamp,
  expiresAt: timestamp,
});
const monetaryMeasureSchema = z.strictObject({
  amount,
  currency,
  unit: z.enum(["currency_minor", "currency_major"]),
  denominator: text,
});
const observedCostProxySchema = z.strictObject({
  kind: z.literal("observed_cost_proxy"),
  proxyId: text,
  label: text,
  measure: monetaryMeasureSchema,
  source: sourceSchema,
  caveatIds: z.array(text).min(1).max(MAX_ITEMS),
  isAuthoritativeBill: z.literal(false),
});
const revenueScenarioSchema = z.strictObject({
  kind: z.literal("hypothetical_revenue_scenario"),
  scenarioId: text,
  label: text,
  price: monetaryMeasureSchema,
  assumedUnits: z.strictObject({ quantity: amount, unit: text }),
  assumption: text,
  caveatIds: z.array(text).min(1).max(MAX_ITEMS),
});

/** Caller-supplied summary contract. It cannot authorize side effects. */
export const pricingUnitEconomicsInputSchema = z.strictObject({
  schemaVersion: z.literal(PRICING_UNIT_ECONOMICS_SCHEMA_VERSION),
  summaryId: text,
  evaluationTime: timestamp,
  generatedAt: timestamp,
  authority: z.strictObject({
    mode: z.literal("recommendation_only"),
    sideEffectAuthority: z.literal("none"),
  }),
  caveats: z.array(z.strictObject({ caveatId: text, statement: text })).min(1)
    .max(MAX_ITEMS),
  thresholdPolicy: z.strictObject({
    policyId: text,
    observedCostProxyId: text,
    comparator: z.literal("less_than_or_equal"),
    maximum: monetaryMeasureSchema,
    onBreach: z.literal("recommend_review"),
  }),
  observedCostProxies: z.array(observedCostProxySchema).min(1).max(MAX_ITEMS),
  hypotheticalRevenueScenarios: z.array(revenueScenarioSchema).max(MAX_ITEMS),
}).superRefine((summary, context) => {
  const evaluated = Date.parse(summary.evaluationTime);
  const generated = Date.parse(summary.generatedAt);
  const caveatIds = new Set(summary.caveats.map((item) => item.caveatId));
  const issue = (path: PropertyKey[], message: string): void =>
    context.addIssue({ code: "custom", path, message });
  if (generated < evaluated) {
    issue(["generatedAt"], "generatedAt must be at or after evaluationTime");
  }
  const unique = (
    values: string[],
    path: PropertyKey[],
    label: string,
  ): void => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) {
        issue([...path, index], `duplicate ${label}: ${value}`);
      }
      seen.add(value);
    });
  };
  unique(summary.caveats.map((item) => item.caveatId), ["caveats"], "caveatId");
  unique(summary.observedCostProxies.map((item) => item.proxyId), [
    "observedCostProxies",
  ], "proxyId");
  unique(summary.observedCostProxies.map((item) => item.source.sourceId), [
    "observedCostProxies",
  ], "sourceId");
  unique(summary.hypotheticalRevenueScenarios.map((item) => item.scenarioId), [
    "hypotheticalRevenueScenarios",
  ], "scenarioId");
  summary.observedCostProxies.forEach((proxy, index) => {
    const source = proxy.source;
    if (
      !(Date.parse(source.observedAt) <= Date.parse(source.collectedAt) &&
        Date.parse(source.collectedAt) <= Date.parse(source.asOf) &&
        Date.parse(source.asOf) <= evaluated &&
        evaluated <= Date.parse(source.expiresAt))
    ) {
      issue(
        ["observedCostProxies", index, "source"],
        "runtime chronology must be observedAt <= collectedAt <= asOf <= evaluationTime <= expiresAt",
      );
    }
    proxy.caveatIds.forEach((id) => {
      if (!caveatIds.has(id)) {
        issue(
          ["observedCostProxies", index, "caveatIds"],
          `unknown caveatId: ${id}`,
        );
      }
    });
  });
  summary.hypotheticalRevenueScenarios.forEach((scenario, index) => {
    if (scenario.assumedUnits.unit !== scenario.price.denominator) {
      issue(
        ["hypotheticalRevenueScenarios", index, "assumedUnits", "unit"],
        "assumed unit must match the price denominator",
      );
    }
    scenario.caveatIds.forEach((id) => {
      if (!caveatIds.has(id)) {
        issue(
          ["hypotheticalRevenueScenarios", index, "caveatIds"],
          `unknown caveatId: ${id}`,
        );
      }
    });
  });
  const proxy = summary.observedCostProxies.find((item) =>
    item.proxyId === summary.thresholdPolicy.observedCostProxyId
  );
  if (!proxy) {
    issue(
      ["thresholdPolicy", "observedCostProxyId"],
      "threshold policy must reference an observed cost proxy",
    );
  } else {
    const maximum = summary.thresholdPolicy.maximum;
    for (const field of ["currency", "unit", "denominator"] as const) {
      if (proxy.measure[field] !== maximum[field]) {
        issue(
          ["thresholdPolicy", "maximum", field],
          `threshold ${field} must match the observed proxy`,
        );
      }
    }
  }
}).transform((summary) => {
  const proxy = summary.observedCostProxies.find((item) =>
    item.proxyId === summary.thresholdPolicy.observedCostProxyId
  )!;
  return {
    ...summary,
    hypotheticalRevenueScenarios: summary.hypotheticalRevenueScenarios.map((
      scenario,
    ) => ({
      ...scenario,
      projectedRevenue: {
        amount: scenario.price.amount * scenario.assumedUnits.quantity,
        currency: scenario.price.currency,
        unit: scenario.price.unit,
        denominator: "scenario_total",
      },
      claimStatus: "hypothetical_not_realized" as const,
    })),
    recommendation: {
      policyId: summary.thresholdPolicy.policyId,
      status: proxy.measure.amount <= summary.thresholdPolicy.maximum.amount
        ? "within_threshold" as const
        : "review_recommended" as const,
      actionAuthority: "none" as const,
    },
    prohibitedClaims: [
      "realized_revenue",
      "realized_profit",
      "net_profit",
    ] as const,
  };
});

const persistedRevenueScenarioSchema = revenueScenarioSchema.extend({
  projectedRevenue: monetaryMeasureSchema.extend({
    denominator: z.literal("scenario_total"),
  }),
  claimStatus: z.literal("hypothetical_not_realized"),
});

/** Strict resource schema for a deterministic transformed summary. */
export const pricingUnitEconomicsOutputSchema = z.strictObject({
  schemaVersion: z.literal(PRICING_UNIT_ECONOMICS_SCHEMA_VERSION),
  summaryId: text,
  evaluationTime: timestamp,
  generatedAt: timestamp,
  authority: z.strictObject({
    mode: z.literal("recommendation_only"),
    sideEffectAuthority: z.literal("none"),
  }),
  caveats: z.array(z.strictObject({ caveatId: text, statement: text })).min(1)
    .max(MAX_ITEMS),
  thresholdPolicy: z.strictObject({
    policyId: text,
    observedCostProxyId: text,
    comparator: z.literal("less_than_or_equal"),
    maximum: monetaryMeasureSchema,
    onBreach: z.literal("recommend_review"),
  }),
  observedCostProxies: z.array(observedCostProxySchema).min(1).max(MAX_ITEMS),
  hypotheticalRevenueScenarios: z.array(persistedRevenueScenarioSchema).max(
    MAX_ITEMS,
  ),
  recommendation: z.strictObject({
    policyId: text,
    status: z.enum(["within_threshold", "review_recommended"]),
    actionAuthority: z.literal("none"),
  }),
  prohibitedClaims: z.tuple([
    z.literal("realized_revenue"),
    z.literal("realized_profit"),
    z.literal("net_profit"),
  ]),
}).superRefine((summary, context) => {
  const input = {
    ...summary,
    hypotheticalRevenueScenarios: summary.hypotheticalRevenueScenarios.map((
      {
        projectedRevenue: _projectedRevenue,
        claimStatus: _claimStatus,
        ...scenario
      },
    ) => scenario),
  } as Record<string, unknown>;
  delete input.recommendation;
  delete input.prohibitedClaims;
  const expected = pricingUnitEconomicsInputSchema.safeParse(input);
  if (!expected.success) {
    expected.error.issues.forEach((issue) =>
      context.addIssue({
        code: "custom",
        path: issue.path,
        message: issue.message,
      })
    );
    return;
  }
  if (JSON.stringify(summary) !== JSON.stringify(expected.data)) {
    context.addIssue({
      code: "custom",
      message: "persisted summary must equal deterministic evaluation",
    });
  }
});

/** Validated and transformed summary output. */
export type PricingUnitEconomicsSummary = z.output<
  typeof pricingUnitEconomicsInputSchema
>;
/** Deterministic success or sorted validation diagnostics. */
export type PricingUnitEconomicsValidation =
  | { success: true; value: PricingUnitEconomicsSummary; diagnostics: [] }
  | {
    success: false;
    diagnostics: Array<{ path: string; code: string; message: string }>;
  };

/** Validate and deterministically transform a candidate summary. */
export function evaluatePricingUnitEconomics(
  input: unknown,
): PricingUnitEconomicsValidation {
  const result = pricingUnitEconomicsInputSchema.safeParse(input);
  if (result.success) {
    return { success: true, value: result.data, diagnostics: [] };
  }
  const diagnostics = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
    message: issue.message,
  }))
    .sort((a, b) =>
      a.path.localeCompare(b.path) || a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message)
    );
  return { success: false, diagnostics };
}
