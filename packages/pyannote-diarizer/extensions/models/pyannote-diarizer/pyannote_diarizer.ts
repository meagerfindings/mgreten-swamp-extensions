/**
 * `@mgreten/pyannote-diarizer` — speaker diarization via pyannote.audio.
 *
 * Runs a self-contained Python helper (embedded inline) that loads the
 * pyannote/speaker-diarization-3.1 pipeline and merges speaker labels into
 * a Whisper transcript JSON.  Requires Python 3 + pyannote.audio installed
 * in the active environment.
 *
 * If diarization fails for any reason (missing token, audio decode error,
 * pyannote crash) the method logs a warning and returns the original
 * transcript unchanged — a failed diarization never blocks the pipeline.
 *
 * Hugging Face token: pass via `hfToken` globalArg (wire from a vault with
 * `{{ vault('meeting-secrets', 'hf_token') }}`), or set the `$HF_TOKEN`
 * environment variable, or write to
 * ~/.config/offline-meeting-transcriber/hf_token.
 *
 * Platform: darwin-aarch64 (pyannote + Apple Silicon tested setup)
 */
import { z } from "npm:zod@4";

// Minimal Python diarization helper — written to a tmpfile at runtime.
// Token is injected via $HF_TOKEN environment variable (not a CLI arg).
const DIARIZE_PY = `
import sys, json, os, subprocess, tempfile
from pathlib import Path

def load_token():
    tok = os.environ.get("HF_TOKEN", "").strip()
    if tok:
        return tok
    p = Path.home() / ".config" / "offline-meeting-transcriber" / "hf_token"
    if p.exists():
        tok = p.read_text().strip()
        if tok:
            return tok
    sys.stderr.write("error: no HF token (set hfToken globalArg or $HF_TOKEN or write to ~/.config/offline-meeting-transcriber/hf_token)\\n")
    sys.exit(2)

transcript_path, audio_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

token = load_token()

# Convert to 16 kHz mono WAV before diarization. AAC/m4a containers include
# encoder-delay priming samples that cause the decoded chunk to be slightly
# shorter than the container duration implies, triggering a ValueError in
# pyannote's sample-count assertion. WAV avoids this entirely.
wav_tmp = None
diarize_path = audio_path
if not audio_path.lower().endswith('.wav'):
    fd, wav_tmp = tempfile.mkstemp(suffix='_diarize.wav')
    os.close(fd)
    subprocess.run(
        ['ffmpeg', '-y', '-i', audio_path, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', wav_tmp],
        check=True, capture_output=True,
    )
    diarize_path = wav_tmp

import torch as _torch
_requested = os.environ.get("PYANNOTE_DEVICE", "auto")
if _requested == "auto":
    _device = _torch.device("mps") if _torch.backends.mps.is_available() else _torch.device("cpu")
else:
    _device = _torch.device(_requested)

try:
    from pyannote.audio import Pipeline
    pipe = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", token=token)
    pipe.to(_device)
    result = pipe(diarize_path)
    annotation = getattr(result, "speaker_diarization", result)
    turns = [
        (float(t.start), float(t.end), str(label))
        for t, _, label in annotation.itertracks(yield_label=True)
    ]
finally:
    if wav_tmp and os.path.exists(wav_tmp):
        os.unlink(wav_tmp)

data = json.loads(Path(transcript_path).read_text())
for seg in data.get("segments") or []:
    s, e = float(seg.get("start", 0)), float(seg.get("end", 0))
    best, best_ov = "Speaker ?", 0.0
    for ts, te, label in turns:
        ov = max(0.0, min(e, te) - max(s, ts))
        if ov > best_ov:
            best, best_ov = label, ov
    seg["speaker"] = best

Path(out_path).write_text(json.dumps(data))
speakers = sorted({l for _, _, l in turns})
print(json.dumps({"speakerCount": len(speakers), "turnCount": len(turns), "speakers": speakers}))
`.trim();

const GlobalArgsSchema = z.object({
  hfToken: z
    .string()
    .optional()
    .meta({ sensitive: true })
    .describe(
      "Hugging Face token for pyannote gated models. " +
        "Passed as $HF_TOKEN to the subprocess — never exposed as a CLI argument. " +
        "Falls back to $HF_TOKEN env var or ~/.config/offline-meeting-transcriber/hf_token",
    ),
  pythonBin: z
    .string()
    .default("python3")
    .describe("Python interpreter to use"),
  device: z
    .string()
    .default("auto")
    .describe(
      "PyTorch device for pyannote inference: 'auto' (prefers MPS on Apple Silicon, falls back to CPU), 'mps', 'cpu', or 'cuda'. Passed as $PYANNOTE_DEVICE to the subprocess.",
    ),
});

const DiarizedResourceSchema = z.object({
  transcriptJson: z.string().describe(
    "Transcript JSON (diarized if successful, original on fallback)",
  ),
  diarized: z.boolean().describe(
    "Whether speaker labels were successfully applied",
  ),
  speakerCount: z.number().describe(
    "Number of detected speakers (0 on fallback)",
  ),
  speakers: z.array(z.string()).describe("Speaker label list"),
});

/** Pyannote speaker diarization model — see module doc for full details. */
export const model = {
  type: "@mgreten/pyannote-diarizer",
  version: "2026.06.27.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    diarizedTranscript: {
      description:
        "Whisper transcript with speaker labels (or original on fallback)",
      schema: DiarizedResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    diarize: {
      description:
        "Apply pyannote speaker diarization to a Whisper transcript. Falls back gracefully on error.",
      arguments: z.object({
        transcriptJson: z.string().describe("Whisper JSON transcript content"),
        audioPath: z.string().describe(
          "Absolute path to the source audio file",
        ),
        instanceName: z.string().optional().describe("Resource instance name"),
      }),
      execute: async (
        args: {
          transcriptJson: string;
          audioPath: string;
          instanceName?: string;
        },
        // deno-lint-ignore no-explicit-any
        context: any,
      ) => {
        const { hfToken, pythonBin, device } = context.globalArgs;
        const stem = args.audioPath.split("/").pop()!.replace(/\.[^.]+$/, "");
        const name = args.instanceName ?? stem;

        const tmpDir = await Deno.makeTempDir({ prefix: "swamp-diarize-" });

        try {
          const scriptPath = `${tmpDir}/diarize.py`;
          const transcriptPath = `${tmpDir}/transcript.json`;
          const outPath = `${tmpDir}/diarized.json`;

          await Deno.writeTextFile(scriptPath, DIARIZE_PY);
          await Deno.writeTextFile(transcriptPath, args.transcriptJson);

          const cmdArgs = [
            scriptPath,
            transcriptPath,
            args.audioPath,
            outPath,
          ];

          // Secrets and device injected via env vars — never via CLI args (would appear in ps output)
          const subEnv: Record<string, string> = {};
          if (hfToken) subEnv["HF_TOKEN"] = hfToken;
          subEnv["PYANNOTE_DEVICE"] = device;

          const cmd = new Deno.Command(pythonBin, {
            args: cmdArgs,
            env: subEnv,
            stdout: "piped",
            stderr: "piped",
          });

          const result = await cmd.output();

          if (!result.success) {
            const stderr = new TextDecoder().decode(result.stderr);
            context.logger.warn(
              `Diarization failed (continuing without speakers): ${
                stderr.slice(-500)
              }`,
            );
            const handle = await context.writeResource(
              "diarizedTranscript",
              name,
              {
                transcriptJson: args.transcriptJson,
                diarized: false,
                speakerCount: 0,
                speakers: [],
              },
            );
            return { dataHandles: [handle] };
          }

          const stdout = new TextDecoder().decode(result.stdout).trim();
          const meta: {
            speakerCount: number;
            turnCount: number;
            speakers: string[];
          } = JSON.parse(stdout);
          const diarizedJson = await Deno.readTextFile(outPath);

          context.logger.info(
            `Diarized: ${meta.speakerCount} speakers, ${meta.turnCount} turns`,
          );

          const handle = await context.writeResource(
            "diarizedTranscript",
            name,
            {
              transcriptJson: diarizedJson,
              diarized: true,
              speakerCount: meta.speakerCount,
              speakers: meta.speakers,
            },
          );

          return { dataHandles: [handle] };
        } finally {
          await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
        }
      },
    },
  },
};
