import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@systeminit/swamp-testing";
import {
  buildSayArgs,
  type CommandResult,
  type CommandRunner,
  model,
  resolveSetting,
} from "./macos_say_tts.ts";

// ─────────────────────────────────────────────────────────────────────
// schemas — defaults, constraints, and resource shape
// ─────────────────────────────────────────────────────────────────────

Deno.test("global arguments: accepts an empty configuration", () => {
  assertEquals(model.globalArguments.parse({}), {});
});

Deno.test("global arguments: accepts a voice and positive integer rate", () => {
  assertEquals(model.globalArguments.parse({ voice: "Samantha", rate: 220 }), {
    voice: "Samantha",
    rate: 220,
  });
});

Deno.test("global arguments: rejects zero, negative, and fractional rates", () => {
  for (const rate of [0, -1, 175.5]) {
    assertThrows(() => model.globalArguments.parse({ rate }));
  }
});

Deno.test("speak arguments: defaults play to true", () => {
  assertEquals(model.methods.speak.arguments.parse({ text: "hello" }), {
    text: "hello",
    play: true,
  });
});

Deno.test("speak arguments: rejects empty text and invalid rates", () => {
  assertThrows(() => model.methods.speak.arguments.parse({ text: "" }));
  assertThrows(() =>
    model.methods.speak.arguments.parse({ text: "hello", rate: 0 })
  );
  assertThrows(() =>
    model.methods.speak.arguments.parse({ text: "hello", rate: 1.5 })
  );
});

Deno.test("utterance schema: accepts a complete record and rejects malformed UUIDs", () => {
  const utterance = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    text: "hello",
    voice: null,
    rate: null,
    audioPath: "/tmp/audio.aiff",
    played: false,
    durationMs: 12,
    spokenAt: "2026-07-16T00:00:00.000Z",
  };
  assertEquals(model.resources.utterance.schema.parse(utterance), utterance);
  assertThrows(() =>
    model.resources.utterance.schema.parse({ ...utterance, id: "not-a-uuid" })
  );
});

// ─────────────────────────────────────────────────────────────────────
// resolveSetting — per-call override > instance default > null
// ─────────────────────────────────────────────────────────────────────

Deno.test("resolveSetting: per-call arg wins over global", () => {
  assertEquals(resolveSetting("Daniel", "Samantha"), "Daniel");
});

Deno.test("resolveSetting: falls back to global when arg absent", () => {
  assertEquals(resolveSetting(undefined, "Samantha"), "Samantha");
});

Deno.test("resolveSetting: null when neither set", () => {
  assertEquals(resolveSetting<string>(undefined, undefined), null);
});

Deno.test("resolveSetting: works for numeric rate", () => {
  assertEquals(resolveSetting(220, 190), 220);
  assertEquals(resolveSetting<number>(undefined, undefined), null);
});

// ─────────────────────────────────────────────────────────────────────
// buildSayArgs — argv construction
// ─────────────────────────────────────────────────────────────────────

Deno.test("buildSayArgs: omits -v and -r when null (system default)", () => {
  assertEquals(
    buildSayArgs("hello", null, null, "/tmp/out.aiff"),
    ["-o", "/tmp/out.aiff", "hello"],
  );
});

Deno.test("buildSayArgs: includes -v and -r when provided", () => {
  assertEquals(
    buildSayArgs("hi", "Daniel", 220, "/tmp/out.aiff"),
    ["-v", "Daniel", "-r", "220", "-o", "/tmp/out.aiff", "hi"],
  );
});

Deno.test("buildSayArgs: text is always the final argument", () => {
  const argv = buildSayArgs("the body", "Samantha", null, "/tmp/x.aiff");
  assertEquals(argv[argv.length - 1], "the body");
});

Deno.test("buildSayArgs: preserves spaces and option-like text as one argument", () => {
  assertEquals(
    buildSayArgs("--voice Alex; hello world", "Alex Lee", 1, "/tmp/a b.aiff"),
    [
      "-v",
      "Alex Lee",
      "-r",
      "1",
      "-o",
      "/tmp/a b.aiff",
      "--voice Alex; hello world",
    ],
  );
});

// ─────────────────────────────────────────────────────────────────────
// speak.execute — with an injected command runner (no real subprocess)
// ─────────────────────────────────────────────────────────────────────

const ok: CommandResult = { success: true, code: 0, stderr: "" };

/** Records each (bin, args) invocation and returns canned results. */
function recordingRunner(
  results: Record<string, CommandResult>,
): { run: CommandRunner; calls: Array<{ bin: string; args: string[] }> } {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const run: CommandRunner = (bin, args) => {
    calls.push({ bin, args });
    return Promise.resolve(results[bin] ?? ok);
  };
  return { run, calls };
}

Deno.test("speak: synthesizes and plays, records a played utterance", async () => {
  const { run, calls } = recordingRunner({ say: ok, afplay: ok });
  const { context, getWrittenResources } = createModelTestContext({
    methodName: "speak",
    globalArgs: {},
  });

  const result = await model.methods.speak.execute(
    { text: "Claude can talk now.", _run: run },
    context,
  );

  assertEquals(result.dataHandles.length, 1);
  assertEquals(calls.map((c) => c.bin), ["say", "afplay"]);

  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "utterance");
  assertEquals(written[0].data.played, true);
  assertEquals(written[0].data.text, "Claude can talk now.");
  assertEquals(written[0].data.voice, null);
  assertEquals(written[0].data.rate, null);
});

Deno.test("speak: play=false synthesizes only, records played=false", async () => {
  const { run, calls } = recordingRunner({ say: ok, afplay: ok });
  const { context, getWrittenResources } = createModelTestContext({
    methodName: "speak",
    globalArgs: {},
  });

  await model.methods.speak.execute(
    { text: "Silent run.", play: false, _run: run },
    context,
  );

  assertEquals(calls.map((c) => c.bin), ["say"]); // afplay never called
  assertEquals(getWrittenResources()[0].data.played, false);
});

Deno.test("speak: per-call voice/rate override the instance defaults", async () => {
  const { run, calls } = recordingRunner({ say: ok, afplay: ok });
  const { context, getWrittenResources } = createModelTestContext({
    methodName: "speak",
    globalArgs: { voice: "Samantha", rate: 175 },
  });

  await model.methods.speak.execute(
    { text: "Override.", voice: "Daniel", rate: 220, _run: run },
    context,
  );

  const sayCall = calls.find((c) => c.bin === "say")!;
  assertEquals(sayCall.args.slice(0, 4), ["-v", "Daniel", "-r", "220"]);
  assertEquals(getWrittenResources()[0].data.voice, "Daniel");
  assertEquals(getWrittenResources()[0].data.rate, 220);
});

Deno.test("speak: instance defaults apply when no per-call override", async () => {
  const { run, calls } = recordingRunner({ say: ok, afplay: ok });
  const { context } = createModelTestContext({
    methodName: "speak",
    globalArgs: { voice: "Samantha", rate: 190 },
  });

  await model.methods.speak.execute({ text: "Default.", _run: run }, context);

  const sayCall = calls.find((c) => c.bin === "say")!;
  assertEquals(sayCall.args.slice(0, 4), ["-v", "Samantha", "-r", "190"]);
});

Deno.test("speak: throws and writes nothing when `say` fails", async () => {
  const { run } = recordingRunner({
    say: { success: false, code: 1, stderr: "synthesis boom" },
  });
  const { context, getWrittenResources } = createModelTestContext({
    methodName: "speak",
    globalArgs: {},
  });

  await assertRejects(
    () => model.methods.speak.execute({ text: "boom", _run: run }, context),
    Error,
    "say exited 1",
  );
  assertEquals(getWrittenResources().length, 0); // no partial write
});

Deno.test("speak: throws and writes nothing when `afplay` fails", async () => {
  const { run } = recordingRunner({
    say: ok,
    afplay: { success: false, code: 2, stderr: "playback boom" },
  });
  const { context, getWrittenResources } = createModelTestContext({
    methodName: "speak",
    globalArgs: {},
  });

  await assertRejects(
    () => model.methods.speak.execute({ text: "boom", _run: run }, context),
    Error,
    "afplay exited 2",
  );
  assertEquals(getWrittenResources().length, 0);
});
