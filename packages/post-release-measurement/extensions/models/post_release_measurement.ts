import { z } from "npm:zod@4";
import {
  PostReleaseMeasurementPlan,
  validatePostReleaseMeasurementPlan,
} from "./_lib/post_release_measurement_contracts.ts";

/** Published CalVer version for this model definition. */
export const POST_RELEASE_MEASUREMENT_MODEL_VERSION = "2026.08.23.1" as const;
const SafeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
/** Input accepted by the persistence-only record method. */
export const recordArgumentsSchema = z.strictObject({
  recordId: SafeId,
  plan: z.unknown(),
});

/** Validates the supplied plan before it can be persisted. */
export function planForPersistence(input: unknown) {
  const result = validatePostReleaseMeasurementPlan(input);
  if (!result.valid) {
    throw new TypeError(
      `Invalid post-release measurement plan: ${
        JSON.stringify(result.diagnostics)
      }`,
    );
  }
  return result.value;
}

/** Records a plan; it never observes production, releases, or makes decisions. */
export const model = {
  type: "@mgreten/post-release-measurement",
  version: POST_RELEASE_MEASUREMENT_MODEL_VERSION,
  globalArguments: z.strictObject({}),
  resources: {
    plan: {
      description:
        "Human-controlled measurement declaration bound to one exact release and work order",
      schema: PostReleaseMeasurementPlan,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    record: {
      description:
        "Validate and persist a supplied plan without observing production, releasing, or making its decisions.",
      arguments: recordArgumentsSchema,
      execute: async (
        args: z.infer<typeof recordArgumentsSchema>,
        context: {
          writeResource(
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ): Promise<unknown>;
        },
      ) => {
        const plan = planForPersistence(args.plan);
        const handle = await context.writeResource(
          "plan",
          `plan-${args.recordId}`,
          plan,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
