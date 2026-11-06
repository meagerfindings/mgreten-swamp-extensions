import {
  type CommandResult,
  type CommandRunner,
  runDenoCommand,
} from "./_lib/adb.ts";
import { DeviceInventorySchema } from "./_lib/inventory.ts";
import { SonyApiError } from "./_lib/sony.ts";
import { createAndroidTvModel } from "./android_tv.ts";

interface CapturedWrite {
  readonly specName: string;
  readonly instanceName: string;
  readonly data: Record<string, unknown>;
}

interface RuntimeGlobalArgs {
  readonly adbBinary: string;
  readonly commandTimeoutMs: number;
  readonly sonyTimeoutMs: number;
}

const DEFAULT_RUNTIME_GLOBALS: RuntimeGlobalArgs = {
  adbBinary: "/example/android-sdk/platform-tools/adb",
  commandTimeoutMs: 1_000,
  sonyTimeoutMs: 1_000,
};

function withRuntimeGlobals<const T extends object>(
  methodArgs: T,
  overrides: Partial<RuntimeGlobalArgs> = {},
) {
  return { ...DEFAULT_RUNTIME_GLOBALS, ...overrides, ...methodArgs };
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

async function assertRejects(
  operation: () => Promise<unknown>,
  messagePattern: RegExp,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(messagePattern.test(message), `Unexpected rejection: ${message}`);
    return;
  }
  throw new Error("Expected operation to reject.");
}

function createContext(overrides: Record<string, unknown> = {}) {
  const writes: CapturedWrite[] = [];
  const logs: string[] = [];
  return {
    writes,
    logs,
    context: {
      globalArgs: {
        ...DEFAULT_RUNTIME_GLOBALS,
        ...overrides,
      },
      logger: {
        info: (message: string) => logs.push(message),
      },
      writeResource: (
        specName: string,
        instanceName: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ specName, instanceName, data });
        return Promise.resolve({
          specName,
          name: instanceName,
          kind: "resource" as const,
          version: 1,
        });
      },
    },
  };
}

function success(stdout: string): CommandResult {
  return { success: true, exitCode: 0, stdout, stderr: "" };
}

function inventoryRunner(
  options: {
    readonly enabledPackages?: string;
    readonly disabledPackages?: string;
    readonly failAt?: string;
  } = {},
) {
  const calls: Array<{ executable: string; args: string[] }> = [];
  const propertyValues: Record<string, string> = {
    "ro.product.model": "ExampleAndroidTV",
    "ro.build.version.release": "7.0",
    "ro.build.version.sdk": "24",
    "ro.build.version.security_patch": "2019-05-01",
    "ro.build.display.id": "example-build-1",
  };
  const runner: CommandRunner = (executable, args) => {
    const copiedArgs = [...args];
    calls.push({ executable, args: copiedArgs });
    if (options.failAt && copiedArgs.includes(options.failAt)) {
      return Promise.resolve({
        success: false,
        exitCode: 1,
        stdout: "",
        stderr: "synthetic failure",
      });
    }
    if (copiedArgs[3] === "getprop") {
      return Promise.resolve(success(propertyValues[copiedArgs[4]] ?? ""));
    }
    if (copiedArgs[3] === "pm") {
      return Promise.resolve(success(
        copiedArgs[6] === "-e"
          ? options.enabledPackages ??
            "package:com.example.launcher\npackage:android\n"
          : options.disabledPackages ?? "package:com.example.disabled\n",
      ));
    }
    if (copiedArgs[3] === "cat") {
      return Promise.resolve(success(
        "MemTotal:        2048000 kB\nMemFree:          128000 kB\nMemAvailable:     512000 kB\nCached:           256000 kB\n",
      ));
    }
    if (copiedArgs[3] === "df") {
      return Promise.resolve(success(
        "Filesystem          1K-blocks Used Available Use% Mounted on\n/dev/block/example 100000 25000 75000 25% /data\n",
      ));
    }
    return Promise.reject(
      new Error(
        `Unexpected synthetic ADB command: ${copiedArgs.join(" ")}`,
      ),
    );
  };
  return { calls, runner };
}

Deno.test("Sony identify sends the fixed interface-information request", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const model = createAndroidTvModel({
    fetcher: (input, init) => {
      requestUrl = input.toString();
      requestInit = init;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 33,
            result: [{
              modelName: "Example BRAVIA Model",
              serverName: "",
              interfaceVersion: "1.0",
              productName: "ExampleProduct",
              productCategory: "TV",
            }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    },
    now: () => new Date("2026-11-06T12:00:00.000Z"),
  });
  const test = createContext();

  await model.methods.identifySony.execute(
    withRuntimeGlobals({ host: "192.0.2.10" }),
    test.context,
  );

  assertEqual(
    requestUrl,
    "http://192.0.2.10/sony/system",
    "Sony endpoint must be fixed",
  );
  assertEqual(requestInit?.method, "POST", "Sony endpoint must use POST");
  assertEqual(
    new Headers(requestInit?.headers).get("content-type"),
    "application/json",
    "Sony request must be JSON",
  );
  assertEqual(
    requestInit?.redirect,
    "error",
    "Sony request must reject redirects to arbitrary URLs",
  );
  assertEqual(JSON.parse(String(requestInit?.body)), {
    method: "getInterfaceInformation",
    id: 33,
    params: [],
    version: "1.0",
  }, "Sony request payload must match the documented v1.0 method");
  assertEqual(
    test.writes[0]?.data.modelName,
    "Example BRAVIA Model",
    "Sony retail identity must be retained",
  );
  assertEqual(
    test.writes[0]?.data.serverName,
    "",
    "Documented empty serverName must be accepted",
  );
  assertEqual(
    test.writes[0]?.data.queriedAt,
    "2026-11-06T12:00:00.000Z",
    "Sony query timestamp must be recorded",
  );
});

Deno.test("Sony identify rejects JSON-RPC errors even with HTTP 200", async () => {
  const model = createAndroidTvModel({
    fetcher: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: 33,
            error: [7, "synthetic Sony error"],
            result: [{ modelName: "Example" }],
          }),
          { status: 200 },
        ),
      ),
  });
  const test = createContext();

  let failure: unknown;
  try {
    await model.methods.identifySony.execute(
      withRuntimeGlobals({ host: "192.0.2.10" }),
      test.context,
    );
  } catch (error) {
    failure = error;
  }
  assert(
    failure instanceof SonyApiError,
    "RPC errors must use the typed error",
  );
  assertEqual(
    failure.rpcErrorCode,
    7,
    "RPC error code must be preserved safely",
  );
  assert(
    !failure.message.includes("synthetic Sony error"),
    "RPC error message text must not be copied into diagnostics",
  );
  assertEqual(test.writes.length, 0, "Sony error must not create a resource");
});

Deno.test("Sony identify accepts JSON-RPC codes at the documented boundaries", async () => {
  for (const rpcErrorCode of [0, 65_535]) {
    const model = createAndroidTvModel({
      fetcher: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: 33,
              error: [rpcErrorCode, "synthetic boundary error"],
            }),
            { status: 200 },
          ),
        ),
    });
    const test = createContext();
    let failure: unknown;
    try {
      await model.methods.identifySony.execute(
        withRuntimeGlobals({ host: "192.0.2.10" }),
        test.context,
      );
    } catch (error) {
      failure = error;
    }

    assert(
      failure instanceof SonyApiError,
      "Documented numeric code must still reject the RPC response",
    );
    assertEqual(
      failure.rpcErrorCode,
      rpcErrorCode,
      "Documented boundary code must remain available for diagnosis",
    );
    assert(
      !failure.message.includes("synthetic boundary error"),
      "RPC error message must not be copied into diagnostics",
    );
    assertEqual(test.writes.length, 0, "RPC error must not create a resource");
  }
});

Deno.test("Sony identify rejects malformed JSON-RPC array codes", async () => {
  const malformedErrors: unknown[] = [
    [-1, "synthetic error"],
    [65_536, "synthetic error"],
    [7.5, "synthetic error"],
    ["7", "synthetic error"],
    [7],
    [7, 42],
    { code: 7, message: "synthetic error" },
  ];

  for (const rpcError of malformedErrors) {
    const model = createAndroidTvModel({
      fetcher: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ id: 33, error: rpcError }),
            { status: 200 },
          ),
        ),
    });
    const test = createContext();
    let failure: unknown;
    try {
      await model.methods.identifySony.execute(
        withRuntimeGlobals({ host: "192.0.2.10" }),
        test.context,
      );
    } catch (error) {
      failure = error;
    }

    assert(
      failure instanceof SonyApiError,
      "Malformed RPC error must still be rejected",
    );
    assertEqual(
      failure.rpcErrorCode,
      undefined,
      "Malformed code must not be surfaced as a diagnostic code",
    );
    assert(
      !failure.message.includes("synthetic error"),
      "Malformed RPC error message must not be copied into diagnostics",
    );
    assertEqual(test.writes.length, 0, "RPC error must not create a resource");
  }
});

Deno.test("Sony identify rejects non-success HTTP status", async () => {
  const model = createAndroidTvModel({
    fetcher: () =>
      Promise.resolve(
        new Response("synthetic upstream failure", { status: 503 }),
      ),
  });
  const test = createContext();
  const privateBodyMarker = "private-diagnostic-body";
  const diagnosticModel = createAndroidTvModel({
    fetcher: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: [5031, privateBodyMarker] }),
          { status: 503 },
        ),
      ),
  });

  await assertRejects(
    () =>
      model.methods.identifySony.execute(
        withRuntimeGlobals({ host: "192.0.2.10" }),
        test.context,
      ),
    /HTTP 503/,
  );
  assertEqual(test.writes.length, 0, "HTTP failure must not create a resource");

  const diagnosticTest = createContext();
  let failure: unknown;
  try {
    await diagnosticModel.methods.identifySony.execute(
      withRuntimeGlobals({ host: "192.0.2.10" }),
      diagnosticTest.context,
    );
  } catch (error) {
    failure = error;
  }
  assert(
    failure instanceof SonyApiError,
    "HTTP failures must use the typed error",
  );
  assertEqual(
    failure.httpStatus,
    503,
    "HTTP status must be available explicitly",
  );
  assertEqual(
    failure.rpcErrorCode,
    5031,
    "Bounded RPC code should aid diagnosis",
  );
  assert(
    !failure.message.includes(privateBodyMarker),
    "HTTP error message must not expose response text",
  );
  assertEqual(
    diagnosticTest.writes.length,
    0,
    "HTTP failure must not create a resource",
  );
});

Deno.test("Sony identify rejects malformed results, invalid hosts, and oversized bodies", async () => {
  let fetchCount = 0;
  const malformed = createAndroidTvModel({
    fetcher: () => {
      fetchCount++;
      return Promise.resolve(
        new Response(
          JSON.stringify({ id: 33, result: [{ modelName: "Example" }] }),
          { status: 200 },
        ),
      );
    },
  });
  const malformedTest = createContext();
  await assertRejects(
    () =>
      malformed.methods.identifySony.execute(
        withRuntimeGlobals({ host: "192.0.2.10" }),
        malformedTest.context,
      ),
    /malformed interface information/,
  );
  assertEqual(
    malformedTest.writes.length,
    0,
    "Malformed Sony result must not create a resource",
  );

  await assertRejects(
    () =>
      malformed.methods.identifySony.execute(
        withRuntimeGlobals({ host: "256.0.0.1" }),
        malformedTest.context,
      ),
    /Sony host must be an IPv4 address/,
  );
  assertEqual(
    fetchCount,
    1,
    "Invalid Sony host must be rejected before the HTTP request",
  );

  const oversized = createAndroidTvModel({
    fetcher: () =>
      Promise.resolve(new Response("x".repeat(16 * 1024 + 1), { status: 200 })),
  });
  const oversizedTest = createContext();
  await assertRejects(
    () =>
      oversized.methods.identifySony.execute(
        withRuntimeGlobals({ host: "192.0.2.10" }),
        oversizedTest.context,
      ),
    /exceeded the 16384-byte limit/,
  );
  assertEqual(
    oversizedTest.writes.length,
    0,
    "Oversized Sony response must not create a resource",
  );
});

Deno.test("Sony identify enforces an abort timeout", async () => {
  const model = createAndroidTvModel({
    fetcher: (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new Error("synthetic abort")), { once: true });
      }),
  });
  const test = createContext({ sonyTimeoutMs: 500 });

  await assertRejects(
    () =>
      model.methods.identifySony.execute(
        withRuntimeGlobals({ host: "192.0.2.10" }, { sonyTimeoutMs: 500 }),
        test.context,
      ),
    /timed out after 500 ms/,
  );
  assertEqual(test.writes.length, 0, "Sony timeout must not create a resource");
});

Deno.test("ADB readiness invokes only configured adb version and parses its output", async () => {
  let actualExecutable = "";
  let actualArgs: string[] = [];
  const model = createAndroidTvModel({
    commandRunner: (executable, args) => {
      actualExecutable = executable;
      actualArgs = [...args];
      return Promise.resolve(success(
        "Android Debug Bridge version 1.0.41\nVersion 37.0.0-example\n",
      ));
    },
    now: () => new Date("2026-11-06T12:00:00.000Z"),
  });
  const test = createContext({ adbBinary: "/example/selected/adb" });

  await model.methods.checkAdbVersion.execute(
    withRuntimeGlobals({}, { adbBinary: "/example/selected/adb" }),
    test.context,
  );

  assertEqual(
    actualExecutable,
    "/example/selected/adb",
    "ADB executable must come from local configuration",
  );
  assertEqual(
    actualArgs,
    ["version"],
    "Readiness must not query devices or manage the server",
  );
  assertEqual(
    test.writes[0]?.data.clientVersion,
    "1.0.41",
    "ADB client version must be parsed",
  );
  assertEqual(
    test.writes[0]?.data.packageBuild,
    "37.0.0-example",
    "ADB package build must not be mislabeled as a server version",
  );
});

Deno.test("ADB readiness rejects command errors and malformed version output", async () => {
  const runners: CommandRunner[] = [
    () =>
      Promise.resolve({
        success: false,
        exitCode: 1,
        stdout: "",
        stderr: "synthetic error",
      }),
    () => Promise.resolve(success("not an adb version response")),
  ];
  for (const commandRunner of runners) {
    const model = createAndroidTvModel({ commandRunner });
    const test = createContext();
    await assertRejects(
      () =>
        model.methods.checkAdbVersion.execute(
          withRuntimeGlobals({}),
          test.context,
        ),
      /failed|recognized client version/,
    );
    assertEqual(
      test.writes.length,
      0,
      "Failed ADB readiness must not create a resource",
    );
  }
});

Deno.test("ADB methods reject an unsafe local executable before invoking it", async () => {
  let calls = 0;
  const model = createAndroidTvModel({
    commandRunner: () => {
      calls++;
      return Promise.resolve(success("Android Debug Bridge version 1.0.41\n"));
    },
  });
  const test = createContext({ adbBinary: "/example/adb\0unexpected" });

  await assertRejects(
    () =>
      model.methods.checkAdbVersion.execute(
        withRuntimeGlobals({}, { adbBinary: "/example/adb\0unexpected" }),
        test.context,
      ),
    /ADB executable path is invalid/,
  );
  assertEqual(calls, 0, "Invalid configured executable must not be invoked");
  assertEqual(
    test.writes.length,
    0,
    "Invalid configured executable must not create a resource",
  );
});

Deno.test("Inventory targets every read explicitly and separates package states", async () => {
  const { calls, runner } = inventoryRunner({
    enabledPackages: "package:android\npackage:com.example.launcher\n",
    disabledPackages: "package:com.example.disabled\n",
  });
  const model = createAndroidTvModel({
    commandRunner: runner,
    now: () => new Date("2026-11-06T12:00:00.000Z"),
  });
  const test = createContext();
  const target = "192.0.2.10:5555";

  await model.methods.inventory.execute(
    withRuntimeGlobals({ target, hostServerReviewed: true }),
    test.context,
  );

  assertEqual(
    calls.length,
    9,
    "Inventory must issue only the selected fixed reads",
  );
  assertEqual(calls.map((call) => call.args), [
    ["-s", target, "shell", "getprop", "ro.product.model"],
    ["-s", target, "shell", "getprop", "ro.build.version.release"],
    ["-s", target, "shell", "getprop", "ro.build.version.sdk"],
    ["-s", target, "shell", "getprop", "ro.build.version.security_patch"],
    ["-s", target, "shell", "getprop", "ro.build.display.id"],
    ["-s", target, "shell", "pm", "list", "packages", "-e", "--user", "0"],
    ["-s", target, "shell", "pm", "list", "packages", "-d", "--user", "0"],
    ["-s", target, "shell", "cat", "/proc/meminfo"],
    ["-s", target, "shell", "df", "-k", "/data"],
  ], "Inventory must use only the fixed minimal read commands");
  for (const call of calls) {
    assertEqual(
      call.args[0],
      "-s",
      "Every device command must select one explicit target",
    );
    assertEqual(
      call.args[1],
      target,
      "Every device command must use the exact validated target",
    );
    assert(
      !["connect", "pair", "tcpip", "start-server", "kill-server"].some((arg) =>
        call.args.includes(arg)
      ),
      "Inventory must not manage ADB connections or server lifecycle",
    );
  }
  const inventory = test.writes[0]?.data;
  assert(inventory !== undefined, "A valid inventory must be written once");
  assertEqual(
    inventory.androidProductModel,
    "ExampleAndroidTV",
    "Android product model must be distinct from Sony retail identity",
  );
  assertEqual(
    inventory.enabledPackages,
    ["android", "com.example.launcher"],
    "Enabled packages must be independently parsed",
  );
  assertEqual(
    inventory.disabledPackages,
    ["com.example.disabled"],
    "Disabled packages must be independently parsed",
  );
  assertEqual(inventory.memory, {
    totalBytes: 2_097_152_000,
    freeBytes: 131_072_000,
    availableBytes: 524_288_000,
    cachedBytes: 262_144_000,
  }, "Memory totals must come from bounded /proc/meminfo fields");
  assertEqual(inventory.dataFilesystem, {
    totalBytes: 102_400_000,
    usedBytes: 25_600_000,
    availableBytes: 76_800_000,
  }, "/data capacity must come from df -k /data");
  assert(
    !JSON.stringify(inventory).includes(target),
    "Inventory resource must not retain its network target",
  );
  assert(
    DeviceInventorySchema.safeParse(inventory).success,
    "Written inventory must satisfy its strict resource schema",
  );
});

Deno.test("Runtime-merged globals are stripped and resource names coexist", async () => {
  const { calls, runner: inventoryRunnerFunction } = inventoryRunner();
  const commandRunner: CommandRunner = (
    executable,
    args,
    timeoutMs,
    maxBytes,
  ) =>
    args.length === 1 && args[0] === "version"
      ? Promise.resolve(success(
        "Android Debug Bridge version 1.0.41\nVersion 37.0.0-example\n",
      ))
      : inventoryRunnerFunction(executable, args, timeoutMs, maxBytes);
  const model = createAndroidTvModel({
    fetcher: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: 33,
            result: [{
              modelName: "Example BRAVIA Model",
              serverName: "",
              interfaceVersion: "1.0",
              productName: "ExampleProduct",
              productCategory: "TV",
            }],
          }),
          { status: 200 },
        ),
      ),
    commandRunner,
  });
  const test = createContext();
  const globalArgs = { ...DEFAULT_RUNTIME_GLOBALS };
  const sonyArgs = withRuntimeGlobals({ host: "192.0.2.10" }, globalArgs);
  const adbArgs = withRuntimeGlobals({}, globalArgs);
  const inventoryArgs = withRuntimeGlobals({
    target: "192.0.2.10:5555",
    hostServerReviewed: true,
  }, globalArgs);

  assertEqual(
    model.methods.identifySony.arguments.parse(sonyArgs),
    { host: "192.0.2.10" },
    "Sony method parsing must strip the merged global fields",
  );
  await model.methods.identifySony.execute(sonyArgs, test.context);

  assertEqual(
    model.methods.checkAdbVersion.arguments.parse(adbArgs),
    {},
    "No-argument method parsing must strip the merged global fields",
  );
  await model.methods.checkAdbVersion.execute(adbArgs, test.context);

  assertEqual(
    model.methods.inventory.arguments.parse(inventoryArgs),
    { target: "192.0.2.10:5555", hostServerReviewed: true },
    "Inventory parsing must strip the merged global fields",
  );
  await model.methods.inventory.execute(inventoryArgs, test.context);

  assertEqual(
    test.writes.map(({ specName, instanceName }) => [
      specName,
      instanceName,
    ]),
    [
      ["sonyIdentification", "sony-identity"],
      ["adbReadiness", "adb-readiness"],
      ["deviceInventory", "device-inventory"],
    ],
    "Each resource spec must write to its own instance name",
  );
  assertEqual(
    new Set(test.writes.map(({ instanceName }) => instanceName)).size,
    3,
    "All three resource instances must coexist without name collisions",
  );
  assertEqual(calls.length, 9, "Synthetic inventory reads should all execute");
});

Deno.test("Inventory rejects overlap and malformed package output", async () => {
  for (
    const packageOptions of [
      {
        enabledPackages: "package:com.example.same\n",
        disabledPackages: "package:com.example.same\n",
      },
      { enabledPackages: "", disabledPackages: "" },
      { enabledPackages: "package:../unsafe\n", disabledPackages: "" },
    ]
  ) {
    const { runner } = inventoryRunner(packageOptions);
    const model = createAndroidTvModel({ commandRunner: runner });
    const test = createContext();
    await assertRejects(
      () =>
        model.methods.inventory.execute({
          ...withRuntimeGlobals({
            target: "192.0.2.10:5555",
            hostServerReviewed: true,
          }),
        }, test.context),
      /both enabled and disabled|no enabled|malformed/,
    );
    assertEqual(
      test.writes.length,
      0,
      "Invalid package inventory must not create a resource",
    );
  }
});

Deno.test("Inventory rejects unsafe targets before invoking ADB", async () => {
  let calls = 0;
  const runner: CommandRunner = () => {
    calls++;
    return Promise.resolve(success(""));
  };
  const model = createAndroidTvModel({ commandRunner: runner });
  const test = createContext();

  assert(
    !model.methods.inventory.arguments.safeParse({ target: "192.0.2.10:5555" })
      .success,
    "Inventory must require explicit host-server review acknowledgement",
  );
  assert(
    !model.methods.inventory.arguments.safeParse({
      target: "192.0.2.10:5555",
      hostServerReviewed: false,
    }).success,
    "Inventory acknowledgement must be true",
  );

  await assertRejects(
    () =>
      model.methods.inventory.execute({
        ...withRuntimeGlobals({
          target: "http://192.0.2.10",
          hostServerReviewed: true,
        }),
      }, test.context),
    /Invalid input|IPv4 address and TCP port/,
  );
  assertEqual(calls, 0, "Unsafe target must be rejected before executing ADB");
  assertEqual(
    test.writes.length,
    0,
    "Unsafe target must not create a resource",
  );
});

Deno.test("Inventory command failures and timeouts do not become empty success resources", async () => {
  const failed = inventoryRunner({ failAt: "getprop" });
  const failedModel = createAndroidTvModel({ commandRunner: failed.runner });
  const failedTest = createContext();
  await assertRejects(
    () =>
      failedModel.methods.inventory.execute({
        ...withRuntimeGlobals({
          target: "192.0.2.10:5555",
          hostServerReviewed: true,
        }),
      }, failedTest.context),
    /ADB property read failed/,
  );
  assertEqual(
    failedTest.writes.length,
    0,
    "ADB command failure must not create a resource",
  );

  const timeoutModel = createAndroidTvModel({
    commandRunner: () =>
      Promise.reject(new Error("ADB command timed out after 1000 ms.")),
  });
  const timeoutTest = createContext();
  await assertRejects(
    () =>
      timeoutModel.methods.inventory.execute({
        ...withRuntimeGlobals({
          target: "192.0.2.10:5555",
          hostServerReviewed: true,
        }),
      }, timeoutTest.context),
    /timed out/,
  );
  assertEqual(
    timeoutTest.writes.length,
    0,
    "ADB timeout must not create a resource",
  );
});

async function withTemporaryCommandScript(
  source: string,
  execute: (path: string) => Promise<void>,
): Promise<void> {
  const path = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(path, source);
    await execute(path);
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
}

Deno.test({
  name: "Production ADB command runner terminates a timed-out child",
  permissions: { run: [Deno.execPath()], write: true },
  fn: async () => {
    await withTemporaryCommandScript(
      "setInterval(() => {}, 60_000);\n",
      async (scriptPath) => {
        const startedAt = performance.now();
        await assertRejects(
          () =>
            runDenoCommand(
              Deno.execPath(),
              ["run", "--quiet", "--no-check", scriptPath],
              500,
              1_024,
            ),
          /timed out after 500 ms/,
        );
        assert(
          performance.now() - startedAt < 5_000,
          "Timed-out command should be killed and awaited promptly",
        );
      },
    );
  },
});

Deno.test({
  name:
    "Production ADB command runner kills children that exceed output limits",
  permissions: { run: [Deno.execPath()], write: true },
  fn: async () => {
    await withTemporaryCommandScript(
      "const chunk = new Uint8Array(4096).fill(0x61);\n" +
        "while (true) await Deno.stdout.write(chunk);\n",
      async (scriptPath) => {
        await assertRejects(
          () =>
            runDenoCommand(
              Deno.execPath(),
              ["run", "--quiet", "--no-check", scriptPath],
              5_000,
              1_024,
            ),
          /output exceeded the 1024-byte limit/,
        );
      },
    );
  },
});
