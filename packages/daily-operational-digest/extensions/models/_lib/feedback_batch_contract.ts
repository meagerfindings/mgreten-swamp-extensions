import { z } from "npm:zod@4";
import {
  FEEDBACK_TRIAGE_SCHEMA_VERSION,
  normalizedFeedbackArtifactSchema,
} from "./feedback_triage_contracts.ts";

const Timestamp = z.iso.datetime({ offset: true });

const MAX_FEEDBACK_RECORDS = 50;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1_000;

export const feedbackBatchSchema = z.strictObject({
  schemaVersion: z.literal(FEEDBACK_TRIAGE_SCHEMA_VERSION),
  collectedAt: Timestamp,
  window: z.strictObject({
    startedAt: Timestamp,
    endedAt: Timestamp,
    endExclusive: z.literal(true),
    maximumHours: z.literal(24),
  }),
  artifacts: z.array(normalizedFeedbackArtifactSchema).max(
    MAX_FEEDBACK_RECORDS,
  ),
  counts: z.strictObject({
    returned: z.number().int().nonnegative().max(MAX_FEEDBACK_RECORDS),
    maximum: z.literal(MAX_FEEDBACK_RECORDS),
  }),
  minimization: z.strictObject({
    selectedColumns: z.tuple([
      z.literal("id"),
      z.literal("category"),
      z.literal("message"),
      z.literal("created_at"),
    ]),
    rawContentIncluded: z.literal(false),
    privateFamilyContentIncluded: z.literal(false),
    userDataIncluded: z.literal(false),
    memoryDataIncluded: z.literal(false),
    emailIncluded: z.literal(false),
    pageUrlIncluded: z.literal(false),
    userAgentIncluded: z.literal(false),
    metadataIncluded: z.literal(false),
  }),
  authority: z.strictObject({
    mode: z.literal("read-only"),
    sideEffects: z.literal("none"),
    mayMutate: z.literal(false),
    agentInvoked: z.literal(false),
    toolsInvoked: z.literal(false),
  }),
}).superRefine((batch, context) => {
  const start = Date.parse(batch.window.startedAt);
  const end = Date.parse(batch.window.endedAt);
  const collected = Date.parse(batch.collectedAt);
  if (start >= end || end - start > MAX_WINDOW_MS) {
    context.addIssue({
      code: "custom",
      path: ["window"],
      message:
        "feedback reader window must be ordered and no longer than 24 hours",
    });
  }
  if (end > collected) {
    context.addIssue({
      code: "custom",
      path: ["collectedAt"],
      message: "feedback cannot be collected before the reader window ends",
    });
  }
});
