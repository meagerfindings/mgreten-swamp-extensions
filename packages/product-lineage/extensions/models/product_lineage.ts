/** Product-lineage persistence model. @module */
import { z } from "npm:zod@4";
import {
  evaluateProductLineage,
  ProductLineage,
  type ProductLineage as ProductLineageValue,
} from "./_lib/product_lineage_contracts.ts";

/** Published model version. */
export const PRODUCT_LINEAGE_MODEL_VERSION = "2026.08.23.1" as const;

/** This model needs no instance-level configuration. */
export const globalArgumentsSchema = z.strictObject({});
const SafeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
/** Arguments for persisting one producer-supplied lineage document. */
export const recordArgumentsSchema = z.strictObject({
  recordId: SafeId,
  lineage: z.unknown(),
});

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${
      Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
        left.localeCompare(right)
      ).map(([key, nested]) =>
        `${JSON.stringify(key)}:${canonicalJson(nested)}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

function fail(message: string, details?: unknown): never {
  throw new TypeError(
    details === undefined ? message : `${message}: ${JSON.stringify(details)}`,
  );
}

/** Validates an already-canonical lineage without deriving, filling, or reordering evidence. */
export function validateLineageForPersistence(
  input: unknown,
): ProductLineageValue {
  const result = evaluateProductLineage(input);
  if (!result.valid) fail("Invalid product lineage", result.diagnostics);
  if (canonicalJson(result.value) !== canonicalJson(input)) {
    fail(
      "Product lineage must already be canonical; normalization is prohibited",
    );
  }
  return result.value;
}

type WriteContext = {
  globalArgs: z.infer<typeof globalArgumentsSchema>;
  writeResource: (
    spec: string,
    name: string,
    data: ProductLineageValue,
  ) => Promise<unknown>;
};

/** Swamp model that validates and stores producer-owned lineage evidence only. */
export const model = {
  type: "@mgreten/product-lineage",
  version: PRODUCT_LINEAGE_MODEL_VERSION,
  globalArguments: globalArgumentsSchema,
  resources: {
    lineage: {
      description:
        "Validated, immutable product lineage with explicit produced or not-yet-produced stages.",
      schema: ProductLineage,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    record: {
      description:
        "Validate and persist producer-supplied lineage without creating stages or external side effects.",
      arguments: recordArgumentsSchema,
      execute: async (
        args: z.infer<typeof recordArgumentsSchema>,
        context: WriteContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const lineage = validateLineageForPersistence(args.lineage);
        const handle = await context.writeResource(
          "lineage",
          `lineage-${args.recordId}`,
          lineage,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
