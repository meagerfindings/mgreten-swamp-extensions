import {
  buildFeedbackResponse,
  feedbackResponseInputSchema,
  model,
} from "./feedback_response_core.ts";
import type { FeedbackResponseInput } from "./feedback_response_core.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

function fixture(): FeedbackResponseInput {
  return {
    schemaVersion: "1.0",
    responseId: "response-synthetic-1",
    evaluatedAt: "2026-08-23T12:00:00Z",
    artifact: {
      schemaVersion: "1.0",
      feedbackId: "feedback-synthetic-1",
      sourceId: "source-synthetic-1",
      normalizedText: "Synthetic playback stops after pause.",
      labels: ["bug"],
      provenance: {
        inputEnvelopeId: "envelope-synthetic-1",
        sourceId: "source-synthetic-1",
        normalizedAt: "2026-08-23T12:00:00Z",
        normalizer: "synthetic-fixture",
        normalizerVersion: "1",
      },
      redaction: {
        method: "deterministic-redaction",
        methodVersion: "1",
        performedAt: "2026-08-23T12:00:00Z",
        inputEnvelopeId: "envelope-synthetic-1",
        categoriesRemoved: [],
        replacementCount: 0,
        reviewStatus: "synthetic_fixture_reviewed",
        limitations:
          "pattern-based redaction does not guarantee detection of all private information",
      },
    },
    assessment: {
      suspectedDataLoss: false,
      suspectedSecurityIncident: false,
      confirmedBroadOutage: false,
      blocksCoreUse: true,
      repeatedContact: false,
      sensitiveIssue: false,
      duplicate: false,
      actionable: true,
      praiseOnly: false,
    },
    productDecision: {
      availability: "unknown",
      decisionId: null,
      version: null,
      sha256: null,
      customerSafeStatement: null,
    },
  };
}

Deno.test("classifies synthetic redacted input and emits a generic bounded draft", async () => {
  const result = await buildFeedbackResponse(fixture());
  assert(result.classification.severity === "medium");
  assert(result.classification.draftDisposition === "personalized-draft");
  assert(result.draft?.text.includes("Synthetic playback") === false);
  assert(result.draft?.text.includes("Example Product") === false);
  assert(!("approval" in result) && !("authority" in result));
});

Deno.test("holds critical synthetic failures without a draft", async () => {
  const value = fixture();
  value.assessment.suspectedSecurityIncident = true;
  const result = await buildFeedbackResponse(value);
  assert(result.classification.severity === "critical");
  assert(result.classification.draftDisposition === "hold-for-specialist");
  assert(result.draft === null);
});

Deno.test("rejects privacy-risk, promise-like, malformed, and contradictory input", async () => {
  for (
    const text of [
      "synthetic@example.test",
      "https://example.test/private",
      "api_key=synthetic",
      "root cause is synthetic",
      "we will fix this",
    ]
  ) {
    const value = fixture();
    value.artifact.normalizedText = text;
    let rejected = false;
    try {
      await buildFeedbackResponse(value);
    } catch {
      rejected = true;
    }
    assert(rejected, text);
  }
  const missingLimitation = fixture() as any;
  missingLimitation.artifact.redaction.limitations = "redaction is complete";
  assert(!feedbackResponseInputSchema.safeParse(missingLimitation).success);
  const contradictory = fixture();
  contradictory.assessment.praiseOnly = true;
  let rejected = false;
  try {
    await buildFeedbackResponse(contradictory);
  } catch {
    rejected = true;
  }
  assert(rejected, "contradictory praise-only assessment");
});

Deno.test("performs exactly one persistence write after successful validation", async () => {
  const writes: unknown[][] = [];
  await model.methods.classifyAndDraft.execute(fixture(), {
    readResource: () => Promise.resolve(null),
    writeResource: async (...args: unknown[]) => {
      writes.push(args);
      return { name: args[1] };
    },
  });
  assert(writes.length === 1 && writes[0][0] === "response");
  const source = await Deno.readTextFile(
    new URL("./feedback_response_core.ts", import.meta.url),
  );
  for (
    const forbidden of [
      "fetch(",
      "globalArguments",
      "publish",
      "endpoint",
      "importToken",
      "authority:",
      "approval:",
    ]
  ) assert(!source.includes(forbidden), forbidden);
});

Deno.test("same responseId replay is idempotent and conflicting content is rejected", async () => {
  const stored = await buildFeedbackResponse(fixture());
  const context = { readResource: () => Promise.resolve(stored), writeResource: () => Promise.resolve({}) };
  const replay = await model.methods.classifyAndDraft.execute(fixture(), context);
  assert(replay.dataHandles.length === 0);
  const changed = fixture(); changed.assessment.blocksCoreUse = false;
  let rejected = false;
  try { await model.methods.classifyAndDraft.execute(changed, context); } catch (error) { rejected = String(error).includes("Conflicting replay"); }
  assert(rejected);
});
