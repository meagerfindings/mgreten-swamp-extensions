import {
  model,
  summarizeArgumentsSchema,
  summarizePricingUnitEconomics,
} from "./pricing_unit_economics.ts";
import {
  evaluatePricingUnitEconomics,
  pricingUnitEconomicsOutputSchema,
} from "./_lib/pricing_unit_economics_contracts.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

const copy = <T>(value: T): T => structuredClone(value);
const measure = (amount: number) => ({
  amount,
  currency: "TST",
  unit: "currency_minor" as const,
  denominator: "account_period",
});
const fixture = () => ({
  schemaVersion: "1.0" as const,
  summaryId: "synthetic-summary-1",
  evaluationTime: "2026-08-23T12:00:00Z",
  generatedAt: "2026-08-23T12:01:00Z",
  authority: {
    mode: "recommendation_only" as const,
    sideEffectAuthority: "none" as const,
  },
  caveats: [
    {
      caveatId: "proxy",
      statement: "Synthetic proxy, not an authoritative bill.",
    },
    {
      caveatId: "scenario",
      statement: "Synthetic scenario, not realized revenue.",
    },
  ],
  thresholdPolicy: {
    policyId: "synthetic-policy",
    observedCostProxyId: "cost-1",
    comparator: "less_than_or_equal" as const,
    maximum: measure(50),
    onBreach: "recommend_review" as const,
  },
  observedCostProxies: [{
    kind: "observed_cost_proxy" as const,
    proxyId: "cost-1",
    label: "Synthetic processing proxy",
    measure: measure(40),
    caveatIds: ["proxy"],
    isAuthoritativeBill: false as const,
    source: {
      sourceId: "synthetic-source",
      system: "fixture",
      resourceType: "aggregate",
      resourceId: "period-1",
      resourceVersion: "v1",
      contentHash: "a".repeat(64),
      observedAt: "2026-08-23T10:00:00Z",
      collectedAt: "2026-08-23T10:30:00Z",
      asOf: "2026-08-23T11:00:00Z",
      expiresAt: "2026-08-24T00:00:00Z",
    },
  }],
  hypotheticalRevenueScenarios: [{
    kind: "hypothetical_revenue_scenario" as const,
    scenarioId: "scenario-1",
    label: "Synthetic volume assumption",
    price: measure(200),
    assumedUnits: { quantity: 10, unit: "account_period" },
    assumption: "Ten sample units",
    caveatIds: ["scenario"],
  }],
});

Deno.test("preserves public type and writes one recommendation-only summary", async () => {
  const writes: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  const result = await model.methods.summarize.execute(
    { requestId: "request-1", input: fixture() },
    {
      globalArgs: {},
      now: () => new Date("2026-08-23T12:02:00Z"),
      writeResource: (spec, name, data) => {
        writes.push({ spec, name, data });
        return Promise.resolve({ name });
      },
    },
  );
  assert(model.type === "@mgreten/pricing-unit-economics");
  assert(
    writes.length === 1 && writes[0].spec === "summary" &&
      writes[0].name === "summary-request-1",
  );
  assert(
    JSON.stringify(result) ===
      JSON.stringify({ dataHandles: [{ name: "summary-request-1" }] }),
  );
  assert(
    (writes[0].data.recommendation as { actionAuthority: string })
      .actionAuthority === "none",
  );
});

Deno.test("is deterministic and labels projected revenue as hypothetical", () => {
  const first = summarizePricingUnitEconomics(
    fixture(),
    new Date("2026-08-23T12:02:00Z"),
  );
  const second = summarizePricingUnitEconomics(
    copy(fixture()),
    new Date("2026-08-23T12:02:00Z"),
  );
  assert(JSON.stringify(first) === JSON.stringify(second));
  assert(
    first.hypotheticalRevenueScenarios[0].projectedRevenue.amount === 2000,
  );
  assert(
    first.hypotheticalRevenueScenarios[0].claimStatus ===
      "hypothetical_not_realized",
  );
  assert(
    JSON.stringify(first.prohibitedClaims) ===
      JSON.stringify(["realized_revenue", "realized_profit", "net_profit"]),
  );
});

Deno.test("has inclusive threshold boundaries and recommendation-only breach output", () => {
  const boundary = fixture();
  boundary.observedCostProxies[0].measure.amount = 50;
  const breached = fixture();
  breached.observedCostProxies[0].measure.amount = 51;
  const atMaximum = evaluatePricingUnitEconomics(boundary);
  const overMaximum = evaluatePricingUnitEconomics(breached);
  assert(
    atMaximum.success &&
      atMaximum.value.recommendation.status === "within_threshold",
  );
  assert(
    overMaximum.success &&
      overMaximum.value.recommendation.status === "review_recommended",
  );
  assert(
    overMaximum.success &&
      overMaximum.value.recommendation.actionAuthority === "none",
  );
});

Deno.test("rejects incompatible currency and denominator units", () => {
  const currencyMismatch = fixture();
  currencyMismatch.thresholdPolicy.maximum.currency = "USD";
  const denominatorMismatch = fixture();
  denominatorMismatch.hypotheticalRevenueScenarios[0].assumedUnits.unit =
    "different_unit";
  assert(!evaluatePricingUnitEconomics(currencyMismatch).success);
  assert(!evaluatePricingUnitEconomics(denominatorMismatch).success);
});

Deno.test("rejects non-normalized and unsafe monetary amounts", () => {
  const fractionalMinorUnits = fixture();
  fractionalMinorUnits.observedCostProxies[0].measure.amount = 40.5;
  const incompatibleUnits = {
    ...fixture(),
    thresholdPolicy: {
      ...fixture().thresholdPolicy,
      maximum: {
        ...fixture().thresholdPolicy.maximum,
        unit: "currency_major",
      },
    },
  };
  const overflowingProjection = fixture();
  overflowingProjection.hypotheticalRevenueScenarios[0].price.amount =
    Number.MAX_SAFE_INTEGER;
  assert(!evaluatePricingUnitEconomics(fractionalMinorUnits).success);
  assert(!evaluatePricingUnitEconomics(incompatibleUnits).success);
  assert(!evaluatePricingUnitEconomics(overflowingProjection).success);
});

Deno.test("rejects missing required data, expired evidence, and any authority claim", () => {
  const missing = fixture() as Record<string, unknown>;
  delete missing.thresholdPolicy;
  const expired = fixture();
  expired.observedCostProxies[0].source.expiresAt = "2026-08-23T11:59:59Z";
  const authority = {
    ...fixture(),
    authority: { mode: "execute", sideEffectAuthority: "write" },
  };
  assert(!evaluatePricingUnitEconomics(missing).success);
  assert(!evaluatePricingUnitEconomics(expired).success);
  assert(!evaluatePricingUnitEconomics(authority).success);
});

Deno.test("rejects oversized text and input collections", () => {
  const oversizedText = fixture();
  oversizedText.caveats[0].statement = "x".repeat(501);
  const tooManyCaveats = fixture();
  tooManyCaveats.caveats = Array.from({ length: 101 }, (_, index) => ({
    caveatId: `caveat-${index}`,
    statement: "Synthetic caveat",
  }));
  const tooManyScenarios = fixture();
  tooManyScenarios.hypotheticalRevenueScenarios = Array.from(
    { length: 101 },
    (_, index) => ({
      ...copy(fixture().hypotheticalRevenueScenarios[0]),
      scenarioId: `scenario-${index}`,
    }),
  );
  assert(!evaluatePricingUnitEconomics(oversizedText).success);
  assert(!evaluatePricingUnitEconomics(tooManyCaveats).success);
  assert(!evaluatePricingUnitEconomics(tooManyScenarios).success);
});

Deno.test("strict schemas reject malformed and tampered contracts", () => {
  assert(
    !summarizeArgumentsSchema.safeParse({
      requestId: "request-1",
      input: fixture(),
      unexpected: true,
    }).success,
  );
  const valid = summarizePricingUnitEconomics(
    fixture(),
    new Date("2026-08-23T12:02:00Z"),
  );
  const tampered = copy(valid) as Record<string, unknown>;
  tampered.recommendation = {
    policyId: "synthetic-policy",
    status: "within_threshold",
    actionAuthority: "execute",
  };
  assert(!pricingUnitEconomicsOutputSchema.safeParse(tampered).success);
  assert(
    !pricingUnitEconomicsOutputSchema.safeParse({ ...valid, unexpected: true })
      .success,
  );
});

Deno.test("repeated requests write the same instance and content", async () => {
  const writes: Array<{ name: string; data: Record<string, unknown> }> = [];
  const context = {
    globalArgs: {},
    now: () => new Date("2026-08-23T12:02:00Z"),
    writeResource: (
      _spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ name, data });
      return Promise.resolve({ name });
    },
  };
  await model.methods.summarize.execute(
    { requestId: "idempotent-request", input: fixture() },
    context,
  );
  await model.methods.summarize.execute(
    { requestId: "idempotent-request", input: copy(fixture()) },
    context,
  );
  assert(writes.length === 2);
  assert(writes[0].name === writes[1].name);
  assert(JSON.stringify(writes[0].data) === JSON.stringify(writes[1].data));
});
