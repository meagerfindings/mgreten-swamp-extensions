import {
  model,
  normalizeSnapshotArgumentsSchema,
} from "./operational_triage.ts";
import { syntheticRedactedSnapshot } from "./fixtures/synthetic_redacted_snapshot.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
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

function harness(existing: Record<string, unknown> | null = null) {
  const writes: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  return {
    writes,
    context: {
      logger: { info: (_message: string, _properties: Record<string, unknown>) => {} },
      readResource: (_name: string) => Promise.resolve(existing),
      writeResource: (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ spec, name, data });
        return Promise.resolve({ name });
      },
    },
  };
}

Deno.test("normalizeSnapshot persists one bounded provider-neutral public resource", async () => {
  const { writes, context } = harness();
  const args = normalizeSnapshotArgumentsSchema.parse({
    snapshot: syntheticRedactedSnapshot(),
    globallyMergedArgument: "stripped-at-method-boundary",
  });
  const result = await model.methods.normalizeSnapshot.execute(args, context);
  equal(writes.length, 1);
  equal([writes[0].spec, writes[0].name], [
    "snapshot",
    "snapshot-synthetic-snapshot-1",
  ]);
  equal(
    writes[0].data,
    model.resources.snapshot.schema.parse(syntheticRedactedSnapshot()),
  );
  equal(result.dataHandles, [{ name: "snapshot-synthetic-snapshot-1" }]);
  equal(model.resources.snapshot.lifetime, "30d");
  equal(model.resources.snapshot.garbageCollection, 10);
});

Deno.test("leakage validation fails closed without writing", async () => {
  for (
    const leaked of [{
      ...syntheticRedactedSnapshot(),
      rawLogs: ["private log line"],
    }, {
      ...syntheticRedactedSnapshot(),
      records: [{
        ...syntheticRedactedSnapshot().records[0],
        summary: "contact owner@example.test",
      }],
    }]
  ) {
    const { writes, context } = harness();
    await rejects(
      () =>
        model.methods.normalizeSnapshot.execute({ snapshot: leaked }, context),
      "Invalid operational triage snapshot",
    );
    equal(writes.length, 0);
  }
});

Deno.test("denylist rejects common credentials, network locations, and identifying references", async () => {
  for (
    const value of [
      "Bearer abc.def.ghi",
      "see https://private.example/resource/123",
      "host 10.20.30.40 failed",
    ]
  ) {
    const leaked = syntheticRedactedSnapshot();
    leaked.records[0].summary = value;
    await rejects(
      () =>
        model.methods.normalizeSnapshot.execute(
          { snapshot: leaked },
          harness().context,
        ),
      "forbidden_content",
    );
  }
  for (
    const source of [
      {
        ...syntheticRedactedSnapshot().records[0].sourceReference.source,
        accountId: "acct-123",
      },
      {
        ...syntheticRedactedSnapshot().records[0].sourceReference.source,
        resourceId: "https://private.example/id",
      },
    ]
  ) {
    const leaked = syntheticRedactedSnapshot();
    leaked.records[0].sourceReference.source = source;
    await rejects(
      () =>
        model.methods.normalizeSnapshot.execute(
          { snapshot: leaked },
          harness().context,
        ),
      "Invalid operational triage snapshot",
    );
  }
  const confidential = syntheticRedactedSnapshot();
  confidential.records[0].sourceReference.sensitivity = "confidential" as never;
  await rejects(
    () =>
      model.methods.normalizeSnapshot.execute(
        { snapshot: confidential },
        harness().context,
      ),
    "Invalid operational triage snapshot",
  );
});

Deno.test("stale evidence is rejected before persistence", async () => {
  const stale = syntheticRedactedSnapshot();
  stale.records[0].sourceReference.freshness.expiresAt = "2026-08-23T10:59:59Z";
  const { writes, context } = harness();
  await rejects(
    () => model.methods.normalizeSnapshot.execute({ snapshot: stale }, context),
    "expired source evidence",
  );
  equal(writes.length, 0);
});

Deno.test("identical replay is idempotent and tampered replay fails closed", async () => {
  const snapshot = syntheticRedactedSnapshot();
  const identical = harness(snapshot);
  const replay = await model.methods.normalizeSnapshot.execute(
    { snapshot: syntheticRedactedSnapshot() },
    identical.context,
  );
  equal(replay.dataHandles, []);
  equal(identical.writes.length, 0);

  const tampered = syntheticRedactedSnapshot();
  tampered.records[0].summary = "Different synthetic state";
  const conflict = harness(tampered);
  await rejects(
    () => model.methods.normalizeSnapshot.execute({ snapshot }, conflict.context),
    "Conflicting replay",
  );
  equal(conflict.writes.length, 0);
});

Deno.test("persistence failures propagate without a success handle", async () => {
  const { context } = harness();
  context.writeResource = () => Promise.reject(new Error("synthetic storage failure"));
  await rejects(
    () =>
      model.methods.normalizeSnapshot.execute(
        { snapshot: syntheticRedactedSnapshot() },
        context,
      ),
    "synthetic storage failure",
  );
});

Deno.test("attestation counts, truncation, and collection time are consistent", async () => {
  const mutations = [
    (snapshot: ReturnType<typeof syntheticRedactedSnapshot>) => {
      snapshot.filtering.includedCount = 0;
    },
    (snapshot: ReturnType<typeof syntheticRedactedSnapshot>) => {
      snapshot.limits.truncated = true;
    },
    (snapshot: ReturnType<typeof syntheticRedactedSnapshot>) => {
      snapshot.records[0].sourceReference.provenance.collectedAt =
        "2026-08-23T11:00:01Z";
    },
  ];
  for (const mutate of mutations) {
    const snapshot = syntheticRedactedSnapshot();
    mutate(snapshot);
    await rejects(
      () => model.methods.normalizeSnapshot.execute({ snapshot }, harness().context),
      "Invalid operational triage snapshot",
    );
  }
});

Deno.test("resource names and aggregate allowlist accounting are bounded", async () => {
  for (const mutate of [
    (snapshot: ReturnType<typeof syntheticRedactedSnapshot>) => {
      snapshot.snapshotId = "unsafe/name";
    },
    (snapshot: ReturnType<typeof syntheticRedactedSnapshot>) => {
      snapshot.filtering.excludedCount = 1;
      snapshot.filtering.excludedByReason.identityNotAllowed = 1;
    },
  ]) {
    const snapshot = syntheticRedactedSnapshot();
    mutate(snapshot);
    await rejects(
      () => model.methods.normalizeSnapshot.execute({ snapshot }, harness().context),
      "Invalid operational triage snapshot",
    );
  }
});

Deno.test("provenance identities and evidence references cannot be ambiguous", async () => {
  const duplicateEvidence = syntheticRedactedSnapshot();
  duplicateEvidence.records[0].evidenceIds.push("synthetic-evidence-1");
  await rejects(
    () => model.methods.normalizeSnapshot.execute(
      { snapshot: duplicateEvidence },
      harness().context,
    ),
    "duplicate evidenceId",
  );

  const ambiguousSource = syntheticRedactedSnapshot();
  ambiguousSource.records.push({
    ...structuredClone(ambiguousSource.records[0]),
    recordId: "synthetic-monitor-record-2",
    sourceReference: {
      ...structuredClone(ambiguousSource.records[0].sourceReference),
      source: {
        ...structuredClone(ambiguousSource.records[0].sourceReference.source),
        resourceId: "secondary-check",
      },
    },
  });
  ambiguousSource.filtering.includedCount = 2;
  ambiguousSource.limits.rowsRead = 2;
  await rejects(
    () => model.methods.normalizeSnapshot.execute(
      { snapshot: ambiguousSource },
      harness().context,
    ),
    "sourceId must identify exactly one source identity",
  );
});

Deno.test("collection and freshness attestations must belong to the snapshot window", async () => {
  for (const field of ["collectedAt", "asOf"] as const) {
    const snapshot = syntheticRedactedSnapshot();
    if (field === "collectedAt") {
      snapshot.records[0].sourceReference.provenance.collectedAt =
        "2026-08-23T09:59:00Z";
    } else {
      snapshot.records[0].sourceReference.freshness.asOf =
        "2026-08-23T09:59:00Z";
    }
    await rejects(
      () => model.methods.normalizeSnapshot.execute(
        { snapshot },
        harness().context,
      ),
      "snapshot window",
    );
  }
});

Deno.test("malformed cyclic input is rejected deterministically", async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await rejects(
    () => model.methods.normalizeSnapshot.execute({ snapshot: cyclic }, harness().context),
    "cyclic_input",
  );
});

Deno.test("model has zero operational authority", () => {
  equal(Object.keys(model.methods), ["normalizeSnapshot"]);
  equal(syntheticRedactedSnapshot().authority, {
    mode: "read-only",
    sideEffects: "none",
    remediation: "prohibited",
    mayAcknowledgeIncidents: false,
    mayModifyMonitors: false,
  });
  const source = model.methods.normalizeSnapshot.execute.toString();
  for (
    const capability of [
      "fetch(",
      "Deno.Command",
      "deleteResource",
      "createFileWriter",
      "vault",
      "credential",
    ]
  ) {
    assert(
      !source.includes(capability),
      `unexpected capability in model: ${capability}`,
    );
  }
});
