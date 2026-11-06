import { z } from "npm:zod@4";
import { roleContextRoleSchema } from "./_lib/role_context_pack_contracts.ts";
import { securityClassificationSchema } from "./_lib/security_classification_contracts.ts";

export const SOURCE_REGISTRY_MODEL_VERSION = "2026.08.21.1" as const;

const nonEmpty = z.string().trim().min(1);
export const registeredSourceLocatorSchema = z.string().trim().max(500).regex(
  /^(?:model:\/\/[a-z0-9][a-z0-9-]*(?:\/[A-Za-z0-9._:-]+)?(?:\?[A-Za-z][A-Za-z0-9]*=[A-Za-z0-9_-]+)?|repository:\/\/[A-Za-z0-9._/-]+)$/,
  "must be a registered model:// or repository:// locator",
);
const sourceClassSchema = z.enum([
  "roadmap",
  "todoist",
  "feedback",
  "better-stack",
  "github-pull-requests",
  "railway-deployments",
  "product-metrics",
  "pricing",
  "factory-records",
  "podcast-notes",
  "decisions",
  "founder-diary",
  "marketing-decision-context",
]);
const availabilitySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    reason: nonEmpty,
    exactLocator: registeredSourceLocatorSchema,
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: nonEmpty,
    exactLocator: z.null(),
  }),
]);

export const sourceRegistryEntrySchema = z.strictObject({
  sourceId: z.string().regex(/^moment-savor:[a-z0-9-]+$/),
  sourceClass: sourceClassSchema,
  resourceIdentity: nonEmpty,
  sensitivity: securityClassificationSchema,
  allowedRoles: z.array(roleContextRoleSchema).min(1),
  provenancePolicy: z.strictObject({
    collector: nonEmpty,
    method: nonEmpty,
    requiredFields: z.tuple([
      z.literal("resourceVersion"),
      z.literal("collectedAt"),
    ]),
  }),
  freshnessPolicy: z.strictObject({
    mode: z.enum(["immutable", "refresh-before-use"]),
    maxAgeSeconds: z.number().int().positive().nullable(),
  }),
  availability: availabilitySchema,
}).superRefine((entry, context) => {
  if (
    entry.freshnessPolicy.mode === "immutable" !==
      (entry.freshnessPolicy.maxAgeSeconds === null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["freshnessPolicy", "maxAgeSeconds"],
      message:
        "immutable sources require null maxAgeSeconds; refreshable sources require a bound",
    });
  }
  if (new Set(entry.allowedRoles).size !== entry.allowedRoles.length) {
    context.addIssue({
      code: "custom",
      path: ["allowedRoles"],
      message: "roles must be unique",
    });
  }
});

export const sourceRegistrySchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  entries: z.array(sourceRegistryEntrySchema).length(13),
  contentIncluded: z.literal(false),
  credentialsIncluded: z.literal(false),
  networkAccess: z.literal("none"),
}).superRefine((registry, context) => {
  const ids = new Set<string>();
  const classes = new Set<string>();
  registry.entries.forEach((entry, index) => {
    if (ids.has(entry.sourceId)) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "sourceId"],
        message: "duplicate sourceId",
      });
    }
    if (classes.has(entry.sourceClass)) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "sourceClass"],
        message: "duplicate sourceClass",
      });
    }
    ids.add(entry.sourceId);
    classes.add(entry.sourceClass);
  });
});

const roles = {
  planning: ["product-direction", "factory-planning", "review"],
  operations: ["operations", "review"],
  feedback: ["feedback-triage", "product-direction"],
} as const;
const provenance = (method: string) => ({
  collector: "swamp-local-data",
  method,
  requiredFields: ["resourceVersion", "collectedAt"] as const,
});
const refresh = (maxAgeSeconds: number) => ({
  mode: "refresh-before-use" as const,
  maxAgeSeconds,
});
const immutable = { mode: "immutable" as const, maxAgeSeconds: null };
const available = (exactLocator: string) => ({
  status: "available" as const,
  reason: "A project-local retrievable resource identity is registered.",
  exactLocator,
});
const unavailable = (reason: string) => ({
  status: "unavailable" as const,
  reason,
  exactLocator: null,
});

const entries = [
  {
    sourceId: "moment-savor:roadmap",
    sourceClass: "roadmap",
    resourceIdentity:
      "repository:docs/MOMENT_SAVOR_SWAMP_SOFTWARE_FACTORY_ROADMAP.md",
    sensitivity: "private-project",
    allowedRoles: [...roles.planning, "implementing"],
    provenancePolicy: provenance("git-blob-at-revision"),
    freshnessPolicy: refresh(86400),
    availability: available(
      "repository://docs/MOMENT_SAVOR_SWAMP_SOFTWARE_FACTORY_ROADMAP.md",
    ),
  },
  {
    sourceId: "moment-savor:todoist",
    sourceClass: "todoist",
    resourceIdentity:
      "swamp-model:moment-savor-todoist-launch-context/project:6gGWC42rvrxMH2v2",
    sensitivity: "private-project",
    allowedRoles: [...roles.planning, "implementing"],
    provenancePolicy: provenance("exact-workflow-sync-run-output-set"),
    freshnessPolicy: refresh(3600),
    availability: available(
      "model://moment-savor-todoist-launch-context",
    ),
  },
  {
    sourceId: "moment-savor:feedback",
    sourceClass: "feedback",
    resourceIdentity: "swamp-model:moment-savor-feedback-read",
    sensitivity: "customer-sensitive",
    allowedRoles: roles.feedback,
    provenancePolicy: provenance("swamp-data-latest-resource"),
    freshnessPolicy: refresh(86400),
    availability: available(
      "model://moment-savor-feedback-read/feedback-current",
    ),
  },
  {
    sourceId: "moment-savor:better-stack",
    sourceClass: "better-stack",
    resourceIdentity: "swamp-model:moment-savor-better-stack-read",
    sensitivity: "company-internal",
    allowedRoles: roles.operations,
    provenancePolicy: provenance("swamp-data-latest-resource"),
    freshnessPolicy: refresh(3600),
    availability: available(
      "model://moment-savor-better-stack-read/operational-current",
    ),
  },
  {
    sourceId: "moment-savor:github-pull-requests",
    sourceClass: "github-pull-requests",
    resourceIdentity: "swamp-model:moment-savor-github-submission",
    sensitivity: "private-project",
    allowedRoles: roles.operations,
    provenancePolicy: provenance("swamp-data-latest-resource"),
    freshnessPolicy: refresh(3600),
    availability: available(
      "model://moment-savor-github-submission/recent-prs-moment-savor",
    ),
  },
  {
    sourceId: "moment-savor:railway-deployments",
    sourceClass: "railway-deployments",
    resourceIdentity: "swamp-model:moment-savor-railway-read",
    sensitivity: "company-internal",
    allowedRoles: roles.operations,
    provenancePolicy: provenance("swamp-data-latest-resource"),
    freshnessPolicy: refresh(3600),
    availability: available(
      "model://moment-savor-railway-read/deployments-current",
    ),
  },
  {
    sourceId: "moment-savor:product-metrics",
    sourceClass: "product-metrics",
    resourceIdentity: "swamp-model:moment-savor-product-metrics",
    sensitivity: "company-internal",
    allowedRoles: roles.planning,
    provenancePolicy: provenance("swamp-data-latest-resource"),
    freshnessPolicy: refresh(86400),
    availability: available("model://moment-savor-product-metrics"),
  },
  {
    sourceId: "moment-savor:pricing",
    sourceClass: "pricing",
    resourceIdentity: "swamp-model:moment-savor-pricing-unit-economics",
    sensitivity: "private-project",
    allowedRoles: roles.planning,
    provenancePolicy: provenance("unregistered-source"),
    freshnessPolicy: refresh(86400),
    availability: unavailable(
      "A deterministic summary boundary exists, but no authoritative fresh pricing source is registered.",
    ),
  },
  {
    sourceId: "moment-savor:factory-records",
    sourceClass: "factory-records",
    resourceIdentity: "swamp-model:moment-savor-factory",
    sensitivity: "private-project",
    allowedRoles: ["factory-planning", "implementing", "review"],
    provenancePolicy: provenance("swamp-data-versioned-resource"),
    freshnessPolicy: immutable,
    availability: available("model://moment-savor-factory"),
  },
  {
    sourceId: "moment-savor:podcast-notes",
    sourceClass: "podcast-notes",
    resourceIdentity: "unregistered:podcast-notes",
    sensitivity: "private-project",
    allowedRoles: ["product-direction"],
    provenancePolicy: provenance("unregistered-source"),
    freshnessPolicy: refresh(86400),
    availability: unavailable(
      "No exact project-local locator or model resource is registered.",
    ),
  },
  {
    sourceId: "moment-savor:decisions",
    sourceClass: "decisions",
    resourceIdentity: "swamp-model:moment-savor-decision-record",
    sensitivity: "private-project",
    allowedRoles: [...roles.planning, "implementing"],
    provenancePolicy: provenance("swamp-data-latest-resource"),
    freshnessPolicy: refresh(86400),
    availability: available("model://moment-savor-decision-record"),
  },
  {
    sourceId: "moment-savor:founder-diary",
    sourceClass: "founder-diary",
    resourceIdentity: "unregistered:founder-diary",
    sensitivity: "private-project",
    allowedRoles: ["product-direction"],
    provenancePolicy: provenance("unregistered-source"),
    freshnessPolicy: refresh(86400),
    availability: unavailable(
      "No exact project-local locator or model resource is registered.",
    ),
  },
  {
    sourceId: "moment-savor:marketing-decision-context",
    sourceClass: "marketing-decision-context",
    resourceIdentity: "swamp-model:moment-savor-marketing-decision-context",
    sensitivity: "private-project",
    allowedRoles: ["marketing"],
    provenancePolicy: provenance("swamp-data-latest-resource"),
    freshnessPolicy: refresh(86400),
    availability: available(
      "model://moment-savor-marketing-decision-context",
    ),
  },
];

/** Returns metadata only, sorted by stable sourceId. It performs no retrieval. */
export function catalogSources() {
  return sourceRegistrySchema.parse({
    schemaVersion: "1.0",
    entries: [...entries].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    contentIncluded: false,
    credentialsIncluded: false,
    networkAccess: "none",
  });
}

export const model = {
  type: "@mgreten/moment-savor-source-registry",
  version: SOURCE_REGISTRY_MODEL_VERSION,
  upgrades: [{
    toVersion: SOURCE_REGISTRY_MODEL_VERSION,
    description:
      "Register retained read-only GitHub PR and Railway deployment evidence.",
    upgradeAttributes: (attributes: Record<string, unknown>) => attributes,
  }],
  globalArguments: z.strictObject({}),
  resources: {
    registry: {
      description: "Reference-only MomentSavor source registry",
      schema: sourceRegistrySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    catalog: {
      description:
        "Persist deterministic source metadata and honest availability without retrieving content",
      arguments: z.object({}),
      execute: async (
        _args: unknown,
        context: {
          writeResource: (
            spec: string,
            name: string,
            data: unknown,
          ) => Promise<unknown>;
        },
      ) => ({
        dataHandles: [
          await context.writeResource("registry", "current", catalogSources()),
        ],
      }),
    },
  },
};
