import { z } from "npm:zod@4";
import {
  AdbBinarySchema,
  AdbReadinessSchema,
  AdbTargetSchema,
  checkAdbVersion,
  type CommandRunner,
  runDenoCommand,
} from "./_lib/adb.ts";
import { collectInventory, DeviceInventorySchema } from "./_lib/inventory.ts";
import {
  applyCleanup as applyCleanupPlan,
  ApplyCleanupArgsSchema,
  type CleanupMethodContext,
  CleanupResourceSchemas,
  type CleanupRuntime,
  prepareCleanup as prepareCleanupPlan,
  PrepareCleanupArgsSchema,
  restoreCleanup as restoreCleanupPlan,
  RestoreCleanupArgsSchema,
  verifyCleanup as verifyCleanupPlan,
  VerifyCleanupArgsSchema,
} from "./_lib/cleanup.ts";
import {
  identifySony,
  type SonyFetcher,
  SonyIdentifyArgsSchema,
  SonyInterfaceSchema,
} from "./_lib/sony.ts";

const GlobalArgsSchema = z.object({
  adbBinary: AdbBinarySchema.optional().describe(
    "User-selected local ADB executable; required by ADB methods only.",
  ),
  commandTimeoutMs: z.number().int().min(500).max(30_000).default(10_000),
  sonyTimeoutMs: z.number().int().min(500).max(30_000).default(8_000),
}).strict();

const SonyIdentificationSchema = SonyInterfaceSchema.extend({
  queriedAt: z.iso.datetime(),
});

const AdbReadinessResourceSchema = AdbReadinessSchema.extend({
  checkedAt: z.iso.datetime(),
});

const InventoryArgsSchema = z.object({
  target: AdbTargetSchema.describe(
    "Already connected IPv4:port ADB target; this method never connects or pairs.",
  ),
  hostServerReviewed: z.literal(true).describe(
    "Confirm that an established ADB session is authorized and the compatible host-server lifecycle has been reviewed.",
  ),
});
const NoArgsSchema = z.object({});

const RESOURCE_INSTANCE_NAMES = {
  sonyIdentification: "sony-identity",
  adbReadiness: "adb-readiness",
  deviceInventory: "device-inventory",
} as const;

type MethodContext = CleanupMethodContext & {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
};

type RuntimeMethodGlobals = z.infer<typeof GlobalArgsSchema>;
type SonyMethodArgs =
  & z.infer<typeof SonyIdentifyArgsSchema>
  & RuntimeMethodGlobals;
type InventoryMethodArgs =
  & z.infer<typeof InventoryArgsSchema>
  & RuntimeMethodGlobals;

interface AndroidTvDependencies {
  readonly fetcher?: SonyFetcher;
  readonly commandRunner?: CommandRunner;
  readonly now?: () => Date;
  readonly createCleanupPlanId?: () => string;
}

function requireResourceWriter(
  context: MethodContext,
): NonNullable<MethodContext["writeResource"]> {
  if (!context.writeResource) {
    throw new Error(
      "Swamp writeResource is required to persist model results.",
    );
  }
  return context.writeResource.bind(context);
}

function readGlobalArgs(
  context: MethodContext,
): z.infer<typeof GlobalArgsSchema> {
  return GlobalArgsSchema.parse(context.globalArgs);
}

function configuredAdbBinary(context: MethodContext): {
  readonly executable: string;
  readonly timeoutMs: number;
} {
  const globalArgs = readGlobalArgs(context);
  if (!globalArgs.adbBinary) {
    throw new Error(
      "Set the local adbBinary global argument before using an ADB method.",
    );
  }
  return {
    executable: globalArgs.adbBinary,
    timeoutMs: globalArgs.commandTimeoutMs,
  };
}

function cleanupRuntime(
  context: MethodContext,
  commandRunner: CommandRunner,
  now: () => Date,
  createPlanId?: () => string,
): CleanupRuntime {
  const { executable, timeoutMs } = configuredAdbBinary(context);
  return {
    adbBinary: executable,
    timeoutMs,
    commandRunner,
    now,
    ...(createPlanId ? { createPlanId } : {}),
  };
}

/** Create the model with injectable transports for local contract tests. */
export function createAndroidTvModel(dependencies: AndroidTvDependencies = {}) {
  const fetcher = dependencies.fetcher ?? fetch;
  const commandRunner = dependencies.commandRunner ?? runDenoCommand;
  const now = dependencies.now ?? (() => new Date());

  return {
    type: "@mgreten/android-tv",
    version: "2026.11.06.1",
    globalArguments: GlobalArgsSchema,
    resources: {
      cleanupBaseline: {
        description:
          "Immutable, private package-state baseline bound to one exact target and Android build.",
        schema: CleanupResourceSchemas.cleanupBaseline,
        lifetime: "infinite" as const,
        garbageCollection: 10_000 as const,
      },
      cleanupPlan: {
        description:
          "Durable per-package cleanup intent, outcome, and recovery journal.",
        schema: CleanupResourceSchemas.cleanupPlan,
        lifetime: "infinite" as const,
        garbageCollection: 10_000 as const,
      },
      cleanupActivePlan: {
        description:
          "Pointer to the one active cleanup plan for this behavior definition.",
        schema: CleanupResourceSchemas.cleanupActivePlan,
        lifetime: "infinite" as const,
        garbageCollection: 10_000 as const,
      },
      sonyIdentification: {
        description:
          "Validated public Sony BRAVIA interface identity response.",
        schema: SonyIdentificationSchema,
        lifetime: "30d" as const,
        garbageCollection: 10,
      },
      adbReadiness: {
        description: "Local ADB client version and readiness check result.",
        schema: AdbReadinessResourceSchema,
        lifetime: "30d" as const,
        garbageCollection: 10,
      },
      deviceInventory: {
        description:
          "Minimal read-only Android device inventory for an existing ADB target.",
        schema: DeviceInventorySchema,
        lifetime: "7d" as const,
        garbageCollection: 3,
      },
    },
    methods: {
      identifySony: {
        description:
          "Read Sony BRAVIA getInterfaceInformation from the fixed /sony/system endpoint.",
        arguments: SonyIdentifyArgsSchema,
        execute: async (
          args: SonyMethodArgs,
          context: MethodContext,
        ) => {
          const globalArgs = readGlobalArgs(context);
          const validatedArgs = SonyIdentifyArgsSchema.parse(args);
          context.logger.info("Reading Sony BRAVIA interface information");
          const identity = await identifySony(
            validatedArgs.host,
            globalArgs.sonyTimeoutMs,
            fetcher,
          );
          const handle = await requireResourceWriter(context)(
            "sonyIdentification",
            RESOURCE_INSTANCE_NAMES.sonyIdentification,
            {
              ...identity,
              queriedAt: now().toISOString(),
            },
          );
          context.logger.info(
            "Sony BRAVIA interface information read successfully",
          );
          return { dataHandles: [handle] };
        },
      },
      checkAdbVersion: {
        description:
          "Check the configured local ADB executable without querying connected devices.",
        arguments: NoArgsSchema,
        execute: async (
          _args: RuntimeMethodGlobals,
          context: MethodContext,
        ) => {
          const { executable, timeoutMs } = configuredAdbBinary(context);
          NoArgsSchema.parse(_args);
          context.logger.info("Checking local ADB client version");
          const readiness = await checkAdbVersion(
            executable,
            timeoutMs,
            commandRunner,
          );
          const handle = await requireResourceWriter(context)(
            "adbReadiness",
            RESOURCE_INSTANCE_NAMES.adbReadiness,
            {
              ...readiness,
              checkedAt: now().toISOString(),
            },
          );
          context.logger.info("Local ADB client version check completed", {
            clientVersion: readiness.clientVersion,
          });
          return { dataHandles: [handle] };
        },
      },
      inventory: {
        description:
          "After separately reviewing and authorizing the ADB host-server lifecycle, read selected Android 7-compatible properties, user-0 package states, RAM, and /data capacity from an already connected explicit host:port target. ADB may start or restart its host server.",
        arguments: InventoryArgsSchema,
        execute: async (
          args: InventoryMethodArgs,
          context: MethodContext,
        ) => {
          const { executable, timeoutMs } = configuredAdbBinary(context);
          const validatedArgs = InventoryArgsSchema.parse(args);
          context.logger.info(
            "Reading minimal Android TV inventory from an existing ADB target",
          );
          const inventory = await collectInventory(
            executable,
            validatedArgs.target,
            timeoutMs,
            commandRunner,
            now,
          );
          const handle = await requireResourceWriter(context)(
            "deviceInventory",
            RESOURCE_INSTANCE_NAMES.deviceInventory,
            inventory,
          );
          context.logger.info("Minimal Android TV inventory read completed", {
            enabledPackageCount: inventory.enabledPackages.length,
            disabledPackageCount: inventory.disabledPackages.length,
          });
          return { dataHandles: [handle] };
        },
      },
      prepareCleanup: {
        kind: "update" as const,
        description:
          "Prepare a privately persisted exact-build baseline and one active cleanup plan; no package state is changed.",
        arguments: PrepareCleanupArgsSchema,
        execute: async (
          args: z.infer<typeof PrepareCleanupArgsSchema> & RuntimeMethodGlobals,
          context: MethodContext,
        ) => {
          context.logger.info("Preparing one bounded Android cleanup plan");
          return await prepareCleanupPlan(
            args,
            cleanupRuntime(
              context,
              commandRunner,
              now,
              dependencies.createCleanupPlanId,
            ),
            context,
          );
        },
      },
      applyCleanup: {
        kind: "update" as const,
        description:
          "Journal durable intent, disable exactly one approved user-0 package, and verify its resulting state.",
        arguments: ApplyCleanupArgsSchema,
        execute: async (
          args: z.infer<typeof ApplyCleanupArgsSchema> & RuntimeMethodGlobals,
          context: MethodContext,
        ) => {
          context.logger.info("Applying one approved Android package change");
          return await applyCleanupPlan(
            args,
            cleanupRuntime(
              context,
              commandRunner,
              now,
              dependencies.createCleanupPlanId,
            ),
            context,
          );
        },
      },
      verifyCleanup: {
        kind: "update" as const,
        description:
          "Read one approved package state and persist its verification result without changing the device.",
        arguments: VerifyCleanupArgsSchema,
        execute: async (
          args: z.infer<typeof VerifyCleanupArgsSchema> & RuntimeMethodGlobals,
          context: MethodContext,
        ) => {
          context.logger.info("Verifying one Android cleanup package state");
          return await verifyCleanupPlan(
            args,
            cleanupRuntime(
              context,
              commandRunner,
              now,
              dependencies.createCleanupPlanId,
            ),
            context,
          );
        },
      },
      restoreCleanup: {
        kind: "update" as const,
        description:
          "Restore only one previously attempted package to its exact recorded user-0 enabled state after fresh drift checks.",
        arguments: RestoreCleanupArgsSchema,
        execute: async (
          args: z.infer<typeof RestoreCleanupArgsSchema> & RuntimeMethodGlobals,
          context: MethodContext,
        ) => {
          context.logger.info(
            "Restoring one previously attempted Android package",
          );
          return await restoreCleanupPlan(
            args,
            cleanupRuntime(
              context,
              commandRunner,
              now,
              dependencies.createCleanupPlanId,
            ),
            context,
          );
        },
      },
    },
  };
}

const modelDefinition = createAndroidTvModel();

/** Swamp entry point for TV diagnostics and bounded cleanup operations. */
export const model = {
  ...modelDefinition,
  type: "@mgreten/android-tv",
  version: "2026.11.06.1",
};
