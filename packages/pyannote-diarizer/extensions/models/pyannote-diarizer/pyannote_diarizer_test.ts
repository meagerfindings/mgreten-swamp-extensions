/** Tests for the pyannote-diarizer model.
 *
 * Python and pyannote are never executed. The model takes the interpreter
 * from the `pythonBin` global argument, so each test points it at a small
 * synthetic `/bin/sh` stub that records argv, env, and the files the model
 * staged, then emulates the helper's success or failure output. The embedded
 * Python speaker-assignment logic itself is not exercised here.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  // deno-lint-ignore no-import-prefix
} from "jsr:@std/assert@1";
import { model } from "./pyannote_diarizer.ts";

interface Written {
  spec: string;
  name: string;
  data: Record<string, unknown>;
}

function fakeContext(globalArgs: Record<string, unknown>) {
  const written: Written[] = [];
  const logs: string[] = [];
  const context = {
    globalArgs,
    logger: {
      info: (msg: string) => logs.push(`info:${msg}`),
      warn: (msg: string) => logs.push(`warn:${msg}`),
    },
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      written.push({ spec, name, data });
      return Promise.resolve({ handle: `${spec}/${name}` });
    },
  };
  return { context, written, logs };
}

/** Executable sh stub standing in for `python3 diarize.py t a out`. */
async function makeStub(
  dir: string,
  opts: {
    diarized?: string;
    stdout?: string;
    exitCode?: number;
    stderr?: string;
  },
) {
  const log = {
    argv: `${dir}/argv.log`,
    env: `${dir}/env.log`,
    script: `${dir}/script.copy`,
    transcript: `${dir}/transcript.copy`,
  };
  const diarizedSrc = `${dir}/diarized.canned`;
  const stdoutSrc = `${dir}/stdout.canned`;
  await Deno.writeTextFile(diarizedSrc, opts.diarized ?? "");
  await Deno.writeTextFile(stdoutSrc, opts.stdout ?? "");
  const bin = `${dir}/fake_python`;
  const script = `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >> '${log.argv}'; done
printf 'HF_TOKEN=%s\\nPYANNOTE_DEVICE=%s\\n' "\${HF_TOKEN-<unset>}" "$PYANNOTE_DEVICE" > '${log.env}'
cp "$1" '${log.script}'
cp "$2" '${log.transcript}'
${
    opts.exitCode
      ? `printf '%s' '${opts.stderr ?? ""}' >&2\nexit ${opts.exitCode}`
      : `cp '${diarizedSrc}' "$4"\ncat '${stdoutSrc}'`
  }
`;
  await Deno.writeTextFile(bin, script);
  await Deno.chmod(bin, 0o755);
  return { bin, log };
}

const INPUT = JSON.stringify({
  segments: [
    { start: 0, end: 2, text: " Let's ship the widget on Tuesday." },
    { start: 2, end: 3, text: " Sounds good." },
  ],
});
const DIARIZED = JSON.stringify({
  segments: [
    {
      start: 0,
      end: 2,
      text: " Let's ship the widget on Tuesday.",
      speaker: "SPEAKER_00",
    },
    { start: 2, end: 3, text: " Sounds good.", speaker: "SPEAKER_01" },
  ],
});

/** Run with HF_TOKEN removed from the parent env so the stub sees only what the model passes. */
async function withoutParentToken<T>(fn: () => Promise<T>): Promise<T> {
  const prev = Deno.env.get("HF_TOKEN");
  Deno.env.delete("HF_TOKEN");
  try {
    return await fn();
  } finally {
    if (prev !== undefined) Deno.env.set("HF_TOKEN", prev);
  }
}

Deno.test("global arguments default to python3/auto and keep hfToken optional", () => {
  assertEquals(model.globalArguments.parse({}), {
    pythonBin: "python3",
    device: "auto",
  });
  assertEquals(
    model.globalArguments.parse({ hfToken: "hf_synthetic" }).hfToken,
    "hf_synthetic",
  );
  assert(!model.globalArguments.safeParse({ hfToken: 42 }).success);
  assert(
    !model.methods.diarize.arguments.safeParse({ transcriptJson: "{}" })
      .success,
  );
});

Deno.test("diarize stages files, passes token via env not argv, and writes diarized resource", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pyannote-test-" });
  try {
    const { bin, log } = await makeStub(dir, {
      diarized: DIARIZED,
      stdout:
        '{"speakerCount": 2, "turnCount": 5, "speakers": ["SPEAKER_00", "SPEAKER_01"]}\n',
    });
    const { context, written, logs } = fakeContext({
      hfToken: "hf_synthetic_secret",
      pythonBin: bin,
      device: "cpu",
    });
    const audioPath = "/synthetic/audio/sync.call.m4a";

    const result = await withoutParentToken(() =>
      model.methods.diarize.execute(
        { transcriptJson: INPUT, audioPath },
        context,
      )
    );

    const argv = (await Deno.readTextFile(log.argv)).trimEnd().split("\n");
    assertEquals(argv.length, 4);
    const tmpDir = argv[0].slice(0, argv[0].lastIndexOf("/"));
    assert(tmpDir.includes("swamp-diarize-"));
    assertEquals(argv, [
      `${tmpDir}/diarize.py`,
      `${tmpDir}/transcript.json`,
      audioPath,
      `${tmpDir}/diarized.json`,
    ]);
    assert(!argv.some((a) => a.includes("hf_synthetic_secret")));
    assertEquals(
      await Deno.readTextFile(log.env),
      "HF_TOKEN=hf_synthetic_secret\nPYANNOTE_DEVICE=cpu\n",
    );
    assertEquals(await Deno.readTextFile(log.transcript), INPUT);
    const helper = await Deno.readTextFile(log.script);
    assertStringIncludes(helper, "pyannote/speaker-diarization-3.1");
    assertStringIncludes(helper, 'os.environ.get("HF_TOKEN"');
    await assertRejects(() => Deno.stat(tmpDir), Deno.errors.NotFound);

    assertEquals(written, [{
      spec: "diarizedTranscript",
      name: "sync.call",
      data: {
        transcriptJson: DIARIZED,
        diarized: true,
        speakerCount: 2,
        speakers: ["SPEAKER_00", "SPEAKER_01"],
      },
    }]);
    assertEquals(result, {
      dataHandles: [{ handle: "diarizedTranscript/sync.call" }],
    });
    assertEquals(logs, ["info:Diarized: 2 speakers, 5 turns"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("diarize omits HF_TOKEN when no hfToken is configured", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pyannote-test-" });
  try {
    const { bin, log } = await makeStub(dir, {
      diarized: DIARIZED,
      stdout: '{"speakerCount": 0, "turnCount": 0, "speakers": []}',
    });
    const { context, written } = fakeContext({
      pythonBin: bin,
      device: "auto",
    });

    await withoutParentToken(() =>
      model.methods.diarize.execute(
        {
          transcriptJson: INPUT,
          audioPath: "/synthetic/a.wav",
          instanceName: "chosen",
        },
        context,
      )
    );

    assertEquals(
      await Deno.readTextFile(log.env),
      "HF_TOKEN=<unset>\nPYANNOTE_DEVICE=auto\n",
    );
    assertEquals(written[0].name, "chosen");
    assertEquals(written[0].data.speakerCount, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("diarize falls back to the original transcript when the helper fails", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pyannote-test-" });
  try {
    const longErr = "x".repeat(600) + "error: no HF token";
    const { bin } = await makeStub(dir, { exitCode: 2, stderr: longErr });
    const { context, written, logs } = fakeContext({
      pythonBin: bin,
      device: "auto",
    });

    const result = await withoutParentToken(() =>
      model.methods.diarize.execute(
        { transcriptJson: INPUT, audioPath: "/synthetic/team.m4a" },
        context,
      )
    );

    assertEquals(written, [{
      spec: "diarizedTranscript",
      name: "team",
      data: {
        transcriptJson: INPUT,
        diarized: false,
        speakerCount: 0,
        speakers: [],
      },
    }]);
    assertEquals(result, {
      dataHandles: [{ handle: "diarizedTranscript/team" }],
    });
    // Only the last 500 chars of stderr are logged.
    assertEquals(logs, [
      `warn:Diarization failed (continuing without speakers): ${
        longErr.slice(-500)
      }`,
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
