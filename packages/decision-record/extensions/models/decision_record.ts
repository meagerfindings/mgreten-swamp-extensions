/**
 * A Swamp model that persists explicit human decisions with no execution authority.
 * @module
 */
// deno-lint-ignore no-import-prefix -- Swamp packages require this pinned npm import.
import { z } from "npm:zod@4";

/** Published model implementation version. */
export const DECISION_RECORD_MODEL_VERSION = "2026.08.23.1" as const;

const Id = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/,
  "must be a stable safe ID",
);
const Text = z.string().trim().min(1).max(2_000);
const Timestamp = z.iso.datetime({ offset: true });
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** The exact dossier identity that a decision covers. */
export const DossierBinding = z.strictObject({
  dossierId: Id,
  version: z.number().int().positive(),
  sha256: Sha256,
  subject: z.strictObject({
    kind: z.string().trim().min(1),
    id: z.string().trim().min(1),
    version: z.number().int().positive(),
    sha256: Sha256,
  }),
});

const NewEvidenceReference = z.strictObject({
  evidenceId: Id,
  sourceId: Id,
  version: z.string().trim().min(1),
  sha256: Sha256,
});

/** A validated, explicit human decision record. */
export const DecisionRecord = z.strictObject({
  schemaVersion: z.literal("1.0"),
  decisionId: Id,
  proposalId: Id,
  dossier: DossierBinding,
  actor: z.strictObject({
    id: Id,
    role: Text,
    humanAuthority: z.literal(true),
  }),
  decision: z.enum(["accept", "defer", "reject", "evidence-needed"]),
  rationale: Text,
  conditions: z.array(Text).max(20),
  evidenceNeeded: z.array(Text).max(20),
  newEvidenceReferences: z.array(NewEvidenceReference).max(20),
  decidedAt: Timestamp,
  reviewAt: Timestamp,
  authority: z.strictObject({
    source: z.literal("explicit-human-input"),
    inferred: z.literal(false),
    mayExecute: z.literal(false),
    sideEffects: z.literal("persist-record-only"),
  }),
}).superRefine((record, context) => {
  if (Date.parse(record.reviewAt) < Date.parse(record.decidedAt)) {
    context.addIssue({
      code: "custom",
      path: ["reviewAt"],
      message: "reviewAt must be at or after decidedAt",
    });
  }

  if (
    record.decision === "evidence-needed" && record.evidenceNeeded.length === 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["evidenceNeeded"],
      message: "evidence-needed requires details",
    });
  }

  if (
    record.decision !== "evidence-needed" && record.evidenceNeeded.length > 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["evidenceNeeded"],
      message: "evidenceNeeded is only valid for evidence-needed",
    });
  }

  const evidenceIds = new Set<string>();
  record.newEvidenceReferences.forEach((reference, index) => {
    if (evidenceIds.has(reference.evidenceId)) {
      context.addIssue({
        code: "custom",
        path: ["newEvidenceReferences", index, "evidenceId"],
        message: "new evidence identities must be unique",
      });
    }
    evidenceIds.add(reference.evidenceId);
  });
});

/** TypeScript representation of a validated decision record. */
export type DecisionRecord = z.infer<typeof DecisionRecord>;

/** Arguments accepted by the record method. */
export const recordArgumentsSchema = z.strictObject({ record: DecisionRecord });

/** Minimal Swamp resource operations used by the persistence function. */
export type DecisionRecordContext = {
  logger: {
    info(message: string, properties?: Record<string, unknown>): void;
  };
  readResource(name: string): Promise<Record<string, unknown> | null>;
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<unknown>;
};

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Persist an explicit decision, reject conflicting replays, and preserve rejection history.
 *
 * The method writes only decision records. It never treats the record as permission to act.
 */
export async function persistDecision(
  input: unknown,
  context: DecisionRecordContext,
): Promise<{ dataHandles: unknown[] }> {
  const { record } = recordArgumentsSchema.parse(input);
  context.logger.info(
    "Recording decision {decisionId} for proposal {proposalId}",
    { decisionId: record.decisionId, proposalId: record.proposalId },
  );
  const decisionName = `decision-${record.decisionId}`;
  const existing = await context.readResource(decisionName);
  if (existing) {
    if (!same(DecisionRecord.parse(existing), record)) {
      throw new Error(`Conflicting replay for ${record.decisionId}`);
    }
    const latestName = `proposal-${record.proposalId}`;
    const latest = await context.readResource(latestName);
    if (latest) {
      if (!same(DecisionRecord.parse(latest), record)) {
        throw new Error(`Conflicting latest decision for ${record.proposalId}`);
      }
      context.logger.info(
        "Decision {decisionId} already recorded for proposal {proposalId}",
        { decisionId: record.decisionId, proposalId: record.proposalId },
      );
      return { dataHandles: [] };
    }
    const latestHandle = await context.writeResource(
      "latestDecision",
      latestName,
      record,
    );
    context.logger.info(
      "Repaired latest decision for proposal {proposalId}",
      { proposalId: record.proposalId },
    );
    return { dataHandles: [latestHandle] };
  }

  const latestName = `proposal-${record.proposalId}`;
  const priorRaw = await context.readResource(latestName);
  if (priorRaw) {
    const prior = DecisionRecord.parse(priorRaw);
    if (Date.parse(record.decidedAt) <= Date.parse(prior.decidedAt)) {
      throw new Error(
        `Decision for ${record.proposalId} must follow the prior decision chronologically`,
      );
    }
    if (prior.decision === "reject") {
      if (
        record.newEvidenceReferences.length === 0 ||
        record.dossier.version <= prior.dossier.version ||
        record.dossier.sha256 === prior.dossier.sha256
      ) {
        throw new Error(
          `Proposal ${record.proposalId} was rejected; exact new-evidence references and a newer changed dossier are required`,
        );
      }
    }
  }

  const decisionHandle = await context.writeResource(
    "decision",
    decisionName,
    record,
  );
  const latestHandle = await context.writeResource(
    "latestDecision",
    latestName,
    record,
  );
  context.logger.info(
    "Recorded decision {decisionId} for proposal {proposalId}",
    { decisionId: record.decisionId, proposalId: record.proposalId },
  );
  return { dataHandles: [decisionHandle, latestHandle] };
}

/** Swamp model definition for immutable decision records. */
export const model = {
  type: "@mgreten/decision-record",
  version: DECISION_RECORD_MODEL_VERSION,
  globalArguments: z.strictObject({}),
  resources: {
    decision: {
      description:
        "Immutable human-supplied decision bound to an exact dossier",
      schema: DecisionRecord,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    latestDecision: {
      description:
        "Latest recorded decision per stable proposal, used only to enforce rejection history",
      schema: DecisionRecord,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    record: {
      description:
        "Persist an explicit human decision; infers no approval and performs no action.",
      arguments: recordArgumentsSchema,
      execute: (input: unknown, context: DecisionRecordContext) =>
        persistDecision(input, context),
    },
  },
};
