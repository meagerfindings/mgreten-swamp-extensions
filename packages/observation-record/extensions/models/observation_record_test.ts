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
  observationId: "archive-context-2026-08-23",
  observedAt: "2026-08-23T12:00:00Z",
  sourceKind: "direct_observer",
  evidenceKind: "verbatim_quote",
  evidence,
  sourceNote: "Synthetic test evidence only.",
  recommendationDisposition: "consider_as_hypothesis",
});

Deno.test("retains source evidence without elevating a single observation", () => {
  const record = retainObservationRecord(fixture());
  assert(record.evidence === evidence);
  assert(record.sampleSize === 1);
  assert(record.evidenceStatus === "unvalidated_qualitative_signal");
  assert(record.attribution.identityStored === false);
  assert(record.authority.decisionAuthority === false);
  assert(record.authority.execution === false);
  assert(record.authority.externalCommunication === false);
});

Deno.test("strictly rejects invented identity, authority, and malformed evidence", () => {
  const invalidRecords = [
    { ...fixture(), sourceName: "A person" },
    { ...fixture(), decisionAuthority: true },
    { ...fixture(), evidence: " " },
    { ...fixture(), observedAt: "today" },
    { ...fixture(), recommendationDisposition: "authorize_action" },
  ];

  for (const value of invalidRecords) {
    let rejected = false;
    try {
      retainObservationRecord(value);
    } catch {
      rejected = true;
    }
    assert(rejected, `expected strict rejection: ${JSON.stringify(value)}`);
  }
});

Deno.test("model has one persistence-only effect and writes the exact record", async () => {
  const writes: unknown[][] = [];
  const result = await model.methods.retain.execute(fixture(), {
    writeResource: (...args: unknown[]) => {
      writes.push(args);
      return Promise.resolve({ name: args[1] });
    },
  });

  assert(writes.length === 1);
  assert(writes[0][0] === "observation");
  assert(writes[0][1] === fixture().observationId);
  assert(Object.keys(model.methods).join() === "retain");
  assert(!("files" in model));
  assert(
    JSON.stringify(result) ===
      JSON.stringify({ dataHandles: [{ name: fixture().observationId }] }),
  );
});
