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
    lineage,
  }, {
    globalArgs: {},
    readResource: () => Promise.resolve(undefined),
    writeResource: (...args: unknown[]) => {
      writes.push(args);
      return Promise.resolve({ name: args[1] });
    },
    logger: { info: () => {} },
  });
  assert(writes.length === 1);
  assert(writes[0][0] === "lineage");
  assert(String(writes[0][1]).match(/^lineage-[0-9a-f]{64}$/));
  assert(JSON.stringify(writes[0][2]) === JSON.stringify(lineage));
  assert(
    JSON.stringify(result) === JSON.stringify({
      dataHandles: [{ name: writes[0][1] }],
    }),
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
  await model.methods.record.execute({ lineage }, {
    globalArgs: {},
    readResource: () => Promise.resolve(undefined),
    writeResource: (_spec, _name, data) => {
      written = data;
      return Promise.resolve({});
    },
    logger: { info: () => {} },
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
      model.methods.record.execute({ lineage: bad }, {
        globalArgs: {},
        readResource: () => Promise.resolve(undefined),
        writeResource: () => {
          writes += 1;
          return Promise.resolve({});
        },
        logger: { info: () => {} },
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
    lineage: syntheticCompleteLineage(),
    bypass: true,
  });
  assert(!result.success, "unknown public arguments must fail closed");
});

Deno.test("record deterministically rejects replay or replacement of an identity/version", async () => {
  const original = syntheticCompleteLineage();
  let instanceName = "";
  await model.methods.record.execute({ lineage: original }, {
    globalArgs: {},
    readResource: () => Promise.resolve(undefined),
    writeResource: (_spec, name) => {
      instanceName = name;
      return Promise.resolve({});
    },
    logger: { info: () => {} },
  });

  const replacement = structuredClone(original) as {
    stages: { artifact: { sha256: string } }[];
  };
  replacement.stages.at(-1)!.artifact.sha256 = "f".repeat(64);
  let writes = 0;
  await rejects(
    () =>
      model.methods.record.execute({ lineage: replacement }, {
        globalArgs: {},
        readResource: (name) =>
          Promise.resolve(name === instanceName ? original : undefined),
        writeResource: () => {
          writes += 1;
          return Promise.resolve({});
        },
        logger: { info: () => {} },
      }),
    "replay or replacement is prohibited",
  );
  assert(writes === 0);
});
