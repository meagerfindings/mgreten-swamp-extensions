import { z } from "npm:zod@4";
import { DecisionDossier } from "./_lib/decision_dossier_contracts.ts";

/** Published model implementation version. */
export const DECISION_DOSSIER_MODEL_VERSION = "2026.08.23.1" as const;

/** Arguments accepted by the persistence-only record method. */
export const recordArgumentsSchema = z.strictObject({
  dossier: DecisionDossier,
});

type Context = {
  logger: {
    info(message: string, properties: Record<string, unknown>): void;
  };
  readResource(name: string): Promise<Record<string, unknown> | null>;
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<unknown>;
};

async function resourceName(dossierId: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(dossierId),
  );
  return `dossier-${
    Array.from(new Uint8Array(digest)).map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("").slice(0, 32)
  }`;
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalize(dossier: DecisionDossier): DecisionDossier {
  const value = structuredClone(dossier);
  const by = <T>(items: T[], key: (item: T) => string) =>
    items.sort((left, right) => key(left).localeCompare(key(right)));
  const strings = (items: string[]) => items.sort((a, b) => a.localeCompare(b));
  value.options.forEach((item) => strings(item.evidenceIds));
  value.economics.estimates.forEach((item) => {
    strings(item.evidenceIds);
    strings(item.assumptions);
  });
  value.risks.forEach((item) => strings(item.evidenceIds));
  value.expectedOutcomes.forEach((item) => strings(item.metricIds));
  strings(value.problem.evidenceIds);
  strings(value.affectedSegment.evidenceIds);
  strings(value.confidence.evidenceIds);
  strings(value.strategicFit.principleIds);
  strings(value.strategicFit.evidenceIds);
  strings(value.recommendation.evidenceIds);
  strings(value.effort.evidenceIds);
  strings(value.effort.assumptions);
  by(value.evidence, (item) => item.evidenceId);
  by(value.options, (item) => item.optionId);
  by(value.economics.estimates, (item) => item.estimateId);
  by(value.risks, (item) => item.riskId);
  by(value.expectedOutcomes, (item) => item.outcomeId);
  by(value.measurementPlan.metrics, (item) => item.metricId);
  by(value.measurementPlan.windows, (item) => item.windowId);
  return value;
}

/** Validates and persists an input dossier. It never makes, approves, or executes decisions. */
export async function persistDossier(input: unknown, context: Context) {
  const dossier = canonicalize(recordArgumentsSchema.parse(input).dossier);
  const name = await resourceName(dossier.dossierId);
  context.logger.info("Recording decision dossier {dossierId}", {
    dossierId: dossier.dossierId,
    version: dossier.version,
  });
  const priorRaw = await context.readResource(name);
  if (priorRaw) {
    const prior = canonicalize(DecisionDossier.parse(priorRaw));
    if (same(prior, dossier)) {
      context.logger.info(
        "Decision dossier replay already recorded {dossierId}",
        {
          dossierId: dossier.dossierId,
          version: dossier.version,
        },
      );
      return { dataHandles: [] };
    }
    if (prior.dossierId !== dossier.dossierId) {
      throw new Error("Decision dossier resource identity collision");
    }
    if (dossier.version <= prior.version) {
      throw new Error(
        `Dossier ${dossier.dossierId} version must increase from ${prior.version}`,
      );
    }
    if (
      prior.subject.kind !== dossier.subject.kind ||
      prior.subject.id !== dossier.subject.id ||
      prior.subject.version !== dossier.subject.version ||
      prior.subject.sha256 !== dossier.subject.sha256
    ) {
      throw new Error(
        `Dossier ${dossier.dossierId} cannot change its subject identity`,
      );
    }
    if (Date.parse(dossier.createdAt) <= Date.parse(prior.createdAt)) {
      throw new Error(
        `Dossier ${dossier.dossierId} createdAt must follow the prior version`,
      );
    }
  }
  const handle = await context.writeResource("dossier", name, dossier);
  context.logger.info("Recorded decision dossier {dossierId}", {
    dossierId: dossier.dossierId,
    version: dossier.version,
  });
  return {
    dataHandles: [handle],
  };
}

/** Swamp model definition for versioned decision dossiers. */
export const model = {
  type: "@mgreten/decision-dossier",
  version: DECISION_DOSSIER_MODEL_VERSION,
  globalArguments: z.strictObject({}),
  resources: {
    dossier: {
      description:
        "Validated versioned decision dossier with evidence provenance and no execution authority",
      schema: DecisionDossier,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    record: {
      description:
        "Validate and retain a decision dossier without invoking a provider or performing an external action.",
      arguments: recordArgumentsSchema,
      execute: persistDossier,
    },
  },
};
