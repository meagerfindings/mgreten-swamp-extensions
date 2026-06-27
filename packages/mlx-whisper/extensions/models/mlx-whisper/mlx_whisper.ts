/**
 * `@mgreten/mlx-whisper` — transcribe audio using mlx_whisper on Apple Silicon.
 *
 * Invokes the `mlx_whisper` CLI (must be installed and on PATH, or set
 * `mlxWhisperBin` to an absolute path).  Writes to a temp directory and
 * returns the full transcript JSON as a resource so downstream steps can
 * use it without touching the filesystem.
 *
 * Platform: darwin-aarch64 (MLX requires Apple Silicon)
 */
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  whisperModel: z
    .string()
    .default("mlx-community/whisper-large-v3-turbo")
    .describe("HuggingFace model ID for mlx_whisper"),
  noSpeechThreshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.6)
    .describe(
      "Skip segments below this no-speech probability (suppresses hallucinations)",
    ),
  mlxWhisperBin: z
    .string()
    .default("mlx_whisper")
    .describe("Path to mlx_whisper binary; defaults to 'mlx_whisper' on PATH"),
});

const TranscriptResourceSchema = z.object({
  transcriptJson: z.string().describe("Full Whisper JSON output"),
  audioPath: z.string().describe("Source audio file path"),
  stem: z.string().describe("Audio filename without extension"),
  segmentCount: z.number().describe("Number of transcript segments"),
  language: z.string().optional().describe("Detected language code"),
});

/** MLX Whisper transcription model — see module doc for full details. */
export const model = {
  type: "@mgreten/mlx-whisper",
  version: "2026.06.27.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    transcript: {
      description: "Whisper JSON transcript with full segment data",
      schema: TranscriptResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    transcribe: {
      description:
        "Transcribe an audio file to structured JSON using mlx_whisper",
      arguments: z.object({
        audioPath: z.string().describe(
          "Absolute path to the audio file (m4a, mp3, wav, etc.)",
        ),
        instanceName: z
          .string()
          .optional()
          .describe("Resource instance name (defaults to audio stem)"),
      }),
      execute: async (
        args: { audioPath: string; instanceName?: string },
        // deno-lint-ignore no-explicit-any
        context: any,
      ) => {
        const { whisperModel, noSpeechThreshold, mlxWhisperBin } =
          context.globalArgs;

        const stem = args.audioPath.split("/").pop()!.replace(/\.[^.]+$/, "");
        const tmpDir = await Deno.makeTempDir({ prefix: "swamp-whisper-" });

        try {
          context.logger.info(
            `Transcribing "${stem}" with ${whisperModel}`,
          );

          const cmd = new Deno.Command(mlxWhisperBin, {
            args: [
              args.audioPath,
              "--model",
              whisperModel,
              "--output-format",
              "json",
              "--output-dir",
              tmpDir,
              "--no-speech-threshold",
              String(noSpeechThreshold),
            ],
            stdout: "piped",
            stderr: "piped",
          });

          const result = await cmd.output();

          if (!result.success) {
            const stderr = new TextDecoder().decode(result.stderr);
            throw new Error(
              `mlx_whisper exited ${result.code}: ${stderr.slice(-2000)}`,
            );
          }

          const transcriptPath = `${tmpDir}/${stem}.json`;
          const transcriptJson = await Deno.readTextFile(transcriptPath);
          const data: { segments?: unknown[]; language?: string } = JSON.parse(
            transcriptJson,
          );
          const segments = data.segments ?? [];

          context.logger.info(
            `Transcribed ${segments.length} segments (lang=${
              data.language ?? "unknown"
            })`,
          );

          const name = args.instanceName ?? stem;
          const handle = await context.writeResource("transcript", name, {
            transcriptJson,
            audioPath: args.audioPath,
            stem,
            segmentCount: segments.length,
            language: data.language,
          });

          return { dataHandles: [handle] };
        } finally {
          await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
        }
      },
    },
  },
};
