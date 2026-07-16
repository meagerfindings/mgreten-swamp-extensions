/**
 * Speak text aloud on macOS using the built-in `say` voice synthesizer.
 * Synthesizes text to an audio file with `say`, optionally plays it through the
 * speakers with `afplay`, and records each utterance as a swamp resource.
 *
 * macOS-only: both `say` and `afplay` are first-party Apple binaries shipped
 * with the OS. There are no external dependencies beyond Zod.
 *
 * @module
 */

import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  voice: z.string().optional().describe(
    "Default `say` voice name (e.g. 'Samantha'). Omit to use the macOS " +
      "system default voice. See `say -v '?'` for installed voices.",
  ),
  rate: z.number().int().positive().optional().describe(
    "Default speech rate in words per minute. Omit to use the system default " +
      "(roughly 175 wpm).",
  ),
});

const UtteranceSchema = z.object({
  id: z.uuid(),
  text: z.string(),
  voice: z.string().nullable(),
  rate: z.number().nullable(),
  audioPath: z.string(),
  played: z.boolean(),
  durationMs: z.number(),
  spokenAt: z.string(),
});

/**
 * Minimal logger surface used by this model — a structural subset of swamp's
 * runtime logger (and the test harness `Logger`), so no external type import is
 * needed in the published bundle.
 */
type Logger = {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  fatal: (message: string, ...args: unknown[]) => void;
};

/** Resolved configuration the runtime hands to each method invocation. */
type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: Logger;
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
};

/** Outcome of running a subprocess: exit success plus decoded stderr. */
export type CommandResult = {
  success: boolean;
  code: number;
  stderr: string;
};

/** Runs a binary with arguments and resolves its {@link CommandResult}. */
export type CommandRunner = (
  bin: string,
  args: string[],
) => Promise<CommandResult>;

/**
 * Build the `say` argument list from the effective voice and rate.
 *
 * Omits `-v`/`-r` when the corresponding value is `null` so `say` falls back to
 * the macOS system default. Always ends with `-o <outputPath> <text>`.
 *
 * @param text The text to synthesize.
 * @param voice Effective voice name, or `null` for the system default.
 * @param rate Effective speech rate (words/min), or `null` for the default.
 * @param outputPath Path the synthesized AIFF should be written to.
 * @returns The ordered argument vector for `say`.
 */
export function buildSayArgs(
  text: string,
  voice: string | null,
  rate: number | null,
  outputPath: string,
): string[] {
  const sayArgs: string[] = [];
  if (voice !== null) sayArgs.push("-v", voice);
  if (rate !== null) sayArgs.push("-r", String(rate));
  sayArgs.push("-o", outputPath, text);
  return sayArgs;
}

/**
 * Resolve the effective voice and rate for a call: per-call argument wins over
 * the instance global default, which falls back to `null` (macOS default).
 *
 * @param argValue The per-call override, if provided.
 * @param globalValue The instance-level default, if configured.
 * @returns The resolved value, or `null` when neither is set.
 */
export function resolveSetting<T>(
  argValue: T | undefined,
  globalValue: T | undefined,
): T | null {
  return argValue ?? globalValue ?? null;
}

/**
 * Run a binary with the given arguments, capturing stdout/stderr.
 *
 * Throws if the binary is missing from PATH (e.g. when run on a non-macOS
 * host); a non-zero exit is reported via the returned {@link CommandResult}
 * rather than thrown, so callers can decide how to surface it.
 *
 * @param bin Executable name or absolute path.
 * @param args Arguments passed to the executable.
 * @returns The exit status and decoded stderr tail.
 */
async function runCommand(
  bin: string,
  args: string[],
): Promise<CommandResult> {
  let output: Deno.CommandOutput;
  try {
    const cmd = new Deno.Command(bin, {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    output = await cmd.output();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to spawn '${bin}' (is this running on macOS?): ${errorMsg}`,
    );
  }
  return {
    success: output.success,
    code: output.code,
    stderr: new TextDecoder().decode(output.stderr).slice(-500),
  };
}

/** Swamp model for speaking text aloud on macOS via the `say` synthesizer. */
export const model = {
  type: "@mgreten/macos-say-tts",
  version: "2026.07.16.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    utterance: {
      description: "Record of a spoken (or synthesized) utterance",
      schema: UtteranceSchema,
      lifetime: "7d" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    speak: {
      description:
        "Synthesize text with macOS `say` and play it through the speakers",
      arguments: z.object({
        text: z.string().min(1).describe("The text to speak aloud"),
        voice: z.string().optional().describe(
          "`say` voice name; overrides the instance default for this call",
        ),
        rate: z.number().int().positive().optional().describe(
          "Speech rate in words per minute; overrides the instance default",
        ),
        play: z.boolean().optional().default(true).describe(
          "Play the audio through the speakers (set false to only synthesize)",
        ),
      }),
      execute: async (
        args: {
          text: string;
          voice?: string;
          rate?: number;
          play?: boolean;
          /** Injectable command runner for tests; defaults to a real subprocess. */
          _run?: CommandRunner;
        },
        context: MethodContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const voice = resolveSetting(args.voice, context.globalArgs.voice);
        const rate = resolveSetting(args.rate, context.globalArgs.rate);
        const play = args.play ?? true;
        const run = args._run ?? runCommand;

        const audioPath = await Deno.makeTempFile({ suffix: ".aiff" });
        const startedAt = Date.now();
        let played = false;

        try {
          const sayArgs = buildSayArgs(args.text, voice, rate, audioPath);

          context.logger.info(
            "Synthesizing speech with `say` ({chars} chars)",
            {
              chars: args.text.length,
              voice: voice ?? "(system default)",
            },
          );

          const sayResult = await run("say", sayArgs);
          if (!sayResult.success) {
            throw new Error(
              `say exited ${sayResult.code}: ${sayResult.stderr}`,
            );
          }

          if (play) {
            const playResult = await run("afplay", [audioPath]);
            if (!playResult.success) {
              throw new Error(
                `afplay exited ${playResult.code}: ${playResult.stderr}`,
              );
            }
            played = true;
            context.logger.info("Played synthesized audio");
          }
        } finally {
          await Deno.remove(audioPath).catch(() => {});
        }

        const utterance = {
          id: crypto.randomUUID(),
          text: args.text,
          voice,
          rate,
          audioPath,
          played,
          durationMs: Date.now() - startedAt,
          spokenAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "utterance",
          `utterance-${Date.now()}`,
          utterance as unknown as Record<string, unknown>,
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
