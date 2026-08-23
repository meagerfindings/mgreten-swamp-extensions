import { z } from "npm:zod@4";
import {
  GlobalArgsSchema,
  type ServerStatus,
  start,
  status,
  StatusSchema,
  stop,
} from "./dev_server_core.ts";

interface ModelContext {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  repoDir: string;
  writeResource(
    specName: "status",
    name: "status-current",
    data: ServerStatus,
  ): Promise<{ name: string }>;
}

function writeStatus(context: ModelContext, state: ServerStatus) {
  return context.writeResource("status", "status-current", state);
}

/** Local-only development server lifecycle controller. */
export const model = {
  type: "@mgreten/local-dev-server",
  version: "2026.08.23.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    status: {
      description: "Most recently observed local development server state",
      schema: StatusSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    status: {
      description:
        "Observe a local server using configured status and loopback health checks.",
      arguments: z.object({}).strict(),
      execute: async (_args: Record<string, never>, context: ModelContext) => {
        const current = await status(
          context.globalArgs,
          context.globalArgs.workingDirectory ?? context.repoDir,
        );
        return { dataHandles: [await writeStatus(context, current)] };
      },
    },
    start: {
      description:
        "Run the configured local start command, then observe server state.",
      arguments: z.object({}).strict(),
      execute: async (_args: Record<string, never>, context: ModelContext) => {
        const result = await start(
          context.globalArgs,
          context.globalArgs.workingDirectory ?? context.repoDir,
        );
        return {
          dataHandles: [
            await writeStatus(context, result.status),
          ],
        };
      },
    },
    stop: {
      description:
        "Run the configured local stop command, then observe server state.",
      arguments: z.object({}).strict(),
      execute: async (_args: Record<string, never>, context: ModelContext) => {
        const result = await stop(
          context.globalArgs,
          context.globalArgs.workingDirectory ?? context.repoDir,
        );
        return {
          dataHandles: [
            await writeStatus(context, result.status),
          ],
        };
      },
    },
  },
};
