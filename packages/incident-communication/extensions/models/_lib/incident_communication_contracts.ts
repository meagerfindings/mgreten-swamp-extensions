import { z } from "npm:zod@4";

export const INCIDENT_COMMUNICATION_SCHEMA_VERSION = "1.0" as const;
export const INCIDENT_COMMUNICATION_LIMITS = {
  evidence: 50,
  statementsPerSection: 30,
  timelineItems: 100,
  textCharacters: 2_000,
} as const;

const id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const text = z.string().trim().min(1).max(
  INCIDENT_COMMUNICATION_LIMITS.textCharacters,
);
const timestamp = z.iso.datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceReferenceIds = z.array(id).min(1).max(20);

export const incidentEvidenceSchema = z.strictObject({
  evidenceId: id,
  version: z.union([
    z.string().trim().min(1).max(128),
    z.number().int().nonnegative(),
  ]),
  contentHash: hash,
  source: z.strictObject({
    system: text.max(120),
    resourceType: text.max(120),
    resourceId: id,
  }),
  provenance: z.strictObject({
    collector: text.max(120),
    collectorVersion: text.max(120),
    method: text.max(240),
    collectedAt: timestamp,
  }),
  observedAt: timestamp,
  freshness: z.strictObject({ asOf: timestamp, expiresAt: timestamp }),
  sensitivity: z.enum(["public", "internal", "confidential", "restricted"]),
  status: z.enum(["available", "superseded", "withdrawn"]),
}).superRefine((value, context) => {
  if (Date.parse(value.observedAt) > Date.parse(value.freshness.asOf)) {
    context.addIssue({
      code: "custom",
      path: ["freshness", "asOf"],
      message: "asOf must not precede observedAt",
    });
  }
  if (
    Date.parse(value.freshness.asOf) > Date.parse(value.freshness.expiresAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["freshness", "expiresAt"],
      message: "expiresAt must not precede asOf",
    });
  }
  if (Date.parse(value.provenance.collectedAt) < Date.parse(value.observedAt)) {
    context.addIssue({
      code: "custom",
      path: ["provenance", "collectedAt"],
      message: "collectedAt must not precede observedAt",
    });
  }
});

const fact = z.strictObject({
  statementId: id,
  type: z.literal("observed-fact"),
  text,
  evidenceIds: evidenceReferenceIds,
});
const hypothesis = z.strictObject({
  statementId: id,
  type: z.literal("hypothesis"),
  text,
  evidenceIds: z.array(id).max(20),
  uncertainty: text.max(500),
});
const mitigation = z.strictObject({
  statementId: id,
  type: z.literal("mitigation"),
  text,
  evidenceIds: z.array(id).max(20),
  status: z.enum(["proposed", "in-progress", "completed", "reverted"]),
  owner: text.max(120),
});
const followUp = z.strictObject({
  statementId: id,
  type: z.literal("follow-up"),
  text,
  evidenceIds: z.array(id).max(20),
  status: z.enum([
    "proposed",
    "accepted",
    "in-progress",
    "completed",
    "cancelled",
  ]),
  owner: text.max(120),
});

function section<T extends z.ZodTypeAny>(item: T) {
  return z.discriminatedUnion("availability", [
    z.strictObject({
      availability: z.literal("available"),
      unavailableReason: z.null(),
      items: z.array(item).min(1).max(
        INCIDENT_COMMUNICATION_LIMITS.statementsPerSection,
      ),
    }),
    z.strictObject({
      availability: z.literal("unavailable"),
      unavailableReason: text.max(500),
      items: z.array(z.never()).length(0),
    }),
  ]);
}

export const incidentCommunicationPacketSchema = z.strictObject({
  schemaVersion: z.literal(INCIDENT_COMMUNICATION_SCHEMA_VERSION),
  packetId: id,
  incident: z.strictObject({
    incidentId: id,
    version: z.union([
      z.string().trim().min(1).max(128),
      z.number().int().nonnegative(),
    ]),
    contentHash: hash,
    status: z.enum([
      "investigating",
      "identified",
      "monitoring",
      "resolved",
      "postmortem",
    ]),
    openedAt: timestamp,
    updatedAt: timestamp,
  }),
  preparedAt: timestamp,
  draft: z.strictObject({
    kind: z.enum(["incident-update", "postmortem"]),
    audience: text.max(240),
    channel: text.max(120),
    privacy: z.enum(["public", "internal", "confidential", "restricted"]),
    sensitivity: z.array(
      z.enum([
        "personal-data",
        "security",
        "customer-data",
        "commercial",
        "none",
      ]),
    ).min(1).max(5),
  }),
  approval: z.strictObject({
    required: z.literal(true),
    status: z.literal("unapproved"),
    approver: z.literal(null),
    approvedAt: z.literal(null),
  }),
  authority: z.strictObject({
    persistenceOnly: z.literal(true),
    maySend: z.literal(false),
    mayPublish: z.literal(false),
    mayRemediate: z.literal(false),
    mayAccessProduction: z.literal(false),
  }),
  evidence: z.array(incidentEvidenceSchema).max(
    INCIDENT_COMMUNICATION_LIMITS.evidence,
  ),
  sections: z.strictObject({
    observedImpact: section(fact),
    hypotheses: section(hypothesis),
    mitigation: section(mitigation),
    followUp: section(followUp),
  }),
  timeline: z.array(
    z.strictObject({
      occurredAt: timestamp,
      entryId: id,
      statementId: id,
      status: text.max(120),
    }),
  ).max(INCIDENT_COMMUNICATION_LIMITS.timelineItems),
}).superRefine((packet, context) => {
  if (
    Date.parse(packet.incident.openedAt) >
      Date.parse(packet.incident.updatedAt) ||
    Date.parse(packet.incident.updatedAt) > Date.parse(packet.preparedAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["incident", "updatedAt"],
      message:
        "incident dates must be chronological and no later than preparedAt",
    });
  }
  const evidenceIds = packet.evidence.map((value) => value.evidenceId);
  const statementSections = [
    packet.sections.observedImpact,
    packet.sections.hypotheses,
    packet.sections.mitigation,
    packet.sections.followUp,
  ];
  const statements: Array<{ statementId: string; evidenceIds: string[] }> = [
    ...packet.sections.observedImpact.items,
    ...packet.sections.hypotheses.items,
    ...packet.sections.mitigation.items,
    ...packet.sections.followUp.items,
  ];
  const statementIds = statements.map((value) => value.statementId);
  const sorted = (values: string[]) =>
    values.every((value, index) =>
      index === 0 || values[index - 1].localeCompare(value) < 0
    );
  if (!sorted(evidenceIds)) {
    context.addIssue({
      code: "custom",
      path: ["evidence"],
      message: "evidence must be uniquely ordered by evidenceId",
    });
  }
  for (const [sectionIndex, value] of statementSections.entries()) {
    if (!sorted(value.items.map((item) => item.statementId))) {
      context.addIssue({
        code: "custom",
        path: ["sections", sectionIndex],
        message: "statements must be uniquely ordered by statementId",
      });
    }
  }
  const evidenceSet = new Set(evidenceIds),
    statementSet = new Set(statementIds);
  for (const statement of statements) {
    if (!sorted(statement.evidenceIds)) {
      context.addIssue({
        code: "custom",
        path: ["sections"],
        message:
          `${statement.statementId} evidenceIds must be uniquely ordered`,
      });
    }
    for (const reference of statement.evidenceIds) {
      if (!evidenceSet.has(reference)) {
        context.addIssue({
          code: "custom",
          path: ["sections"],
          message:
            `${statement.statementId} references unknown evidence ${reference}`,
        });
      }
      const evidence = packet.evidence.find((item) =>
        item.evidenceId === reference
      );
      if (
        evidence &&
        (evidence.status !== "available" ||
          Date.parse(evidence.provenance.collectedAt) >
            Date.parse(packet.preparedAt) ||
          Date.parse(evidence.freshness.asOf) > Date.parse(packet.preparedAt) ||
          Date.parse(evidence.freshness.expiresAt) <
            Date.parse(packet.preparedAt))
      ) {
        context.addIssue({
          code: "custom",
          path: ["sections", statement.statementId],
          message:
            "evidence-bearing statements require evidence that is available and fresh at preparedAt",
        });
      }
    }
  }
  if (
    packet.draft.sensitivity.includes("none") &&
    packet.draft.sensitivity.length !== 1
  ) {
    context.addIssue({
      code: "custom",
      path: ["draft", "sensitivity"],
      message: "none cannot be combined with another sensitivity",
    });
  }
  packet.timeline.forEach((entry, index) => {
    if (!statementSet.has(entry.statementId)) {
      context.addIssue({
        code: "custom",
        path: ["timeline", index, "statementId"],
        message: "timeline references unknown statement",
      });
    }
    if (Date.parse(entry.occurredAt) > Date.parse(packet.preparedAt)) {
      context.addIssue({
        code: "custom",
        path: ["timeline", index, "occurredAt"],
        message: "timeline entry is later than preparedAt",
      });
    }
    if (
      index &&
      (`${packet.timeline[index - 1].occurredAt}\0${
        packet.timeline[index - 1].entryId
      }` >= `${entry.occurredAt}\0${entry.entryId}`)
    ) {
      context.addIssue({
        code: "custom",
        path: ["timeline", index],
        message:
          "timeline must be uniquely chronological by occurredAt then entryId",
      });
    }
  });
});

export type IncidentCommunicationPacket = z.infer<
  typeof incidentCommunicationPacketSchema
>;

export function validateIncidentCommunicationPacket(input: unknown) {
  const result = incidentCommunicationPacketSchema.safeParse(input);
  if (result.success) {
    return { valid: true as const, value: result.data, diagnostics: [] };
  }
  return {
    valid: false as const,
    diagnostics: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      code: issue.code,
      message: issue.message,
    })).sort((a, b) =>
      a.path.localeCompare(b.path) || a.message.localeCompare(b.message)
    ),
  };
}
