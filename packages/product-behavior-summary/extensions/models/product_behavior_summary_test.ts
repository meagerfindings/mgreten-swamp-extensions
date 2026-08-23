import { model, summarizeProductBehavior } from "./product_behavior_summary.ts";

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}
async function rejects(
  fn: () => unknown | Promise<unknown>,
  text: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (String(error).includes(text)) return;
    throw error;
  }
  throw new Error(`expected rejection: ${text}`);
}

const outcomes = ["signup", "engaged", "subscribed"] as const;
const metric = (outcome: typeof outcomes[number], index: number) => ({
  status: "measured" as const,
  outcome,
  numeratorDefinition: `${outcome} completions`,
  denominatorDefinition: `${outcome} eligible cohort`,
  numerator: 20 + index,
  denominator: 100,
  window: { startsAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-08T00:00:00Z" },
  segment: {
    name: "synthetic-control",
    dimensions: { experiment: "synthetic" },
  },
  source: {
    sourceId: `upstream-${outcome}`,
    aggregateLevel: "cohort" as const,
    containsUserLevelData: false as const,
    method: "synthetic aggregate",
  },
  freshness: {
    asOf: "2026-08-08T01:00:00Z",
    expiresAt: "2026-08-18T00:00:00Z",
  },
  privacy: { minimumCohortSize: 25 },
  claim: {
    kind: "descriptive_association" as const,
    causalClaim: "none" as const,
  },
});
const summary = () => ({
  schemaVersion: "1.0" as const,
  summaryId: "synthetic-week-32",
  generatedAt: "2026-08-17T12:00:00Z",
  inputPolicy: {
    aggregateOnly: true as const,
    userLevelIdentifiersAllowed: false as const,
  },
  sideEffectAuthority: "none" as const,
  metrics: outcomes.map(metric),
});

Deno.test("generic catalog persists deterministic rates", async () => {
  const writes: Array<{ spec: string; name: string; data: unknown }> = [];
  const context = {
    globalArgs: { expectedOutcomes: [...outcomes] },
    logger: { info: () => undefined },
    now: () => new Date("2026-08-17T12:00:00Z"),
    writeResource: (spec: string, name: string, data: unknown) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  };
  const result = await model.methods.summarize.execute(
    { input: summary() },
    context,
  );
  equal(result, { dataHandles: [{ name: "current" }] });
  equal([writes[0].spec, writes[0].name], ["summary", "current"]);
  equal(
    (writes[0].data as { metrics: Array<{ result: unknown }> }).metrics.map((
      item,
    ) => item.result),
    [
      { status: "calculated", rate: 0.2 },
      { status: "calculated", rate: 0.21 },
      { status: "calculated", rate: 0.22 },
    ],
  );
});

Deno.test("catalog order makes equivalent input deterministic", () => {
  const input = summary();
  input.metrics.reverse();
  const output = summarizeProductBehavior(
    input,
    outcomes,
    new Date("2026-08-17T12:00:00Z"),
  );
  equal(output.metrics.map((item) => item.outcome), outcomes);
});

Deno.test("missing and privacy-suppressed metrics retain null rates", () => {
  const input = summary();
  input.metrics[1] = {
    ...metric("engaged", 1),
    status: "missing",
    numerator: null,
    denominator: null,
    reason: "upstream unavailable",
  } as never;
  input.metrics[2] = {
    ...metric("subscribed", 2),
    status: "privacy_suppressed",
    numerator: null,
    denominator: null,
    reason: "cohort below disclosure threshold",
  } as never;
  const output = summarizeProductBehavior(
    input,
    outcomes,
    new Date("2026-08-17T12:00:00Z"),
  );
  equal(output.metrics[1].result, { status: "missing", rate: null });
  equal(output.metrics[2].result, { status: "privacy_suppressed", rate: null });
});

Deno.test("accepts allowlisted aggregate segment dimensions", () => {
  const input = summary();
  input.metrics[0].segment.dimensions = {
    channel: "referral",
    country: "US",
    deviceType: "mobile",
    experiment: "synthetic",
    variant: "control",
  } as typeof input.metrics[0]["segment"]["dimensions"];
  const output = summarizeProductBehavior(
    input,
    outcomes,
    new Date("2026-08-17T12:00:00Z"),
  );
  equal(
    output.metrics[0].segment.dimensions,
    input.metrics[0].segment.dimensions,
  );
});

Deno.test("rejects ID-like aliases as segment dimension keys", async () => {
  for (const key of ["memberId", "profileUuid"]) {
    const input = summary();
    input.metrics[0].segment.dimensions = {
      [key]: "user-123",
    } as typeof input.metrics[0]["segment"]["dimensions"];
    await rejects(
      () =>
        summarizeProductBehavior(
          input,
          outcomes,
          new Date("2026-08-17T12:00:00Z"),
        ),
      "allowed aggregate facet",
    );
  }
});

Deno.test("identifiers, catalog mismatches, low cohorts, stale inputs, and causal claims fail closed", async () => {
  const cases: Array<[unknown, string]> = [
    [{ ...summary(), userId: "user-123" }, "identifier"],
    [
      { ...summary(), metrics: summary().metrics.slice(0, 2) },
      "exactly one subscribed",
    ],
    [{
      ...summary(),
      metrics: summary().metrics.map((item, index) =>
        index === 0 ? { ...item, denominator: 10 } : item
      ),
    }, "minimumCohortSize"],
    [{
      ...summary(),
      metrics: summary().metrics.map((item, index) =>
        index === 0
          ? {
            ...item,
            freshness: { ...item.freshness, expiresAt: "2026-08-17T12:00:00Z" },
          }
          : item
      ),
    }, "Stale"],
    [{
      ...summary(),
      metrics: summary().metrics.map((item, index) =>
        index === 0
          ? {
            ...item,
            claim: { kind: "causal", causalClaim: "experiment caused signup" },
          }
          : item
      ),
    }, "claim"],
  ];
  for (const [input, message] of cases) {
    await rejects(() =>
      summarizeProductBehavior(
        input,
        outcomes,
        new Date("2026-08-17T12:00:00Z"),
      ), message);
  }
});

Deno.test("future provenance and cyclic malformed inputs fail closed", async () => {
  const future = summary();
  future.generatedAt = "2026-08-17T12:00:01Z";
  await rejects(
    () =>
      summarizeProductBehavior(
        future,
        outcomes,
        new Date("2026-08-17T12:00:00Z"),
      ),
    "generatedAt cannot be in the future",
  );

  const cyclic: Record<string, unknown> = { ...summary() };
  cyclic.self = cyclic;
  await rejects(
    () =>
      summarizeProductBehavior(
        cyclic,
        outcomes,
        new Date("2026-08-17T12:00:00Z"),
      ),
    "Invalid product behavior summary",
  );
});

Deno.test("retries are idempotent and invalid input never writes", async () => {
  const writes: unknown[] = [];
  const context = {
    globalArgs: { expectedOutcomes: [...outcomes] },
    logger: { info: () => undefined },
    now: () => new Date("2026-08-17T12:00:00Z"),
    writeResource: (_spec: string, name: string, data: unknown) => {
      writes.push(data);
      return Promise.resolve({ name });
    },
  };
  await model.methods.summarize.execute({ input: summary() }, context);
  await model.methods.summarize.execute({ input: summary() }, context);
  equal(writes[0], writes[1]);

  const tampered = { ...summary(), sideEffectAuthority: "write" };
  await rejects(
    () => model.methods.summarize.execute({ input: tampered }, context),
    "Invalid product behavior summary",
  );
  equal(writes.length, 2);
});

Deno.test("catalogs, metrics, dimensions, and free text are practically bounded", async () => {
  await rejects(
    () =>
      summarizeProductBehavior(
        summary(),
        Array.from({ length: 101 }, (_, i) => `outcome-${i}`),
        new Date("2026-08-17T12:00:00Z"),
      ),
    "Too big",
  );
  const tooManyDimensions = summary();
  tooManyDimensions.metrics[0].segment.dimensions = Object.fromEntries(
    Array.from({ length: 13 }, (_, i) => [`facet${i}`, "value"]),
  ) as never;
  await rejects(
    () =>
      summarizeProductBehavior(
        tooManyDimensions,
        outcomes,
        new Date("2026-08-17T12:00:00Z"),
      ),
    "Invalid key",
  );
  const longText = summary();
  longText.metrics[0].numeratorDefinition = "x".repeat(501);
  await rejects(
    () =>
      summarizeProductBehavior(
        longText,
        outcomes,
        new Date("2026-08-17T12:00:00Z"),
      ),
    "Too big",
  );
});
