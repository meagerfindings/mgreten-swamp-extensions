/**
 * Tests for hermes-config. The model shells out through Deno.Command (ssh,
 * `sudo python3`, the hermes binary) with no injection seam, so each test
 * swaps Deno.Command for a fake that records argv and the Python script piped
 * on stdin, and restores it in a finally block. No ssh, sudo or docker command
 * is ever run.
 *
 * The config read/write/merge logic lives in the generated Python scripts. To
 * test that behaviour for real, the "file" tests hand the captured script to a
 * local `python3 -I -` (never sudo) that only touches a temp-dir config.
 */

// deno-lint-ignore no-import-prefix
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./hermes_config.ts";

type Call = { argv: string[]; script?: string };
type Reply = { code: number; stdout?: string; stderr?: string };
type Responder = (call: Call) => Reply | Promise<Reply>;
type Write = { spec: string; name: string; data: Record<string, unknown> };
type Log = { level: string; msg: string; props?: Record<string, unknown> };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const RealCommand = Deno.Command;
const HOST = "user@hermes.example.com";
const DOCKER_HOST = "ops@docker.example.com";
const SSH_PREFIX = ["ssh", "-o", "ConnectTimeout=10", "-o", "BatchMode=yes"];

function reply(r: Reply) {
  return {
    success: r.code === 0,
    code: r.code,
    signal: null,
    stdout: encoder.encode(r.stdout ?? ""),
    stderr: encoder.encode(r.stderr ?? ""),
  };
}

async function withFakeCommands<T>(
  respond: Responder,
  fn: (calls: Call[]) => Promise<T>,
): Promise<T> {
  const calls: Call[] = [];
  class FakeCommand {
    #call: Call;
    constructor(cmd: string, opts?: { args?: string[] }) {
      this.#call = { argv: [cmd, ...(opts?.args ?? [])] };
      calls.push(this.#call);
    }
    async output() {
      return reply(await respond(this.#call));
    }
    spawn() {
      const call = this.#call;
      const chunks: Uint8Array[] = [];
      const stdin = new WritableStream<Uint8Array>({
        write(chunk) {
          chunks.push(chunk);
        },
      });
      return {
        stdin,
        output: async () => {
          const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
          let off = 0;
          for (const c of chunks) {
            all.set(c, off);
            off += c.length;
          }
          call.script = decoder.decode(all);
          return reply(await respond(call));
        },
      };
    }
  }
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = FakeCommand;
  try {
    return await fn(calls);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = RealCommand;
  }
}

/** Run a captured model script with the real local python3 (no sudo). */
async function runPython(script: string): Promise<Reply> {
  const proc = new RealCommand("python3", {
    args: ["-I", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const w = proc.stdin.getWriter();
  await w.write(encoder.encode(script));
  await w.close();
  const out = await proc.output();
  return {
    code: out.code,
    stdout: decoder.decode(out.stdout),
    stderr: decoder.decode(out.stderr),
  };
}

const pythonPresent = (() => {
  try {
    return new RealCommand("python3", { args: ["--version"] }).outputSync()
      .success;
  } catch {
    return false;
  }
})();

function makeContext(globalArgs: Record<string, unknown>) {
  const writes: Write[] = [];
  const logs: Log[] = [];
  const log =
    (level: string) => (msg: string, props?: Record<string, unknown>) =>
      logs.push({ level, msg, props });
  const context = {
    globalArgs: model.globalArguments.parse(globalArgs),
    logger: { info: log("info"), warning: log("warning") },
    writeResource: (spec: string, name: string, data: unknown) => {
      writes.push({ spec, name, data: data as Record<string, unknown> });
      return Promise.resolve({ name });
    },
  };
  return { context, writes, logs };
}

const CONFIG = `model:
  default: old-model:7b
  provider: lmstudio
  base_url: http://hermes.example.com:1234/v1
  extra_body:
    options:
      num_ctx: 8192
      think: true
auxiliary:
  vision:
    provider: auto
    model: ''
  title_generation:
    provider: lmstudio
    model: 'tiny-model:1b'
  mcp:
    provider: openrouter
    model: ''
  compression:
    provider: lmstudio
    model: 'squash:2b'
memory:
  provider: builtin
  default: keep-me
`;

async function withTempConfig<T>(
  fn: (dir: string, path: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "hermes_config_test_" });
  const path = `${dir}/config.yaml`;
  await Deno.writeTextFile(path, CONFIG);
  try {
    return await fn(dir, path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function scriptKind(script = ""): string {
  if (script.includes("shutil.copy2")) return "backup";
  if (script.includes("config.yaml looks truncated")) return "validate";
  if (script.includes("aux_overrides = {}")) return "read";
  if (script.includes("num_ctx = ")) return "setMain";
  if (script.includes("tasks = json.loads(")) return "setAux";
  return "unknown";
}

Deno.test("globalArguments apply documented defaults and reject bad types", () => {
  assertEquals(model.globalArguments.parse({}), {
    localMode: false,
    hermesHost: "",
    configPath: "/opt/data/config.yaml",
    hermesBin: "/opt/hermes/.venv/bin/hermes",
    dockerHost: "",
    hermesComposePath: "/docker/services/hermes",
  });
  assertEquals(
    model.globalArguments.safeParse({ localMode: "yes" }).success,
    false,
  );
  assertEquals(
    model.globalArguments.safeParse({ hermesHost: 42 }).success,
    false,
  );
});

Deno.test("method argument schemas validate the documented contract", () => {
  const main = model.methods.setMainModel.arguments;
  assertEquals(main.parse({ modelName: "fake-model:3b" }), {
    modelName: "fake-model:3b",
    provider: "lmstudio",
  });
  assertEquals(main.safeParse({}).success, false);
  assertEquals(main.safeParse({ modelName: "m", numCtx: 0 }).success, false);
  assertEquals(main.safeParse({ modelName: "m", numCtx: 1.5 }).success, false);
  assertEquals(
    main.safeParse({ modelName: "m", think: "true" }).success,
    false,
  );

  const aux = model.methods.setAuxiliaryModels.arguments;
  const okTasks = {
    tasks: { mcp: null, vision: { provider: "lmstudio", model: "eye:1b" } },
  };
  assertEquals(aux.parse(okTasks), okTasks);
  assertEquals(
    aux.safeParse({ tasks: { vision: { provider: "lmstudio" } } }).success,
    false,
  );
  assertEquals(aux.safeParse({ tasks: { vision: "auto" } }).success, false);

  const state = model.resources.configState.schema;
  assertEquals(
    state.safeParse({
      mainModel: { name: "a", provider: "b" },
      auxiliaryOverrides: { mcp: { provider: "p", model: "m" } },
      timestamp: "2026-01-01T00:00:00.000Z",
    }).success,
    true,
  );
  assertEquals(
    state.safeParse({
      mainModel: { name: "a" },
      auxiliaryOverrides: {},
      timestamp: "t",
    }).success,
    false,
  );
});

Deno.test("getConfig over SSH sends the read script and stores the parsed snapshot", async () => {
  const parsed = {
    main: { name: "remote-model:9b", provider: "lmstudio", numCtx: 4096 },
    auxiliaryOverrides: { mcp: { provider: "lmstudio", model: "tool:2b" } },
  };
  await withFakeCommands(
    () => ({ code: 0, stdout: JSON.stringify(parsed) + "\n" }),
    async (calls) => {
      const { context, writes, logs } = makeContext({
        hermesHost: HOST,
        configPath: "/srv/hermes/config.yaml",
      });
      const result = await model.methods.getConfig.execute({}, context);

      assertEquals(calls.length, 1);
      assertEquals(calls[0].argv, [...SSH_PREFIX, HOST, "sudo python3"]);
      assertEquals(scriptKind(calls[0].script), "read");
      assert(
        calls[0].script!.includes('with open("/srv/hermes/config.yaml") as f:'),
      );

      assertEquals(writes.length, 1);
      assertEquals(writes[0].spec, "configState");
      assertEquals(writes[0].name, "current");
      assertEquals(writes[0].data.mainModel, parsed.main);
      assertEquals(
        writes[0].data.auxiliaryOverrides,
        parsed.auxiliaryOverrides,
      );
      assertEquals(result, { dataHandles: [{ name: "current" }] });
      assertEquals(logs.map((l) => [l.level, l.msg, l.props]), [
        ["info", "Reading Hermes config from {path}", {
          path: "/srv/hermes/config.yaml",
        }],
        [
          "info",
          "Main model: {model} (provider: {provider}, numCtx: {numCtx})",
          {
            model: "remote-model:9b",
            provider: "lmstudio",
            numCtx: 4096,
          },
        ],
        ["info", "{count} auxiliary override(s): {tasks}", {
          count: 1,
          tasks: "mcp",
        }],
      ]);
    },
  );
});

Deno.test("SSH failure surfaces exit code and stderr and writes nothing", async () => {
  await withFakeCommands(
    () => ({ code: 255, stderr: "Permission denied (publickey).\n" }),
    async (calls) => {
      const { context, writes } = makeContext({ hermesHost: HOST });
      await assertRejects(
        () =>
          model.methods.setMainModel.execute(
            { modelName: "x", provider: "lmstudio" },
            context,
          ),
        Error,
        `SSH python3 on ${HOST} failed (exit 255): Permission denied (publickey).`,
      );
      // Stops at the backup step: no edit is attempted after a failed backup.
      assertEquals(calls.length, 1);
      assertEquals(scriptKind(calls[0].script), "backup");
      assertEquals(writes, []);
    },
  );
});

Deno.test("setMainModel runs backup, edit, validate in order and reports details", async () => {
  await withFakeCommands(
    () => ({ code: 0, stdout: "OK\n" }),
    async (calls) => {
      const { context, writes } = makeContext({ hermesHost: HOST });
      await model.methods.setMainModel.execute(
        {
          modelName: "new-model:35b",
          provider: "openrouter",
          numCtx: 32768,
          think: false,
        },
        context,
      );
      assertEquals(calls.map((c) => scriptKind(c.script)), [
        "backup",
        "setMain",
        "validate",
      ]);
      for (const c of calls) {
        assertEquals(c.argv, [...SSH_PREFIX, HOST, "sudo python3"]);
      }
      const edit = calls[1].script!;
      assert(edit.includes('model_name = "new-model:35b"'));
      assert(edit.includes('provider = "openrouter"'));
      assert(edit.includes("num_ctx = 32768"));
      assert(edit.includes("think = False"));
      assertEquals(writes.length, 1);
      assertEquals(writes[0].spec, "opResult");
      assertEquals(writes[0].name, "set-main-model");
      assertEquals(writes[0].data.success, true);
      assertEquals(
        writes[0].data.message,
        "Main model updated (model=new-model:35b, provider=openrouter, num_ctx=32768, think=false). Run restartGateway to apply.",
      );
    },
  );
});

Deno.test("setMainModel fails when post-edit validation does not print OK", async () => {
  await withFakeCommands(
    (call) => ({
      code: 0,
      stdout: scriptKind(call.script) === "validate" ? "nope\n" : "OK\n",
    }),
    async (calls) => {
      const { context, writes } = makeContext({ localMode: true });
      await assertRejects(
        () =>
          model.methods.setMainModel.execute(
            { modelName: "m", provider: "lmstudio" },
            context,
          ),
        Error,
        "Config validation failed: nope",
      );
      assertEquals(calls.map((c) => c.argv), [
        ["sudo", "python3"],
        ["sudo", "python3"],
        ["sudo", "python3"],
      ]);
      assertEquals(writes, []);
    },
  );
});

Deno.test({
  name: "getConfig in localMode parses a real config file",
  ignore: !pythonPresent,
  fn: () =>
    withTempConfig((_dir, path) =>
      withFakeCommands(
        (call) => runPython(call.script!),
        async (calls) => {
          const { context, writes } = makeContext({
            localMode: true,
            configPath: path,
          });
          await model.methods.getConfig.execute({}, context);
          assertEquals(calls[0].argv, ["sudo", "python3"]);
          assertEquals(writes[0].data.mainModel, {
            name: "old-model:7b",
            provider: "lmstudio",
            numCtx: 8192,
            think: true,
          });
          // vision (auto) and mcp (empty model) are not overrides.
          assertEquals(writes[0].data.auxiliaryOverrides, {
            title_generation: { provider: "lmstudio", model: "tiny-model:1b" },
            compression: { provider: "lmstudio", model: "squash:2b" },
          });
        },
      )
    ),
});

Deno.test({
  name:
    "setMainModel rewrites only the model section and backs up the original",
  ignore: !pythonPresent,
  fn: () =>
    withTempConfig((dir, path) =>
      withFakeCommands(
        (call) => runPython(call.script!),
        async () => {
          const { context } = makeContext({
            localMode: true,
            configPath: path,
          });
          await model.methods.setMainModel.execute(
            {
              modelName: "new-model:35b",
              provider: "openrouter",
              think: false,
            },
            context,
          );
          assertEquals(
            await Deno.readTextFile(path),
            CONFIG
              .replace("  default: old-model:7b", "  default: new-model:35b")
              .replace(
                "  provider: lmstudio\n  base_url",
                "  provider: openrouter\n  base_url",
              )
              .replace("      think: true", "      think: false"),
          );
          const backups = [];
          for await (const e of Deno.readDir(dir)) {
            if (e.name.startsWith("config.yaml.bak.")) backups.push(e.name);
          }
          assertEquals(backups.length, 1);
          assertEquals(await Deno.readTextFile(`${dir}/${backups[0]}`), CONFIG);
        },
      )
    ),
});

Deno.test({
  name: "setAuxiliaryModels merges sets and resets and warns on unknown tasks",
  ignore: !pythonPresent,
  fn: () =>
    withTempConfig((_dir, path) =>
      withFakeCommands(
        (call) => runPython(call.script!),
        async () => {
          const { context, writes, logs } = makeContext({
            localMode: true,
            configPath: path,
          });
          await model.methods.setAuxiliaryModels.execute(
            {
              tasks: {
                vision: { provider: "lmstudio", model: "eye:4b" },
                title_generation: null,
                made_up_task: null,
              },
            },
            context,
          );
          assertEquals(
            await Deno.readTextFile(path),
            CONFIG
              .replace(
                "  vision:\n    provider: auto\n    model: ''",
                "  vision:\n    provider: lmstudio\n    model: 'eye:4b'",
              )
              .replace(
                "  title_generation:\n    provider: lmstudio\n    model: 'tiny-model:1b'",
                "  title_generation:\n    provider: auto\n    model: ''",
              ),
          );
          assertEquals(writes.length, 1);
          assertEquals(writes[0].name, "set-aux-models");
          assertEquals(
            writes[0].data.message,
            "set 1 override(s), reset 2 to auto. Run restartGateway to apply.",
          );
          assertEquals(writes[0].data.warnings, [
            "Unknown auxiliary task 'made_up_task' — will attempt update anyway",
            "WARNING: tasks not found in config: made_up_task",
          ]);
          assertEquals(
            logs.filter((l) => l.level === "warning").map((l) => l.props),
            [{ task: "made_up_task" }],
          );
        },
      )
    ),
});

Deno.test("restartGateway over SSH targets dockerHost, falling back to hermesHost", async () => {
  await withFakeCommands(
    () => ({ code: 0, stdout: " Container hermes  Restarting\n" }),
    async (calls) => {
      const a = makeContext({
        hermesHost: HOST,
        dockerHost: DOCKER_HOST,
        hermesComposePath: "/srv/compose/hermes",
      });
      await model.methods.restartGateway.execute({}, a.context);
      const b = makeContext({ hermesHost: HOST });
      await model.methods.restartGateway.execute({}, b.context);

      assertEquals(calls.map((c) => c.argv), [
        [
          ...SSH_PREFIX,
          DOCKER_HOST,
          "cd /srv/compose/hermes && docker compose restart hermes 2>&1",
        ],
        [
          ...SSH_PREFIX,
          HOST,
          "cd /docker/services/hermes && docker compose restart hermes 2>&1",
        ],
      ]);
      assertEquals(a.writes.map((w) => [w.spec, w.name, w.data.message]), [[
        "opResult",
        "restart-gateway",
        "Hermes container restarted. Allow ~15s for the gateway to come back up.",
      ]]);
      assertEquals(
        a.logs.at(-1)?.props,
        { out: "Container hermes  Restarting" },
      );
    },
  );
});

Deno.test("restartGateway SSH failure throws without writing a result", async () => {
  await withFakeCommands(
    () => ({ code: 1, stderr: "no such service: hermes\n" }),
    async () => {
      const { context, writes } = makeContext({ hermesHost: HOST });
      await assertRejects(
        () => model.methods.restartGateway.execute({}, context),
        Error,
        `SSH to ${HOST} failed (exit 1): no such service: hermes`,
      );
      assertEquals(writes, []);
    },
  );
});

Deno.test("restartGateway in localMode writes the result before spawning the hermes binary", async () => {
  const order: string[] = [];
  await withFakeCommands(
    () => ({ code: 0 }),
    async (calls) => {
      const { context, writes } = makeContext({
        localMode: true,
        hermesBin: "/opt/fake/bin/hermes",
      });
      const origWrite = context.writeResource;
      context.writeResource = (s, n, d) => {
        order.push(`write:${calls.length}`);
        return origWrite(s, n, d);
      };
      await model.methods.restartGateway.execute({}, context);
      assertEquals(calls.map((c) => c.argv), [
        ["/opt/fake/bin/hermes", "gateway", "restart"],
      ]);
      assertEquals(order, ["write:0"]);
      assertEquals(writes.length, 1);
      assertEquals(
        writes[0].data.message,
        "Gateway restart triggered — connection will drop momentarily.",
      );
    },
  );
});
