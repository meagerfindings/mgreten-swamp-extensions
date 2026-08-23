/** Synthetic product-lineage contract tests. */
import {
  evaluateProductLineage,
  PRODUCT_LINEAGE_SCHEMA_VERSION,
  PRODUCT_LINEAGE_STAGES,
  ProductLineage,
} from "./product_lineage_contracts.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

/** Creates a fresh synthetic lineage fixture with every stage produced. */
export function syntheticCompleteLineage(): Record<string, unknown> {
  const source = {
    schemaVersion: "1.0",
    sourceId: "synthetic:source:1",
    source: { system: "synthetic", resourceType: "fixture", resourceId: "1" },
    provenance: {
      collector: "fixture",
      collectorVersion: "1",
      method: "generated",
      collectedAt: "2026-01-01T00:00:00Z",
    },
    observedAt: "2026-01-01T00:00:00Z",
    freshness: {
      asOf: "2026-01-01T00:00:00Z",
      expiresAt: "2027-01-01T00:00:00Z",
    },
    sensitivity: "internal",
  };
  const reference = (index: number) => ({
    artifactId: `synthetic:artifact:${index}`,
    version: 1,
    sha256: index.toString(16).repeat(64),
  });
  return {
    schemaVersion: PRODUCT_LINEAGE_SCHEMA_VERSION,
    lineageId: "synthetic:lineage:1",
    lineageVersion: 1,
    stages: PRODUCT_LINEAGE_STAGES.map((stage, index) => ({
      stage,
      status: "produced",
      artifact: {
        ...reference(index + 1),
        lineageId: "synthetic:lineage:1",
        lineageVersion: 1,
        producedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
        predecessor: index === 0 ? null : reference(index),
        sourceReferences: [source],
      },
    })),
  };
}

Deno.test("accepts a complete ordered, evidence-backed lineage", () => {
  const parsed = ProductLineage.parse(syntheticCompleteLineage());
  assert(parsed.stages.length === PRODUCT_LINEAGE_STAGES.length);
  assert(parsed.stages.at(-1)?.stage === "post_release_measurement");
});

Deno.test("allows only an explicit not-yet-produced suffix", () => {
  const partial = structuredClone(syntheticCompleteLineage()) as {
    stages: Record<string, unknown>[];
  };
  partial.stages.splice(
    3,
    partial.stages.length - 3,
    ...PRODUCT_LINEAGE_STAGES.slice(3).map((stage) => ({
      stage,
      status: "not_yet_produced",
      reason: "awaiting predecessor",
    })),
  );
  assert(evaluateProductLineage(partial).valid);
  partial.stages[5] = structuredClone(
    (syntheticCompleteLineage() as { stages: Record<string, unknown>[] })
      .stages[5],
  );
  assert(!evaluateProductLineage(partial).valid);
});

Deno.test("rejects gaps, reorderings, duplicate artifacts, and broken predecessors", () => {
  const invalids = [
    (value: { stages: Record<string, unknown>[] }) => value.stages.splice(2, 1),
    (value: { stages: Record<string, unknown>[] }) =>
      [value.stages[1], value.stages[2]] = [value.stages[2], value.stages[1]],
    (value: { stages: Record<string, unknown>[] }) =>
      (value.stages[2].artifact as { artifactId: string }).artifactId =
        "synthetic:artifact:2",
    (value: { stages: Record<string, unknown>[] }) =>
      (value.stages[3].artifact as { predecessor: { version: number } })
        .predecessor.version = 2,
  ];
  for (const mutate of invalids) {
    const value = structuredClone(syntheticCompleteLineage()) as {
      stages: Record<string, unknown>[];
    };
    mutate(value);
    assert(!evaluateProductLineage(value).valid);
  }
});

Deno.test("rejects chronology and evidence timestamps that follow their artifact", () => {
  const sameTime = structuredClone(syntheticCompleteLineage()) as {
    stages: { artifact: { producedAt: string } }[];
  };
  sameTime.stages[2].artifact.producedAt =
    sameTime.stages[1].artifact.producedAt;
  const futureEvidence = structuredClone(syntheticCompleteLineage()) as {
    stages: {
      artifact: { sourceReferences: { freshness: { asOf: string } }[] };
    }[];
  };
  futureEvidence.stages[2].artifact.sourceReferences[0].freshness.asOf =
    "2026-01-04T00:00:00Z";
  const staleEvidence = structuredClone(syntheticCompleteLineage()) as {
    stages: {
      artifact: { sourceReferences: { freshness: { expiresAt: string } }[] };
    }[];
  };
  staleEvidence.stages[2].artifact.sourceReferences[0].freshness.expiresAt =
    "2026-01-02T12:00:00Z";
  assert(!evaluateProductLineage(sameTime).valid);
  assert(!evaluateProductLineage(futureEvidence).valid);
  assert(!evaluateProductLineage(staleEvidence).valid);
});

Deno.test("returns stable, sorted diagnostics", () => {
  const invalid = structuredClone(syntheticCompleteLineage()) as {
    lineageId: string;
    stages: { artifact: { predecessor: unknown } }[];
  };
  invalid.lineageId = "";
  invalid.stages[0].artifact.predecessor = {
    artifactId: "other",
    version: 1,
    sha256: "a".repeat(64),
  };
  const first = evaluateProductLineage(invalid);
  const second = evaluateProductLineage(structuredClone(invalid));
  assert(!first.valid && !second.valid);
  assert(JSON.stringify(first) === JSON.stringify(second));
  assert(
    JSON.stringify(first.diagnostics) ===
      JSON.stringify(
        [...first.diagnostics].sort((a, b) =>
          a.path.localeCompare(b.path) || a.code.localeCompare(b.code) ||
          a.message.localeCompare(b.message)
        ),
      ),
  );
});
