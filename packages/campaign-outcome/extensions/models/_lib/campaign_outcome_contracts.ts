import { z } from "npm:zod@4";

/** Current version of the aggregate evidence schema. */
export const CAMPAIGN_OUTCOME_SCHEMA_VERSION = "1.0" as const;
/** Canonical order and complete set of campaign funnel stages. */
export const CAMPAIGN_OUTCOME_STAGES = [
  "acquisition",
  "activation",
  "retention",
  "checkout",
  "paid",
] as const;

const text = z.string().trim().min(1).max(500);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const timestamp = z.iso.datetime({ offset: true });
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const nonnegative = z.number().finite().nonnegative();

const artifact = z.strictObject({ id, version: text, sha256: hash });
const source = z.strictObject({
  sourceId: id,
  system: text,
  resourceType: text,
  resourceId: id,
  resourceVersion: text,
  contentHash: hash,
  provenance: z.strictObject({
    collector: text,
    method: text,
    collectedAt: timestamp,
  }),
  freshness: z.strictObject({ asOf: timestamp, expiresAt: timestamp }),
});
const denominator = z.strictObject({
  name: text,
  count: nonnegative,
  unit: text,
});
const window = z.strictObject({ startsAt: timestamp, endsAt: timestamp });
const references = {
  evidenceIds: z.array(id).min(1).max(20),
  uncertaintyIds: z.array(id).max(10),
};
const observed = z.strictObject({
  status: z.literal("observed"),
  value: nonnegative,
  denominator,
  window,
  source,
  ...references,
});
const unavailable = z.strictObject({
  status: z.literal("unavailable"),
  reason: text,
  denominator,
  window,
  source,
  ...references,
});
const hypothetical = z.strictObject({
  status: z.literal("hypothetical"),
  value: nonnegative,
  assumption: text,
  denominator,
  window,
  source,
  ...references,
});
const measurement = z.discriminatedUnion("status", [
  observed,
  unavailable,
  hypothetical,
]);
const spendFields = {
  currency: z.string().regex(/^[A-Z]{3}$/),
  unit: z.enum(["currency_minor", "currency_major"]),
  spendDenominator: text,
};
const spend = z.discriminatedUnion("status", [
  observed.extend(spendFields),
  unavailable.extend(spendFields),
  hypothetical.extend(spendFields),
]);

/** Strict schema for aggregate-only campaign outcome evidence. */
export const campaignOutcomeEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(CAMPAIGN_OUTCOME_SCHEMA_VERSION),
  outcomeId: id,
  evaluatedAt: timestamp,
  campaign: artifact,
  creative: artifact,
  message: artifact,
  landing: artifact.extend({ path: z.string().regex(/^\/[A-Za-z0-9/_\-.]*$/) }),
  spend,
  outcomes: z.array(z.strictObject({
    stage: z.enum(CAMPAIGN_OUTCOME_STAGES),
    metric: text,
    measurement,
  })).length(CAMPAIGN_OUTCOME_STAGES.length),
  evidence: z.array(z.strictObject({
    evidenceId: id,
    claim: text,
    source,
  })).min(1).max(50),
  uncertainties: z.array(z.strictObject({
    uncertaintyId: id,
    statement: text,
    impact: z.enum(["low", "medium", "high", "unknown"]),
  })).max(20),
  recommendation: z.strictObject({
    type: z.enum([
      "continue",
      "pause",
      "revise_message",
      "revise_landing",
      "reallocate",
      "collect_more_evidence",
      "no_action",
    ]),
    rationale: text,
    evidenceIds: z.array(id).min(1).max(20),
    uncertaintyIds: z.array(id).max(10),
    authority: z.literal("human_decision_required"),
    actionTaken: z.literal(false),
  }),
  privacy: z.strictObject({
    aggregation: z.literal("aggregate_only"),
    containsUserLevelData: z.literal(false),
    containsUserStories: z.literal(false),
  }),
}).superRefine((record, context) => {
  const issue = (path: PropertyKey[], message: string) =>
    context.addIssue({ code: "custom", path, message });
  const evidenceIds = new Set(record.evidence.map((item) => item.evidenceId));
  const uncertaintyIds = new Set(
    record.uncertainties.map((item) => item.uncertaintyId),
  );
  const unique = (values: string[], path: string) => {
    values.forEach((value, index) => {
      if (values.indexOf(value) !== index) {
        issue([path, index], `duplicate id: ${value}`);
      }
    });
  };
  unique(record.evidence.map((item) => item.evidenceId), "evidence");
  unique(
    record.uncertainties.map((item) => item.uncertaintyId),
    "uncertainties",
  );
  const checkSource = (value: z.infer<typeof source>, path: PropertyKey[]) => {
    if (
      Date.parse(value.provenance.collectedAt) >
        Date.parse(value.freshness.asOf) ||
      Date.parse(value.freshness.asOf) > Date.parse(record.evaluatedAt) ||
      Date.parse(value.freshness.expiresAt) <= Date.parse(record.evaluatedAt)
    ) {
      issue(
        path,
        "source chronology must be collectedAt <= asOf <= evaluatedAt < expiresAt",
      );
    }
  };
  const checkMeasurement = (
    value: z.infer<typeof measurement>,
    path: PropertyKey[],
  ) => {
    if (Date.parse(value.window.startsAt) >= Date.parse(value.window.endsAt)) {
      issue([...path, "window"], "window startsAt must precede endsAt");
    }
    if (Date.parse(value.window.endsAt) > Date.parse(record.evaluatedAt)) {
      issue(
        [...path, "window", "endsAt"],
        "measurement window cannot end after evaluatedAt",
      );
    }
    checkSource(value.source, [...path, "source"]);
    unique(value.evidenceIds, `${path.join(".")}.evidenceIds`);
    unique(value.uncertaintyIds, `${path.join(".")}.uncertaintyIds`);
    value.evidenceIds.forEach((valueId, index) => {
      if (!evidenceIds.has(valueId)) {
        issue([...path, "evidenceIds", index], "unknown evidenceId");
      }
    });
    value.uncertaintyIds.forEach((valueId, index) => {
      if (!uncertaintyIds.has(valueId)) {
        issue([...path, "uncertaintyIds", index], "unknown uncertaintyId");
      }
    });
  };
  checkMeasurement(record.spend, ["spend"]);
  record.outcomes.forEach((item, index) =>
    checkMeasurement(item.measurement, ["outcomes", index, "measurement"])
  );
  record.evidence.forEach((item, index) =>
    checkSource(item.source, ["evidence", index, "source"])
  );
  const stages = record.outcomes.map((item) => item.stage);
  if (
    new Set(stages).size !== CAMPAIGN_OUTCOME_STAGES.length ||
    CAMPAIGN_OUTCOME_STAGES.some((stage) => !stages.includes(stage))
  ) {
    issue(
      ["outcomes"],
      "outcomes must contain each downstream stage exactly once",
    );
  }
  record.recommendation.evidenceIds.forEach((value, index) => {
    if (!evidenceIds.has(value)) {
      issue(["recommendation", "evidenceIds", index], "unknown evidenceId");
    }
  });
  record.recommendation.uncertaintyIds.forEach((value, index) => {
    if (!uncertaintyIds.has(value)) {
      issue(
        ["recommendation", "uncertaintyIds", index],
        "unknown uncertaintyId",
      );
    }
  });
}).transform((record) => ({
  ...record,
  spend: {
    ...record.spend,
    evidenceIds: [...record.spend.evidenceIds].sort(),
    uncertaintyIds: [...record.spend.uncertaintyIds].sort(),
  },
  outcomes: [...record.outcomes].map((item) => ({
    ...item,
    measurement: {
      ...item.measurement,
      evidenceIds: [...item.measurement.evidenceIds].sort(),
      uncertaintyIds: [...item.measurement.uncertaintyIds].sort(),
    },
  })).sort((a, b) =>
    CAMPAIGN_OUTCOME_STAGES.indexOf(a.stage) -
    CAMPAIGN_OUTCOME_STAGES.indexOf(b.stage)
  ),
  evidence: [...record.evidence].sort((a, b) =>
    a.evidenceId.localeCompare(b.evidenceId)
  ),
  uncertainties: [...record.uncertainties].sort((a, b) =>
    a.uncertaintyId.localeCompare(b.uncertaintyId)
  ),
  recommendation: {
    ...record.recommendation,
    evidenceIds: [...record.recommendation.evidenceIds].sort(),
    uncertaintyIds: [...record.recommendation.uncertaintyIds].sort(),
  },
}));

/** Canonical output type produced after successful evidence validation. */
export type CampaignOutcomeEvidence = z.output<
  typeof campaignOutcomeEvidenceSchema
>;
/** Validate input and return canonical evidence or sorted diagnostics. */
export function evaluateCampaignOutcomeEvidence(input: unknown) {
  const result = campaignOutcomeEvidenceSchema.safeParse(input);
  if (result.success) {
    return { success: true as const, value: result.data, diagnostics: [] };
  }
  const diagnostics = result.error.issues.map((item) => ({
    path: item.path.map(String).join("."),
    code: item.code,
    message: item.message,
  })).sort((a, b) =>
    a.path.localeCompare(b.path) || a.code.localeCompare(b.code) ||
    a.message.localeCompare(b.message)
  );
  return { success: false as const, diagnostics };
}
