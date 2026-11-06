# @mgreten/pyannote-diarizer

Apply speaker diarization to a Whisper transcript using
[pyannote.audio](https://github.com/pyannote/pyannote-audio).  Takes the JSON
output from `@mgreten/mlx-whisper` (or any Whisper-compatible transcript),
runs the `pyannote/speaker-diarization-3.1` pipeline, and tags each segment
with a speaker label (`SPEAKER_00`, `SPEAKER_01`, …).

**Graceful fallback** — if diarization fails for any reason (missing HF token,
audio decode error, pyannote crash), the method logs a warning and returns the
original transcript unchanged.  A bad token never blocks the pipeline.

## Requirements

- Python 3 + pyannote.audio: `pip install pyannote.audio`
- A free Hugging Face account with the pyannote model agreements accepted:
  - <https://huggingface.co/pyannote/speaker-diarization-3.1>
  - <https://huggingface.co/pyannote/segmentation-3.0>

## Quick Start

```bash
# Install the extension
swamp extension pull @mgreten/pyannote-diarizer

# Create a model instance
swamp model create @mgreten/pyannote-diarizer pyannote-diarizer

# Point to your venv python if pyannote isn't on PATH
swamp model create @mgreten/pyannote-diarizer pyannote-diarizer \
  --global-arg pythonBin=/path/to/.venv/bin/python3
```

## HF Token Setup (one-time)

```bash
# Option 1 — write to the config file
mkdir -p ~/.config/offline-meeting-transcriber
printf '%s' 'hf_xxx...' > ~/.config/offline-meeting-transcriber/hf_token
chmod 600 ~/.config/offline-meeting-transcriber/hf_token

# Option 2 — environment variable
export HF_TOKEN=hf_xxx...

# Option 3 — wire from a swamp vault in a workflow
#   globalArgs:
#     hfToken: "{{ vault('meeting-secrets', 'hf_token') }}"
```

## Usage

```bash
# Diarize a transcript
swamp model method run pyannote-diarizer diarize \
  --arg transcriptJson="$(cat standup.json)" \
  --arg audioPath=/abs/path/to/standup.m4a \
  --arg instanceName="2026-05-28 Standup"

# Check whether diarization succeeded
swamp model output get pyannote-diarizer --json \
  | jq '.diarizedTranscript["2026-05-28 Standup"].attributes | {diarized, speakerCount, speakers}'
```

## Workflow Integration

Designed to sit between `@mgreten/mlx-whisper` and
`@mgreten/meeting-summarizer` in the `meeting-process` workflow:

```yaml
task:
  type: model_method
  modelIdOrName: pyannote-diarizer
  methodName: diarize
  inputs:
    transcriptJson: ${{ data.latest("mlx-whisper", "transcript").attributes.transcriptJson }}
    audioPath: ${{ inputs.audioPath }}
    instanceName: ${{ inputs.noteName }}
```

The `transcriptJson` output is always populated (with or without speaker labels),
so the downstream summarizer step never needs to handle a missing value.

## Configuration

| Global Arg   | Default    | Description                                  |
| ------------ | ---------- | -------------------------------------------- |
| `hfToken`    | _(empty)_  | HF token (sensitive — use vault in prod)     |
| `pythonBin`  | `python3`  | Python interpreter path                      |

## Output

The `diarizedTranscript` resource contains:

```json
{
  "transcriptJson": "{\"segments\": [{\"speaker\": \"SPEAKER_00\", ...}]}",
  "diarized": true,
  "speakerCount": 2,
  "speakers": ["SPEAKER_00", "SPEAKER_01"]
}
```

On fallback: `diarized: false`, `speakerCount: 0`, `speakers: []`, and
`transcriptJson` is the original undiarized Whisper output.
