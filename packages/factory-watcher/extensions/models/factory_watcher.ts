import { z } from "npm:zod@4";
import {
  factoryWatcherOutputSchema,
  watchFactory,
} from "./_lib/factory_watcher_contracts.ts";

/** The watcher requires no instance-wide configuration. */
export const globalArgumentsSchema = z.strictObject({});
const argumentsSchema = z.strictObject({
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
  input: z.unknown(),
});
type Context = {
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
};

/** Decision-only factory observation model. */
export const model = {
  type: "@mgreten/factory-watcher",
  version: "2026.08.23.1",
  globalArguments: globalArgumentsSchema,
  resources: {
    watch: {
      description: "Deterministic recommendation-only factory watch",
      schema: factoryWatcherOutputSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    watch: {
      description:
        "Analyze caller-supplied evidence and persist recommendations only.",
      arguments: argumentsSchema,
      execute: async (
        args: z.infer<typeof argumentsSchema>,
        context: Context,
      ) => {
        const output = watchFactory(args.input);
        if (output.watchId !== args.requestId) {
          throw new TypeError("requestId must exactly match input.watchId");
        }
        return {
          dataHandles: [
            await context.writeResource(
              "watch",
              `watch-${args.requestId}`,
              output,
            ),
          ],
        };
      },
    },
  },
};
