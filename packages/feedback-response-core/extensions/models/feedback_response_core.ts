import { z } from "npm:zod@4";

/** Version of the feedback response input and output schemas. */
export const FEEDBACK_RESPONSE_SCHEMA_VERSION = "1.0" as const;
/** Version of the standalone feedback-response-core model. */
export const FEEDBACK_RESPONSE_CORE_VERSION = "2026.08.23.1" as const;

const Id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const Timestamp = z.iso.datetime({ offset: true });
const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const SafeText = z.string().trim().min(1).max(500);
const RedactionLimitation =
  "pattern-based redaction does not guarantee detection of all private information";

const categorySchema = z.enum(["bug", "confusion", "feature_request", "other"]);
const redactedArtifactSchema = z.strictObject({
  schemaVersion: z.literal(FEEDBACK_RESPONSE_SCHEMA_VERSION),
  feedbackId: Id,
  sourceId: Id,
  normalizedText: z.string().trim().min(1).max(10_000),
  labels: z.array(z.string().trim().min(1).max(200)),
  provenance: z.strictObject({
    inputEnvelopeId: Id,
    sourceId: Id,
    normalizedAt: Timestamp,
    normalizer: Id,
    normalizerVersion: Id,
  }),
  redaction: z.strictObject({
    method: z.literal("deterministic-redaction"),
    methodVersion: Id,
    performedAt: Timestamp,
    inputEnvelopeId: Id,
    categoriesRemoved: z.array(z.enum([
      "email",
      "phone",
      "address",
      "account_identifier",
      "credential",
      "freeform_private_content",
    ])),
    replacementCount: z.number().int().nonnegative(),
    reviewStatus: z.enum(["not_reviewed", "synthetic_fixture_reviewed"]),
    limitations: z.literal(RedactionLimitation),
  }),
}).superRefine((artifact, context) => {
  if (artifact.sourceId !== artifact.provenance.sourceId) {
    context.addIssue({
      code: "custom",
      path: ["provenance", "sourceId"],
      message: "provenance sourceId must match sourceId",
    });
  }
  if (
    artifact.provenance.inputEnvelopeId !== artifact.redaction.inputEnvelopeId
  ) {
    context.addIssue({
      code: "custom",
      path: ["redaction", "inputEnvelopeId"],
      message:
        "redaction and provenance must reference the same input envelope",
    });
  }
  if (
    Date.parse(artifact.redaction.performedAt) >
      Date.parse(artifact.provenance.normalizedAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["redaction", "performedAt"],
      message: "redaction must be performed by normalizedAt",
    });
  }
  if (
    artifact.redaction.replacementCount === 0 &&
    artifact.redaction.categoriesRemoved.length !== 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["redaction", "categoriesRemoved"],
      message: "categoriesRemoved must be empty when replacementCount is zero",
    });
  }
  if (
    artifact.redaction.replacementCount > 0 &&
    artifact.redaction.categoriesRemoved.length === 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["redaction", "categoriesRemoved"],
      message: "redaction categories are required when replacements were made",
    });
  }
});

const decisionSchema = z.discriminatedUnion("availability", [
  z.strictObject({
    availability: z.literal("unknown"),
    decisionId: z.literal(null),
    version: z.literal(null),
    sha256: z.literal(null),
    customerSafeStatement: z.literal(null),
  }),
  z.strictObject({
    availability: z.literal("known"),
    decisionId: Id,
    version: Id,
    sha256: Hash,
    customerSafeStatement: SafeText,
  }),
]);

/** Strict contract for one redacted artifact and its assessment inputs. */
export const feedbackResponseInputSchema = z.strictObject({
  schemaVersion: z.literal(FEEDBACK_RESPONSE_SCHEMA_VERSION),
  responseId: Id,
  evaluatedAt: Timestamp,
  artifact: redactedArtifactSchema,
  assessment: z.strictObject({
    suspectedDataLoss: z.boolean(),
    suspectedSecurityIncident: z.boolean(),
    confirmedBroadOutage: z.boolean(),
    blocksCoreUse: z.boolean(),
    repeatedContact: z.boolean(),
    sensitiveIssue: z.boolean(),
    duplicate: z.boolean(),
    actionable: z.boolean(),
    praiseOnly: z.boolean(),
  }),
  productDecision: decisionSchema,
}).superRefine((input, context) => {
  const categories = input.artifact.labels.filter((label) =>
    categorySchema.safeParse(label).success
  );
  if (categories.length !== 1) {
    context.addIssue({
      code: "custom",
      path: ["artifact", "labels"],
      message: "exactly one feedback category is required",
    });
  }
  if (
    Date.parse(input.artifact.provenance.normalizedAt) >
      Date.parse(input.evaluatedAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["evaluatedAt"],
      message: "feedback cannot be evaluated before normalization",
    });
  }
  const assessment = input.assessment;
  if (
    assessment.praiseOnly &&
    (assessment.actionable || assessment.suspectedDataLoss ||
      assessment.suspectedSecurityIncident || assessment.confirmedBroadOutage ||
      assessment.blocksCoreUse || assessment.repeatedContact ||
      assessment.sensitiveIssue)
  ) {
    context.addIssue({
      code: "custom",
      path: ["assessment", "praiseOnly"],
      message: "praiseOnly conflicts with actionable or escalation flags",
    });
  }
});

/** Strict contract for the persisted classification and optional draft. */
export const feedbackResponseOutputSchema = z.strictObject({
  schemaVersion: z.literal(FEEDBACK_RESPONSE_SCHEMA_VERSION),
  responseId: Id,
  evaluatedAt: Timestamp,
  source: z.strictObject({
    feedbackId: Id,
    sourceId: Id,
    inputEnvelopeId: Id,
    normalizedAt: Timestamp,
    sha256: Hash,
  }),
  category: categorySchema,
  classification: z.strictObject({
    severity: z.enum(["critical", "high", "medium", "low", "informational"]),
    urgency: z.enum([
      "immediate",
      "within-2-hours",
      "within-1-business-day",
      "within-3-business-days",
      "digest",
    ]),
    escalationReasons: z.array(
      z.enum([
        "suspected-data-loss",
        "suspected-security-incident",
        "confirmed-broad-outage",
        "blocks-core-use",
        "repeated-contact",
        "sensitive-issue",
      ]),
    ),
    draftDisposition: z.enum([
      "hold-for-specialist",
      "personalized-draft",
      "acknowledgement-draft",
      "no-draft",
    ]),
  }),
  productDecision: decisionSchema,
  draft: z.strictObject({
    text: SafeText,
    facts: z.array(SafeText).min(1).max(4),
    unknowns: z.array(SafeText).min(1).max(4),
    nextStep: SafeText,
    binding: z.strictObject({
      id: Id,
      version: z.literal(FEEDBACK_RESPONSE_SCHEMA_VERSION),
      sha256: Hash,
    }),
  }).nullable(),
}).superRefine((output, context) => {
  const suppressesDraft = output.classification.draftDisposition ===
      "hold-for-specialist" ||
    output.classification.draftDisposition === "no-draft";
  if (suppressesDraft !== (output.draft === null)) {
    context.addIssue({
      code: "custom",
      path: ["draft"],
      message: "draft presence must match the draft disposition",
    });
  }
});

/** Validated input accepted by the classify-and-draft method. */
export type FeedbackResponseInput = z.infer<typeof feedbackResponseInputSchema>;
/** Persisted response packet produced by the classify-and-draft method. */
export type FeedbackResponseOutput = z.infer<
  typeof feedbackResponseOutputSchema
>;

const forbiddenContent = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:https?:\/\/|api[_ -]?key|password|secret|bearer|access[_ -]?token)\b/i,
  /\b(?:diagnosed|root cause is|guarantee(?:d)?|promise|delivery date|ship date)\b/i,
  /\b(?:we|i) will (?:fix|ship|deliver|resolve)\b/i,
];

/** Validates structure and rejects common privacy-risk or promise-like text. */
export function parseFeedbackResponseInput(
  value: unknown,
): FeedbackResponseInput {
  const parsed = feedbackResponseInputSchema.parse(value);
  const findings: string[] = [];
  const inspect = (nested: unknown, path: string[]): void => {
    if (typeof nested === "string") {
      if (
        path.join(".") !== "artifact.redaction.limitations" &&
        forbiddenContent.some((pattern) => pattern.test(nested))
      ) findings.push(path.join("."));
    } else if (Array.isArray(nested)) {
      nested.forEach((item, index) => inspect(item, [...path, String(index)]));
    } else if (nested && typeof nested === "object") {
      Object.entries(nested).forEach(([key, item]) =>
        inspect(item, [...path, key])
      );
    }
  };
  inspect(parsed, []);
  if (findings.length) {
    throw new TypeError(
      `feedback response input contains forbidden content at ${
        [...new Set(findings)].sort().join(", ")
      }`,
    );
  }
  return parsed;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0
      ).map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
        .join(",")
    }}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(value)),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

const acknowledgements = {
  bug: "Thank you for describing the problem you encountered.",
  confusion: "Thank you for describing where the experience felt unclear.",
  feature_request: "Thank you for sharing this idea.",
  other: "Thank you for taking the time to share this feedback.",
} as const;

/** Deterministically classifies one input and creates its bounded draft packet. */
export async function buildFeedbackResponse(
  value: unknown,
): Promise<FeedbackResponseOutput> {
  const input = parseFeedbackResponseInput(value);
  const assessment = input.assessment;
  const category = categorySchema.parse(
    input.artifact.labels.find((label) =>
      categorySchema.safeParse(label).success
    ),
  );
  const critical = assessment.suspectedDataLoss ||
    assessment.suspectedSecurityIncident;
  const high = assessment.confirmedBroadOutage || assessment.repeatedContact ||
    assessment.sensitiveIssue;
  const noDraft =
    (assessment.duplicate || !assessment.actionable || assessment.praiseOnly) &&
    !critical && !high && !assessment.blocksCoreUse;
  const severity = critical
    ? "critical" as const
    : high
    ? "high" as const
    : assessment.blocksCoreUse
    ? "medium" as const
    : noDraft
    ? "informational" as const
    : "low" as const;
  const urgency = severity === "critical"
    ? "immediate" as const
    : severity === "high"
    ? "within-2-hours" as const
    : severity === "medium"
    ? "within-1-business-day" as const
    : severity === "low"
    ? "within-3-business-days" as const
    : "digest" as const;
  const draftDisposition = (critical || assessment.sensitiveIssue)
    ? "hold-for-specialist" as const
    : noDraft
    ? "no-draft" as const
    : (severity === "high" || severity === "medium" ||
        assessment.repeatedContact)
    ? "personalized-draft" as const
    : "acknowledgement-draft" as const;
  const escalationReasons = [
    [assessment.suspectedDataLoss, "suspected-data-loss"],
    [assessment.suspectedSecurityIncident, "suspected-security-incident"],
    [assessment.confirmedBroadOutage, "confirmed-broad-outage"],
    [assessment.blocksCoreUse, "blocks-core-use"],
    [assessment.repeatedContact, "repeated-contact"],
    [assessment.sensitiveIssue, "sensitive-issue"],
  ].flatMap(([enabled, reason]) => enabled ? [reason] : []);
  let draft: FeedbackResponseOutput["draft"] = null;
  if (
    draftDisposition !== "hold-for-specialist" &&
    draftDisposition !== "no-draft"
  ) {
    const decision = input.productDecision.availability === "known"
      ? ` Reviewed information: ${input.productDecision.customerSafeStatement}`
      : " No confirmed decision is available.";
    const text = `${
      acknowledgements[category]
    }${decision} This draft does not promise an outcome or delivery date.`;
    const facts = [
      `The feedback was classified as ${category.replace("_", " ")}.`,
      `The review urgency is ${urgency.replaceAll("-", " ")}.`,
    ];
    const unknowns = input.productDecision.availability === "known"
      ? ["No implementation or delivery outcome is guaranteed."]
      : ["No reviewed decision is currently available."];
    const nextStep = "Human review is required before any use of this draft.";
    draft = {
      text,
      facts,
      unknowns,
      nextStep,
      binding: {
        id: input.responseId,
        version: FEEDBACK_RESPONSE_SCHEMA_VERSION,
        sha256: await sha256({ text, facts, unknowns, nextStep }),
      },
    };
  }
  return feedbackResponseOutputSchema.parse({
    schemaVersion: FEEDBACK_RESPONSE_SCHEMA_VERSION,
    responseId: input.responseId,
    evaluatedAt: input.evaluatedAt,
    source: {
      feedbackId: input.artifact.feedbackId,
      sourceId: input.artifact.sourceId,
      inputEnvelopeId: input.artifact.provenance.inputEnvelopeId,
      normalizedAt: input.artifact.provenance.normalizedAt,
      sha256: await sha256(input.artifact),
    },
    category,
    classification: { severity, urgency, escalationReasons, draftDisposition },
    productDecision: input.productDecision,
    draft,
  });
}

/** Swamp model definition for privacy-bounded feedback response drafting. */
export const model = {
  type: "@mgreten/feedback-response-core",
  version: FEEDBACK_RESPONSE_CORE_VERSION,
  resources: {
    response: {
      description: "Redacted feedback classification and draft packet",
      schema: feedbackResponseOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    classifyAndDraft: {
      description: "Classify one redacted artifact and persist a draft packet.",
      arguments: feedbackResponseInputSchema,
      execute: async (
        args: FeedbackResponseInput,
        context: {
          readResource(name: string): Promise<Record<string, unknown> | null>;
          logger: {
            info(message: string, properties?: Record<string, unknown>): void;
          };
          writeResource(
            spec: string,
            name: string,
            data: FeedbackResponseOutput,
          ): Promise<unknown>;
        },
      ) => {
        context.logger.info("Classifying feedback response {responseId}", {
          responseId: args.responseId,
        });
        const response = await buildFeedbackResponse(args);
        const existing = await context.readResource(args.responseId);
        if (existing) {
          if (
            canonical(feedbackResponseOutputSchema.parse(existing)) !==
              canonical(response)
          ) {
            throw new Error(
              `Conflicting replay for response ${args.responseId}`,
            );
          }
          context.logger.info("Reused feedback response {responseId}", {
            responseId: args.responseId,
          });
          return { dataHandles: [] };
        }
        const handle = await context.writeResource(
          "response",
          args.responseId,
          response,
        );
        context.logger.info("Stored feedback response {responseId}", {
          responseId: args.responseId,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
