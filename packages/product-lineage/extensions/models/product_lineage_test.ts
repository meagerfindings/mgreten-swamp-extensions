/** Synthetic product-lineage model tests. */
import { PRODUCT_LINEAGE_STAGES } from "./_lib/product_lineage_contracts.ts";
import { syntheticCompleteLineage } from "./_lib/product_lineage_contracts_test.ts";
import { model, validateLineageForPersistence } from "./product_lineage.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

async function rejects(
  operation: () => unknown | Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    assert(String(error).includes(message), String(error));
    return;
  }
  throw new Error(`expected rejection: ${message}`);
}

Deno.test("record preserves a complete lineage exactly and has no producer methods", async () => {
  const lineage = syntheticCompleteLineage();
  const writes: unknown[][] = [];
  const result = await model.methods.record.execute({
    recordId: "synthetic-v1",
    lineage,
  }, {
    globalArgs: {},
    writeResource: (...args: unknown[]) => {
      writes.push(args);
      return Promise.resolve({ name: args[1] });
    },
  });
  assert(
    JSON.stringify(writes) ===
      JSON.stringify([["lineage", "lineage-synthetic-v1", lineage]]),
  );
  assert(
    JSON.stringify(result) ===
      JSON.stringify({ dataHandles: [{ name: "lineage-synthetic-v1" }] }),
  );
  assert(
    JSON.stringify(Object.keys(model.methods)) === JSON.stringify(["record"]),
  );
});

Deno.test("record preserves an explicit incomplete suffix", async () => {
  const lineage = structuredClone(syntheticCompleteLineage()) as {
    stages: Record<string, unknown>[];
  };
  lineage.stages.splice(
    2,
    lineage.stages.length - 2,
    ...PRODUCT_LINEAGE_STAGES.slice(2).map((stage) => ({
      stage,
      status: "not_yet_produced",
      reason: "producer has not emitted this stage",
    })),
  );
  let written: unknown;
  await model.methods.record.execute({ recordId: "partial", lineage }, {
    globalArgs: {},
    writeResource: (_spec, _name, data) => {
      written = data;
      return Promise.resolve({});
    },
  });
  assert(JSON.stringify(written) === JSON.stringify(lineage));
});

Deno.test("invalid and silently normalized inputs fail before persistence", async () => {
  const bad = structuredClone(syntheticCompleteLineage()) as {
    stages: { artifact: { sourceReferences: { sourceId: string }[] } }[];
  };
  bad.stages[0].artifact.sourceReferences[0].sourceId = " padded-source ";
  let writes = 0;
  await rejects(
    () =>
      model.methods.record.execute({ recordId: "bad", lineage: bad }, {
        globalArgs: {},
        writeResource: () => {
          writes += 1;
          return Promise.resolve({});
        },
      }),
    "normalization is prohibited",
  );
  assert(writes === 0);
  await rejects(
    () => validateLineageForPersistence({}),
    "Invalid product lineage",
  );
});

Deno.test("record arguments reject unknown fields", () => {
  const result = model.methods.record.arguments.safeParse({
    recordId: "synthetic",
    lineage: syntheticCompleteLineage(),
    bypass: true,
  });
  assert(!result.success, "unknown public arguments must fail closed");
});
