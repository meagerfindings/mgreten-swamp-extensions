# @mgreten/mlx-whisper

Transcribe audio files on Apple Silicon using
[mlx_whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper).
Runs the CLI, captures the structured JSON output (segments + timestamps +
language), and stores it as a swamp resource for downstream pipeline steps.

## Requirements

- Apple Silicon Mac (MLX runs on M-series chips only)
- Python + mlx_whisper: `pip install mlx-whisper`

## Quick Start

```bash
# Install the extension
swamp extension pull @mgreten/mlx-whisper

# Create a model instance (uses whisper-large-v3-turbo by default)
swamp model create @mgreten/mlx-whisper mlx-whisper

# Point to your venv if mlx_whisper isn't on PATH
swamp model create @mgreten/mlx-whisper mlx-whisper \
  --global-arg mlxWhisperBin=/path/to/.venv/bin/mlx_whisper
```

## Usage

```bash
# Transcribe a meeting recording
swamp model method run mlx-whisper transcribe \
  --arg audioPath=/abs/path/to/meeting.m4a \
  --arg instanceName="2026-05-28 Standup"

# Retrieve the transcript JSON (pipe to downstream tools)
swamp model output get mlx-whisper --json \
  | jq -r '.transcript["2026-05-28 Standup"].attributes.transcriptJson' \
  > transcript.json
```

## Workflow Integration

Designed to chain with `@mgreten/pyannote-diarizer` (speaker labels) and
`@mgreten/meeting-summarizer` (LLM summary) in the `meeting-process` workflow:

```yaml
# Workflow step example:
task:
  type: model_method
  modelIdOrName: mlx-whisper
  methodName: transcribe
  inputs:
    audioPath: ${{ inputs.audioPath }}
    instanceName: ${{ inputs.noteName }}
```

## Configuration

| Global Arg            | Default                               | Description                          |
| --------------------- | ------------------------------------- | ------------------------------------ |
| `whisperModel`        | `mlx-community/whisper-large-v3-turbo` | HuggingFace model ID                |
| `noSpeechThreshold`   | `0.6`                                 | Silence filter (0–1)                 |
| `mlxWhisperBin`       | `mlx_whisper`                         | Path to the mlx_whisper binary       |

## Output

The `transcript` resource contains:

```json
{
  "transcriptJson": "{\"segments\": [...], \"language\": \"en\"}",
  "audioPath": "/abs/path/to/meeting.m4a",
  "stem": "meeting",
  "segmentCount": 342,
  "language": "en"
}
```

The `transcriptJson` field is the raw Whisper JSON, compatible with
`@mgreten/pyannote-diarizer` and `@mgreten/meeting-summarizer`.
