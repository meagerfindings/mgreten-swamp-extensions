/** Product-lineage schema and deterministic validation contracts. @module */
import { z } from "npm:zod@4";
import { sourceEvidenceReferenceSchema } from "./source_evidence_contracts.ts";

/** Stable schema version for the product-lineage interchange contract. */
export const PRODUCT_LINEAGE_SCHEMA_VERSION = "2.0" as const;

/** The complete, fixed order of product-delivery stages. */
export const PRODUCT_LINEAGE_STAGES = [
  "signal",
  "dossier",
  "decision",
  "work_packet",
  "factory_artifacts",
  "draft_pr",
  "merged_change",
  "released_outcome",
  "post_release_measurement",
] as const;

const Id = z.string().trim().min(1);
const Version = z.number().int().positive();
const Hash = z.string().regex(
  /^[0-9a-f]{64}$/,
  "sha256 must be a lowercase 64-character hash",
);
const Timestamp = z.iso.datetime({ offset: true });

const ArtifactReference = z.strictObject({
  artifactId: Id,
  version: Version,
  sha256: Hash,
});

const ProducedStage = z.strictObject({
  stage: z.enum(PRODUCT_LINEAGE_STAGES),
  status: z.literal("produced"),
  artifact: ArtifactReference.extend({
    lineageId: Id,
    lineageVersion: Version,
    producedAt: Timestamp,
    predecessor: ArtifactReference.nullable(),
    sourceReferences: z.array(sourceEvidenceReferenceSchema).min(1),
  }),
});

const NotProducedStage = z.strictObject({
  stage: z.enum(PRODUCT_LINEAGE_STAGES),
  status: z.literal("not_yet_produced"),
  reason: Id,
});

/** Validates an ordered lineage and its evidence, identity, and predecessor invariants. */
export const ProductLineage = z.strictObject({
  schemaVersion: z.literal(PRODUCT_LINEAGE_SCHEMA_VERSION),
  lineageId: Id,
  lineageVersion: Version,
  stages: z.array(
    z.discriminatedUnion("status", [ProducedStage, NotProducedStage]),
  )
    .length(PRODUCT_LINEAGE_STAGES.length),
}).superRefine((lineage, context) => {
  let previous: z.infer<typeof ArtifactReference> | undefined;
  let previousProducedAt: number | undefined;
  let incomplete = false;
  const artifactIds = new Set<string>();

  lineage.stages.forEach((entry, index) => {
    const expectedStage = PRODUCT_LINEAGE_STAGES[index];
    if (entry.stage !== expectedStage) {
      context.addIssue({
        code: "custom",
        path: ["stages", index, "stage"],
        message: `stage must be ${expectedStage}`,
      });
    }
    if (entry.status === "not_yet_produced") {
      incomplete = true;
      return;
    }
    if (incomplete) {
      context.addIssue({
        code: "custom",
        path: ["stages", index, "status"],
        message: "a produced stage cannot follow a not-yet-produced stage",
      });
    }

    const artifact = entry.artifact;
    if (artifact.lineageId !== lineage.lineageId) {
      context.addIssue({
        code: "custom",
        path: ["stages", index, "artifact", "lineageId"],
        message: "lineageId must remain immutable",
      });
    }
    if (artifact.lineageVersion !== lineage.lineageVersion) {
      context.addIssue({
        code: "custom",
        path: ["stages", index, "artifact", "lineageVersion"],
        message: "lineageVersion must remain immutable",
      });
    }
    if (artifactIds.has(artifact.artifactId)) {
      context.addIssue({
        code: "custom",
        path: ["stages", index, "artifact", "artifactId"],
        message: "artifactId must be unique",
      });
    }
    artifactIds.add(artifact.artifactId);

    const producedAt = Date.parse(artifact.producedAt);
    if (previousProducedAt !== undefined && producedAt <= previousProducedAt) {
      context.addIssue({
        code: "custom",
        path: ["stages", index, "artifact", "producedAt"],
        message: "producedAt must strictly follow the prior stage",
      });
    }
    artifact.sourceReferences.forEach((source, sourceIndex) => {
      const path = [
        "stages",
        index,
        "artifact",
        "sourceReferences",
        sourceIndex,
      ];
      if (Date.parse(source.observedAt) > producedAt) {
        context.addIssue({
          code: "custom",
          path: [...path, "observedAt"],
          message:
            "source evidence must be observed no later than artifact production",
        });
      }
      if (Date.parse(source.provenance.collectedAt) > producedAt) {
        context.addIssue({
          code: "custom",
          path: [...path, "provenance", "collectedAt"],
          message:
            "source evidence must be collected no later than artifact production",
        });
      }
      if (Date.parse(source.freshness.asOf) > producedAt) {
        context.addIssue({
          code: "custom",
          path: [...path, "freshness", "asOf"],
          message:
            "source evidence freshness must be established no later than artifact production",
        });
      }
    });

    if (index === 0 && artifact.predecessor !== null) {
      context.addIssue({
        code: "custom",
        path: ["stages", index, "artifact", "predecessor"],
        message: "signal must not have a predecessor",
      });
    }
    if (
      index > 0 &&
      JSON.stringify(artifact.predecessor) !== JSON.stringify(previous)
    ) {
      context.addIssue({
        code: "custom",
        path: ["stages", index, "artifact", "predecessor"],
        message:
          "predecessor must exactly bind the preceding artifact identity and version",
      });
    }
    previous = {
      artifactId: artifact.artifactId,
      version: artifact.version,
      sha256: artifact.sha256,
    };
    previousProducedAt = producedAt;
  });
});

/** The parsed product-lineage value. */
export type ProductLineage = z.infer<typeof ProductLineage>;

/** A deterministic, serializable schema-validation diagnostic. */
export type ProductLineageDiagnostic = {
  path: string;
  code: string;
  message: string;
};

/** The result of evaluating an unknown value against the lineage contract. */
export type ProductLineageEvaluation =
  | { valid: true; value: ProductLineage; diagnostics: [] }
  | { valid: false; diagnostics: ProductLineageDiagnostic[] };

/** Evaluates an unknown value and returns sorted diagnostics instead of throwing. */
export function evaluateProductLineage(
  input: unknown,
): ProductLineageEvaluation {
  const result = ProductLineage.safeParse(input);
  if (result.success) {
    return { valid: true, value: result.data, diagnostics: [] };
  }
  const diagnostics = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
    message: issue.message,
  })).sort((left, right) =>
    left.path.localeCompare(right.path) ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  );
  return { valid: false, diagnostics };
}
