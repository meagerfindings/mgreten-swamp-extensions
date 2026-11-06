/** Schemas and deterministic compiler for domain-neutral decision context. */
import { z } from "npm:zod@4";

const Id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Time = z.iso.datetime({ offset: true });
const Text = z.string().trim().min(1).max(500);
const Recommendation = z.enum([
  "continue",
  "select",
  "pause",
  "revise",
  "collect_more_evidence",
  "none",
]);

const bindingSchema = z.strictObject({
  kind: z.enum([
    "policy",
    "operating_context",
    "decision_brief",
    "action_brief",
    "authorization_record",
  ]),
  artifactId: Id,
  version: Id,
  contentHash: Hash,
  observedAt: Time,
  expiresAt: Time,
  approved: z.boolean(),
});
const dimensionsSchema = z.strictObject({
  initiativeId: Id.nullable(),
  subjectId: Id.nullable(),
  window: z.strictObject({ startsAt: Time, endsAt: Time }),
});
const statusSchema = z.enum([
  "observed",
  "missing",
  "unavailable",
  "immature",
  "hypothetical",
  "privacy_suppressed",
]);
const outcomeSchema = z.strictObject({
  domain: z.enum(["subject", "initiative", "economics"]),
  outcome: Id,
  status: statusSchema,
  dimensions: dimensionsSchema,
  value: z.number().finite().nullable(),
  unit: Text.nullable(),
  sourceBinding: z.strictObject({
    artifactId: Id,
    version: Id,
    contentHash: Hash,
  }),
});
const evidenceSchema = z.strictObject({
  evidenceId: Id,
  sourceType: z.enum([
    "first_party_aggregate",
    "stakeholder_research",
    "public_reference",
    "expert_reference",
    "other",
  ]),
  classification: z.enum(["public", "private"]),
  rightsStatus: z.enum(["cleared", "restricted", "unknown"]),
  termsStatus: z.enum(["compliant", "restricted", "unknown"]),
  contentHash: Hash,
  observedAt: Time,
  expiresAt: Time,
  sampleSize: z.number().int().nonnegative().nullable(),
});
const claimSchema = z.strictObject({
  claimId: Id,
  statement: Text,
  evidenceIds: z.array(Id).min(1).max(10),
});

/** Accepted records for a decision-context compilation. */
export const decisionContextInputSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  packetId: Id,
  evaluatedAt: Time,
  bindings: z.array(bindingSchema).min(4).max(20),
  safeClaims: z.array(claimSchema).max(30),
  outcomes: z.array(outcomeSchema).max(50),
  evidence: z.array(evidenceSchema).max(50),
  requestedRecommendation: Recommendation,
}).superRefine((input, context) => {
  const issue = (path: PropertyKey[], message: string) =>
    context.addIssue({ code: "custom", path, message });
  const unique = (values: string[], path: PropertyKey[], message: string) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) issue([...path, index], message);
      seen.add(value);
    });
  };
  unique(
    input.safeClaims.map((item) => item.claimId),
    ["safeClaims"],
    "duplicate claimId",
  );
  unique(
    input.evidence.map((item) => item.evidenceId),
    ["evidence"],
    "duplicate evidenceId",
  );
  unique(
    input.outcomes.map((item) =>
      `${item.domain}:${item.outcome}:${item.dimensions.initiativeId}:${item.dimensions.subjectId}:${item.dimensions.window.startsAt}:${item.dimensions.window.endsAt}`
    ),
    ["outcomes"],
    "duplicate outcome identity",
  );
  input.bindings.forEach((item, index) => {
    if (Date.parse(item.observedAt) > Date.parse(input.evaluatedAt)) {
      issue(["bindings", index, "observedAt"], "binding is from the future");
    }
    if (Date.parse(item.observedAt) > Date.parse(item.expiresAt)) {
      issue(["bindings", index], "binding freshness interval is invalid");
    }
  });
  input.outcomes.forEach((item, index) => {
    if (
      Date.parse(item.dimensions.window.startsAt) >
        Date.parse(item.dimensions.window.endsAt)
    ) issue(["outcomes", index, "dimensions", "window"], "window is invalid");
    if (
      ["observed", "hypothetical"].includes(item.status) !==
        (item.value !== null)
    ) {
      issue(
        ["outcomes", index, "value"],
        "observed and hypothetical outcomes require values; missing states forbid them",
      );
    }
  });
  input.safeClaims.forEach((item, index) => {
    unique(
      item.evidenceIds,
      ["safeClaims", index, "evidenceIds"],
      "duplicate evidenceId reference",
    );
  });
  input.evidence.forEach((item, index) => {
    if (Date.parse(item.observedAt) > Date.parse(input.evaluatedAt)) {
      issue(["evidence", index, "observedAt"], "evidence is from the future");
    }
    if (Date.parse(item.observedAt) > Date.parse(item.expiresAt)) {
      issue(["evidence", index], "evidence freshness interval is invalid");
    }
  });
});
/** Input type inferred from the public schema. */
export type DecisionContextInput = z.infer<typeof decisionContextInputSchema>;

const diagnosticCode = z.enum([
  "stale_revision",
  "conflicting_revision",
  "missing_downstream_outcomes",
  "hypothetical_economics",
  "immature_evidence",
  "unresolved_rights",
  "insufficient_source_diversity",
  "unsupported_claim",
  "incompatible_initiative",
  "incompatible_subject",
  "incompatible_window",
  "insufficient_evidence_cannot_recommend",
]);
const diagnosticSchema = z.strictObject({
  code: diagnosticCode,
  path: z.string(),
  message: Text,
});
/** Persisted decision-context packet, including strictly advisory authority. */
export const decisionContextPacketSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  packetId: Id,
  evaluatedAt: Time,
  bindings: z.array(bindingSchema),
  safeClaims: z.array(claimSchema),
  outcomes: z.array(outcomeSchema),
  evidence: z.array(evidenceSchema),
  recommendation: Recommendation,
  diagnostics: z.array(diagnosticSchema),
  authority: z.strictObject({
    disposition: z.literal("recommendation_and_persistence_only"),
    providerInvocation: z.literal(false),
    network: z.literal(false),
    publish: z.literal(false),
    externalCommunication: z.literal(false),
    spend: z.literal(false),
    policyChange: z.literal(false),
    productionMutation: z.literal(false),
  }),
});

const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
    ? `{${
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b)
      ).map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
        .join(",")
    }}`
    : JSON.stringify(value);

/** Compile records into a deterministic, advisory-only decision packet. */
export function compileDecisionContext(raw: unknown) {
  const input = decisionContextInputSchema.parse(raw);
  const diagnostics: z.infer<typeof diagnosticSchema>[] = [];
  const add = (
    code: z.infer<typeof diagnosticCode>,
    path: string,
    message: string,
  ) => diagnostics.push({ code, path, message });
  const now = Date.parse(input.evaluatedAt);
  const bindings = [...input.bindings].sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.artifactId.localeCompare(b.artifactId) ||
    a.version.localeCompare(b.version) ||
    a.contentHash.localeCompare(b.contentHash) ||
    a.observedAt.localeCompare(b.observedAt) ||
    a.expiresAt.localeCompare(b.expiresAt) ||
    Number(a.approved) - Number(b.approved)
  );
  const evidence = [...input.evidence].sort((a, b) =>
    a.evidenceId.localeCompare(b.evidenceId)
  );
  const safeClaims = input.safeClaims.map((claim) => ({
    ...claim,
    evidenceIds: [...claim.evidenceIds].sort(),
  })).sort((a, b) => a.claimId.localeCompare(b.claimId));
  const outcomes = [...input.outcomes].sort((a, b) =>
    a.domain.localeCompare(b.domain) || a.outcome.localeCompare(b.outcome) ||
    canonical(a.dimensions).localeCompare(canonical(b.dimensions))
  );
  for (
    const kind of [
      "policy",
      "operating_context",
      "decision_brief",
      "action_brief",
    ] as const
  ) {
    if (
      !bindings.some((binding) => binding.kind === kind && binding.approved)
    ) add("stale_revision", "bindings", `missing approved ${kind} binding`);
  }
  bindings.forEach((binding, index) => {
    if (Date.parse(binding.expiresAt) <= now) {
      add(
        "stale_revision",
        `bindings.${index}`,
        `${binding.kind} binding is stale`,
      );
    }
    const peers = bindings.filter((candidate) =>
      candidate.kind === binding.kind &&
      candidate.artifactId === binding.artifactId
    );
    if (
      new Set(
        peers.map((candidate) =>
          `${candidate.version}:${candidate.contentHash}`
        ),
      ).size > 1
    ) {
      add(
        "conflicting_revision",
        "bindings",
        `conflicting retained revisions for ${binding.kind}:${binding.artifactId}`,
      );
    }
  });
  const initiative = outcomes.filter((outcome) =>
    outcome.domain === "initiative"
  );
  const downstream = ["activation", "retention", "completion", "adoption"];
  if (
    downstream.some((name) =>
      !initiative.some((outcome) =>
        outcome.outcome === name && outcome.status === "observed"
      )
    )
  ) {
    add(
      "missing_downstream_outcomes",
      "outcomes",
      "observed activation, retention, completion, and adoption outcomes are required before a select/continue recommendation",
    );
  }
  if (
    outcomes.some((outcome) =>
      outcome.domain === "economics" && outcome.status === "hypothetical"
    )
  ) {
    add(
      "hypothetical_economics",
      "outcomes",
      "economics include hypothetical values",
    );
  }
  if (outcomes.some((outcome) => outcome.status === "immature")) {
    add(
      "immature_evidence",
      "outcomes",
      "one or more aggregate outcomes are not mature enough for a decision",
    );
  }
  evidence.forEach((item, index) => {
    if (
      Date.parse(item.expiresAt) <= now || item.sampleSize === null ||
      item.sampleSize < 5
    ) {
      add(
        "immature_evidence",
        `evidence.${index}`,
        `${item.evidenceId} is stale or has an immature sample`,
      );
    }
    if (item.rightsStatus !== "cleared" || item.termsStatus !== "compliant") {
      add(
        "unresolved_rights",
        `evidence.${index}`,
        `${item.evidenceId} has unresolved rights or terms`,
      );
    }
  });
  if (new Set(evidence.map((item) => item.sourceType)).size < 2) {
    add(
      "insufficient_source_diversity",
      "evidence",
      "at least two source types are required",
    );
  }
  const byId = new Map(evidence.map((item) => [item.evidenceId, item]));
  safeClaims.forEach((claim, index) => {
    if (
      claim.evidenceIds.some((id) =>
        !byId.has(id) || byId.get(id)!.rightsStatus !== "cleared" ||
        byId.get(id)!.termsStatus !== "compliant" ||
        Date.parse(byId.get(id)!.expiresAt) <= now
      )
    ) {
      add(
        "unsupported_claim",
        `safeClaims.${index}`,
        `${claim.claimId} is not supported by cleared retained evidence`,
      );
    }
  });
  const observed = initiative.filter((outcome) =>
    outcome.status === "observed"
  );
  for (
    const [field, code] of [["initiativeId", "incompatible_initiative"], [
      "subjectId",
      "incompatible_subject",
    ]] as const
  ) {
    if (
      new Set(observed.map((outcome) => outcome.dimensions[field])).size > 1
    ) add(code, "outcomes", `initiative outcomes have incompatible ${field}`);
  }
  if (
    new Set(observed.map((outcome) => canonical(outcome.dimensions.window)))
      .size > 1
  ) {
    add(
      "incompatible_window",
      "outcomes",
      "initiative outcomes have incompatible windows",
    );
  }
  if (
    ["continue", "select"].includes(input.requestedRecommendation) &&
    !initiative.some((outcome) =>
      downstream.includes(outcome.outcome) && outcome.status === "observed"
    )
  ) {
    add(
      "insufficient_evidence_cannot_recommend",
      "requestedRecommendation",
      "an early outcome alone cannot recommend continue or select",
    );
  }
  const recommendation = input.requestedRecommendation === "pause" ||
      input.requestedRecommendation === "revise"
    ? input.requestedRecommendation
    : ["continue", "select"].includes(input.requestedRecommendation) &&
        diagnostics.length === 0
    ? input.requestedRecommendation
    : input.requestedRecommendation === "none" && diagnostics.length === 0
    ? "none"
    : "collect_more_evidence";
  return decisionContextPacketSchema.parse({
    schemaVersion: "1.0",
    packetId: input.packetId,
    evaluatedAt: input.evaluatedAt,
    bindings,
    safeClaims,
    outcomes,
    evidence,
    recommendation,
    diagnostics: diagnostics.sort((a, b) =>
      a.code.localeCompare(b.code) || a.path.localeCompare(b.path) ||
      a.message.localeCompare(b.message)
    ),
    authority: {
      disposition: "recommendation_and_persistence_only",
      providerInvocation: false,
      network: false,
      publish: false,
      externalCommunication: false,
      spend: false,
      policyChange: false,
      productionMutation: false,
    },
  });
}
