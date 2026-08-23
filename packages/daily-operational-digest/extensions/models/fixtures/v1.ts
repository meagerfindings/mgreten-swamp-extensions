/** Versioned synthetic evidence used by the v1 contract tests. */
export const syntheticSourceV1 = (sourceId: string) => ({
  schemaVersion: "1.0" as const,
  sourceId,
  source: {
    system: "synthetic",
    resourceType: "snapshot",
    resourceId: sourceId,
  },
  provenance: {
    collector: "synthetic-fixture",
    collectorVersion: "v1",
    method: "fixture",
    collectedAt: "2026-08-23T11:00:00Z",
  },
  observedAt: "2026-08-23T10:00:00Z",
  freshness: {
    asOf: "2026-08-23T11:00:00Z",
    expiresAt: "2026-08-24T11:00:00Z",
  },
  sensitivity: "internal" as const,
  redacted: true as const,
});
