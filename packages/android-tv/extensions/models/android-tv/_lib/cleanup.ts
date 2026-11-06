import { z } from "npm:zod@4";
import { AdbBinarySchema, AdbTargetSchema, type CommandRunner } from "./adb.ts";

const PackageNameSchema = z.string().min(1).max(255).regex(
  /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/,
);

const SupportedOriginalStateSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(3),
]);

const ObservedStateSchema = z.number().int().min(0).max(4);

export const Android7BuildSchema = z.object({
  androidProductModel: z.string().min(1).max(256),
  androidRelease: z.literal("7.0"),
  androidSdkLevel: z.literal(24),
  buildDisplayId: z.string().min(1).max(128),
}).strict();

export type Android7Build = z.infer<typeof Android7BuildSchema>;

const PrepareApprovalSchema = z.object({
  target: AdbTargetSchema,
  expectedBuild: Android7BuildSchema,
  packages: z.array(PackageNameSchema).min(1).max(3),
}).strict();

export const PrepareCleanupArgsSchema = z.object({
  target: AdbTargetSchema,
  expectedBuild: Android7BuildSchema,
  packages: z.array(PackageNameSchema).min(1).max(3),
  approval: PrepareApprovalSchema,
  hostServerReviewed: z.literal(true),
});

const PackageApprovalSchema = z.object({
  planId: z.uuid(),
  packageName: PackageNameSchema,
  target: AdbTargetSchema,
  build: Android7BuildSchema,
}).strict();

const OnePackageArgsSchema = z.object({
  planId: z.uuid(),
  packageName: PackageNameSchema,
  approval: PackageApprovalSchema,
  hostServerReviewed: z.literal(true),
});

export const ApplyCleanupArgsSchema = OnePackageArgsSchema;
export const VerifyCleanupArgsSchema = OnePackageArgsSchema;

export const RestoreCleanupArgsSchema = OnePackageArgsSchema.extend({
  retryPreviousRestore: z.boolean().default(false),
});

const BaselinePackageSchema = z.object({
  packageName: PackageNameSchema,
  versionCode: z.string().regex(/^\d{1,20}$/),
  appUid: z.number().int().min(0).max(2_147_483_647),
  systemApp: z.boolean(),
  persistentApp: z.literal(false),
  sharedUser: z.literal(false),
  originalState: SupportedOriginalStateSchema,
}).strict();

export const CleanupBaselineSchema = z.object({
  planId: z.uuid(),
  target: AdbTargetSchema,
  build: Android7BuildSchema,
  packages: z.array(BaselinePackageSchema).min(1).max(3),
  capturedAt: z.iso.datetime(),
}).strict();

const DisableStatusSchema = z.enum([
  "notAttempted",
  "attempting",
  "disabled",
  "unknown",
  "alreadyDisabled",
]);

const RestoreStatusSchema = z.enum([
  "pending",
  "notNeeded",
  "attempting",
  "restored",
  "unknown",
  "conflict",
]);

const RestoreAttemptSchema = z.object({
  status: z.enum(["attempting", "restored", "unknown", "conflict"]),
  intentAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
  exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(),
  observedState: ObservedStateSchema.optional(),
}).strict();

const VerificationSchema = z.object({
  status: z.enum(["originalState", "disabledUser", "drift"]),
  observedState: ObservedStateSchema.optional(),
  checkedAt: z.iso.datetime(),
}).strict();

const CleanupJournalEntrySchema = z.object({
  packageName: PackageNameSchema,
  disableStatus: DisableStatusSchema,
  disableIntentAt: z.iso.datetime().optional(),
  disableCompletedAt: z.iso.datetime().optional(),
  disableExitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647)
    .optional(),
  disableObservedState: ObservedStateSchema.optional(),
  restoreStatus: RestoreStatusSchema,
  restoreAttempts: z.array(RestoreAttemptSchema).max(20),
  verification: VerificationSchema.optional(),
}).strict();

export const CleanupPlanSchema = z.object({
  planId: z.uuid(),
  baselineInstanceName: z.string().min(1).max(128),
  baselineVersion: z.number().int().min(1),
  phase: z.enum(["prepared", "active", "restoring", "restored"]),
  journal: z.array(CleanupJournalEntrySchema).min(1).max(3),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();

const CleanupActivePointerSchema = z.object({
  planId: z.uuid(),
  planInstanceName: z.string().min(1).max(128),
  planVersion: z.number().int().min(1),
  updatedAt: z.iso.datetime(),
}).strict();

export const CleanupResourceSchemas = {
  cleanupBaseline: CleanupBaselineSchema,
  cleanupPlan: CleanupPlanSchema,
  cleanupActivePlan: CleanupActivePointerSchema,
} as const;

export interface CleanupDataHandle {
  readonly specName: string;
  readonly name: string;
  readonly kind: "resource" | "file";
  readonly version: number;
}

export interface CleanupMethodContext {
  readonly readResource?: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  readonly writeResource?: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<CleanupDataHandle>;
  readonly logger: {
    info: (message: string, properties?: Record<string, unknown>) => void;
  };
}

export interface CleanupRuntime {
  readonly adbBinary: string;
  readonly timeoutMs: number;
  readonly commandRunner: CommandRunner;
  readonly now: () => Date;
  readonly createPlanId?: () => string;
}

interface PackageObservation {
  readonly packageName: string;
  readonly versionCode: string;
  readonly appUid: number;
  readonly systemApp: boolean;
  readonly persistentApp: boolean;
  readonly sharedUser: boolean;
  readonly enabledState: number;
}

interface LoadedPlan {
  readonly pointer: z.infer<typeof CleanupActivePointerSchema>;
  readonly plan: z.infer<typeof CleanupPlanSchema>;
  readonly baseline: z.infer<typeof CleanupBaselineSchema>;
}

const ACTIVE_PLAN_INSTANCE = "cleanup-active-plan";
const COMMAND_OUTPUT_LIMIT = 64 * 1024;
const ROLE_OUTPUT_LIMIT = 32 * 1024;
const MAX_RESTORE_ATTEMPTS = 5;

// A system-app flag alone is deliberately not a refusal: Android TV candidates
// are often preloaded system apps. Reserved platform UIDs, persistent/shared
// apps, protected categories, and live role-bearing packages are refused.
const PROTECTED_PACKAGE_NAMES = new Set([
  "com.android.settings",
  "com.android.systemui",
  "com.android.tv.settings",
  "com.google.android.apps.mediashell",
  "com.google.android.gms",
  "com.google.android.gsf",
  "com.google.android.gsf.login",
  "com.google.android.inputmethod.latin",
  "com.google.android.leanbacklauncher",
  "com.google.android.tvlauncher",
  "com.amazon.amazonvideo.livingroom",
  "com.amazon.aiv.us",
  "org.pbskids.video",
]);

const PROTECTED_PACKAGE_PREFIXES = [
  "com.android.",
  "com.sony.dtv.",
  "com.sonyericsson.",
  "com.mediatek.",
  "com.amazon.",
  "org.pbskids.",
] as const;

const ROLE_QUERIES = [
  {
    kind: "activities",
    args: [
      "query-activities",
      "--components",
      "--user",
      "0",
      "-a",
      "android.intent.action.MAIN",
      "-c",
      "android.intent.category.HOME",
    ],
    label: "Home activity",
  },
  {
    kind: "activities",
    args: [
      "query-activities",
      "--components",
      "--user",
      "0",
      "-a",
      "android.settings.SETTINGS",
    ],
    label: "Settings activity",
  },
  {
    kind: "services",
    args: [
      "query-services",
      "--components",
      "--user",
      "0",
      "-a",
      "android.media.tv.TvInputService",
    ],
    label: "TV input service",
  },
  {
    kind: "services",
    args: [
      "query-services",
      "--components",
      "--user",
      "0",
      "-a",
      "android.view.InputMethod",
    ],
    label: "input method service",
  },
] as const;

function timestamp(runtime: CleanupRuntime): string {
  return runtime.now().toISOString();
}

function requireReadResource(
  context: CleanupMethodContext,
): NonNullable<CleanupMethodContext["readResource"]> {
  if (!context.readResource) {
    throw new Error("Swamp readResource is required for cleanup recovery.");
  }
  return context.readResource.bind(context);
}

function requireWriteResource(
  context: CleanupMethodContext,
): NonNullable<CleanupMethodContext["writeResource"]> {
  if (!context.writeResource) {
    throw new Error("Swamp writeResource is required for cleanup recovery.");
  }
  return context.writeResource.bind(context);
}

function checkOutputSize(
  stdout: string,
  stderr: string,
  maximum: number,
): void {
  const encoder = new TextEncoder();
  if (
    encoder.encode(stdout).byteLength > maximum ||
    encoder.encode(stderr).byteLength > maximum
  ) {
    throw new Error("ADB output exceeded the cleanup read limit.");
  }
}

async function runFixedCommand(
  runtime: CleanupRuntime,
  target: string,
  args: readonly string[],
  maximumOutputBytes = COMMAND_OUTPUT_LIMIT,
): Promise<Awaited<ReturnType<CommandRunner>>> {
  const result = await runtime.commandRunner(
    AdbBinarySchema.parse(runtime.adbBinary),
    ["-s", AdbTargetSchema.parse(target), ...args],
    runtime.timeoutMs,
    maximumOutputBytes,
  );
  checkOutputSize(result.stdout, result.stderr, maximumOutputBytes);
  return result;
}

async function readFixedCommand(
  runtime: CleanupRuntime,
  target: string,
  args: readonly string[],
  maximumOutputBytes = COMMAND_OUTPUT_LIMIT,
): Promise<string> {
  const result = await runFixedCommand(
    runtime,
    target,
    args,
    maximumOutputBytes,
  );
  if (!result.success || result.exitCode !== 0) {
    throw new Error("ADB cleanup preflight read failed.");
  }
  return result.stdout;
}

function checkedProperty(value: string, name: string, maximum: number): string {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 || trimmed.length > maximum ||
    Array.from(trimmed).some((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error(`Android ${name} property was malformed.`);
  }
  return trimmed;
}

async function readProperty(
  runtime: CleanupRuntime,
  target: string,
  property: string,
  maximum: number,
): Promise<string> {
  return checkedProperty(
    await readFixedCommand(runtime, target, ["shell", "getprop", property]),
    property,
    maximum,
  );
}

async function readBuild(
  runtime: CleanupRuntime,
  target: string,
): Promise<Android7Build> {
  const [androidProductModel, androidRelease, sdkText, buildDisplayId] =
    await Promise.all([
      readProperty(runtime, target, "ro.product.model", 256),
      readProperty(runtime, target, "ro.build.version.release", 64),
      readProperty(runtime, target, "ro.build.version.sdk", 4),
      readProperty(runtime, target, "ro.build.display.id", 128),
    ]);
  if (sdkText !== "24") {
    throw new Error(
      "Cleanup methods require the verified Android 7/API 24 build.",
    );
  }
  return Android7BuildSchema.parse({
    androidProductModel,
    androidRelease,
    androidSdkLevel: 24,
    buildDisplayId,
  });
}

function sameBuild(left: Android7Build, right: Android7Build): boolean {
  return left.androidProductModel === right.androidProductModel &&
    left.androidRelease === right.androidRelease &&
    left.androidSdkLevel === right.androidSdkLevel &&
    left.buildDisplayId === right.buildDisplayId;
}

function parseComponentPackages(output: string, label: string): Set<string> {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(
    Boolean,
  );
  if (
    lines.length === 0 ||
    lines.some((line) =>
      /^(?:No activity found|No activities found|No services found)\.?$/i.test(
        line,
      )
    )
  ) {
    throw new Error(`Android ${label} role check was inconclusive.`);
  }
  if (lines.length > 128) {
    throw new Error(`Android ${label} role output was too broad.`);
  }

  const packages = new Set<string>();
  for (const line of lines) {
    const component = /^([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\/[A-Za-z0-9_.$]+$/
      .exec(line);
    if (!component) {
      throw new Error(`Android ${label} role output was malformed.`);
    }
    packages.add(PackageNameSchema.parse(component[1]));
  }
  if (packages.size === 0) {
    throw new Error(`Android ${label} role check was inconclusive.`);
  }
  return packages;
}

async function readProtectedRolePackages(
  runtime: CleanupRuntime,
  target: string,
): Promise<Set<string>> {
  const packages = new Set<string>();
  for (const query of ROLE_QUERIES) {
    const output = await readFixedCommand(
      runtime,
      target,
      ["shell", "cmd", "package", ...query.args],
      ROLE_OUTPUT_LIMIT,
    );
    for (
      const packageName of parseComponentPackages(output, query.label)
    ) packages.add(packageName);
  }
  return packages;
}

function packageBlockHeader(line: string): string | undefined {
  return /^\s*Package \[([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\] \([^)]*\):\s*$/
    .exec(line)?.[1];
}

function exactlyOneMatch<T>(matches: T[], message: string): T {
  if (matches.length !== 1) throw new Error(message);
  return matches[0];
}

function exactlyOneConsistentMatch<T>(matches: T[], message: string): T {
  if (matches.length === 0) throw new Error(message);
  const first = matches[0];
  if (matches.some((match) => match !== first)) throw new Error(message);
  return first;
}

function exactlyOneTokenField(
  lines: readonly string[],
  field: string,
  pattern: string,
  allowRepeatedIdentical = false,
): string {
  const expression = new RegExp(`\\b${field}=([^\\s]*)`, "g");
  const matches = lines.flatMap((line) =>
    [...line.matchAll(expression)].map((match) => match[1] ?? "")
  );
  const message = `Selected package ${field} field was absent or ambiguous.`;
  const value = allowRepeatedIdentical
    ? exactlyOneConsistentMatch(matches, message)
    : exactlyOneMatch(matches, message);
  if (!new RegExp(`^(?:${pattern})$`).test(value)) {
    throw new Error(`Selected package ${field} field was malformed.`);
  }
  return value;
}

function exactlyOneLineField(
  lines: readonly string[],
  field: string,
  pattern: string,
  allowRepeatedIdentical = false,
): string {
  const fieldLines = lines.filter((line) =>
    new RegExp(`\\b${field}=`).test(line)
  );
  const message = `Selected package ${field} field was absent or ambiguous.`;
  if (fieldLines.length === 0) {
    throw new Error(message);
  }
  const expression = new RegExp(`^\\s*${field}=(${pattern})\\s*$`);
  const values = fieldLines.map((line) => {
    const match = expression.exec(line);
    if (match?.[1] === undefined) {
      throw new Error(`Selected package ${field} field was malformed.`);
    }
    return match[1];
  });
  return allowRepeatedIdentical
    ? exactlyOneConsistentMatch(values, message)
    : exactlyOneMatch(values, message);
}

function parsePackageDump(
  output: string,
  expectedPackage: string,
): PackageObservation {
  const lines = output.split(/\r?\n/);
  const packagesSections = lines.flatMap((line, index) =>
    line.trim() === "Packages:" ? [index] : []
  );
  const packagesStart = exactlyOneMatch(
    packagesSections,
    "Selected package dump had no unambiguous active Packages section.",
  );
  const hiddenStart = lines.findIndex((line, index) =>
    index > packagesStart && line.trim() === "Hidden system packages:"
  );
  const activeEnd = hiddenStart < 0 ? lines.length : hiddenStart;
  const activeLines = lines.slice(packagesStart + 1, activeEnd);
  const packageHeaders = activeLines.flatMap((line, index) => {
    const name = packageBlockHeader(line);
    return name === undefined ? [] : [{ index, name }];
  });
  const targetBlocks = packageHeaders.filter(({ name }) =>
    name === expectedPackage
  );
  if (packageHeaders.length !== 1 || targetBlocks.length !== 1) {
    throw new Error("Selected package dump was absent or ambiguous.");
  }

  const start = targetBlocks[0].index;
  const blockLines = activeLines.slice(start + 1);
  const versionCode = exactlyOneTokenField(
    blockLines,
    "versionCode",
    "\\d{1,20}",
  );
  const appUidText = exactlyOneLineField(
    blockLines,
    "userId",
    "\\d{1,10}",
    true,
  );
  const appUid = Number(appUidText);
  if (!Number.isSafeInteger(appUid)) {
    throw new Error("Selected package UID was malformed.");
  }

  const flagsText = exactlyOneLineField(
    blockLines,
    "flags",
    "\\[[A-Z0-9_ ]*\\]",
    true,
  ).slice(1, -1);
  const flags = new Set(
    flagsText.trim().length === 0 ? [] : flagsText.trim().split(/\s+/),
  );
  const userZeroLines = blockLines.filter((line) => /^\s*User 0:/.test(line));
  if (userZeroLines.length === 0) {
    throw new Error("Selected package user-0 state was absent or ambiguous.");
  }
  const installed = exactlyOneTokenField(
    userZeroLines,
    "installed",
    "true|false",
    true,
  );
  const hidden = exactlyOneTokenField(
    userZeroLines,
    "hidden",
    "true|false",
    true,
  );
  const suspended = exactlyOneTokenField(
    userZeroLines,
    "suspended",
    "true|false",
    true,
  );
  const enabledText = exactlyOneTokenField(
    userZeroLines,
    "enabled",
    "\\d+",
    true,
  );
  if (
    installed !== "true" || hidden !== "false" || suspended !== "false" ||
    enabledText === undefined
  ) {
    throw new Error(
      "Selected package user-0 installation state was unsafe or malformed.",
    );
  }
  const enabledState = Number(enabledText);
  if (!Number.isInteger(enabledState) || enabledState < 0 || enabledState > 4) {
    throw new Error("Selected package user-0 enabled state was unsupported.");
  }

  return {
    packageName: expectedPackage,
    versionCode,
    appUid,
    systemApp: flags.has("SYSTEM"),
    persistentApp: flags.has("PERSISTENT"),
    sharedUser: blockLines.some((line) => /^\s*sharedUser=/.test(line)),
    enabledState,
  };
}

async function readPackageObservation(
  runtime: CleanupRuntime,
  target: string,
  packageName: string,
): Promise<PackageObservation> {
  const output = await readFixedCommand(runtime, target, [
    "shell",
    "dumpsys",
    "package",
    PackageNameSchema.parse(packageName),
  ]);
  return parsePackageDump(output, packageName);
}

function isBuiltInProtected(packageName: string): boolean {
  return PROTECTED_PACKAGE_NAMES.has(packageName) ||
    PROTECTED_PACKAGE_PREFIXES.some((prefix) => packageName.startsWith(prefix));
}

function assertEligible(
  observation: PackageObservation,
  protectedRoles: ReadonlySet<string>,
): void {
  if (
    observation.sharedUser || observation.appUid < 10_000 ||
    observation.persistentApp
  ) {
    throw new Error(
      "Selected package has shared, persistent, or reserved-UID status.",
    );
  }
  if (
    isBuiltInProtected(observation.packageName) ||
    protectedRoles.has(observation.packageName)
  ) {
    throw new Error(
      "Selected package is protected by a built-in category or live role.",
    );
  }
}

function assertSamePackage(
  observation: PackageObservation,
  baseline: z.infer<typeof BaselinePackageSchema>,
): void {
  if (
    observation.packageName !== baseline.packageName ||
    observation.versionCode !== baseline.versionCode ||
    observation.appUid !== baseline.appUid ||
    observation.systemApp !== baseline.systemApp ||
    observation.persistentApp !== baseline.persistentApp ||
    observation.sharedUser !== baseline.sharedUser
  ) {
    throw new Error(
      "Selected package identity or version drifted from its baseline.",
    );
  }
}

function sortedUniquePackages(packages: readonly string[]): string[] {
  const sorted = [...packages].sort();
  if (new Set(sorted).size !== sorted.length) {
    throw new Error("Cleanup package selection contains duplicates.");
  }
  return sorted;
}

function assertPrepareApproval(
  input: z.infer<typeof PrepareCleanupArgsSchema>,
): string[] {
  const packages = sortedUniquePackages(input.packages);
  const approvedPackages = sortedUniquePackages(input.approval.packages);
  if (
    input.approval.target !== input.target ||
    !sameBuild(input.approval.expectedBuild, input.expectedBuild) ||
    packages.length !== approvedPackages.length ||
    packages.some((packageName, index) =>
      packageName !== approvedPackages[index]
    )
  ) {
    throw new Error(
      "Cleanup approval does not match the exact target, build, and package set.",
    );
  }
  return packages;
}

function assertPackageApproval(
  approval: z.infer<typeof PackageApprovalSchema>,
  baseline: z.infer<typeof CleanupBaselineSchema>,
  planId: string,
  packageName: string,
): void {
  if (
    approval.planId !== planId || approval.packageName !== packageName ||
    approval.target !== baseline.target ||
    !sameBuild(approval.build, baseline.build)
  ) {
    throw new Error(
      "Package approval does not match this plan, target, build, and package.",
    );
  }
}

async function readResource(
  context: CleanupMethodContext,
  name: string,
  version?: number,
): Promise<Record<string, unknown>> {
  const raw = await requireReadResource(context)(name, version);
  if (raw === null) {
    throw new Error("Required Swamp recovery resource was not found.");
  }
  return raw;
}

async function loadCurrentPlan(
  context: CleanupMethodContext,
): Promise<LoadedPlan> {
  const pointer = CleanupActivePointerSchema.parse(
    await readResource(context, ACTIVE_PLAN_INSTANCE),
  );
  const plan = CleanupPlanSchema.parse(
    await readResource(context, pointer.planInstanceName, pointer.planVersion),
  );
  if (
    plan.planId !== pointer.planId ||
    pointer.planInstanceName !== `cleanup-plan-${plan.planId}` ||
    plan.baselineInstanceName !== `cleanup-baseline-${plan.planId}`
  ) {
    throw new Error(
      "Swamp cleanup plan pointer did not match its trusted plan.",
    );
  }
  const baseline = CleanupBaselineSchema.parse(
    await readResource(
      context,
      plan.baselineInstanceName,
      plan.baselineVersion,
    ),
  );
  if (
    baseline.planId !== plan.planId || baseline.target.length === 0 ||
    baseline.packages.length !== plan.journal.length ||
    baseline.packages.some((entry, index) =>
      entry.packageName !== plan.journal[index]?.packageName
    )
  ) {
    throw new Error(
      "Swamp cleanup baseline did not match the exact plan version.",
    );
  }
  return { pointer, plan, baseline };
}

async function loadRequestedPlan(
  context: CleanupMethodContext,
  planId: string,
): Promise<LoadedPlan> {
  const loaded = await loadCurrentPlan(context);
  if (loaded.plan.planId !== planId) {
    throw new Error(
      "Requested cleanup plan is not the active plan for this definition.",
    );
  }
  return loaded;
}

function checkedHandle(
  handle: CleanupDataHandle,
  expectedSpecName: string,
  expectedName: string,
): CleanupDataHandle {
  if (
    handle.specName !== expectedSpecName ||
    handle.name !== expectedName ||
    handle.kind !== "resource" ||
    !Number.isSafeInteger(handle.version) || handle.version < 1
  ) {
    throw new Error("Swamp returned an invalid cleanup resource handle.");
  }
  return handle;
}

async function writePlanAndPointer(
  context: CleanupMethodContext,
  plan: z.infer<typeof CleanupPlanSchema>,
  runtime: CleanupRuntime,
): Promise<CleanupDataHandle[]> {
  const planName = `cleanup-plan-${plan.planId}`;
  const updatedPlan = CleanupPlanSchema.parse({
    ...plan,
    updatedAt: timestamp(runtime),
  });
  const writer = requireWriteResource(context);
  const planHandle = checkedHandle(
    await writer("cleanupPlan", planName, updatedPlan),
    "cleanupPlan",
    planName,
  );
  const pointer = CleanupActivePointerSchema.parse({
    planId: plan.planId,
    planInstanceName: planName,
    planVersion: planHandle.version,
    updatedAt: timestamp(runtime),
  });
  const pointerHandle = checkedHandle(
    await writer("cleanupActivePlan", ACTIVE_PLAN_INSTANCE, pointer),
    "cleanupActivePlan",
    ACTIVE_PLAN_INSTANCE,
  );
  return [planHandle, pointerHandle];
}

function baselinePackage(
  baseline: z.infer<typeof CleanupBaselineSchema>,
  packageName: string,
): z.infer<typeof BaselinePackageSchema> {
  const found = baseline.packages.find((entry) =>
    entry.packageName === packageName
  );
  if (!found) {
    throw new Error("Package is not part of the trusted cleanup baseline.");
  }
  return found;
}

function journalIndex(
  plan: z.infer<typeof CleanupPlanSchema>,
  packageName: string,
): number {
  const index = plan.journal.findIndex((entry) =>
    entry.packageName === packageName
  );
  if (index < 0) {
    throw new Error("Package is not part of the trusted cleanup journal.");
  }
  return index;
}

function replaceJournalEntry(
  plan: z.infer<typeof CleanupPlanSchema>,
  index: number,
  entry: z.infer<typeof CleanupJournalEntrySchema>,
  phase?: z.infer<typeof CleanupPlanSchema>["phase"],
): z.infer<typeof CleanupPlanSchema> {
  const journal = [...plan.journal];
  journal[index] = CleanupJournalEntrySchema.parse(entry);
  const nextPhase = phase ??
    (entry.restoreStatus === "conflict" ? "restoring" : plan.phase);
  return CleanupPlanSchema.parse({
    ...plan,
    journal,
    phase: nextPhase,
  });
}

function planPhaseAfterRestore(
  plan: z.infer<typeof CleanupPlanSchema>,
  journal: z.infer<typeof CleanupPlanSchema>["journal"],
): "prepared" | "active" | "restoring" | "restored" {
  const hasRestoreDecision = journal.some((entry) =>
    entry.restoreStatus !== "pending"
  );
  const resolved = journal.every((entry) => {
    if (
      entry.disableStatus === "notAttempted" ||
      entry.disableStatus === "alreadyDisabled"
    ) return true;
    return entry.restoreStatus === "restored" ||
      entry.restoreStatus === "notNeeded";
  });
  if (hasRestoreDecision && resolved) return "restored";
  if (hasRestoreDecision) return "restoring";
  return plan.phase === "prepared" ? "prepared" : "active";
}

function resultHandles(...handles: CleanupDataHandle[]) {
  return { dataHandles: handles };
}

export async function prepareCleanup(
  rawArgs: unknown,
  runtime: CleanupRuntime,
  context: CleanupMethodContext,
) {
  const input = PrepareCleanupArgsSchema.parse(rawArgs);
  const packages = assertPrepareApproval(input);
  const read = requireReadResource(context);
  const writer = requireWriteResource(context);

  const activeRaw = await read(ACTIVE_PLAN_INSTANCE);
  if (activeRaw !== null) {
    const prior = await loadCurrentPlan(context);
    if (prior.plan.phase !== "restored") {
      throw new Error("A prior cleanup plan is still active or unresolved.");
    }
  }

  const build = await readBuild(runtime, input.target);
  if (!sameBuild(build, input.expectedBuild)) {
    throw new Error("Current Android build does not match the approved build.");
  }
  const protectedRoles = await readProtectedRolePackages(runtime, input.target);
  const observations: PackageObservation[] = [];
  for (const packageName of packages) {
    const observation = await readPackageObservation(
      runtime,
      input.target,
      packageName,
    );
    assertEligible(observation, protectedRoles);
    if (
      !SupportedOriginalStateSchema.safeParse(observation.enabledState).success
    ) {
      throw new Error(
        "Selected package uses an unsupported original enabled state.",
      );
    }
    observations.push(observation);
  }

  const createPlanId = runtime.createPlanId ?? (() => crypto.randomUUID());
  const planId = z.uuid().parse(createPlanId());
  const baselineInstanceName = `cleanup-baseline-${planId}`;
  const planInstanceName = `cleanup-plan-${planId}`;
  const baseline = CleanupBaselineSchema.parse({
    planId,
    target: input.target,
    build,
    packages: observations.map((observation) => ({
      packageName: observation.packageName,
      versionCode: observation.versionCode,
      appUid: observation.appUid,
      systemApp: observation.systemApp,
      persistentApp: false,
      sharedUser: false,
      originalState: observation.enabledState,
    })),
    capturedAt: timestamp(runtime),
  });
  const baselineHandle = checkedHandle(
    await writer("cleanupBaseline", baselineInstanceName, baseline),
    "cleanupBaseline",
    baselineInstanceName,
  );
  if (baselineHandle.version !== 1) {
    throw new Error("Cleanup baseline name was already in use.");
  }

  const plan = CleanupPlanSchema.parse({
    planId,
    baselineInstanceName,
    baselineVersion: baselineHandle.version,
    phase: "prepared",
    journal: observations.map((observation) => ({
      packageName: observation.packageName,
      disableStatus: observation.enabledState === 3
        ? "alreadyDisabled"
        : "notAttempted",
      ...(observation.enabledState === 3
        ? { disableCompletedAt: timestamp(runtime) }
        : {}),
      restoreStatus: "pending",
      restoreAttempts: [],
    })),
    createdAt: timestamp(runtime),
    updatedAt: timestamp(runtime),
  });
  const planHandle = checkedHandle(
    await writer("cleanupPlan", planInstanceName, plan),
    "cleanupPlan",
    planInstanceName,
  );
  if (planHandle.version !== 1) {
    throw new Error("Cleanup plan name was already in use.");
  }
  const pointer = CleanupActivePointerSchema.parse({
    planId,
    planInstanceName,
    planVersion: planHandle.version,
    updatedAt: timestamp(runtime),
  });
  const pointerHandle = checkedHandle(
    await writer("cleanupActivePlan", ACTIVE_PLAN_INSTANCE, pointer),
    "cleanupActivePlan",
    ACTIVE_PLAN_INSTANCE,
  );

  return resultHandles(baselineHandle, planHandle, pointerHandle);
}

export async function applyCleanup(
  rawArgs: unknown,
  runtime: CleanupRuntime,
  context: CleanupMethodContext,
) {
  const input = ApplyCleanupArgsSchema.parse(rawArgs);
  const { plan, baseline } = await loadRequestedPlan(
    context,
    input.planId,
  );
  assertPackageApproval(
    input.approval,
    baseline,
    input.planId,
    input.packageName,
  );
  if (plan.phase === "restoring" || plan.phase === "restored") {
    throw new Error(
      "A cleanup plan with restoration started cannot be applied.",
    );
  }

  const original = baselinePackage(baseline, input.packageName);
  const index = journalIndex(plan, input.packageName);
  const journalEntry = plan.journal[index];
  if (!journalEntry) throw new Error("Cleanup journal entry was unavailable.");
  const build = await readBuild(runtime, baseline.target);
  if (!sameBuild(build, baseline.build)) {
    throw new Error(
      "Android build drifted from the immutable cleanup baseline.",
    );
  }
  const observation = await readPackageObservation(
    runtime,
    baseline.target,
    input.packageName,
  );
  assertSamePackage(observation, original);

  if (original.originalState === 3) {
    if (observation.enabledState !== 3) {
      throw new Error(
        "Previously disabled package state drifted from its baseline.",
      );
    }
    return resultHandles();
  }
  if (journalEntry.disableStatus !== "notAttempted") {
    throw new Error(
      "This package already has a durable apply attempt; blind retry is refused.",
    );
  }
  if (observation.enabledState !== original.originalState) {
    const driftPlan = replaceJournalEntry(plan, index, {
      ...journalEntry,
      verification: {
        status: "drift",
        observedState: observation.enabledState,
        checkedAt: timestamp(runtime),
      },
    });
    const [planHandle, pointerHandle] = await writePlanAndPointer(
      context,
      driftPlan,
      runtime,
    );
    return resultHandles(planHandle, pointerHandle);
  }

  const protectedRoles = await readProtectedRolePackages(
    runtime,
    baseline.target,
  );
  assertEligible(observation, protectedRoles);

  const intentPlan = replaceJournalEntry(plan, index, {
    ...journalEntry,
    disableStatus: "attempting",
    disableIntentAt: timestamp(runtime),
    verification: undefined,
  });
  await writePlanAndPointer(
    context,
    { ...intentPlan, phase: "active" },
    runtime,
  );

  let commandExitCode: number | undefined;
  try {
    const result = await runFixedCommand(runtime, baseline.target, [
      "shell",
      "pm",
      "disable-user",
      "--user",
      "0",
      input.packageName,
    ]);
    commandExitCode = result.exitCode;
  } catch {
    // Command errors and timeouts can occur after Android applied the change.
    // Preserve only the intent and verify with one bounded read; never retry.
  }

  let observedState: number | undefined;
  let verifiedDisabled = false;
  try {
    const afterBuild = await readBuild(runtime, baseline.target);
    const after = await readPackageObservation(
      runtime,
      baseline.target,
      input.packageName,
    );
    observedState = after.enabledState;
    verifiedDisabled = sameBuild(afterBuild, baseline.build) &&
      after.packageName === original.packageName &&
      after.versionCode === original.versionCode &&
      after.appUid === original.appUid &&
      after.systemApp === original.systemApp &&
      after.persistentApp === original.persistentApp &&
      after.sharedUser === original.sharedUser &&
      after.enabledState === 3;
  } catch {
    // The saved intent remains authoritative when read-back is inconclusive.
  }

  const outcomeEntry = CleanupJournalEntrySchema.parse({
    ...intentPlan.journal[index],
    disableStatus: verifiedDisabled ? "disabled" : "unknown",
    disableCompletedAt: timestamp(runtime),
    ...(commandExitCode === undefined
      ? {}
      : { disableExitCode: commandExitCode }),
    ...(observedState === undefined
      ? {}
      : { disableObservedState: observedState }),
  });
  const outcomePlan = replaceJournalEntry(intentPlan, index, outcomeEntry);
  const [outcomePlanHandle, outcomePointerHandle] = await writePlanAndPointer(
    context,
    outcomePlan,
    runtime,
  );
  return resultHandles(outcomePlanHandle, outcomePointerHandle);
}

export async function verifyCleanup(
  rawArgs: unknown,
  runtime: CleanupRuntime,
  context: CleanupMethodContext,
) {
  const input = VerifyCleanupArgsSchema.parse(rawArgs);
  const { plan, baseline } = await loadRequestedPlan(
    context,
    input.planId,
  );
  assertPackageApproval(
    input.approval,
    baseline,
    input.planId,
    input.packageName,
  );
  const original = baselinePackage(baseline, input.packageName);
  const index = journalIndex(plan, input.packageName);
  const journalEntry = plan.journal[index];
  if (!journalEntry) throw new Error("Cleanup journal entry was unavailable.");

  let status: "originalState" | "disabledUser" | "drift" = "drift";
  let observedState: number | undefined;
  try {
    const build = await readBuild(runtime, baseline.target);
    if (!sameBuild(build, baseline.build)) {
      throw new Error("Android build drifted.");
    }
    const observation = await readPackageObservation(
      runtime,
      baseline.target,
      input.packageName,
    );
    observedState = observation.enabledState;
    assertSamePackage(observation, original);
    const protectedRoles = await readProtectedRolePackages(
      runtime,
      baseline.target,
    );
    if (
      protectedRoles.has(input.packageName) ||
      isBuiltInProtected(input.packageName)
    ) {
      status = "drift";
    } else if (observation.enabledState === original.originalState) {
      status = "originalState";
    } else if (
      observation.enabledState === 3 && original.originalState !== 3 &&
      ["attempting", "disabled", "unknown"].includes(journalEntry.disableStatus)
    ) {
      status = "disabledUser";
    }
  } catch {
    status = "drift";
  }

  const nextEntry = CleanupJournalEntrySchema.parse({
    ...journalEntry,
    verification: {
      status,
      ...(observedState === undefined ? {} : { observedState }),
      checkedAt: timestamp(runtime),
    },
  });
  const nextPlan = replaceJournalEntry(plan, index, nextEntry);
  const [planHandle, pointerHandle] = await writePlanAndPointer(
    context,
    nextPlan,
    runtime,
  );
  return resultHandles(planHandle, pointerHandle);
}

function restorationOutcome(
  state: number,
  originalState: number,
  disableStatus: z.infer<typeof DisableStatusSchema>,
): "originalState" | "restore" | "conflict" {
  if (state === originalState) return "originalState";
  if (
    state === 3 && originalState !== 3 &&
    ["attempting", "disabled", "unknown"].includes(disableStatus)
  ) return "restore";
  return "conflict";
}

export async function restoreCleanup(
  rawArgs: unknown,
  runtime: CleanupRuntime,
  context: CleanupMethodContext,
) {
  const input = RestoreCleanupArgsSchema.parse(rawArgs);
  const { plan, baseline } = await loadRequestedPlan(
    context,
    input.planId,
  );
  assertPackageApproval(
    input.approval,
    baseline,
    input.planId,
    input.packageName,
  );
  const original = baselinePackage(baseline, input.packageName);
  const index = journalIndex(plan, input.packageName);
  const journalEntry = plan.journal[index];
  if (!journalEntry) throw new Error("Cleanup journal entry was unavailable.");

  let build: Android7Build;
  try {
    build = await readBuild(runtime, baseline.target);
  } catch {
    const conflictPlan = replaceJournalEntry(plan, index, {
      ...journalEntry,
      restoreStatus: "conflict",
    });
    const [planHandle, pointerHandle] = await writePlanAndPointer(
      context,
      conflictPlan,
      runtime,
    );
    return resultHandles(planHandle, pointerHandle);
  }
  if (!sameBuild(build, baseline.build)) {
    const conflictPlan = replaceJournalEntry(plan, index, {
      ...journalEntry,
      restoreStatus: "conflict",
    });
    const [planHandle, pointerHandle] = await writePlanAndPointer(
      context,
      conflictPlan,
      runtime,
    );
    return resultHandles(planHandle, pointerHandle);
  }

  let observation: PackageObservation;
  try {
    observation = await readPackageObservation(
      runtime,
      baseline.target,
      input.packageName,
    );
  } catch {
    const conflictPlan = replaceJournalEntry(plan, index, {
      ...journalEntry,
      restoreStatus: "conflict",
    });
    const [planHandle, pointerHandle] = await writePlanAndPointer(
      context,
      conflictPlan,
      runtime,
    );
    return resultHandles(planHandle, pointerHandle);
  }

  if (
    observation.packageName !== original.packageName ||
    observation.versionCode !== original.versionCode ||
    observation.appUid !== original.appUid ||
    observation.systemApp !== original.systemApp ||
    observation.persistentApp !== original.persistentApp ||
    observation.sharedUser !== original.sharedUser
  ) {
    const conflictPlan = replaceJournalEntry(plan, index, {
      ...journalEntry,
      restoreStatus: "conflict",
      ...(observation.enabledState >= 0
        ? {
          verification: {
            status: "drift",
            observedState: observation.enabledState,
            checkedAt: timestamp(runtime),
          },
        }
        : {}),
    });
    const [planHandle, pointerHandle] = await writePlanAndPointer(
      context,
      conflictPlan,
      runtime,
    );
    return resultHandles(planHandle, pointerHandle);
  }

  const intentOutcome = restorationOutcome(
    observation.enabledState,
    original.originalState,
    journalEntry.disableStatus,
  );
  if (intentOutcome === "conflict") {
    const conflictPlan = replaceJournalEntry(plan, index, {
      ...journalEntry,
      restoreStatus: "conflict",
      verification: {
        status: "drift",
        observedState: observation.enabledState,
        checkedAt: timestamp(runtime),
      },
    });
    const [planHandle, pointerHandle] = await writePlanAndPointer(
      context,
      conflictPlan,
      runtime,
    );
    return resultHandles(planHandle, pointerHandle);
  }
  if (intentOutcome === "originalState") {
    const restoreStatus = journalEntry.disableStatus === "notAttempted" ||
        journalEntry.disableStatus === "alreadyDisabled"
      ? "notNeeded"
      : "restored";
    if (
      journalEntry.restoreStatus === restoreStatus &&
      journalEntry.verification?.status === "originalState" &&
      plan.phase !== "restoring"
    ) return resultHandles();
    const resolvedEntry = CleanupJournalEntrySchema.parse({
      ...journalEntry,
      restoreStatus,
      verification: {
        status: "originalState",
        observedState: observation.enabledState,
        checkedAt: timestamp(runtime),
      },
    });
    const journal = [...plan.journal];
    journal[index] = resolvedEntry;
    const resolvedPlan = CleanupPlanSchema.parse({
      ...plan,
      journal,
      phase: planPhaseAfterRestore(plan, journal),
    });
    const [planHandle, pointerHandle] = await writePlanAndPointer(
      context,
      resolvedPlan,
      runtime,
    );
    return resultHandles(planHandle, pointerHandle);
  }

  const previousRestoreStatus = journalEntry.restoreStatus;
  if (previousRestoreStatus === "restored") {
    const conflictPlan = replaceJournalEntry(plan, index, {
      ...journalEntry,
      restoreStatus: "conflict",
      verification: {
        status: "drift",
        observedState: observation.enabledState,
        checkedAt: timestamp(runtime),
      },
    });
    const [planHandle, pointerHandle] = await writePlanAndPointer(
      context,
      conflictPlan,
      runtime,
    );
    return resultHandles(planHandle, pointerHandle);
  }
  if (
    (previousRestoreStatus === "attempting" ||
      previousRestoreStatus === "unknown" ||
      previousRestoreStatus === "conflict") &&
    !input.retryPreviousRestore
  ) {
    return resultHandles();
  }
  if (journalEntry.restoreAttempts.length >= MAX_RESTORE_ATTEMPTS) {
    const conflictPlan = replaceJournalEntry(plan, index, {
      ...journalEntry,
      restoreStatus: "conflict",
    });
    const [planHandle, pointerHandle] = await writePlanAndPointer(
      context,
      conflictPlan,
      runtime,
    );
    return resultHandles(planHandle, pointerHandle);
  }

  const restoreIntentAt = timestamp(runtime);
  const attempt = RestoreAttemptSchema.parse({
    status: "attempting",
    intentAt: restoreIntentAt,
  });
  const intentEntry = CleanupJournalEntrySchema.parse({
    ...journalEntry,
    restoreStatus: "attempting",
    restoreAttempts: [...journalEntry.restoreAttempts, attempt],
  });
  const intentPlan = replaceJournalEntry(plan, index, intentEntry);
  await writePlanAndPointer(
    context,
    { ...intentPlan, phase: "restoring" },
    runtime,
  );

  let commandExitCode: number | undefined;
  try {
    const operation = original.originalState === 0 ? "default-state" : "enable";
    const command = await runFixedCommand(runtime, baseline.target, [
      "shell",
      "pm",
      operation,
      "--user",
      "0",
      input.packageName,
    ]);
    commandExitCode = command.exitCode;
  } catch {
    // The preceding intent is durable; read-back determines whether retry is safe.
  }

  let observedState: number | undefined;
  let completion: "restored" | "unknown" | "conflict" = "unknown";
  try {
    const afterBuild = await readBuild(runtime, baseline.target);
    const after = await readPackageObservation(
      runtime,
      baseline.target,
      input.packageName,
    );
    observedState = after.enabledState;
    const samePackage = after.packageName === original.packageName &&
      after.versionCode === original.versionCode &&
      after.appUid === original.appUid &&
      after.systemApp === original.systemApp &&
      after.persistentApp === original.persistentApp &&
      after.sharedUser === original.sharedUser;
    if (!sameBuild(afterBuild, baseline.build) || !samePackage) {
      completion = "conflict";
    } else if (after.enabledState === original.originalState) {
      completion = "restored";
    } else if (after.enabledState !== 3) {
      completion = "conflict";
    }
  } catch {
    completion = "unknown";
  }

  const completedAt = timestamp(runtime);
  const completedAttempt = RestoreAttemptSchema.parse({
    status: completion,
    intentAt: restoreIntentAt,
    completedAt,
    ...(commandExitCode === undefined ? {} : { exitCode: commandExitCode }),
    ...(observedState === undefined ? {} : { observedState }),
  });
  const finalEntry = CleanupJournalEntrySchema.parse({
    ...intentEntry,
    restoreStatus: completion,
    restoreAttempts: [
      ...intentEntry.restoreAttempts.slice(0, -1),
      completedAttempt,
    ],
    verification: {
      status: completion === "restored" ? "originalState" : "drift",
      ...(observedState === undefined ? {} : { observedState }),
      checkedAt: completedAt,
    },
  });
  const journal = [...intentPlan.journal];
  journal[index] = finalEntry;
  const completedPlan = CleanupPlanSchema.parse({
    ...intentPlan,
    journal,
    phase: planPhaseAfterRestore(intentPlan, journal),
  });
  const [finalPlanHandle, finalPointerHandle] = await writePlanAndPointer(
    context,
    completedPlan,
    runtime,
  );
  return resultHandles(finalPlanHandle, finalPointerHandle);
}
