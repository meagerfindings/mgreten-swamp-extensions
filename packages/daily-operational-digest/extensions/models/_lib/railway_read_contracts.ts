import { z } from "npm:zod@4";

// Pinned consumer contract for @mgreten/railway-read@2026.08.21.1. Keeping
// this local lets the private watchdog and digest adapters validate the
// public model's persisted boundary without importing ignored Swamp
// installation files.
const Uuid = z.string().uuid();
const Timestamp = z.iso.datetime({ offset: true });

const deploymentStatusSchema = z.enum([
  "BUILDING",
  "DEPLOYING",
  "SUCCESS",
  "FAILED",
  "CRASHED",
  "REMOVED",
  "SLEEPING",
  "SKIPPED",
  "WAITING",
  "QUEUED",
  "INITIALIZING",
]);

const deploymentSourceSchema = z.strictObject({
  repository: z.string().nullable(),
  branch: z.string().nullable(),
  commitSha: z.string().nullable(),
  commitMessage: z.string().nullable(),
});

const deploymentSchema = z.strictObject({
  id: z.string().min(1),
  status: deploymentStatusSchema,
  createdAt: z.string().datetime(),
  url: z.string().url().nullable(),
  staticUrl: z.string().min(1).max(2048).nullable(),
  source: deploymentSourceSchema,
});

export const railwayDeploymentSnapshotSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  collectedAt: z.string().datetime(),
  projectId: Uuid,
  environmentId: Uuid,
  services: z.array(z.strictObject({
    id: Uuid,
    name: z.string().min(1),
    deployments: z.array(deploymentSchema).max(50),
    truncated: z.boolean(),
  })).min(1).max(20),
  truncated: z.boolean(),
  authority: z.strictObject({
    mode: z.literal("read-only"),
    sideEffects: z.literal("none"),
    mutationsExposed: z.literal(false),
  }),
});
export type RailwayDeploymentSnapshot = z.infer<
  typeof railwayDeploymentSnapshotSchema
>;

export const railwayScopeSchema = z.strictObject({
  projectId: Uuid,
  environmentId: Uuid,
  services: z.array(z.strictObject({
    id: Uuid,
    name: z.string().min(1).max(100),
  })).min(1).max(20),
  maxSnapshotAgeSeconds: z.number().int().min(60).max(900),
}).superRefine((value, context) => {
  if (
    new Set(value.services.map((service) => service.id)).size !==
      value.services.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["services"],
      message: "configured Railway service IDs must be unique",
    });
  }
  if (
    new Set(value.services.map((service) => service.name)).size !==
      value.services.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["services"],
      message: "configured Railway service names must be unique",
    });
  }
});
export type RailwayScope = z.infer<typeof railwayScopeSchema>;

const latestDeploymentEvidenceSchema = z.strictObject({
  serviceId: Uuid,
  serviceName: z.string().min(1).max(100),
  status: deploymentStatusSchema,
  deploymentId: z.string().min(1).max(200),
  commitSha: z.string().min(1).max(64).nullable(),
  deployedAt: Timestamp,
});
export type LatestDeploymentEvidence = z.infer<
  typeof latestDeploymentEvidenceSchema
>;

export const railwayEvidenceSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("available"),
    collectedAt: Timestamp,
    services: z.array(latestDeploymentEvidenceSchema).min(1).max(20),
  }),
  z.strictObject({
    state: z.literal("unavailable"),
    reason: z.string().min(1).max(200),
  }),
]);
export type RailwayEvidence = z.infer<typeof railwayEvidenceSchema>;

/** Re-validates already-produced evidence at a later consumption boundary. */
export function validateRailwayEvidence(value: unknown):
  | { success: true; data: RailwayEvidence }
  | { success: false; diagnostics: unknown } {
  const parsed = railwayEvidenceSchema.safeParse(value);
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, diagnostics: parsed.error.issues };
}

/**
 * Strict fail-closed consumer boundary for @mgreten/railway-read evidence.
 * Any schema, authority, scope, roster, ordering, or freshness deviation
 * makes the entire snapshot unavailable rather than partially trusted; only
 * a snapshot that exactly matches the configured project, environment, and
 * complete service roster, with descending non-future deployments per
 * service, within the bounded freshness window, is treated as available.
 */
export function evaluateRailwayEvidence(
  value: unknown,
  scope: unknown,
  asOf: string,
): RailwayEvidence {
  const expected = railwayScopeSchema.parse(scope);
  const unavailable = (reason: string): RailwayEvidence =>
    railwayEvidenceSchema.parse({ state: "unavailable", reason });

  const parsed = railwayDeploymentSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    return unavailable("Railway snapshot failed schema validation.");
  }
  const snapshot = parsed.data;

  if (
    snapshot.authority.mode !== "read-only" ||
    snapshot.authority.sideEffects !== "none" ||
    snapshot.authority.mutationsExposed !== false
  ) {
    return unavailable("Railway snapshot authority is not strictly read-only.");
  }
  if (
    snapshot.projectId !== expected.projectId ||
    snapshot.environmentId !== expected.environmentId
  ) {
    return unavailable(
      "Railway snapshot project or environment does not match the configured scope.",
    );
  }

  const actualIds = snapshot.services.map((service) => service.id);
  const uniqueActualIds = [...new Set(actualIds)];
  if (uniqueActualIds.length !== actualIds.length) {
    return unavailable("Railway snapshot contains duplicate services.");
  }
  const expectedIds = [...new Set(expected.services.map((s) => s.id))].sort();
  const sortedActualIds = [...uniqueActualIds].sort();
  if (
    expectedIds.length !== sortedActualIds.length ||
    expectedIds.some((id, index) => id !== sortedActualIds[index])
  ) {
    return unavailable(
      "Railway snapshot service roster does not exactly match the configured scope.",
    );
  }

  const collected = Date.parse(snapshot.collectedAt);
  const asOfMs = Date.parse(asOf);
  if (Number.isNaN(collected) || Number.isNaN(asOfMs)) {
    return unavailable("Railway snapshot timestamps are unparseable.");
  }
  if (collected > asOfMs + 120_000) {
    return unavailable("Railway snapshot was collected in the future.");
  }
  if (collected < asOfMs - expected.maxSnapshotAgeSeconds * 1_000) {
    return unavailable("Railway snapshot is stale.");
  }

  const nameById = new Map(
    expected.services.map((service) => [service.id, service.name]),
  );
  const services: LatestDeploymentEvidence[] = [];
  for (const service of snapshot.services) {
    if (service.name !== nameById.get(service.id)) {
      return unavailable(
        `Railway snapshot service name does not match configured service ${service.id}.`,
      );
    }
    if (service.deployments.length === 0) {
      return unavailable(
        `Railway snapshot has no deployment evidence for service ${service.id}.`,
      );
    }
    for (let index = 1; index < service.deployments.length; index++) {
      const previous = Date.parse(service.deployments[index - 1].createdAt);
      const current = Date.parse(service.deployments[index].createdAt);
      if (
        Number.isNaN(previous) || Number.isNaN(current) || previous < current
      ) {
        return unavailable(
          `Railway snapshot deployments for service ${service.id} are not in descending order.`,
        );
      }
    }
    const latest = service.deployments[0];
    const createdAtMs = Date.parse(latest.createdAt);
    if (Number.isNaN(createdAtMs) || createdAtMs > collected) {
      return unavailable(
        `Railway snapshot has a future deployment for service ${service.id}.`,
      );
    }
    services.push(latestDeploymentEvidenceSchema.parse({
      serviceId: service.id,
      serviceName: nameById.get(service.id) ?? service.name,
      status: latest.status,
      deploymentId: latest.id,
      commitSha: latest.source.commitSha,
      deployedAt: latest.createdAt,
    }));
  }

  return railwayEvidenceSchema.parse({
    state: "available",
    collectedAt: snapshot.collectedAt,
    services: services.sort((a, b) => a.serviceId.localeCompare(b.serviceId)),
  });
}
