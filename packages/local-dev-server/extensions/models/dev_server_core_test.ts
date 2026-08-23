import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  type CommandResult,
  GlobalArgsSchema,
  type LifecycleDependencies,
  runCommand,
  start,
  status,
  stop,
  validateWorkingDirectory,
} from "./dev_server_core.ts";

const result = (code: number, stdout = "", stderr = ""): CommandResult => ({
  code,
  stdout,
  stderr,
});

function mockedLifecycle(
  commands: Record<string, CommandResult>,
  statuses: number[],
): LifecycleDependencies {
  let now = 0;
  return {
    run(command) {
      return Promise.resolve(
        commands[command] ?? result(1, "", "unexpected command"),
      );
    },
    fetch(_url, _signal) {
      const next = statuses.shift();
      if (next === undefined) return Promise.reject(new Error("not ready"));
      return Promise.resolve({ status: next });
    },
    sleep(milliseconds) {
      now += milliseconds;
      return Promise.resolve();
    },
    now() {
      return new Date(now);
    },
  };
}

const config = {
  startCommand: "supervisor start demo",
  stopCommand: "supervisor stop demo",
  statusCommand: "supervisor status demo",
  healthCheck: {
    url: "http://127.0.0.1:4100/health",
    expectedStatus: 204,
    timeoutMs: 10,
    intervalMs: 1,
  },
  certificate: { strategy: "none" as const },
};

Deno.test("start waits for the mocked loopback service and records a healthy lifecycle state", async () => {
  const dependencies = mockedLifecycle({
    "supervisor start demo": result(0, "started"),
    "supervisor status demo": result(0, "running"),
  }, [503, 204]);

  const outcome = await start(config, "/tmp/demo", dependencies);

  assertEquals(outcome.command.stdout, "started");
  assertEquals(outcome.status, {
    running: true,
    health: "healthy",
    healthUrl: "http://127.0.0.1:4100/health",
    commandExitCode: 0,
    certificateExpiresAt: null,
    checkedAt: new Date(1).toISOString(),
  });
});

Deno.test("stop records an unhealthy stopped lifecycle state", async () => {
  const dependencies = mockedLifecycle({
    "supervisor stop demo": result(0, "stopped"),
    "supervisor status demo": result(3, "stopped"),
  }, []);

  const outcome = await stop(config, "/tmp/demo", dependencies);

  assertEquals(outcome.status.running, false);
  assertEquals(outcome.status.health, "unhealthy");
  assertEquals(outcome.status.commandExitCode, 3);
});

Deno.test("a failed start command does not attempt a health check", async () => {
  const dependencies = mockedLifecycle({
    "supervisor start demo": result(2, "", "failed"),
  }, []);

  await assertRejects(
    () => start(config, "/tmp/demo", dependencies),
    Error,
    "startCommand exited with 2",
  );
});

Deno.test("schemas reject unknown configuration fields", () => {
  const parsed = GlobalArgsSchema.safeParse({
    startCommand: "start",
    stopCommand: "stop",
    certificate: { strategy: "none" },
    unexpected: true,
  });
  assertEquals(parsed.success, false);
});

Deno.test("health URLs reject non-HTTP protocols and embedded credentials", () => {
  for (
    const url of [
      "file://localhost/tmp/health",
      "http://user:password@localhost:3000/health",
      "http://example.com:3000/health",
    ]
  ) {
    const parsed = GlobalArgsSchema.safeParse({
      startCommand: "start",
      stopCommand: "stop",
      healthCheck: { url },
    });
    assertEquals(parsed.success, false);
  }
});

Deno.test("working directories are confined to the repository", async () => {
  assertEquals(await validateWorkingDirectory("/tmp", "/tmp"), "/tmp");
  await assertRejects(
    () => validateWorkingDirectory("/tmp", "/"),
    Error,
    "workingDirectory must be",
  );
});

Deno.test("health fetch receives an abort signal bounded by the health deadline", async () => {
  let receivedSignal: AbortSignal | undefined;
  const dependencies = mockedLifecycle({}, []);
  dependencies.fetch = (_url, signal) => {
    receivedSignal = signal;
    return Promise.resolve({ status: 200 });
  };
  await status(
    {
      startCommand: "start",
      stopCommand: "stop",
      healthCheck: {
        url: "http://localhost:3000",
        expectedStatus: 200,
        timeoutMs: 100,
        intervalMs: 50,
      },
      certificate: { strategy: "none" },
    },
    "/tmp/demo",
    dependencies,
  );
  assertEquals(receivedSignal instanceof AbortSignal, true);
});

Deno.test("certificate command failures and invalid timestamps are reported", async () => {
  for (const commandResult of [result(2), result(0, "not-a-timestamp")]) {
    const dependencies = mockedLifecycle({ certificate: commandResult }, []);
    await assertRejects(
      () =>
        status(
          {
            startCommand: "start",
            stopCommand: "stop",
            certificate: {
              strategy: "command",
              expiryCommand: "certificate",
            },
          },
          "/tmp/demo",
          dependencies,
        ),
      Error,
      commandResult.code === 0 ? "invalid timestamp" : "exited with 2",
    );
  }
});

Deno.test("status supports health-only configurations", async () => {
  const dependencies = mockedLifecycle({}, [200]);
  const outcome = await status(
    {
      startCommand: "start",
      stopCommand: "stop",
      healthCheck: {
        url: "http://localhost:3000",
        expectedStatus: 200,
        timeoutMs: 100,
        intervalMs: 50,
      },
      certificate: { strategy: "none" },
    },
    "/tmp/demo",
    dependencies,
  );

  assertEquals(outcome.running, true);
  assertEquals(outcome.commandExitCode, null);
});

Deno.test("start fails when configured readiness checks do not become healthy", async () => {
  const dependencies = mockedLifecycle({
    start: result(0),
    check: result(0),
  }, [503]);
  await assertRejects(
    () =>
      start(
        {
          startCommand: "start",
          stopCommand: "stop",
          statusCommand: "check",
          healthCheck: {
            url: "http://localhost:3000/health",
            expectedStatus: 200,
            timeoutMs: 1,
            intervalMs: 1,
          },
          certificate: { strategy: "none" },
        },
        "/tmp",
        dependencies,
      ),
    Error,
    "health check failed",
  );
});

Deno.test("stop fails when the supervisor still reports running", async () => {
  const dependencies = mockedLifecycle({
    stop: result(0),
    check: result(0),
  }, []);
  await assertRejects(
    () =>
      stop(
        {
          startCommand: "start",
          stopCommand: "stop",
          statusCommand: "check",
          certificate: { strategy: "none" },
        },
        "/tmp",
        dependencies,
      ),
    Error,
    "still running",
  );
});

Deno.test("real command runner terminates hung children", async () => {
  await assertRejects(
    () => runCommand("sleep 10", "/tmp", 100, 1024),
    Error,
    "timed out",
  );
});

Deno.test("real command runner bounds flood output", async () => {
  const output = await runCommand("yes x | head -c 100000", "/tmp", 2_000, 512);
  assertEquals(output.code, 0);
  assertEquals(new TextEncoder().encode(output.stdout).length <= 512, true);
});

Deno.test("failed command context is bounded and credential-redacted", async () => {
  const dependencies = mockedLifecycle({
    start: result(2, "", `Bearer top-secret\n${"x".repeat(1000)}`),
  }, []);
  const error = await assertRejects(() =>
    start(
      {
        startCommand: "start",
        stopCommand: "stop",
        certificate: { strategy: "none" },
      },
      "/tmp",
      dependencies,
    )
  );
  assertEquals(String(error).includes("top-secret"), false);
  assertEquals(String(error).length < 600, true);
});
