import {
  type ObservationRecordInput,
  retainObservationRecord,
} from "./_lib/observation_record_contracts.ts";
import { model } from "./observation_record.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

const evidence = "The archive should preserve the context behind this observation.";

const fixture = (): ObservationRecordInput => ({
  schemaVersion: "1.0",
  observedAt: "2026-08-23T12:00:00Z",
  sourceKind: "direct_observer",
  evidenceKind: "verbatim_quote",
  evidence,
  sourceNote: "Synthetic test evidence only.",
  provenance: {
    collectionMethod: "direct",
    collectedAt: "2026-08-23T12:01:00Z",
    sourceLocatorHash: "a".repeat(64),
  },
  freshness: { expiresAt: "2026-09-23T12:01:00Z" },
  privacy: {
    classification: "private",
    identityStored: false,
    personalDataStored: false,
  },
  recommendationDisposition: "consider_as_hypothesis",
});

Deno.test("retains source evidence without elevating a single observation", async () => {
  const record = await retainObservationRecord(fixture());
  assert(record.evidence === evidence);
  assert(record.sampleSize === 1);
  assert(record.evidenceStatus === "unvalidated_qualitative_signal");
  assert(record.privacy.identityStored === false);
  assert(record.privacy.personalDataStored === false);
  assert(record.observationId === record.contentHash);
  assert(record.authority.decisionAuthority === false);
  assert(record.authority.execution === false);
  assert(record.authority.externalCommunication === false);
});

Deno.test("strictly rejects invented identity, authority, and malformed evidence", async () => {
  const invalidRecords = [
    { ...fixture(), sourceName: "A person" },
    { ...fixture(), decisionAuthority: true },
    { ...fixture(), evidence: " " },
    { ...fixture(), observedAt: "today" },
    { ...fixture(), observationId: "caller-controlled" },
    { ...fixture(), recommendationDisposition: "authorize_action" },
  ];

  for (const value of invalidRecords) {
    let rejected = false;
    try {
      await retainObservationRecord(value);
    } catch {
      rejected = true;
    }
    assert(rejected, `expected strict rejection: ${JSON.stringify(value)}`);
  }
});

Deno.test("model has one persistence-only effect and writes the exact record", async () => {
  const writes: unknown[][] = [];
  const logs: string[] = [];
  const result = await model.methods.retain.execute(fixture(), {
    logger: { info: (message) => logs.push(message) },
    readResource: () => Promise.resolve(null),
    writeResource: (...args: unknown[]) => {
      writes.push(args);
      return Promise.resolve({ name: args[1] });
    },
  });

  assert(writes.length === 1);
  assert(writes[0][0] === "observation");
  assert(writes[0][1] === (writes[0][2] as { observationId: string }).observationId);
  assert(logs.length === 2);
  assert(Object.keys(model.methods).join() === "retain");
  assert(!("files" in model));
  assert(
    JSON.stringify(result) ===
      JSON.stringify({ dataHandles: [{ name: writes[0][1] }] }),
  );
});

Deno.test("identity is deterministic and chronology is bounded", async () => {
  const first = await retainObservationRecord(fixture());
  const second = await retainObservationRecord(fixture());
  assert(first.observationId === second.observationId);

  for (
    const invalid of [
      { ...fixture(), observedAt: "2026-08-23T12:02:00Z" },
      { ...fixture(), freshness: { expiresAt: "2026-08-23T12:00:00Z" } },
    ]
  ) {
    let rejected = false;
    try {
      await retainObservationRecord(invalid);
    } catch {
      rejected = true;
    }
    assert(rejected);
  }
});

Deno.test("exact replay is idempotent and tamper or conflict fails closed", async () => {
  const writes: unknown[][] = [];
  let stored: Record<string, unknown> | null = null;
  const context = {
    logger: { info: (_message: string, _properties: Record<string, unknown>) => {} },
    readResource: () => Promise.resolve(stored),
    writeResource: (...args: unknown[]) => {
      writes.push(args);
      stored = args[2] as Record<string, unknown>;
      return Promise.resolve({ name: args[1] });
    },
  };
  const first = await model.methods.retain.execute(fixture(), context);
  const retry = await model.methods.retain.execute(fixture(), context);
  assert(first.dataHandles.length === 1 && retry.dataHandles.length === 0);
  assert(writes.length === 1);

  stored = { ...(stored ?? {}), evidence: "Tampered evidence" };
  let rejected = false;
  try {
    await model.methods.retain.execute(fixture(), context);
  } catch (error) {
    rejected = String(error).includes("tampered replay");
  }
  assert(rejected);
  assert(writes.length === 1);
});
