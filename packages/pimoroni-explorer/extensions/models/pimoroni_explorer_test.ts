// Unit coverage uses injected command runners; no physical board is required.
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import {
  buildDashboardProgram,
  buildDashboardPagesProgram,
  buildProbeProgram,
  buildScoreProgram,
  type CommandRunner,
  DashboardPagesArgumentsSchema,
  DashboardUsagePageSchema,
  model,
  validateTarget,
} from "./pimoroni_explorer.ts";

function fakeContext() {
  const writes: Array<{ specName: string; name: string; data: Record<string, unknown> }> = [];
  return {
    writes,
    context: {
      globalArgs: { device: "auto", mpremoteCommand: "mpremote", timeoutMs: 30_000 },
      logger: { info: () => {}, error: () => {} },
      extensionFile: (relativePath: string) =>
        decodeURIComponent(new URL(relativePath, import.meta.url).pathname),
      writeResource: (
        specName: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ specName, name, data });
        return Promise.resolve({ specName, name });
      },
    },
  };
}

function successfulRunner(stdout: string): CommandRunner {
  return (_command, _args, _timeoutMs) =>
    Promise.resolve({ success: true, code: 0, stdout, stderr: "", timedOut: false });
}

Deno.test("probe records a verified Explorer response", async () => {
  const { context, writes } = fakeContext();
  const stdout = 'SWAMP_EXPLORER_PROBE={"machine":"Pimoroni Explorer with RP2350","micropythonVersion":"1.27.0","displayWidth":320,"displayHeight":240,"files":["main.py"]}\n';
  await model.methods.probe.execute(
    { _runner: successfulRunner(stdout) },
    // deno-lint-ignore no-explicit-any
    context as any,
  );
  assertEquals(writes.length, 1);
  assertEquals(writes[0].specName, "device");
  assertEquals(writes[0].name, "device-current");
  assertEquals(writes[0].data.displayWidth, 320);
});

Deno.test("probe rejects a different MicroPython board before writing data", async () => {
  const { context, writes } = fakeContext();
  const stdout = 'SWAMP_EXPLORER_PROBE={"machine":"Raspberry Pi Pico","micropythonVersion":"1.27.0","displayWidth":320,"displayHeight":240,"files":[]}\n';
  await assertRejects(
    () =>
      model.methods.probe.execute(
        { _runner: successfulRunner(stdout) },
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
    Error,
    "not a Pimoroni Explorer",
  );
  assertEquals(writes.length, 0);
});

Deno.test("probe rejects malformed device output before writing data", async () => {
  const { context, writes } = fakeContext();
  const stdout = 'SWAMP_EXPLORER_PROBE={"machine":"Pimoroni Explorer","displayWidth":"wide"}\n';
  await assertRejects(
    () =>
      model.methods.probe.execute(
        { _runner: successfulRunner(stdout) },
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
    Error,
  );
  assertEquals(writes.length, 0);
});

Deno.test("displayScore passes values as Python literals and records confirmation", async () => {
  const { context, writes } = fakeContext();
  let commandArgs: string[] = [];
  const runner: CommandRunner = (_command, args) => {
    commandArgs = args;
    return Promise.resolve({
      success: true,
      code: 0,
      stdout: "SWAMP_EXPLORER_SCORE_OK\n",
      stderr: "",
      timedOut: false,
    });
  };
  await model.methods.displayScore.execute(
    { username: 'mat"\nprint("oops")', score: 1234, rank: 7, streakDays: 12, _runner: runner },
    // deno-lint-ignore no-explicit-any
    context as any,
  );
  assertEquals(commandArgs.slice(0, 3), ["connect", "auto", "exec"]);
  assertStringIncludes(commandArgs[3], 'username = "mat\\"\\nprint(\\"oops\\")"');
  assertEquals(writes[0].specName, "display");
  assertEquals(writes[0].data.score, 1234);
});

Deno.test("displayScore does not persist state without device confirmation", async () => {
  const { context, writes } = fakeContext();
  await assertRejects(
    () =>
      model.methods.displayScore.execute(
        { username: "mgreten", score: 1, _runner: successfulRunner("no marker") },
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
    Error,
    "did not confirm",
  );
  assertEquals(writes.length, 0);
});

Deno.test("displayScore reports command timeout without persisting state", async () => {
  const { context, writes } = fakeContext();
  const runner: CommandRunner = () =>
    Promise.resolve({
      success: false,
      code: 143,
      stdout: "",
      stderr: "",
      timedOut: true,
    });
  await assertRejects(
    () =>
      model.methods.displayScore.execute(
        { username: "mgreten", score: 1, _runner: runner },
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
    Error,
    "timed out after 30000ms",
  );
  assertEquals(writes.length, 0);
});

Deno.test("probe explains how to install a missing mpremote executable", async () => {
  const { context, writes } = fakeContext();
  const runner: CommandRunner = () => {
    throw new Deno.errors.NotFound("mpremote");
  };
  await assertRejects(
    () =>
      model.methods.probe.execute(
        { _runner: runner },
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
    Error,
    "pipx install mpremote",
  );
  assertEquals(writes.length, 0);
});

Deno.test("run executes a local script from RAM and records stdout", async () => {
  const { context, writes } = fakeContext();
  const scriptPath = await Deno.makeTempFile({ suffix: ".py" });
  await Deno.writeTextFile(scriptPath, 'print("hello")\n');
  let commandArgs: string[] = [];
  const runner: CommandRunner = (_command, args) => {
    commandArgs = args;
    return Promise.resolve({
      success: true,
      code: 0,
      stdout: "hello\n",
      stderr: "",
      timedOut: false,
    });
  };
  try {
    await model.methods.run.execute(
      { scriptPath, _runner: runner },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    assertEquals(commandArgs, ["connect", "auto", "run", scriptPath]);
    assertEquals(writes[0].specName, "run");
    assertEquals(writes[0].data.stdout, "hello\n");
  } finally {
    await Deno.remove(scriptPath);
  }
});

Deno.test("install copies a new menu app and records its digest", async () => {
  const { context, writes } = fakeContext();
  const appPath = await Deno.makeTempFile({ suffix: ".py" });
  await Deno.writeTextFile(appPath, 'print("score")\n');
  const calls: string[][] = [];
  const runner: CommandRunner = (_command, args) => {
    calls.push(args);
    const stdout = calls.length === 1
      ? 'SWAMP_EXPLORER_FILE={"exists":false,"sha256":null}\n'
      : "";
    return Promise.resolve({ success: true, code: 0, stdout, stderr: "", timedOut: false });
  };
  try {
    await model.methods.install.execute(
      { appPath, target: "swamp_score.py", force: false, _runner: runner },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
    assertEquals(calls.length, 2);
    assertEquals(calls[1], ["connect", "auto", "fs", "cp", appPath, ":swamp_score.py"]);
    assertEquals(writes[0].specName, "installation");
    assertEquals(writes[0].data.changed, true);
    assert(/^[0-9a-f]{64}$/.test(String(writes[0].data.sha256)));
  } finally {
    await Deno.remove(appPath);
  }
});

Deno.test("install refuses to replace changed content without force", async () => {
  const { context, writes } = fakeContext();
  const appPath = await Deno.makeTempFile({ suffix: ".py" });
  await Deno.writeTextFile(appPath, 'print("new")\n');
  let calls = 0;
  const runner: CommandRunner = () => {
    calls += 1;
    return Promise.resolve({
      success: true,
      code: 0,
      stdout: `SWAMP_EXPLORER_FILE={"exists":true,"sha256":"${"0".repeat(64)}"}\n`,
      stderr: "",
      timedOut: false,
    });
  };
  try {
    await assertRejects(
      () =>
        model.methods.install.execute(
          { appPath, target: "swamp_score.py", force: false, _runner: runner },
          // deno-lint-ignore no-explicit-any
          context as any,
        ),
      Error,
      "force=true",
    );
    assertEquals(calls, 1);
    assertEquals(writes.length, 0);
  } finally {
    await Deno.remove(appPath);
  }
});

Deno.test("installRickRoll resolves and installs the bundled menu app", async () => {
  const { context, writes } = fakeContext();
  const calls: string[][] = [];
  const runner: CommandRunner = (_command, args) => {
    calls.push(args);
    const stdout = calls.length === 1
      ? 'SWAMP_EXPLORER_FILE={"exists":false,"sha256":null}\n'
      : "";
    return Promise.resolve({ success: true, code: 0, stdout, stderr: "", timedOut: false });
  };
  await model.methods.installRickRoll.execute(
    { force: false, _runner: runner },
    // deno-lint-ignore no-explicit-any
    context as any,
  );
  assertEquals(calls.length, 2);
  assertEquals(calls[1].slice(0, 5), ["connect", "auto", "fs", "cp", calls[1][4]]);
  assert(calls[1][4].endsWith("/apps/rick_roll.py.txt"));
  assertEquals(calls[1][5], ":rick_roll.py");
  assertEquals(writes[0].specName, "installation");
  assertEquals(writes[0].data.target, "rick_roll.py");
});

Deno.test("installDashboard resolves and installs the bundled persistent menu app", async () => {
  const { context, writes } = fakeContext();
  const calls: string[][] = [];
  const runner: CommandRunner = (_command, args) => {
    calls.push(args);
    const stdout = calls.length === 1
      ? 'SWAMP_EXPLORER_FILE={"exists":false,"sha256":null}\n'
      : "";
    return Promise.resolve({ success: true, code: 0, stdout, stderr: "", timedOut: false });
  };
  await model.methods.installDashboard.execute(
    { force: false, _runner: runner },
    // deno-lint-ignore no-explicit-any
    context as any,
  );
  assertEquals(calls.length, 2);
  assert(calls[1][4].endsWith("/apps/swamp_dashboard.py.txt"));
  assertEquals(calls[1][5], ":swamp_dashboard.py");
  assertEquals(writes[0].specName, "installation");
  assertEquals(writes[0].data.target, "swamp_dashboard.py");
});

Deno.test("updateDashboard persists encoded values and records device confirmation", async () => {
  const { context, writes } = fakeContext();
  let commandArgs: string[] = [];
  const runner: CommandRunner = (_command, args) => {
    commandArgs = args;
    return Promise.resolve({
      success: true,
      code: 0,
      stdout: "SWAMP_EXPLORER_SCORE_OK\nSWAMP_EXPLORER_DASHBOARD_OK\n",
      stderr: "",
      timedOut: false,
    });
  };
  await model.methods.updateDashboard.execute(
    {
      title: 'CLAUDE "AMP"',
      value: 143_862_958,
      subtitle: "TOKENS BURNED TODAY",
      sourceUpdatedAt: "2026-07-31T14:57:54Z",
      _runner: runner,
    },
    // deno-lint-ignore no-explicit-any
    context as any,
  );
  assertEquals(commandArgs.slice(0, 3), ["connect", "auto", "exec"]);
  assertStringIncludes(commandArgs[3], "swamp_dashboard.tmp");
  assertStringIncludes(commandArgs[3], "swamp_dashboard.json");
  assertStringIncludes(commandArgs[3], "143,862,958");
  assertStringIncludes(commandArgs[3], 'CLAUDE \\\"AMP\\\"');
  assertEquals(writes[0].specName, "dashboard");
  assertEquals(writes[0].name, "dashboard-current");
  assertEquals(writes[0].data.value, 143_862_958);
});

Deno.test("updateDashboard does not persist Swamp state without save confirmation", async () => {
  const { context, writes } = fakeContext();
  await assertRejects(
    () =>
      model.methods.updateDashboard.execute(
        {
          title: "ALL AGENTS",
          value: 42,
          subtitle: "TOKENS BURNED TODAY",
          _runner: successfulRunner("SWAMP_EXPLORER_SCORE_OK\n"),
        },
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
    Error,
    "did not confirm",
  );
  assertEquals(writes.length, 0);
});

Deno.test("score program renders optional rank and streak", () => {
  const program = buildScoreProgram({
    username: "mgreten",
    score: 10_960_652,
    rank: 3,
    streakDays: 9,
  });
  assertStringIncludes(program, "score = 10960652");
  assertStringIncludes(program, 'score_text = "10,960,652"');
  assertStringIncludes(program, "scale=score_scale");
  assertStringIncludes(program, "rank = 3");
  assertStringIncludes(program, "streak = 9");
  assertStringIncludes(program, "display.update()");
});

Deno.test("score program accepts missing nullable profile metrics", () => {
  const program = buildScoreProgram({
    username: "mgreten",
    score: 42,
    rank: null,
    streakDays: null,
  });
  assertStringIncludes(program, "rank = None");
  assertStringIncludes(program, "streak = None");
});

Deno.test("dashboard program saves a versioned snapshot before rendering", () => {
  const program = buildDashboardProgram({
    title: "CLAUDE + AMP + CODEX",
    value: 143_862_958,
    subtitle: "TOKENS BURNED TODAY",
  });
  assertStringIncludes(program, '\\"version\\":1');
  assertStringIncludes(program, '\\"valueText\\":\\"143,862,958\\"');
  assert(program.indexOf("os.rename") < program.indexOf("display.update()"));
  assertStringIncludes(program, "SWAMP_EXPLORER_DASHBOARD_OK");
});

Deno.test("dashboard pages schema enforces bounds and discriminated page shapes", () => {
  const metric = {
    kind: "metric" as const,
    title: "SWAMP SCORE",
    subtitle: "TOTAL",
    value: 123_456,
    secondaryLabel: "TODAY / 24H",
    secondaryValue: 789,
  };
  const status = {
    kind: "status" as const,
    title: "HOME ASSISTANT",
    lines: [{ label: "Front Door", state: "OPEN", severity: "warning" as const }],
  };
  assert(DashboardPagesArgumentsSchema.safeParse({ pages: [metric, status] }).success);
  assert(!DashboardPagesArgumentsSchema.safeParse({ pages: [] }).success);
  assert(!DashboardPagesArgumentsSchema.safeParse({ pages: Array(7).fill(metric) }).success);
  assert(!DashboardPagesArgumentsSchema.safeParse({
    pages: [{ ...metric, title: "x".repeat(25) }],
  }).success);
  assert(!DashboardPagesArgumentsSchema.safeParse({
    pages: [{ ...status, lines: [{ label: "Front Door", state: "OPEN", severity: "bad" }] }],
  }).success);
  assert(!DashboardPagesArgumentsSchema.safeParse({
    pages: [{ kind: "metric", title: "X", subtitle: "Y", value: -1, lines: [] }],
  }).success);
  assert(!DashboardPagesArgumentsSchema.safeParse({
    pages: [{ ...metric, secondaryLabel: undefined }],
  }).success);
  assert(!DashboardPagesArgumentsSchema.safeParse({
    pages: [{ ...metric, secondaryValue: undefined }],
  }).success);
  assert(DashboardPagesArgumentsSchema.safeParse({
    pages: [{
      kind: "metric",
      title: "T".repeat(24),
      subtitle: "S".repeat(24),
      value: Number.MAX_SAFE_INTEGER,
      secondaryLabel: "L".repeat(24),
      secondaryValue: Number.MAX_SAFE_INTEGER,
    }, {
      kind: "status",
      title: "T".repeat(24),
      subtitle: "S".repeat(24),
      lines: [{
        label: "L".repeat(22),
        state: "S".repeat(12),
        severity: "critical",
      }],
    }],
  }).success);
  assert(!DashboardPagesArgumentsSchema.safeParse({
    pages: [{ ...metric, value: Number.MAX_SAFE_INTEGER + 1 }],
  }).success);
});

Deno.test("usage page schema requires bounded nonnegative breakdown values", () => {
  const usage = {
    kind: "usage" as const,
    title: "ALL AGENT TOKENS TODAY",
    totalTokens: 33_407_722,
    uncachedInputTokens: 1_900,
    outputTokens: 143_000,
    cacheReadTokens: 32_630_000,
    cacheWriteTokens: 637_000,
    requestCount: 161,
    model: "MIXED",
    activity: [0, 1_200, 65_000, 540_000],
  };
  assert(DashboardUsagePageSchema.safeParse(usage).success);
  assert(DashboardPagesArgumentsSchema.safeParse({ pages: [usage] }).success);
  assert(!DashboardUsagePageSchema.safeParse({ ...usage, totalTokens: -1 }).success);
  assert(!DashboardUsagePageSchema.safeParse({ ...usage, model: "x".repeat(17) }).success);
  assert(!DashboardUsagePageSchema.safeParse({ ...usage, activity: Array(25).fill(0) }).success);
  assert(!DashboardUsagePageSchema.safeParse({ ...usage, unknown: true }).success);
});

Deno.test("usage page program formats totals and renders breakdown, activity, and footer", () => {
  const program = buildDashboardPagesProgram({
    pages: [{
      kind: "usage",
      title: "ALL AGENT TOKENS TODAY",
      totalTokens: 33_407_722,
      uncachedInputTokens: 1_900,
      outputTokens: 143_000,
      cacheReadTokens: 32_630_000,
      cacheWriteTokens: 637_000,
      requestCount: 161,
      model: "MIXED",
      activity: [0, 1_200, 65_000, 540_000],
    }],
  });
  assertStringIncludes(program, '\\"totalText\\":\\"33,407,722\\"');
  assertStringIncludes(program, '\\"totalCompact\\":\\"33.41M\\"');
  assertStringIncludes(program, '\\"outputText\\":\\"143K\\"');
  assertStringIncludes(program, '\\"cacheReadText\\":\\"32.63M\\"');
  assertStringIncludes(program, 'values = [page["outputTokens"], page["uncachedInputTokens"]');
  assertStringIncludes(program, 'display.rectangle(x, 106, width, 12)');
  assertStringIncludes(program, 'footer = str(page["requestCount"]) + " REQS  " + page["model"]');
  assertStringIncludes(program, 'activity = page.get("activity", [])');
  assert(!program.includes("display.set_pen(MUTED)"));
});

Deno.test("dashboard pages program safely encodes hostile strings and stages before render", () => {
  const program = buildDashboardPagesProgram({
    pages: [{
      kind: "status",
      title: 'HOME "\\\nimport os',
      subtitle: "STATUS",
      lines: [{
        label: 'Front Door\\\nprint("oops")',
        state: "OPEN",
        severity: "warning",
      }],
    }],
  });
  assertStringIncludes(program, 'snapshot = "{\\"version\\":2');
  assertStringIncludes(program, 'HOME \\\\\\\"\\\\\\\\\\\\nimport os');
  assert(program.indexOf("from explorer import") < program.indexOf("with open"));
  assert(program.indexOf("os.rename") < program.indexOf("display.clear()"));
  assert(program.indexOf("display.update()") < program.indexOf("SWAMP_EXPLORER_DASHBOARD_PAGES_OK"));
});

Deno.test("dashboard pages renderer fits schema boundary content within 320 pixels", () => {
  const program = buildDashboardPagesProgram({
    pages: [{
      kind: "metric",
      title: "T".repeat(24),
      subtitle: "S".repeat(24),
      value: Number.MAX_SAFE_INTEGER,
      secondaryLabel: "L".repeat(24),
      secondaryValue: Number.MAX_SAFE_INTEGER,
    }, {
      kind: "status",
      title: "T".repeat(24),
      subtitle: "S".repeat(24),
      lines: [{
        label: "L".repeat(22),
        state: "S".repeat(12),
        severity: "critical",
      }],
    }],
  });
  assertStringIncludes(program, "9,007,199,254,740,991");
  assertStringIncludes(program, 'fit_text(page["title"], 296, 2)');
  assertStringIncludes(program, 'fit_text(line["label"], 176, 2)');
  assertStringIncludes(program, 'fit_text(line["state"], 108, 2)');
  assertStringIncludes(program, "right_edge - state_width");
});

Deno.test("updateDashboardPages records a separate stable resource after confirmation", async () => {
  const { context, writes } = fakeContext();
  await model.methods.updateDashboardPages.execute(
    {
      pages: [{
        kind: "metric",
        title: "SWAMP SCORE",
        subtitle: "TOTAL",
        value: 10_960_652,
        secondaryLabel: "TODAY / 24H",
        secondaryValue: 42_123,
      }],
      _runner: successfulRunner("SWAMP_EXPLORER_DASHBOARD_PAGES_OK\n"),
    },
    // deno-lint-ignore no-explicit-any
    context as any,
  );
  assertEquals(writes[0].specName, "dashboardPages");
  assertEquals(writes[0].name, "dashboard-pages-current");
  assertEquals(writes[0].data.version, 2);
  assert(model.resources.dashboardPages.schema.safeParse(writes[0].data).success);
});

Deno.test("updateDashboardPages does not write Swamp state without its distinct marker", async () => {
  const { context, writes } = fakeContext();
  await assertRejects(
    () => model.methods.updateDashboardPages.execute(
      {
        pages: [{ kind: "metric", title: "SCORE", subtitle: "TOTAL", value: 1 }],
        _runner: successfulRunner("SWAMP_EXPLORER_DASHBOARD_OK\n"),
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    ),
    Error,
    "did not confirm",
  );
  assertEquals(writes.length, 0);
});

Deno.test("bundled dashboard reloads rotating pages, retains v1, and honors factory import-launch contract", async () => {
  const app = await Deno.readTextFile(new URL("./apps/swamp_dashboard.py.txt", import.meta.url));
  assertStringIncludes(app, 'data.get("version") not in (1, 2)');
  assertStringIncludes(app, 'value_text = str(data.get("valueText", data.get("value", 0)))');
  assertStringIncludes(app, "def draw(data):");
  assertStringIncludes(app, "PAGE_SECONDS = 8");
  assertStringIncludes(app, "while True:\n            latest = load_snapshot()");
  assertStringIncludes(app, 'if latest.get("version") == 2:\n                pages = latest["pages"]');
  assertStringIncludes(app, "index %= len(pages)");
  assertStringIncludes(app, "time.sleep(PAGE_SECONDS)");
  assertStringIncludes(app, "# Factory main.py launches the selected filename with __import__");
  assert(app.trimEnd().endsWith("main()"));
  assert(!app.includes('if __name__ == "__main__":'));
  assertStringIncludes(app, "display.measure_text(text, scale=scale)");
  assertStringIncludes(app, "RIGHT_EDGE - state_width");
  assertStringIncludes(app, 'pens = {"ok": GREEN, "warning": AMBER, "critical": RED, "unknown": GRAY}');
  assertStringIncludes(app, "def draw_usage(page):");
  assertStringIncludes(app, 'display.rectangle(x, 106, width, 12)');
  assertStringIncludes(app, 'footer = str(page.get("requestCount", 0))');
});

Deno.test("probe program imports the Explorer display", () => {
  assertStringIncludes(buildProbeProgram(), "from explorer import display");
});

Deno.test("install target accepts menu apps and protects lifecycle files", () => {
  validateTarget("swamp_score.py");
  for (const target of ["main.py", "boot.py", "explorer.py", "Bad.py", "has-dash.py", "../x.py"]) {
    let threw = false;
    try {
      validateTarget(target);
    } catch {
      threw = true;
    }
    assert(threw, `expected ${target} to be rejected`);
  }
});
