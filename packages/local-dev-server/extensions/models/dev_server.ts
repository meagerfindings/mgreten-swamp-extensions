import { z } from "npm:zod@4";
import {
  GlobalArgsSchema,
  type ServerStatus,
  start,
  status,
  StatusSchema,
  stop,
  validateWorkingDirectory,
} from "./dev_server_core.ts";

interface ModelContext {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  repoDir: string;
  signal: AbortSignal;
  logger: {
    info(message: string, properties?: Record<string, unknown>): void;
  };
  writeResource(
    specName: "status",
    name: "status-current",
    data: ServerStatus,
  ): Promise<{ name: string }>;
}

function writeStatus(context: ModelContext, state: ServerStatus) {
  return context.writeResource("status", "status-current", state);
}

async function workingDirectory(context: ModelContext) {
  return await validateWorkingDirectory(
    context.repoDir,
    context.globalArgs.workingDirectory ?? context.repoDir,
  );
}

/** Local-only development server lifecycle controller. */
export const model = {
  type: "@mgreten/local-dev-server",
  version: "2026.08.24.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    status: {
      description: "Most recently observed local development server state",
      schema: StatusSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  checks: {
    "local-working-directory": {
      description:
        "Ensure lifecycle commands are confined to the local Swamp repository.",
      labels: ["policy"],
      appliesTo: ["start", "stop"],
      execute: async (context: ModelContext) => {
        try {
          await workingDirectory(context);
          return { pass: true };
        } catch (error) {
          return { pass: false, errors: [String(error)] };
        }
      },
    },
  },
  methods: {
    status: {
      description:
        "Observe a local server using configured status and loopback health checks.",
      arguments: z.object({}).strict(),
      execute: async (_args: Record<string, never>, context: ModelContext) => {
        context.logger.info("Checking local development server status");
        const current = await status(
          context.globalArgs,
          await workingDirectory(context),
          undefined,
          context.signal,
        );
        context.logger.info("Checked local development server status", {
          running: current.running,
          health: current.health,
        });
        return { dataHandles: [await writeStatus(context, current)] };
      },
    },
    start: {
      description:
        "Run the configured local start command, then observe server state.",
      arguments: z.object({}).strict(),
      execute: async (_args: Record<string, never>, context: ModelContext) => {
        context.logger.info("Starting local development server");
        const result = await start(
          context.globalArgs,
          await workingDirectory(context),
          undefined,
          context.signal,
        );
        context.logger.info("Started local development server", {
          health: result.status.health,
        });
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
        context.logger.info("Stopping local development server");
        const result = await stop(
          context.globalArgs,
          await workingDirectory(context),
          undefined,
          context.signal,
        );
        context.logger.info("Stopped local development server", {
          health: result.status.health,
        });
        return {
          dataHandles: [
            await writeStatus(context, result.status),
          ],
        };
      },
    },
  },
};
