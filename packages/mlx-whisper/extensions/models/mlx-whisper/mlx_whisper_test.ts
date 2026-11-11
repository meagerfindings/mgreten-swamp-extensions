/** Tests for the mlx-whisper model.
 *
 * The real `mlx_whisper` CLI is never executed. The model takes the binary
 * path from the `mlxWhisperBin` global argument, so each test points it at a
 * small synthetic `/bin/sh` stub written to a temp directory. The stub logs
 * its argv and writes a canned, obviously synthetic Whisper JSON file.
 */

// deno-lint-ignore no-import-prefix
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model } from "./mlx_whisper.ts";

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

/** Write an executable sh stub that records argv and emulates mlx_whisper. */
async function makeStub(
  dir: string,
  opts: { transcript?: string; exitCode?: number; stderr?: string },
): Promise<{ bin: string; argvLog: string }> {
  const argvLog = `${dir}/argv.log`;
  const transcriptSrc = `${dir}/canned.json`;
  if (opts.transcript !== undefined) {
    await Deno.writeTextFile(transcriptSrc, opts.transcript);
  }
  const bin = `${dir}/fake_mlx_whisper`;
  const script = `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >> '${argvLog}'; done
${
    opts.exitCode
      ? `printf '%s' '${opts.stderr ?? ""}' >&2\nexit ${opts.exitCode}`
      : `base=$(basename "$1")\nstem="\${base%.*}"\ncp '${transcriptSrc}' "$7/$stem.json"`
  }
`;
  await Deno.writeTextFile(bin, script);
  await Deno.chmod(bin, 0o755);
  return { bin, argvLog };
}

const SYNTHETIC_TRANSCRIPT = JSON.stringify({
  language: "en",
  text: "Speaker A: Let's ship the widget on Tuesday.",
  segments: [
    { id: 0, start: 0.0, end: 2.5, text: " Let's ship the widget" },
    { id: 1, start: 2.5, end: 4.0, text: " on Tuesday." },
  ],
});

Deno.test("global arguments apply documented defaults and bound the threshold", () => {
  assertEquals(model.globalArguments.parse({}), {
    whisperModel: "mlx-community/whisper-large-v3-turbo",
    noSpeechThreshold: 0.6,
    mlxWhisperBin: "mlx_whisper",
  });
  assertEquals(
    model.globalArguments.parse({ noSpeechThreshold: 0 }).noSpeechThreshold,
    0,
  );
  assertEquals(
    model.globalArguments.parse({ noSpeechThreshold: 1 }).noSpeechThreshold,
    1,
  );
  assert(!model.globalArguments.safeParse({ noSpeechThreshold: 1.01 }).success);
  assert(!model.globalArguments.safeParse({ noSpeechThreshold: -0.1 }).success);
  assert(!model.methods.transcribe.arguments.safeParse({}).success);
});

Deno.test("transcribe passes exact CLI args and writes the transcript resource", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mlx-whisper-test-" });
  try {
    const { bin, argvLog } = await makeStub(dir, {
      transcript: SYNTHETIC_TRANSCRIPT,
    });
    const { context, written, logs } = fakeContext({
      whisperModel: "synthetic/model-x",
      noSpeechThreshold: 0.35,
      mlxWhisperBin: bin,
    });
    const audioPath = "/synthetic/audio/standup.2026-01-02.m4a";

    const result = await model.methods.transcribe.execute(
      { audioPath },
      context,
    );

    const argv = (await Deno.readTextFile(argvLog)).trimEnd().split("\n");
    const tmpDir = argv[6];
    assertEquals(argv, [
      audioPath,
      "--model",
      "synthetic/model-x",
      "--output-format",
      "json",
      "--output-dir",
      tmpDir,
      "--no-speech-threshold",
      "0.35",
    ]);
    assert(tmpDir.includes("swamp-whisper-"));
    // The temp output directory is cleaned up after the run.
    await assertRejects(() => Deno.stat(tmpDir), Deno.errors.NotFound);

    assertEquals(written, [{
      spec: "transcript",
      // Only the final extension is stripped from the stem.
      name: "standup.2026-01-02",
      data: {
        transcriptJson: SYNTHETIC_TRANSCRIPT,
        audioPath,
        stem: "standup.2026-01-02",
        segmentCount: 2,
        language: "en",
      },
    }]);
    assertEquals(result, {
      dataHandles: [{ handle: "transcript/standup.2026-01-02" }],
    });
    assertEquals(logs, [
      'info:Transcribing "standup.2026-01-02" with synthetic/model-x',
      "info:Transcribed 2 segments (lang=en)",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("transcribe honors instanceName and tolerates missing segments/language", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mlx-whisper-test-" });
  try {
    const transcript = JSON.stringify({ text: "" });
    const { bin } = await makeStub(dir, { transcript });
    const { context, written, logs } = fakeContext({
      whisperModel: "synthetic/model-x",
      noSpeechThreshold: 0.6,
      mlxWhisperBin: bin,
    });

    await model.methods.transcribe.execute(
      { audioPath: "/synthetic/silence.wav", instanceName: "custom-name" },
      context,
    );

    assertEquals(written.length, 1);
    assertEquals(written[0].name, "custom-name");
    assertEquals(written[0].data, {
      transcriptJson: transcript,
      audioPath: "/synthetic/silence.wav",
      stem: "silence",
      segmentCount: 0,
      language: undefined,
    });
    assertEquals(logs[1], "info:Transcribed 0 segments (lang=unknown)");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("transcribe surfaces non-zero exit with stderr and writes nothing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mlx-whisper-test-" });
  try {
    const { bin, argvLog } = await makeStub(dir, {
      exitCode: 3,
      stderr: "synthetic decode failure",
    });
    const { context, written } = fakeContext({
      whisperModel: "synthetic/model-x",
      noSpeechThreshold: 0.6,
      mlxWhisperBin: bin,
    });

    await assertRejects(
      () =>
        model.methods.transcribe.execute(
          { audioPath: "/synthetic/broken.mp3" },
          context,
        ),
      Error,
      "mlx_whisper exited 3: synthetic decode failure",
    );
    assertEquals(written, []);
    const tmpDir = (await Deno.readTextFile(argvLog)).split("\n")[6];
    await assertRejects(() => Deno.stat(tmpDir), Deno.errors.NotFound);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("transcribe rejects malformed transcript JSON from the CLI", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mlx-whisper-test-" });
  try {
    const { bin } = await makeStub(dir, { transcript: "{not json" });
    const { context, written } = fakeContext({
      whisperModel: "synthetic/model-x",
      noSpeechThreshold: 0.6,
      mlxWhisperBin: bin,
    });
    await assertRejects(
      () =>
        model.methods.transcribe.execute(
          { audioPath: "/synthetic/garbled.m4a" },
          context,
        ),
      SyntaxError,
    );
    assertEquals(written, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("transcribe accepts Python's NaN and Infinity tokens and stores valid JSON", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mlx-whisper-test-" });
  try {
    // Python's json.dump writes non-finite floats as bare NaN / Infinity tokens,
    // which mlx_whisper emits for some segments (e.g. avg_logprob).
    const transcript = '{"language": "en", "segments": [' +
      '{"id": 0, "start": 0.0, "end": 2.0, "text": " NaN and Infinity stay text", ' +
      '"avg_logprob": NaN, "compression_ratio": Infinity, "no_speech_prob": -Infinity}]}';
    const { bin } = await makeStub(dir, { transcript });
    const { context, written } = fakeContext({
      whisperModel: "synthetic/model-x",
      noSpeechThreshold: 0.6,
      mlxWhisperBin: bin,
    });

    await model.methods.transcribe.execute(
      { audioPath: "/synthetic/nan.wav" },
      context,
    );

    assertEquals(written.length, 1);
    assertEquals(written[0].data.segmentCount, 1);
    const stored = JSON.parse(written[0].data.transcriptJson as string);
    assertEquals(stored.segments[0], {
      id: 0,
      start: 0.0,
      end: 2.0,
      text: " NaN and Infinity stay text",
      avg_logprob: null,
      compression_ratio: null,
      no_speech_prob: null,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
