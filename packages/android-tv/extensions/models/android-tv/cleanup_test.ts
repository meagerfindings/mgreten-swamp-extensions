import type { CommandResult, CommandRunner } from "./_lib/adb.ts";
import {
  CleanupBaselineSchema,
  type CleanupDataHandle,
  CleanupPlanSchema,
} from "./_lib/cleanup.ts";
import { createAndroidTvModel } from "./android_tv.ts";

const TARGET = "192.0.2.55:5555";
const GLOBALS = {
  adbBinary: "/synthetic/adb",
  commandTimeoutMs: 1_000,
  sonyTimeoutMs: 1_000,
} as const;
const BUILD = {
  androidProductModel: "ExampleAndroidTV",
  androidRelease: "7.0",
  androidSdkLevel: 24,
  buildDisplayId: "example-build-1",
} as const;
const PACKAGE_NAME = "com.example.diagnostics";
const FIXED_TIME = "2026-11-06T12:00:00.000Z";

interface PackageFixture {
  packageName: string;
  versionCode: string;
  appUid: number;
  systemApp: boolean;
  persistentApp: boolean;
  sharedUser: boolean;
  enabledState: number;
}

interface StoredResource {
  readonly specName: string;
  readonly name: string;
  readonly version: number;
  readonly data: Record<string, unknown>;
}

interface SyntheticStore {
  readonly records: StoredResource[];
  readonly context: {
    readonly globalArgs: typeof GLOBALS;
    readonly logger: {
      info: (message: string, properties?: Record<string, unknown>) => void;
    };
    readonly readResource: (
      name: string,
      version?: number,
    ) => Promise<Record<string, unknown> | null>;
    readonly writeResource: (
      specName: string,
      name: string,
      data: Record<string, unknown>,
    ) => Promise<CleanupDataHandle>;
  };
  failNextWriteFor: (specName: string, name?: string) => void;
  latest: (name: string) => StoredResource | undefined;
  atVersion: (name: string, version: number) => StoredResource | undefined;
}

interface HarnessOptions {
  readonly initialState?: number;
  readonly packages?: PackageFixture[];
  readonly absentPackages?: ReadonlySet<string>;
  readonly roleOverrides?: ReadonlyMap<string, string>;
  readonly malformedDumpFor?: string;
  readonly duplicateVersionCodeFor?: string;
  readonly duplicateUserZeroFor?: string;
  readonly duplicateActivePackageFor?: string;
  readonly repeatedMetadataFor?: string;
  readonly conflictingUserIdFor?: string;
  readonly conflictingFlagsFor?: string;
  readonly headerOnlyUserZeroFor?: string;
  readonly omitHiddenSystemSectionFor?: string;
  readonly resourceHandleNameOverride?: string;
  readonly mutatePackage?: (record: PackageFixture) => void;
  readonly buildOverrides?: Readonly<Record<string, string>>;
}

interface Harness {
  readonly calls: string[][];
  readonly store: SyntheticStore;
  readonly model: ReturnType<typeof createAndroidTvModel>;
  readonly state: (packageName?: string) => number;
  readonly setState: (state: number, packageName?: string) => void;
  readonly setBuild: (property: string, value: string) => void;
  applyBehavior:
    | "normal"
    | "exitZeroNoEffect"
    | "throwBefore"
    | "applyThenThrow";
  restoreBehavior: "normal" | "throwBefore" | "applyThenThrow";
  failNextPackageRead: boolean;
  failReadAfterDisable: boolean;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `${message}\nExpected: ${expectedJson}\nActual: ${actualJson}`,
    );
  }
}

function assertUniqueDataHandleNames(
  handles: readonly CleanupDataHandle[] | undefined,
  message: string,
): asserts handles is readonly CleanupDataHandle[] {
  // Pinned Swamp validates uniqueness by handle.name alone.
  assert(handles !== undefined, `${message} must return data handles`);
  const names = new Set<string>();
  for (const handle of handles) {
    assert(
      !names.has(handle.name),
      `${message} returned duplicate data instance name '${handle.name}'`,
    );
    names.add(handle.name);
  }
}

async function assertRejects(
  operation: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(pattern.test(message), `Unexpected rejection: ${message}`);
    return;
  }
  throw new Error("Expected the cleanup operation to reject.");
}

function makeStore(resourceHandleNameOverride?: string): SyntheticStore {
  const records: StoredResource[] = [];
  let failSpec: string | undefined;
  let failName: string | undefined;
  return {
    records,
    context: {
      globalArgs: GLOBALS,
      logger: { info: () => undefined },
      readResource: (name, version) => {
        const record = version === undefined
          ? records.filter((item) => item.name === name).at(-1)
          : records.find((item) =>
            item.name === name && item.version === version
          );
        return Promise.resolve(
          record === undefined ? null : structuredClone(record.data),
        );
      },
      writeResource: (specName, name, data) => {
        if (
          failSpec === specName && (failName === undefined || failName === name)
        ) {
          failSpec = undefined;
          failName = undefined;
          return Promise.reject(new Error("synthetic durable write failure"));
        }
        const version = records.filter((item) => item.name === name).length + 1;
        records.push({ specName, name, version, data: structuredClone(data) });
        const tags = { type: "resource", specName };
        return Promise.resolve({
          name: resourceHandleNameOverride ?? name,
          specName,
          kind: "resource" as const,
          dataId: crypto.randomUUID(),
          version,
          size: new TextEncoder().encode(JSON.stringify(data)).byteLength,
          tags,
          metadata: {
            contentType: "application/json",
            lifetime: "infinite",
            garbageCollection: 10_000,
            streaming: false,
            tags,
            ownerDefinition: {
              ownerType: "model-method",
              ownerRef: "synthetic-model",
            },
          },
          attributes: structuredClone(data),
        });
      },
    },
    failNextWriteFor: (specName, name) => {
      failSpec = specName;
      failName = name;
    },
    latest: (name) => records.filter((item) => item.name === name).at(-1),
    atVersion: (name, version) =>
      records.find((item) => item.name === name && item.version === version),
  };
}

function defaultPackage(state = 1): PackageFixture {
  return {
    packageName: PACKAGE_NAME,
    versionCode: "17",
    appUid: 10_123,
    systemApp: true,
    persistentApp: false,
    sharedUser: false,
    enabledState: state,
  };
}

interface PackageDumpOptions {
  readonly duplicateUserZero?: boolean;
  readonly duplicateActivePackage?: boolean;
  readonly repeatedMetadata?: boolean;
  readonly conflictingUserId?: boolean;
  readonly conflictingFlags?: boolean;
  readonly headerOnlyUserZero?: boolean;
  readonly omitHiddenSystemSection?: boolean;
}

function packageDump(
  record: PackageFixture,
  options: PackageDumpOptions = {},
): string {
  const flags = [
    ...(record.systemApp ? ["SYSTEM"] : []),
    ...(record.persistentApp ? ["PERSISTENT"] : []),
    "HAS_CODE",
  ].join(" ");
  const repeatedUserId = options.repeatedMetadata
    ? `    userId=${record.appUid + (options.conflictingUserId ? 1 : 0)}\n`
    : "";
  const repeatedFlags = options.repeatedMetadata
    ? `    flags=[ ${
      options.conflictingFlags ? `${flags} PERSISTENT` : flags
    } ]\n`
    : "";
  const sharedUser = record.sharedUser
    ? "    sharedUser=SharedUserSetting{example}\n"
    : "";
  const userZero =
    `    User 0: ceDataInode=11 installed=true hidden=false suspended=false stopped=false enabled=${record.enabledState}\n`;
  const activePackage =
    `  Package [${record.packageName}] (a1b2):\n    userId=${record.appUid}\n${repeatedUserId}    versionCode=${record.versionCode} minSdk=23 targetSdk=24\n    flags=[ ${flags} ]\n${repeatedFlags}${sharedUser}${
      options.headerOnlyUserZero ? "    User 0:\n" : ""
    }${userZero}${
      options.duplicateUserZero ? userZero : ""
    }    User 10: ceDataInode=22 installed=true hidden=false suspended=false stopped=false enabled=4\n`;
  const conflictingHiddenCopy =
    `  Package [${record.packageName}] (factory):\n    userId=10000\n    versionCode=3 minSdk=21 targetSdk=23\n    flags=[ SYSTEM HAS_CODE ]\n    User 0: ceDataInode=1 installed=true hidden=false suspended=false stopped=false enabled=4\n`;
  return `Packages:\n${activePackage}${
    options.duplicateActivePackage ? activePackage : ""
  }${
    options.omitHiddenSystemSection
      ? ""
      : `Hidden system packages:\n${conflictingHiddenCopy}`
  }`;
}

function commandSuccess(stdout: string): CommandResult {
  return { success: true, exitCode: 0, stdout, stderr: "" };
}

function createHarness(options: HarnessOptions = {}): Harness {
  const store = makeStore(options.resourceHandleNameOverride);
  const recordMap = new Map<string, PackageFixture>();
  for (
    const record of options.packages ??
      [defaultPackage(options.initialState ?? 1)]
  ) {
    recordMap.set(record.packageName, structuredClone(record));
  }
  const absentPackages = options.absentPackages ?? new Set<string>();
  const calls: string[][] = [];
  const buildProperties: Record<string, string> = {
    "ro.product.model": BUILD.androidProductModel,
    "ro.build.version.release": BUILD.androidRelease,
    "ro.build.version.sdk": String(BUILD.androidSdkLevel),
    "ro.build.display.id": BUILD.buildDisplayId,
    ...options.buildOverrides,
  };
  let nextPlanId = 1;
  const harnessRef: { current?: Harness } = {};
  const getHarness = (): Harness => {
    const harness = harnessRef.current;
    if (!harness) throw new Error("Synthetic harness is not initialized.");
    return harness;
  };

  const runner: CommandRunner = (_executable, args) => {
    const argv = [...args];
    calls.push(argv);
    if (argv[0] !== "-s" || argv[1] !== TARGET) {
      return Promise.reject(new Error("synthetic target mismatch"));
    }
    if (argv[2] !== "shell") {
      return Promise.reject(new Error("synthetic shell command required"));
    }

    if (argv[3] === "getprop") {
      return Promise.resolve(commandSuccess(buildProperties[argv[4]] ?? ""));
    }
    if (argv[3] === "cmd" && argv[4] === "package") {
      const action = argv[argv.indexOf("-a") + 1];
      const category = argv[argv.indexOf("-c") + 1];
      if (category === "android.intent.category.HOME") {
        return Promise.resolve(commandSuccess(
          options.roleOverrides?.get("home") ?? "com.example.stockhome/.Home",
        ));
      }
      if (action === "android.settings.SETTINGS") {
        return Promise.resolve(commandSuccess(
          options.roleOverrides?.get("settings") ??
            "com.example.settings/.Settings",
        ));
      }
      if (action === "android.media.tv.TvInputService") {
        return Promise.resolve(commandSuccess(
          options.roleOverrides?.get("tvInput") ?? "com.example.input/.TvInput",
        ));
      }
      if (action === "android.view.InputMethod") {
        return Promise.resolve(commandSuccess(
          options.roleOverrides?.get("inputMethod") ?? "com.example.ime/.Ime",
        ));
      }
      return Promise.reject(new Error("unexpected synthetic role query"));
    }
    if (argv[3] === "dumpsys" && argv[4] === "package") {
      if (getHarness().failNextPackageRead) {
        getHarness().failNextPackageRead = false;
        return Promise.reject(new Error("synthetic package read timeout"));
      }
      const packageName = argv[5];
      if (packageName === options.malformedDumpFor) {
        return Promise.resolve(commandSuccess(
          `Packages:\n  Package [${packageName}] (a1b2):\n    userId=10123\n    versionCode=17\n    flags=[ SYSTEM ]\n    User 0: installed=true hidden=false suspended=false enabled=1 enabled=bad\n`,
        ));
      }
      if (packageName === options.duplicateVersionCodeFor) {
        return Promise.resolve(commandSuccess(
          `Packages:\n  Package [${packageName}] (a1b2):\n    userId=10123\n    versionCode=17 versionCode=18 versionCode=bad minSdk=23 targetSdk=24\n    flags=[ SYSTEM ]\n    User 0: installed=true hidden=false suspended=false enabled=1\n`,
        ));
      }
      if (absentPackages.has(packageName)) {
        return Promise.resolve(commandSuccess("Packages:\n"));
      }
      const record = recordMap.get(packageName);
      if (!record) return Promise.resolve(commandSuccess("Packages:\n"));
      return Promise.resolve(commandSuccess(packageDump(
        record,
        {
          duplicateUserZero: packageName === options.duplicateUserZeroFor,
          duplicateActivePackage:
            packageName === options.duplicateActivePackageFor,
          repeatedMetadata: packageName === options.repeatedMetadataFor ||
            packageName === options.conflictingUserIdFor ||
            packageName === options.conflictingFlagsFor,
          conflictingUserId: packageName === options.conflictingUserIdFor,
          conflictingFlags: packageName === options.conflictingFlagsFor,
          headerOnlyUserZero: packageName === options.headerOnlyUserZeroFor,
          omitHiddenSystemSection:
            packageName === options.omitHiddenSystemSectionFor,
        },
      )));
    }
    if (argv[3] === "pm") {
      const operation = argv[4];
      const packageName = argv.at(-1) ?? "";
      const record = recordMap.get(packageName);
      if (!record || argv[5] !== "--user" || argv[6] !== "0") {
        return Promise.reject(new Error("unsafe synthetic package command"));
      }
      if (operation === "disable-user") {
        const activePointer = store.latest("cleanup-active-plan")?.data;
        const pointerVersion = Number(activePointer?.planVersion);
        const pointerPlanName = String(activePointer?.planInstanceName);
        const durablePlan = store.atVersion(pointerPlanName, pointerVersion)
          ?.data;
        const journal = durablePlan?.journal as Array<Record<string, unknown>>;
        if (
          journal?.find((entry) => entry.packageName === packageName)
            ?.disableStatus !== "attempting"
        ) {
          return Promise.reject(
            new Error("disable intent was not durable first"),
          );
        }
        if (getHarness().applyBehavior === "throwBefore") {
          return Promise.reject(new Error("synthetic timeout before apply"));
        }
        if (getHarness().applyBehavior !== "exitZeroNoEffect") {
          record.enabledState = 3;
        }
        if (getHarness().failReadAfterDisable) {
          getHarness().failReadAfterDisable = false;
          getHarness().failNextPackageRead = true;
        }
        if (getHarness().applyBehavior === "applyThenThrow") {
          return Promise.reject(new Error("synthetic timeout after apply"));
        }
        return Promise.resolve(commandSuccess("Package disabled-user"));
      }
      if (operation === "default-state" || operation === "enable") {
        const activePointer = store.latest("cleanup-active-plan")?.data;
        const pointerVersion = Number(activePointer?.planVersion);
        const pointerPlanName = String(activePointer?.planInstanceName);
        const durablePlan = store.atVersion(pointerPlanName, pointerVersion)
          ?.data;
        const journal = durablePlan?.journal as Array<Record<string, unknown>>;
        const entry = journal?.find((item) => item.packageName === packageName);
        const attempts = entry?.restoreAttempts as
          | Array<Record<string, unknown>>
          | undefined;
        if (attempts?.at(-1)?.status !== "attempting") {
          return Promise.reject(
            new Error("restore intent was not durable first"),
          );
        }
        if (getHarness().restoreBehavior === "throwBefore") {
          return Promise.reject(new Error("synthetic timeout before restore"));
        }
        record.enabledState = operation === "default-state" ? 0 : 1;
        if (getHarness().restoreBehavior === "applyThenThrow") {
          return Promise.reject(new Error("synthetic timeout after restore"));
        }
        return Promise.resolve(commandSuccess("Package state changed"));
      }
      return Promise.reject(new Error("unexpected synthetic package command"));
    }
    return Promise.reject(new Error("unexpected synthetic ADB argv"));
  };

  const model = createAndroidTvModel({
    commandRunner: runner,
    now: () => new Date(FIXED_TIME),
    createCleanupPlanId: () =>
      `00000000-0000-4000-8000-${String(nextPlanId++).padStart(12, "0")}`,
  });
  const harness: Harness = {
    calls,
    store,
    model,
    state: (packageName = PACKAGE_NAME) => {
      const record = recordMap.get(packageName);
      if (!record) throw new Error("Synthetic package was not present.");
      return record.enabledState;
    },
    setState: (state, packageName = PACKAGE_NAME) => {
      const record = recordMap.get(packageName);
      if (!record) throw new Error("Synthetic package was not present.");
      record.enabledState = state;
    },
    setBuild: (property, value) => {
      buildProperties[property] = value;
    },
    applyBehavior: "normal",
    restoreBehavior: "normal",
    failNextPackageRead: false,
    failReadAfterDisable: false,
  };
  harnessRef.current = harness;
  options.mutatePackage?.(recordMap.get(PACKAGE_NAME) ?? defaultPackage());
  return harness;
}

function preparationArgs(
  packages: string[] = [PACKAGE_NAME],
  overrides: Record<string, unknown> = {},
) {
  return {
    ...GLOBALS,
    target: TARGET,
    expectedBuild: BUILD,
    packages,
    approval: { target: TARGET, expectedBuild: BUILD, packages },
    hostServerReviewed: true as const,
    ...overrides,
  };
}

async function prepare(harness: Harness, packages = [PACKAGE_NAME]) {
  await harness.model.methods.prepareCleanup.execute(
    preparationArgs(packages),
    harness.store.context,
  );
  const pointer = harness.store.latest("cleanup-active-plan")?.data;
  assert(pointer !== undefined, "Prepare must persist the active plan pointer");
  const planId = String(pointer.planId);
  const baselineName = `cleanup-baseline-${planId}`;
  const baselineHandle = harness.store.latest(baselineName);
  assert(
    baselineHandle !== undefined,
    "Prepare must persist an immutable baseline",
  );
  const baseline = CleanupBaselineSchema.parse(baselineHandle.data);
  return { planId, baselineName, baseline };
}

function approvedPackage(planId: string, packageName = PACKAGE_NAME) {
  return {
    planId,
    packageName,
    approval: { planId, packageName, target: TARGET, build: BUILD },
    hostServerReviewed: true as const,
    retryPreviousRestore: false,
  };
}

function currentPlan(
  harness: Harness,
): ReturnType<typeof CleanupPlanSchema.parse> {
  const pointer = harness.store.latest("cleanup-active-plan")?.data;
  assert(pointer !== undefined, "The active plan pointer should exist");
  const name = String(pointer.planInstanceName);
  const version = Number(pointer.planVersion);
  const plan = harness.store.atVersion(name, version)?.data;
  assert(
    plan !== undefined,
    "The active pointer must name its exact plan version",
  );
  return CleanupPlanSchema.parse(plan);
}

function cleanupTest(name: string, fn: () => void | Promise<void>): void {
  Deno.test({
    name,
    permissions: { net: false, run: false, read: false, write: false },
    fn,
  });
}

cleanupTest(
  "cleanup methods declare update and parse Swamp-merged globals",
  () => {
    const harness = createHarness();
    for (
      const methodName of [
        "prepareCleanup",
        "applyCleanup",
        "verifyCleanup",
        "restoreCleanup",
      ] as const
    ) {
      assertEqual(
        harness.model.methods[methodName].kind,
        "update",
        `${methodName} must hold Swamp's mutating-method lock`,
      );
    }
    const args = preparationArgs();
    const parsed = harness.model.methods.prepareCleanup.arguments.parse(args);
    assertEqual(
      Object.keys(parsed).sort(),
      ["approval", "expectedBuild", "hostServerReviewed", "packages", "target"],
      "Method schemas must strip merged globals but retain declared fields",
    );
  },
);

cleanupTest(
  "prepare persists exact user-0 baseline without changing packages",
  async () => {
    const harness = createHarness({ initialState: 0 });
    const { planId, baselineName, baseline } = await prepare(harness);
    const stored = harness.store.latest(baselineName);
    assertEqual(
      stored?.version,
      1,
      "The baseline must be an immutable first version",
    );
    assertEqual(baseline.target, TARGET, "The baseline binds the exact target");
    assertEqual(baseline.build, BUILD, "The baseline binds the observed build");
    assertEqual(
      baseline.packages,
      [{
        packageName: PACKAGE_NAME,
        versionCode: "17",
        appUid: 10_123,
        systemApp: true,
        persistentApp: false,
        sharedUser: false,
        originalState: 0,
      }],
      "The baseline retains the exact numeric state and only selected fields",
    );
    const capturedPackage = baseline.packages[0];
    assert(
      capturedPackage !== undefined,
      "The selected baseline package must exist",
    );
    assertEqual(
      Object.keys(capturedPackage).sort(),
      [
        "appUid",
        "originalState",
        "packageName",
        "persistentApp",
        "sharedUser",
        "systemApp",
        "versionCode",
      ],
      "Raw dumps and other-user details must not enter persisted state",
    );
    assertEqual(harness.state(), 0, "Prepare must not change package state");
    assertEqual(
      harness.calls.filter((argv) => argv[3] === "pm").length,
      0,
      "Prepare must not invoke package-state commands",
    );
    assert(
      harness.store.latest(`cleanup-plan-${planId}`) !== undefined,
      "The per-plan journal must be persisted",
    );
  },
);

cleanupTest(
  "prepare ignores conflicting hidden-system and other-user records",
  async () => {
    const harness = createHarness({ initialState: 1 });
    const { baseline } = await prepare(harness);
    assertEqual(
      baseline.packages[0].originalState,
      1,
      "Only the active Packages block's User 0 state is authoritative",
    );
  },
);

cleanupTest(
  "prepare parses repeated Android 7 fields but still rejects unsafe identity",
  async () => {
    const harness = createHarness({
      packages: [{
        ...defaultPackage(0),
        appUid: 2_000,
        sharedUser: true,
      }],
      repeatedMetadataFor: PACKAGE_NAME,
      headerOnlyUserZeroFor: PACKAGE_NAME,
      omitHiddenSystemSectionFor: PACKAGE_NAME,
    });
    await assertRejects(
      () => prepare(harness),
      /shared, persistent, or reserved-UID status/,
    );
    assertEqual(
      harness.store.records.length,
      0,
      "Repeated-field Sony output must not weaken package eligibility",
    );
  },
);

cleanupTest(
  "prepare accepts identical repeated user-0 state fields",
  async () => {
    const harness = createHarness({ duplicateUserZeroFor: PACKAGE_NAME });
    const { baseline } = await prepare(harness);
    assertEqual(
      baseline.packages[0].originalState,
      1,
      "Repeated identical user-0 state fields should agree on one original state",
    );
  },
);

cleanupTest(
  "prepare rejects absent, malformed, shared, persistent, and reserved packages",
  async () => {
    const cases: Array<{
      readonly label: string;
      readonly options: HarnessOptions;
      readonly packageName?: string;
    }> = [
      { label: "absent", options: { absentPackages: new Set([PACKAGE_NAME]) } },
      {
        label: "malformed fields",
        options: { malformedDumpFor: PACKAGE_NAME },
      },
      {
        label: "conflicting repeated user ID fields",
        options: { conflictingUserIdFor: PACKAGE_NAME },
      },
      {
        label: "conflicting repeated flags fields",
        options: { conflictingFlagsFor: PACKAGE_NAME },
      },
      {
        label: "duplicate version fields",
        options: { duplicateVersionCodeFor: PACKAGE_NAME },
      },
      {
        label: "duplicate active blocks",
        options: { duplicateActivePackageFor: PACKAGE_NAME },
      },
      {
        label: "shared UID",
        options: { mutatePackage: (record) => record.sharedUser = true },
      },
      {
        label: "persistent",
        options: { mutatePackage: (record) => record.persistentApp = true },
      },
      {
        label: "reserved UID",
        options: { mutatePackage: (record) => record.appUid = 1_001 },
      },
      {
        label: "protected package category",
        options: {
          packages: [{ ...defaultPackage(), packageName: "org.pbskids.video" }],
        },
        packageName: "org.pbskids.video",
      },
      ...[
        "com.google.android.apps.mediashell",
        "com.amazon.amazonvideo.livingroom",
        "com.sony.dtv.tvlaunchercustomizer",
        "com.android.settings",
      ].map((packageName) => ({
        label: `protected category ${packageName}`,
        options: {
          packages: [{ ...defaultPackage(), packageName }],
        },
        packageName,
      })),
    ];
    for (const testCase of cases) {
      const harness = createHarness(testCase.options);
      const selected = testCase.packageName ?? PACKAGE_NAME;
      await assertRejects(
        () =>
          harness.model.methods.prepareCleanup.execute(
            preparationArgs([selected]),
            harness.store.context,
          ),
        /absent|ambiguous|malformed|shared|persistent|reserved|protected|unsafe/i,
      );
      assertEqual(
        harness.store.records.length,
        0,
        `${testCase.label} must not persist a plan or baseline`,
      );
    }
  },
);

cleanupTest(
  "prepare rejects states 2 and 4 instead of mapping them",
  async () => {
    for (const state of [2, 4]) {
      const harness = createHarness({ initialState: state });
      await assertRejects(
        () => prepare(harness),
        /unsupported original enabled state/,
      );
      assertEqual(
        harness.store.records.length,
        0,
        `State ${state} must not be saved`,
      );
    }
  },
);

cleanupTest(
  "prepare rejects a protected live Home role and inconclusive role output",
  async () => {
    const roleOwned = createHarness({
      roleOverrides: new Map([["home", `${PACKAGE_NAME}/.Home`]]),
    });
    await assertRejects(
      () => prepare(roleOwned),
      /protected by a built-in category or live role/,
    );

    const noHome = createHarness({
      roleOverrides: new Map([["home", "No activities found"]]),
    });
    await assertRejects(() => prepare(noHome), /role check was inconclusive/);
    assertEqual(
      noHome.store.records.length,
      0,
      "Inconclusive roles must block planning",
    );

    for (const role of ["settings", "tvInput", "inputMethod"]) {
      const roleOwned = createHarness({
        roleOverrides: new Map([[role, `${PACKAGE_NAME}/.ProtectedRole`]]),
      });
      await assertRejects(
        () => prepare(roleOwned),
        /protected by a built-in category or live role/,
      );
    }
  },
);

cleanupTest(
  "prepare binds expected target and verified Android build",
  async () => {
    const wrongBuild = createHarness({
      buildOverrides: { "ro.build.display.id": "different-build" },
    });
    await assertRejects(
      () =>
        wrongBuild.model.methods.prepareCleanup.execute(
          preparationArgs(),
          wrongBuild.store.context,
        ),
      /does not match the approved build/,
    );

    const wrongApproval = createHarness();
    const input = preparationArgs();
    const approval = input.approval;
    await assertRejects(
      () =>
        wrongApproval.model.methods.prepareCleanup.execute({
          ...input,
          approval: { ...approval, target: "192.0.2.56:5555" },
        }, wrongApproval.store.context),
      /does not match the exact target, build, and package set/,
    );
    assertEqual(
      wrongApproval.store.records.length,
      0,
      "Mismatched approval must not write",
    );
  },
);

cleanupTest(
  "baseline write failure stops before any package mutation",
  async () => {
    const harness = createHarness();
    harness.store.failNextWriteFor("cleanupBaseline");
    await assertRejects(
      () => prepare(harness),
      /synthetic durable write failure/,
    );
    assertEqual(
      harness.calls.filter((argv) => argv[3] === "pm").length,
      0,
      "No package command may run when the durable baseline write fails",
    );
  },
);

cleanupTest(
  "prepare accepts Swamp DataHandle.name and rejects a mismatched handle name",
  async () => {
    const validHandle = createHarness();
    const prepared = await validHandle.model.methods.prepareCleanup.execute(
      preparationArgs(),
      validHandle.store.context,
    );
    assertEqual(
      validHandle.store.records.length,
      3,
      "An authentic Swamp DataHandle shape should allow the baseline, plan, and pointer",
    );
    assert(
      prepared.dataHandles?.every((handle) =>
        !("instanceName" in handle) && "name" in handle
      ),
      "Returned handles should retain Swamp's name field, not invent instanceName",
    );

    const mismatchedHandle = createHarness({
      resourceHandleNameOverride: "wrong-handle-name",
    });
    await assertRejects(
      () => prepare(mismatchedHandle),
      /invalid cleanup resource handle/,
    );
    assertEqual(
      mismatchedHandle.store.records.length,
      1,
      "A mismatched returned handle may follow a successful write but must not create a plan or pointer",
    );
    assertEqual(
      mismatchedHandle.calls.filter((argv) => argv[3] === "pm").length,
      0,
      "Handle identity failure must precede every package mutation",
    );
  },
);

cleanupTest(
  "already-disabled packages stay disabled and an explicit no-op restore closes the plan",
  async () => {
    const harness = createHarness({ initialState: 3 });
    const { planId } = await prepare(harness);
    const entry = currentPlan(harness).journal[0];
    assert(entry !== undefined, "The journal entry must exist");
    assertEqual(
      entry.disableStatus,
      "alreadyDisabled",
      "Original state 3 is recorded",
    );
    assertEqual(
      entry.restoreStatus,
      "pending",
      "Only explicit restore settles the plan",
    );
    await harness.model.methods.applyCleanup.execute(
      { ...GLOBALS, ...approvedPackage(planId) },
      harness.store.context,
    );
    await harness.model.methods.restoreCleanup.execute(
      { ...GLOBALS, ...approvedPackage(planId) },
      harness.store.context,
    );
    assertEqual(
      harness.state(),
      3,
      "A previously disabled package remains disabled",
    );
    assertEqual(
      harness.calls.filter((argv) => argv[3] === "pm").length,
      0,
      "No disable or enable command is needed for original state 3",
    );
    assertEqual(
      currentPlan(harness).phase,
      "restored",
      "Explicit no-op restore closes the plan",
    );
    await prepare(harness);
    assertEqual(
      harness.store.records.filter((record) =>
        record.specName === "cleanupBaseline"
      ).length,
      2,
      "A settled no-op plan permits a distinct new baseline",
    );
  },
);

cleanupTest(
  "apply writes durable intent before one fixed disable and verifies state",
  async () => {
    const harness = createHarness({ initialState: 1 });
    const { planId } = await prepare(harness);
    const methodArgs = approvedPackage(planId);
    await harness.model.methods.applyCleanup.execute(
      { ...GLOBALS, ...methodArgs },
      harness.store.context,
    );
    assertEqual(
      harness.state(),
      3,
      "The synthetic transport should model user-0 disable",
    );
    assertEqual(
      harness.calls.filter((argv) => argv[3] === "pm").map((argv) =>
        argv.slice(3)
      ),
      [["pm", "disable-user", "--user", "0", PACKAGE_NAME]],
      "Apply may run only the fixed one-package user-0 command",
    );
    const entry =
      (currentPlan(harness).journal as Array<Record<string, unknown>>)[0];
    assertEqual(
      entry.disableStatus,
      "disabled",
      "Read-back must establish the outcome",
    );

    await harness.model.methods.verifyCleanup.execute(
      { ...GLOBALS, ...methodArgs },
      harness.store.context,
    );
    const verified = currentPlan(harness).journal[0];
    assert(verified !== undefined, "The journal entry must exist");
    assertEqual(
      (verified.verification as Record<string, unknown>).status,
      "disabledUser",
      "Verify must persist the observed user-0 state",
    );
  },
);

cleanupTest(
  "apply returns unique final handles while preserving intent and outcome writes",
  async () => {
    const harness = createHarness({ initialState: 1 });
    const { planId } = await prepare(harness);
    const planName = `cleanup-plan-${planId}`;
    const result = await harness.model.methods.applyCleanup.execute(
      { ...GLOBALS, ...approvedPackage(planId) },
      harness.store.context,
    );

    assertUniqueDataHandleNames(result.dataHandles, "applyCleanup");
    assertEqual(
      result.dataHandles?.map((
        { name, specName, version },
      ) => [name, specName, version]),
      [[planName, "cleanupPlan", 3], [
        "cleanup-active-plan",
        "cleanupActivePlan",
        3,
      ]],
      "Apply returns only the latest plan and pointer handles",
    );
    const intentRecord = harness.store.atVersion(planName, 2);
    assert(intentRecord !== undefined, "The apply intent version must remain");
    assertEqual(
      CleanupPlanSchema.parse(intentRecord.data).journal[0]?.disableStatus,
      "attempting",
      "The durable intent write must be preserved",
    );
    const outcomeRecord = harness.store.atVersion(planName, 3);
    assert(
      outcomeRecord !== undefined,
      "The apply outcome version must remain",
    );
    assertEqual(
      CleanupPlanSchema.parse(outcomeRecord.data).journal[0]?.disableStatus,
      "disabled",
      "The durable outcome write must be preserved",
    );
    const intentPointer = harness.store.atVersion("cleanup-active-plan", 2);
    assert(intentPointer !== undefined, "The apply intent pointer must remain");
    assertEqual(
      intentPointer.data.planVersion,
      2,
      "The intent pointer must name its matching plan version",
    );
    const outcomePointer = harness.store.atVersion("cleanup-active-plan", 3);
    assert(
      outcomePointer !== undefined,
      "The apply outcome pointer must remain",
    );
    assertEqual(
      outcomePointer.data.planVersion,
      3,
      "The final pointer must name the latest plan version",
    );
  },
);

cleanupTest(
  "apply refuses baseline-state drift and mismatched package approval",
  async () => {
    const harness = createHarness({ initialState: 1 });
    const { planId } = await prepare(harness);
    const args = approvedPackage(planId);
    const badApproval = {
      ...args,
      approval: { ...args.approval, packageName: "com.example.other" },
    };
    await assertRejects(
      () =>
        harness.model.methods.applyCleanup.execute(
          { ...GLOBALS, ...badApproval },
          harness.store.context,
        ),
      /does not match this plan, target, build, and package/,
    );
    await assertRejects(
      () =>
        harness.model.methods.applyCleanup.execute({
          ...GLOBALS,
          ...args,
          approval: {
            ...args.approval,
            build: { ...BUILD, buildDisplayId: "other-build" },
          },
        }, harness.store.context),
      /does not match this plan, target, build, and package/,
    );
    await assertRejects(
      () =>
        harness.model.methods.applyCleanup.execute({
          ...GLOBALS,
          ...args,
          approval: { ...args.approval, target: "192.0.2.56:5555" },
        }, harness.store.context),
      /does not match this plan, target, build, and package/,
    );
    harness.setBuild("ro.build.display.id", "other-build");
    await assertRejects(
      () =>
        harness.model.methods.applyCleanup.execute(
          { ...GLOBALS, ...args },
          harness.store.context,
        ),
      /Android build drifted from the immutable cleanup baseline/,
    );
    harness.setBuild("ro.build.display.id", BUILD.buildDisplayId);
    harness.setState(0);
    await harness.model.methods.applyCleanup.execute(
      { ...GLOBALS, ...args },
      harness.store.context,
    );
    assertEqual(harness.state(), 0, "Drifted packages must not be disabled");
    assertEqual(
      harness.calls.filter((argv) => argv[3] === "pm").length,
      0,
      "Mismatched approval and pre-apply drift must not invoke pm",
    );
  },
);

cleanupTest(
  "intent write failure prevents the ADB disable command",
  async () => {
    const harness = createHarness({ initialState: 1 });
    const { planId } = await prepare(harness);
    harness.store.failNextWriteFor("cleanupPlan", `cleanup-plan-${planId}`);
    await assertRejects(
      () =>
        harness.model.methods.applyCleanup.execute(
          { ...GLOBALS, ...approvedPackage(planId) },
          harness.store.context,
        ),
      /synthetic durable write failure/,
    );
    assertEqual(
      harness.state(),
      1,
      "Failed intent persistence must precede no device write",
    );
    assertEqual(
      harness.calls.filter((argv) => argv[3] === "pm").length,
      0,
      "No pm command may run without a durable attempt record",
    );
  },
);

cleanupTest(
  "exit zero without a state change remains unknown and is never blindly retried",
  async () => {
    const harness = createHarness({ initialState: 1 });
    const { planId } = await prepare(harness);
    harness.applyBehavior = "exitZeroNoEffect";
    await harness.model.methods.applyCleanup.execute(
      { ...GLOBALS, ...approvedPackage(planId) },
      harness.store.context,
    );
    const journal = currentPlan(harness).journal;
    const entry = journal[0];
    assert(entry !== undefined, "The journal entry must exist");
    assertEqual(
      entry.disableStatus,
      "unknown",
      "Exit zero is not proof of disablement",
    );
    assertEqual(
      entry.disableExitCode,
      0,
      "The exit code remains bounded evidence",
    );
    await assertRejects(
      () =>
        harness.model.methods.applyCleanup.execute(
          { ...GLOBALS, ...approvedPackage(planId) },
          harness.store.context,
        ),
      /blind retry is refused/,
    );
    assertEqual(
      harness.calls.filter((argv) =>
        argv[3] === "pm" && argv[4] === "disable-user"
      ).length,
      1,
      "An uncertain apply must not issue a second disable",
    );
  },
);

cleanupTest(
  "apply timeout plus failed read-back is unknown but remains safely restorable",
  async () => {
    const harness = createHarness({ initialState: 0 });
    const { planId } = await prepare(harness);
    harness.failReadAfterDisable = true;
    harness.applyBehavior = "applyThenThrow";
    const args = approvedPackage(planId);
    await harness.model.methods.applyCleanup.execute(
      { ...GLOBALS, ...args },
      harness.store.context,
    );
    let entry = currentPlan(harness).journal[0];
    assert(entry !== undefined, "The journal entry must exist");
    assertEqual(
      entry.disableStatus,
      "unknown",
      "Failed read-back preserves unknown outcome",
    );
    assertEqual(
      harness.state(),
      3,
      "The synthetic command models a possibly applied change",
    );
    await harness.model.methods.restoreCleanup.execute(
      { ...GLOBALS, ...args },
      harness.store.context,
    );
    entry = currentPlan(harness).journal[0];
    assert(entry !== undefined, "The journal entry must exist");
    assertEqual(
      harness.state(),
      0,
      "Restore uses the saved baseline after unknown apply",
    );
    assertEqual(entry.restoreStatus, "restored", "Read-back resolves recovery");
  },
);

cleanupTest(
  "restore maps exact states 0 and 1 to their Android 7 operations",
  async () => {
    for (const originalState of [0, 1]) {
      const harness = createHarness({ initialState: originalState });
      const { planId } = await prepare(harness);
      const args = approvedPackage(planId);
      await harness.model.methods.applyCleanup.execute(
        { ...GLOBALS, ...args },
        harness.store.context,
      );
      await harness.model.methods.restoreCleanup.execute(
        { ...GLOBALS, ...args },
        harness.store.context,
      );
      assertEqual(
        harness.state(),
        originalState,
        "Restore must recover exact original state",
      );
      assertEqual(
        harness.calls.filter((argv) => argv[3] === "pm").map((argv) => argv[4]),
        ["disable-user", originalState === 0 ? "default-state" : "enable"],
        "Only the state-specific fixed restoration command is allowed",
      );
    }
  },
);

cleanupTest(
  "restore returns unique final handles while preserving intent and outcome writes",
  async () => {
    const harness = createHarness({ initialState: 1 });
    const { planId } = await prepare(harness);
    const args = approvedPackage(planId);
    const planName = `cleanup-plan-${planId}`;
    await harness.model.methods.applyCleanup.execute(
      { ...GLOBALS, ...args },
      harness.store.context,
    );
    const result = await harness.model.methods.restoreCleanup.execute(
      { ...GLOBALS, ...args },
      harness.store.context,
    );

    assertUniqueDataHandleNames(result.dataHandles, "restoreCleanup");
    assertEqual(
      result.dataHandles?.map((
        { name, specName, version },
      ) => [name, specName, version]),
      [[planName, "cleanupPlan", 5], [
        "cleanup-active-plan",
        "cleanupActivePlan",
        5,
      ]],
      "Restore returns only the latest plan and pointer handles",
    );
    const intentRecord = harness.store.atVersion(planName, 4);
    assert(
      intentRecord !== undefined,
      "The restore intent version must remain",
    );
    assertEqual(
      CleanupPlanSchema.parse(intentRecord.data).journal[0]?.restoreStatus,
      "attempting",
      "The durable restore intent write must be preserved",
    );
    const outcomeRecord = harness.store.atVersion(planName, 5);
    assert(
      outcomeRecord !== undefined,
      "The restore outcome version must remain",
    );
    assertEqual(
      CleanupPlanSchema.parse(outcomeRecord.data).journal[0]?.restoreStatus,
      "restored",
      "The durable restore outcome write must be preserved",
    );
    const intentPointer = harness.store.atVersion("cleanup-active-plan", 4);
    assert(
      intentPointer !== undefined,
      "The restore intent pointer must remain",
    );
    assertEqual(
      intentPointer.data.planVersion,
      4,
      "The restore intent pointer must name its matching plan version",
    );
    const outcomePointer = harness.store.atVersion("cleanup-active-plan", 5);
    assert(
      outcomePointer !== undefined,
      "The restore outcome pointer must remain",
    );
    assertEqual(
      outcomePointer.data.planVersion,
      5,
      "The final restore pointer must name the latest plan version",
    );
  },
);

cleanupTest(
  "restore does not issue a redundant command when state is already original",
  async () => {
    const harness = createHarness({ initialState: 1 });
    const { planId } = await prepare(harness);
    harness.applyBehavior = "exitZeroNoEffect";
    const args = approvedPackage(planId);
    await harness.model.methods.applyCleanup.execute(
      { ...GLOBALS, ...args },
      harness.store.context,
    );
    await harness.model.methods.restoreCleanup.execute(
      { ...GLOBALS, ...args },
      harness.store.context,
    );
    const packageCommands = harness.calls.filter((argv) => argv[3] === "pm");
    assertEqual(
      packageCommands.map((argv) => argv[4]),
      ["disable-user"],
      "A fresh state read showing the original state must make restore a no-op",
    );
    const entry =
      (currentPlan(harness).journal as Array<Record<string, unknown>>)[0];
    assertEqual(
      entry.restoreStatus,
      "restored",
      "The journal records no-op recovery",
    );
  },
);

cleanupTest(
  "restore conflict requires explicit reviewed retry and checks state first",
  async () => {
    const harness = createHarness({ initialState: 0 });
    const { planId } = await prepare(harness);
    const args = approvedPackage(planId);
    await harness.model.methods.applyCleanup.execute(
      { ...GLOBALS, ...args },
      harness.store.context,
    );
    harness.setState(2);
    await harness.model.methods.restoreCleanup.execute(
      { ...GLOBALS, ...args },
      harness.store.context,
    );
    assertEqual(harness.state(), 2, "State 2 drift must remain untouched");
    assertEqual(
      harness.calls.filter((argv) => argv[3] === "pm").map((argv) => argv[4]),
      ["disable-user"],
      "Conflict detection must not run a restoration command",
    );

    harness.setState(3);
    await harness.model.methods.restoreCleanup.execute(
      { ...GLOBALS, ...args },
      harness.store.context,
    );
    assertEqual(
      harness.state(),
      3,
      "Conflict recovery must wait for explicit retry approval",
    );
    await harness.model.methods.restoreCleanup.execute(
      { ...GLOBALS, ...args, retryPreviousRestore: true },
      harness.store.context,
    );
    assertEqual(
      harness.state(),
      0,
      "Reviewed retry should restore the exact default state",
    );
  },
);

cleanupTest(
  "restore blocks on build drift and permits explicit recovery after revalidation",
  async () => {
    const harness = createHarness({ initialState: 1 });
    const { planId } = await prepare(harness);
    const args = approvedPackage(planId);
    await harness.model.methods.applyCleanup.execute(
      { ...GLOBALS, ...args },
      harness.store.context,
    );
    harness.setBuild("ro.build.display.id", "other-build");
    await harness.model.methods.restoreCleanup.execute(
      { ...GLOBALS, ...args },
      harness.store.context,
    );
    assertEqual(
      harness.state(),
      3,
      "Build drift must block restoration commands",
    );
    assertEqual(
      harness.calls.filter((argv) => argv[3] === "pm").map((argv) => argv[4]),
      ["disable-user"],
      "No restore operation may run against a mismatched build",
    );
    harness.setBuild("ro.build.display.id", BUILD.buildDisplayId);
    await harness.model.methods.restoreCleanup.execute(
      { ...GLOBALS, ...args, retryPreviousRestore: true },
      harness.store.context,
    );
    assertEqual(
      harness.state(),
      1,
      "Explicit recovery restores after build revalidation",
    );
  },
);

cleanupTest(
  "unknown restore outcome requires read-back and explicit retry",
  async () => {
    const harness = createHarness({ initialState: 1 });
    const { planId } = await prepare(harness);
    const args = approvedPackage(planId);
    await harness.model.methods.applyCleanup.execute(
      { ...GLOBALS, ...args },
      harness.store.context,
    );
    harness.restoreBehavior = "throwBefore";
    await harness.model.methods.restoreCleanup.execute(
      { ...GLOBALS, ...args },
      harness.store.context,
    );
    let journal = currentPlan(harness).journal as Array<
      Record<string, unknown>
    >;
    assertEqual(
      journal[0].restoreStatus,
      "unknown",
      "Unconfirmed restore remains unknown",
    );
    const firstRestoreCount =
      harness.calls.filter((argv) => argv[3] === "pm" && argv[4] === "enable")
        .length;
    await harness.model.methods.restoreCleanup.execute(
      { ...GLOBALS, ...args },
      harness.store.context,
    );
    assertEqual(
      harness.calls.filter((argv) => argv[3] === "pm" && argv[4] === "enable")
        .length,
      firstRestoreCount,
      "Unknown outcome must not be blindly repeated",
    );
    harness.restoreBehavior = "normal";
    await harness.model.methods.restoreCleanup.execute(
      { ...GLOBALS, ...args, retryPreviousRestore: true },
      harness.store.context,
    );
    journal = currentPlan(harness).journal as Array<Record<string, unknown>>;
    assertEqual(
      harness.state(),
      1,
      "Explicit retry restores the recorded state",
    );
    assertEqual(
      journal[0].restoreStatus,
      "restored",
      "Read-back resolves the recovery journal",
    );
  },
);

cleanupTest(
  "restore reads the immutable baseline version, not a newer same-name version",
  async () => {
    const harness = createHarness({ initialState: 0 });
    const { planId, baselineName, baseline } = await prepare(harness);
    harness.store.context.writeResource(
      "cleanupBaseline",
      baselineName,
      {
        ...baseline,
        packages: [{ ...baseline.packages[0], originalState: 1 }],
      },
    );
    assertEqual(
      harness.store.latest(baselineName)?.version,
      2,
      "Fixture adds a later version",
    );
    await harness.model.methods.applyCleanup.execute(
      { ...GLOBALS, ...approvedPackage(planId) },
      harness.store.context,
    );
    const inventedRestoreArgs = {
      ...GLOBALS,
      ...approvedPackage(planId),
      originalState: 1,
    };
    await harness.model.methods.restoreCleanup.execute(
      inventedRestoreArgs,
      harness.store.context,
    );
    assertEqual(
      harness.state(),
      0,
      "Restore must use recorded version 1 state zero",
    );
    assertEqual(
      harness.calls.filter((argv) => argv[3] === "pm").map((argv) => argv[4]),
      ["disable-user", "default-state"],
      "The later baseline version must not change the selected restore command",
    );
  },
);

cleanupTest(
  "only one active plan is allowed, and recovery data remains versioned",
  async () => {
    const harness = createHarness({ initialState: 1 });
    const first = await prepare(harness);
    await assertRejects(
      () => prepare(harness),
      /prior cleanup plan is still active or unresolved/,
    );
    await harness.model.methods.restoreCleanup.execute(
      { ...GLOBALS, ...approvedPackage(first.planId) },
      harness.store.context,
    );
    const second = await prepare(harness);
    assert(
      first.planId !== second.planId,
      "A completed plan must not be overwritten",
    );
    const firstBaselineRecord = harness.store.atVersion(first.baselineName, 1);
    assert(
      firstBaselineRecord !== undefined,
      "Original baseline version must remain",
    );
    const firstBaseline = CleanupBaselineSchema.parse(firstBaselineRecord.data);
    assertEqual(
      firstBaseline.packages[0]?.originalState,
      1,
      "The original immutable baseline must remain recoverable",
    );
    assertEqual(
      harness.store.latest(`cleanup-baseline-${second.planId}`)?.version,
      1,
      "A new plan receives a separate baseline instance chain",
    );
  },
);

cleanupTest(
  "multi-package plans still apply exactly one package per invocation",
  async () => {
    const secondPackage = "com.example.second";
    const harness = createHarness({
      packages: [defaultPackage(1), {
        ...defaultPackage(0),
        packageName: secondPackage,
      }],
    });
    const { planId, baseline } = await prepare(harness, [
      PACKAGE_NAME,
      secondPackage,
    ]);
    assertEqual(
      baseline.packages.map((entry: Record<string, unknown>) =>
        entry.packageName
      ),
      [PACKAGE_NAME, secondPackage],
      "The exact selected package set belongs to one plan",
    );
    await harness.model.methods.applyCleanup.execute(
      { ...GLOBALS, ...approvedPackage(planId, PACKAGE_NAME) },
      harness.store.context,
    );
    assertEqual(
      harness.state(PACKAGE_NAME),
      3,
      "The requested package is disabled",
    );
    assertEqual(
      harness.state(secondPackage),
      0,
      "Other approved packages remain untouched",
    );
    assertEqual(
      harness.calls.filter((argv) => argv[3] === "pm").map((argv) =>
        argv.at(-1)
      ),
      [PACKAGE_NAME],
      "One apply invocation must never issue bulk package commands",
    );
  },
);
