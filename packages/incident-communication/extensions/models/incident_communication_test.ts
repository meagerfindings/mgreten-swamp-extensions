import { validateIncidentCommunicationPacket } from "./_lib/incident_communication_contracts.ts";
import { model } from "./incident_communication.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
async function rejects(fn: () => unknown | Promise<unknown>, text: string) {
  try {
    await fn();
  } catch (error) {
    assert(String(error).includes(text), String(error));
    return;
  }
  throw new Error(`expected rejection: ${text}`);
}
const logger = {
  info: (_message: string, _properties: Record<string, unknown>) => {},
};
const evidence = (evidenceId: string) => ({
  evidenceId,
  version: "v1",
  contentHash: "1".repeat(64),
  source: {
    system: "synthetic",
    resourceType: "event",
    resourceId: `resource:${evidenceId}`,
  },
  provenance: {
    collector: "fixture",
    collectorVersion: "1",
    method: "synthetic fixture",
    collectedAt: "2026-08-17T10:01:00Z",
  },
  observedAt: "2026-08-17T10:00:00Z",
  freshness: {
    asOf: "2026-08-17T10:01:00Z",
    expiresAt: "2026-08-18T10:01:00Z",
  },
  sensitivity: "internal",
  status: "available",
});
const packet = () => ({
  schemaVersion: "1.0",
  packetId: "packet-1",
  incident: {
    incidentId: "incident-7",
    version: 3,
    contentHash: "a".repeat(64),
    status: "monitoring",
    openedAt: "2026-08-17T09:00:00Z",
    updatedAt: "2026-08-17T11:00:00Z",
  },
  preparedAt: "2026-08-17T12:00:00Z",
  draft: {
    kind: "incident-update",
    audience: "Affected customers",
    channel: "Status page",
    privacy: "internal",
    sensitivity: ["none"],
  },
  approval: {
    required: true,
    status: "unapproved",
    approver: null,
    approvedAt: null,
  },
  authority: {
    persistenceOnly: true,
    maySend: false,
    mayPublish: false,
    mayRemediate: false,
    mayAccessProduction: false,
  },
  evidence: [evidence("e-1")],
  sections: {
    observedImpact: {
      availability: "available",
      unavailableReason: null,
      items: [{
        statementId: "s-1",
        type: "observed-fact",
        text: "Synthetic requests failed.",
        evidenceIds: ["e-1"],
      }],
    },
    hypotheses: {
      availability: "available",
      unavailableReason: null,
      items: [{
        statementId: "s-2",
        type: "hypothesis",
        text: "A synthetic dependency may be involved.",
        evidenceIds: ["e-1"],
        uncertainty: "Not confirmed.",
      }],
    },
    mitigation: {
      availability: "unavailable",
      unavailableReason: "No mitigation facts supplied.",
      items: [],
    },
    followUp: {
      availability: "available",
      unavailableReason: null,
      items: [{
        statementId: "s-4",
        type: "follow-up",
        text: "Review synthetic logs.",
        evidenceIds: [],
        status: "proposed",
        owner: "Incident commander",
      }],
    },
  },
  timeline: [{
    occurredAt: "2026-08-17T10:00:00Z",
    entryId: "t-1",
    statementId: "s-1",
    status: "observed",
  }],
});

Deno.test("accepts a strict bounded unapproved persistence-only packet", () => {
  const result = validateIncidentCommunicationPacket(packet());
  assert(result.valid);
  assert(result.value.incident.incidentId === "incident-7");
});
Deno.test("facts require known evidence and unavailable facts are explicit", () => {
  const missing = packet();
  missing.sections.observedImpact.items[0].evidenceIds = [] as never;
  assert(!validateIncidentCommunicationPacket(missing).valid);
  const unknown = packet();
  unknown.sections.observedImpact.items[0].evidenceIds = ["e-404"];
  assert(!validateIncidentCommunicationPacket(unknown).valid);
  const stale = packet();
  stale.evidence[0].freshness.expiresAt = "2026-08-17T11:59:59Z";
  assert(!validateIncidentCommunicationPacket(stale).valid);
  const withdrawn = packet();
  withdrawn.evidence[0].status = "withdrawn";
  assert(!validateIncidentCommunicationPacket(withdrawn).valid);
});
Deno.test("rejects ordering, chronology, authority, approval, and extra fields", () => {
  const unordered = packet();
  unordered.evidence = [evidence("e-2"), evidence("e-1")];
  assert(!validateIncidentCommunicationPacket(unordered).valid);
  const future = packet();
  future.timeline[0].occurredAt = "2026-08-18T10:00:00Z";
  assert(!validateIncidentCommunicationPacket(future).valid);
  const authority = packet();
  authority.authority.mayPublish = true as never;
  assert(!validateIncidentCommunicationPacket(authority).valid);
  const approval = packet();
  approval.approval.status = "approved" as never;
  assert(!validateIncidentCommunicationPacket(approval).valid);
  assert(
    !validateIncidentCommunicationPacket({ ...packet(), extra: true }).valid,
  );
});
Deno.test("model validates before its sole persistence side effect", async () => {
  const writes: unknown[] = [];
  const context = {
    logger,
    readResource: () => Promise.resolve(null),
    writeResource: async (...args: unknown[]) => {
      writes.push(args);
      return { name: args[1] };
    },
  };
  await model.methods.record.execute(
    { packetId: "packet-1", packet: packet() },
    context,
  );
  assert(writes.length === 1);
  await rejects(
    () =>
      model.methods.record.execute(
        { packetId: "wrong", packet: packet() },
        context,
      ),
    "exactly match",
  );
  await rejects(
    () =>
      model.methods.record.execute({
        packetId: "packet-1",
        packet: {
          ...packet(),
          approval: { required: true, status: "approved" },
        },
      }, context),
    "Invalid incident",
  );
  assert(writes.length === 1);
});

Deno.test("exact retries are idempotent and conflicting packet retries fail", async () => {
  const writes: unknown[][] = [];
  let stored: Record<string, unknown> | null = null;
  const context = {
    logger,
    readResource: () => Promise.resolve(stored),
    writeResource: async (...args: unknown[]) => {
      writes.push(args);
      stored = args[2] as Record<string, unknown>;
      return { name: args[1] };
    },
  };
  const first = await model.methods.record.execute(
    { packetId: "packet-1", packet: packet() },
    context,
  );
  const retry = await model.methods.record.execute(
    { packetId: "packet-1", packet: packet() },
    context,
  );
  assert(writes.length === 1);
  assert(
    writes.every((write) => write[0] === "packet" && write[1] === "packet-1"),
  );
  assert(first.dataHandles.length === 1 && retry.dataHandles.length === 0);
  const changed = packet();
  changed.draft.audience = "Different audience";
  await rejects(
    () =>
      model.methods.record.execute(
        { packetId: "packet-1", packet: changed },
        context,
      ),
    "Conflicting replay",
  );
  assert(Object.keys(model.methods).join(",") === "record");
  assert(model.resources.packet.description.includes("Unapproved"));
});

Deno.test("every evidence-bearing section requires available fresh evidence", () => {
  for (const section of ["hypotheses", "mitigation", "followUp"] as const) {
    const candidate = packet();
    if (section === "mitigation") {
      candidate.sections.mitigation = {
        availability: "available",
        unavailableReason: null,
        items: [{
          statementId: "s-3",
          type: "mitigation",
          text: "Synthetic mitigation.",
          evidenceIds: ["e-1"],
          status: "proposed",
          owner: "Owner",
        }],
      } as never;
    } else if (section === "followUp") {
      candidate.sections.followUp.items[0].evidenceIds = ["e-1"] as never;
    }
    candidate.evidence[0].status = "withdrawn";
    assert(!validateIncidentCommunicationPacket(candidate).valid, section);
  }
});

Deno.test("rejects privacy downgrade, duplicate sensitivity, and malformed input", () => {
  const privacyDowngrade = packet();
  privacyDowngrade.evidence[0].sensitivity = "restricted";
  privacyDowngrade.draft.privacy = "public";
  assert(!validateIncidentCommunicationPacket(privacyDowngrade).valid);

  const duplicateSensitivity = packet();
  duplicateSensitivity.draft.sensitivity = ["security", "security"] as never;
  assert(!validateIncidentCommunicationPacket(duplicateSensitivity).valid);
  assert(!validateIncidentCommunicationPacket(null).valid);
  assert(!validateIncidentCommunicationPacket({ packetId: "packet-1" }).valid);
});

Deno.test("tampered stored packets fail closed without writes", async () => {
  const writes: unknown[] = [];
  const tampered = {
    ...packet(),
    authority: { ...packet().authority, maySend: true },
  };
  await rejects(
    () =>
      model.methods.record.execute(
        { packetId: "packet-1", packet: packet() },
        {
          logger,
          readResource: () => Promise.resolve(tampered as never),
          writeResource: (...args: unknown[]) => {
            writes.push(args);
            return Promise.resolve({});
          },
        },
      ),
    "Invalid input",
  );
  assert(writes.length === 0);
});

Deno.test("published model has no approval or delivery authority", () => {
  const source = Deno.readTextFileSync(
    new URL("./incident_communication.ts", import.meta.url),
  );
  assert(Object.keys(model.methods).join(",") === "record");
  for (
    const forbidden of [
      "fetch(",
      "Deno.Command",
      "maySend: true",
      "mayPublish: true",
    ]
  ) {
    assert(
      !source.includes(forbidden),
      `forbidden delivery surface: ${forbidden}`,
    );
  }
});
