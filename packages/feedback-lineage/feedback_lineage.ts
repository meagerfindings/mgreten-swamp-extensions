/**
 * Swamp model that persists validated feedback lineage without deriving,
 * contacting, consolidating, or closing source records.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  evaluateFeedbackLineage,
  FeedbackLineageRecord,
  type FeedbackLineageRecord as RecordValue,
} from "./_lib/feedback_lineage_contracts.ts";

/** Version of the standalone feedback-lineage model. */
export const FEEDBACK_LINEAGE_MODEL_VERSION = "2026.08.23.1" as const;

const SafeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);

/** This model has no global configuration. */
export const globalArgumentsSchema = z.strictObject({});

/** Arguments accepted by the immutable record method. */
export const recordArgumentsSchema = z.strictObject({
  persistenceId: SafeId,
  record: z.unknown(),
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b)
      ).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

/**
 * Validate a lineage record and reject input that would need normalization
 * before persistence.
 */
export function validateForPersistence(input: unknown): RecordValue {
  const result = evaluateFeedbackLineage(input);
  if (!result.valid) {
    throw new TypeError(
      `Invalid feedback lineage: ${JSON.stringify(result.diagnostics)}`,
    );
  }
  if (canonical(result.value) !== canonical(input)) {
    throw new TypeError(
      "Feedback lineage must already be canonical; identity normalization is prohibited",
    );
  }
  return result.value;
}

/** Runtime operations required to implement idempotent persistence. */
export type FeedbackLineageContext = {
  readResource(name: string): Promise<Record<string, unknown> | null>;
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<unknown>;
};

/**
 * Persist one canonical record or accept an identical replay. A mismatched
 * replay is rejected; this operation performs no external side effects.
 */
export async function persistFeedbackLineage(
  input: unknown,
  context: FeedbackLineageContext,
): Promise<{ dataHandles: unknown[] }> {
  const args = recordArgumentsSchema.parse(input);
  const record = validateForPersistence(args.record);
  const name = `feedback-lineage-${args.persistenceId}`;
  const existing = await context.readResource(name);
  if (existing) {
    if (canonical(existing) !== canonical(record)) {
      throw new Error(`Conflicting replay for ${args.persistenceId}`);
    }
    return { dataHandles: [] };
  }
  const handle = await context.writeResource("lineage", name, record);
  return { dataHandles: [handle] };
}

/** Swamp model definition for immutable feedback-lineage records. */
export const model = {
  type: "@mgreten/feedback-lineage",
  version: FEEDBACK_LINEAGE_MODEL_VERSION,
  globalArguments: globalArgumentsSchema,
  resources: {
    lineage: {
      description:
        "Immutable, source-preserving feedback relationships with recommendation-only authority",
      schema: FeedbackLineageRecord,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    record: {
      description:
        "Validate and persist supplied lineage only; performs no calls, merging, closure, or other side effects.",
      arguments: recordArgumentsSchema,
      execute: persistFeedbackLineage,
    },
  },
};
