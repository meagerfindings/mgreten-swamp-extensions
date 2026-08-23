import { z } from "npm:zod@4";

export const BOUNDED_EXPERIMENT_LIMITS = {
  evidencePerKind: 20,
  claims: 30,
  guardrails: 20,
  stopConditions: 20,
  population: 100_000,
  durationDays: 90,
  text: 1_000,
} as const;

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Text = z.string().trim().min(1).max(BOUNDED_EXPERIMENT_LIMITS.text);
const Timestamp = z.iso.datetime({ offset: true });
const Measure = z.strictObject({
  value: z.number().finite(),
  unit: Text,
  denominator: Text,
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
});
const Money = z.strictObject({
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  unit: z.literal("currency_minor"),
  denominator: Text,
});
const Provenance = z.strictObject({
  artifactId: Id,
  artifactVersion: Id,
  contentHash: Hash,
  producer: Text,
  sourceSystem: Text,
  sourceUri: z.string().url().max(2_000),
  observedAt: Timestamp,
  generatedAt: Timestamp,
  expiresAt: Timestamp,
});
const Evidence = z.strictObject({
  evidenceId: Id,
  evidenceKind: z.enum(["product_metric", "unit_economics"]),
  provenance: Provenance,
  metricName: Text,
  observedValue: Measure,
  populationDenominator: Text,
  caveat: Text,
});
const Criterion = z.strictObject({
  criterionId: Id,
  metricName: Text,
  comparator: z.enum(["lt", "lte", "gt", "gte", "eq"]),
  threshold: Measure,
  minimumSampleSize: z.number().int().positive().max(
    BOUNDED_EXPERIMENT_LIMITS.population,
  ),
});
const Approval = z.strictObject({
  approvalKind: z.enum(["pricing", "spend", "publishing", "launch"]),
  applicable: z.boolean(),
  required: z.boolean(),
  status: z.literal("not_requested"),
  approverRole: Text,
});

export const boundedExperimentInputSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  proposalId: Id,
  evaluatedAt: Timestamp,
  experimentKind: z.enum(["pricing", "positioning"]),
  title: Text,
  hypothesis: Text,
  evidence: z.array(Evidence).min(2).max(
    BOUNDED_EXPERIMENT_LIMITS.evidencePerKind * 2,
  ),
  observedClaims: z.array(
    z.strictObject({
      claimId: Id,
      statement: Text,
      evidenceIds: z.array(Id).min(1).max(10),
    }),
  ).min(1).max(BOUNDED_EXPERIMENT_LIMITS.claims),
  hypotheticalClaims: z.array(
    z.strictObject({ claimId: Id, statement: Text, assumption: Text }),
  ).min(1).max(BOUNDED_EXPERIMENT_LIMITS.claims),
  policy: z.strictObject({
    policyId: Id,
    policyVersion: Id,
    policyHash: Hash,
    maximumPopulation: z.number().int().positive().max(
      BOUNDED_EXPERIMENT_LIMITS.population,
    ),
    maximumDurationDays: z.number().int().positive().max(
      BOUNDED_EXPERIMENT_LIMITS.durationDays,
    ),
    maximumSpend: Money,
    maximumRevenueDownside: Money,
    maximumUserDownsideCount: z.number().int().nonnegative().max(
      BOUNDED_EXPERIMENT_LIMITS.population,
    ),
  }),
  bounds: z.strictObject({
    population: z.number().int().positive().max(
      BOUNDED_EXPERIMENT_LIMITS.population,
    ),
    durationDays: z.number().int().positive().max(
      BOUNDED_EXPERIMENT_LIMITS.durationDays,
    ),
    maxSpend: Money,
    maxRevenueDownside: Money,
    maxUserDownsideCount: z.number().int().nonnegative().max(
      BOUNDED_EXPERIMENT_LIMITS.population,
    ),
  }),
  guardrails: z.array(
    z.strictObject({
      guardrailId: Id,
      metric: Text,
      limit: Measure,
      response: z.literal("stop_and_review"),
    }),
  ).min(1).max(BOUNDED_EXPERIMENT_LIMITS.guardrails),
  stopConditions: z.array(
    z.strictObject({
      conditionId: Id,
      signal: Text,
      comparator: z.enum(["lt", "lte", "gt", "gte", "eq"]),
      threshold: Measure,
      action: z.literal("stop_and_review"),
    }),
  ).min(1).max(BOUNDED_EXPERIMENT_LIMITS.stopConditions),
  decisions: z.strictObject({
    success: z.strictObject({
      decision: z.literal("recommend_consider_expansion"),
      criteria: z.array(Criterion).min(1).max(20),
    }),
    failure: z.strictObject({
      decision: z.literal("recommend_stop"),
      criteria: z.array(Criterion).min(1).max(20),
    }),
    ambiguity: z.strictObject({
      decision: z.literal("recommend_no_change_and_review"),
      rule: Text,
    }),
  }),
  publishingInvolved: z.boolean(),
  approvals: z.array(Approval).length(4),
  sourceDataGap: z.string().max(1_000).nullable(),
});
export const boundedExperimentOutputSchema = boundedExperimentInputSchema
  .extend({
    authority: z.strictObject({
      mode: z.literal("recommendation_only"),
      sideEffects: z.literal("persistence_only"),
      prohibitedEffects: z.tuple([
        z.literal("price_change"),
        z.literal("spend"),
        z.literal("publish"),
        z.literal("user_assignment"),
        z.literal("provider_or_network_call"),
        z.literal("production_change"),
        z.literal("launch"),
      ]),
    }),
  });
export type BoundedExperimentProposal = z.infer<
  typeof boundedExperimentOutputSchema
>;
export type Diagnostic = { path: string; code: string; message: string };
export type Evaluation = {
  success: true;
  value: BoundedExperimentProposal;
  diagnostics: [];
} | { success: false; diagnostics: Diagnostic[] };

const sameMoney = (a: z.infer<typeof Money>, b: z.infer<typeof Money>) =>
  a.currency === b.currency && a.unit === b.unit &&
  a.denominator === b.denominator;
const diagnostic = (
  path: string,
  code: string,
  message: string,
): Diagnostic => ({ path, code, message });

/** Returns sorted diagnostics so equivalent inputs always have equivalent results. */
export function evaluateBoundedExperiment(input: unknown): Evaluation {
  const parsed = boundedExperimentInputSchema.safeParse(input);
  const diagnostics: Diagnostic[] = parsed.success
    ? []
    : parsed.error.issues.map((issue) =>
      diagnostic(issue.path.map(String).join("."), issue.code, issue.message)
    );
  if (parsed.success) {
    const value = parsed.data;
    for (const kind of ["product_metric", "unit_economics"] as const) {
      if (!value.evidence.some((item) => item.evidenceKind === kind)) {
        diagnostics.push(
          diagnostic(
            "evidence",
            "missing_evidence_kind",
            `${kind} evidence is required`,
          ),
        );
      }
    }
    const evidenceIds = new Set(value.evidence.map((item) => item.evidenceId));
    if (evidenceIds.size !== value.evidence.length) {
      diagnostics.push(
        diagnostic(
          "evidence",
          "duplicate_id",
          "evidenceId values must be unique",
        ),
      );
    }
    value.evidence.forEach((item, index) => {
      const provenance = item.provenance;
      const base = `evidence.${index}.provenance`;
      if (
        Date.parse(provenance.observedAt) > Date.parse(provenance.generatedAt)
      ) {
        diagnostics.push(
          diagnostic(
            base,
            "invalid_time_order",
            "observedAt must not follow generatedAt",
          ),
        );
      }
      if (Date.parse(provenance.generatedAt) > Date.parse(value.evaluatedAt)) {
        diagnostics.push(
          diagnostic(
            base,
            "future_evidence",
            "generatedAt must not follow evaluatedAt",
          ),
        );
      }
      if (Date.parse(provenance.expiresAt) <= Date.parse(value.evaluatedAt)) {
        diagnostics.push(
          diagnostic(
            base,
            "stale_evidence",
            "evidence must be fresh at evaluatedAt",
          ),
        );
      }
    });
    value.observedClaims.forEach((claim, index) =>
      claim.evidenceIds.forEach((id) => {
        if (!evidenceIds.has(id)) {
          diagnostics.push(
            diagnostic(
              `observedClaims.${index}.evidenceIds`,
              "unknown_evidence",
              `unknown evidenceId: ${id}`,
            ),
          );
        }
      })
    );
    for (
      const [name, ids] of [[
        "observedClaims",
        value.observedClaims.map((item) => item.claimId),
      ], [
        "hypotheticalClaims",
        value.hypotheticalClaims.map((item) => item.claimId),
      ], [
        "guardrails",
        value.guardrails.map((item) => item.guardrailId),
      ], [
        "stopConditions",
        value.stopConditions.map((item) => item.conditionId),
      ]] as const
    ) {
      if (new Set(ids).size !== ids.length) {
        diagnostics.push(
          diagnostic(name, "duplicate_id", `${name} identities must be unique`),
        );
      }
    }
    const policy = value.policy, bounds = value.bounds;
    if (bounds.population > policy.maximumPopulation) {
      diagnostics.push(
        diagnostic(
          "bounds.population",
          "policy_exceeded",
          "population exceeds caller policy",
        ),
      );
    }
    if (bounds.durationDays > policy.maximumDurationDays) {
      diagnostics.push(
        diagnostic(
          "bounds.durationDays",
          "policy_exceeded",
          "duration exceeds caller policy",
        ),
      );
    }
    for (
      const [name, actual, maximum] of [[
        "maxSpend",
        bounds.maxSpend,
        policy.maximumSpend,
      ], [
        "maxRevenueDownside",
        bounds.maxRevenueDownside,
        policy.maximumRevenueDownside,
      ]] as const
    ) {
      if (!sameMoney(actual, maximum)) {
        diagnostics.push(
          diagnostic(
            `bounds.${name}`,
            "unit_mismatch",
            "currency, unit, and denominator must match policy",
          ),
        );
      } else if (actual.amountMinor > maximum.amountMinor) {
        diagnostics.push(
          diagnostic(
            `bounds.${name}`,
            "policy_exceeded",
            `${name} exceeds caller policy`,
          ),
        );
      }
    }
    if (
      bounds.maxUserDownsideCount > policy.maximumUserDownsideCount ||
      bounds.maxUserDownsideCount > bounds.population
    ) {
      diagnostics.push(
        diagnostic(
          "bounds.maxUserDownsideCount",
          "policy_exceeded",
          "user downside exceeds policy or population",
        ),
      );
    }
    const expected = {
      pricing: value.experimentKind === "pricing",
      spend: bounds.maxSpend.amountMinor > 0,
      publishing: value.publishingInvolved,
      launch: true,
    };
    for (const kind of ["pricing", "spend", "publishing", "launch"] as const) {
      const approvals = value.approvals.filter((approval) =>
        approval.approvalKind === kind
      );
      if (approvals.length !== 1) {
        diagnostics.push(
          diagnostic(
            "approvals",
            "approval_cardinality",
            `exactly one ${kind} approval is required`,
          ),
        );
      } else if (
        approvals[0].applicable !== expected[kind] ||
        approvals[0].required !== expected[kind]
      ) {
        diagnostics.push(
          diagnostic(
            `approvals.${value.approvals.indexOf(approvals[0])}`,
            "approval_mismatch",
            `${kind} applicable and required must equal ${expected[kind]}`,
          ),
        );
      }
    }
  }
  diagnostics.sort((a, b) =>
    a.path.localeCompare(b.path) || a.code.localeCompare(b.code) ||
    a.message.localeCompare(b.message)
  );
  if (!parsed.success || diagnostics.length) {
    return { success: false, diagnostics };
  }
  const value = parsed.data;
  const sorted = <T extends object, K extends keyof T>(
    items: T[],
    key: K,
  ) => [...items].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
  return {
    success: true,
    diagnostics: [],
    value: boundedExperimentOutputSchema.parse({
      ...value,
      evidence: sorted(value.evidence, "evidenceId"),
      observedClaims: sorted(value.observedClaims, "claimId"),
      hypotheticalClaims: sorted(value.hypotheticalClaims, "claimId"),
      guardrails: sorted(value.guardrails, "guardrailId"),
      stopConditions: sorted(value.stopConditions, "conditionId"),
      approvals: sorted(value.approvals, "approvalKind"),
      authority: {
        mode: "recommendation_only",
        sideEffects: "persistence_only",
        prohibitedEffects: [
          "price_change",
          "spend",
          "publish",
          "user_assignment",
          "provider_or_network_call",
          "production_change",
          "launch",
        ],
      },
    }),
  };
}
