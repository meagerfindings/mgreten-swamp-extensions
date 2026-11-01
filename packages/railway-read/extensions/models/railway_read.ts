/**
 * Read-only Railway deployment synchronization for Swamp.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Published model version, retained as an importable constant. */
export const RAILWAY_READ_MODEL_VERSION = "2026.08.21.1" as const;

const serviceSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
});

const globalArgumentsSchema = z.strictObject({
  token: z.string().min(1).max(4096).meta({ sensitive: true }),
  authenticationMode: z.enum(["project-token", "bearer"]).default(
    "project-token",
  ),
  projectId: z.string().uuid().optional(),
  environmentId: z.string().uuid().optional(),
  services: z.array(serviceSchema).min(1).max(20),
  apiUrl: z.string().url().default(
    "https://backboard.railway.com/graphql/v2",
  ),
});

const syncArgumentsSchema = z.object({
  limitPerService: z.number().int().min(1).max(50).default(10),
});

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

/** Schema for the bounded deployment snapshot retained by the model. */
export const railwayDeploymentSnapshotSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  collectedAt: z.string().datetime(),
  projectId: z.string().uuid(),
  environmentId: z.string().uuid(),
  services: z.array(z.strictObject({
    id: z.string().uuid(),
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

const tokenScopeResponseSchema = z.strictObject({
  data: z.strictObject({
    projectToken: z.strictObject({
      projectId: z.string().uuid(),
      environmentId: z.string().uuid(),
    }),
  }),
});

const deploymentNodeSchema = z.object({
  id: z.string().min(1),
  status: deploymentStatusSchema,
  createdAt: z.string().datetime(),
  url: z.string().url().nullable().optional(),
  staticUrl: z.string().min(1).max(2048).nullable().optional(),
  meta: z.record(z.string(), z.unknown()).nullable().optional(),
});

const deploymentListResponseSchema = z.strictObject({
  data: z.strictObject({
    deployments: z.strictObject({
      edges: z.array(z.strictObject({ node: deploymentNodeSchema })),
      pageInfo: z.strictObject({ hasNextPage: z.boolean() }),
    }),
  }),
});

type Fetch = typeof fetch;
type DeploymentSnapshot = z.infer<typeof railwayDeploymentSnapshotSchema>;

type MethodContext = {
  globalArgs: z.infer<typeof globalArgumentsSchema>;
  signal: AbortSignal;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  logger: { info: (msg: string, props?: Record<string, unknown>) => void };
  _fetch?: Fetch;
};

async function queryRailway(
  fetcher: Fetch,
  apiUrl: string,
  token: string,
  authenticationMode: "project-token" | "bearer",
  query: string,
  variables: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetcher(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authenticationMode === "project-token"
        ? { "Project-Access-Token": token }
        : { "Authorization": `Bearer ${token}` }),
    },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Railway API request failed with HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  const errors = typeof body === "object" && body !== null
    ? (body as { errors?: unknown }).errors
    : undefined;
  if (Array.isArray(errors)) {
    const messages = errors.slice(0, 3).map((error) => {
      if (typeof error !== "object" || error === null) return "unknown error";
      const message = (error as { message?: unknown }).message;
      return typeof message === "string"
        ? message.slice(0, 500)
        : "unknown error";
    });
    throw new Error(
      `Railway GraphQL query returned errors: ${messages.join("; ")}`,
    );
  }
  return body;
}

const tokenScopeQuery = `
  query ProjectTokenScope {
    projectToken { projectId environmentId }
  }
`;

const deploymentsQuery = `
  query ServiceDeployments($input: DeploymentListInput!, $first: Int) {
    deployments(input: $input, first: $first) {
      edges {
        node { id status createdAt url staticUrl meta }
      }
      pageInfo { hasNextPage }
    }
  }
`;

function optionalMetaString(
  meta: Record<string, unknown>,
  key: string,
): string | null {
  const value = meta[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function paceRailwayQueries(signal: AbortSignal): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 125));
  if (signal.aborted) throw signal.reason;
}

/** Collects and validates one bounded deployment snapshot without mutations. */
export async function collectDeploymentSnapshot(
  rawArgs: unknown,
  context: MethodContext,
): Promise<DeploymentSnapshot> {
  const args = syncArgumentsSchema.parse(rawArgs);
  const globals = globalArgumentsSchema.parse(context.globalArgs);
  if (Boolean(globals.projectId) !== Boolean(globals.environmentId)) {
    throw new TypeError(
      "projectId and environmentId must be supplied together",
    );
  }
  if (globals.authenticationMode === "bearer" && !globals.projectId) {
    throw new TypeError(
      "bearer authentication requires projectId and environmentId",
    );
  }
  const fetcher = context._fetch ?? fetch;
  context.logger.info(
    "Syncing Railway deployments for {serviceCount} services",
    { serviceCount: globals.services.length },
  );
  const scope = globals.projectId && globals.environmentId
    ? { projectId: globals.projectId, environmentId: globals.environmentId }
    : tokenScopeResponseSchema.parse(
      await queryRailway(
        fetcher,
        globals.apiUrl,
        globals.token,
        globals.authenticationMode,
        tokenScopeQuery,
        {},
        context.signal,
      ),
    ).data.projectToken;

  const services: DeploymentSnapshot["services"] = [];
  for (const service of globals.services) {
    await paceRailwayQueries(context.signal);
    const response = deploymentListResponseSchema.parse(
      await queryRailway(
        fetcher,
        globals.apiUrl,
        globals.token,
        globals.authenticationMode,
        deploymentsQuery,
        {
          input: {
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            serviceId: service.id,
          },
          first: args.limitPerService,
        },
        context.signal,
      ),
    );
    const deployments = response.data.deployments.edges.map(({ node }) => {
      const meta = node.meta ?? {};
      return deploymentSchema.parse({
        id: node.id,
        status: node.status,
        createdAt: node.createdAt,
        url: node.url ?? null,
        staticUrl: node.staticUrl ?? null,
        source: {
          repository: optionalMetaString(meta, "repo"),
          branch: optionalMetaString(meta, "branch"),
          commitSha: optionalMetaString(meta, "commitHash"),
          commitMessage: optionalMetaString(meta, "commitMessage"),
        },
      });
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    services.push({
      ...service,
      deployments,
      truncated: response.data.deployments.pageInfo.hasNextPage,
    });
  }

  const snapshot = railwayDeploymentSnapshotSchema.parse({
    schemaVersion: "1.0",
    collectedAt: new Date().toISOString(),
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    services,
    truncated: services.some((service) => service.truncated),
    authority: {
      mode: "read-only",
      sideEffects: "none",
      mutationsExposed: false,
    },
  });
  context.logger.info(
    "Retained Railway deployment status for {serviceCount} services",
    { serviceCount: snapshot.services.length },
  );
  return snapshot;
}

/** Query-only Railway deployment model. */
export const model = {
  type: "@mgreten/railway-read",
  version: "2026.08.21.1",
  globalArguments: globalArgumentsSchema,
  resources: {
    deploymentSnapshot: {
      description:
        "Read-only Railway deployment status and source-commit correlation",
      schema: railwayDeploymentSnapshotSchema,
      lifetime: "30d" as const,
      garbageCollection: 100,
    },
  },
  methods: {
    syncDeployments: {
      description:
        "Read bounded deployment status for configured services using only Railway GraphQL queries",
      arguments: syncArgumentsSchema,
      execute: async (args: unknown, context: MethodContext) => ({
        dataHandles: [
          await context.writeResource(
            "deploymentSnapshot",
            "deployments-current",
            await collectDeploymentSnapshot(args, context),
          ),
        ],
      }),
    },
  },
};
