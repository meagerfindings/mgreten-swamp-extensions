# @mgreten/meeting-summarizer

Chunk a Whisper transcript and summarize it into a Granola-style meeting note
using a local Ollama LLM.  Handles long recordings with greedy segment-boundary
chunking (default 2500 tokens, 200-token overlap) and a deduplication merge pass.
Pure TypeScript — no Python, no subprocess.  Works with any Ollama-compatible
model on any platform.

## Methods

| Method          | Description                                               |
| --------------- | --------------------------------------------------------- |
| `summarize`     | Transcript JSON → Granola-style markdown note             |
| `combine_notes` | Merge handwritten Obsidian note + analysis into one file  |
| `write_note`    | Write a markdown string to a file path                    |

## Quick Start

```bash
# Install the extension
swamp extension pull @mgreten/meeting-summarizer

# Create a model instance (uses qwen3.6:35b-a3b-nvfp4 by default)
swamp model create @mgreten/meeting-summarizer meeting-summarizer

# Or pick a different Ollama model
swamp model create @mgreten/meeting-summarizer meeting-summarizer \
  --global-arg ollamaModel=llama3.3:70b
```

## Usage — summarize

```bash
# Summarize a Whisper JSON transcript (from mlx-whisper or any tool that
# produces the standard Whisper JSON format with a "segments" array).
swamp model method run meeting-summarizer summarize \
  --arg transcriptJson="$(cat standup.json)" \
  --arg instanceName="2026-05-28 Standup"

# Retrieve the markdown result
swamp model output get meeting-summarizer --json \
  | jq -r '.summary["2026-05-28 Standup"].attributes.markdown'
```

## Usage — combine_notes

```bash
# Combine an existing handwritten Obsidian note with the analysis
swamp model method run meeting-summarizer combine_notes \
  --arg notesMarkdown="$(cat 'Product Sync.md')" \
  --arg analysisMarkdown="$(cat 'Product Sync Analysis.md')" \
  --arg notesName="Product Sync" \
  --arg analysisName="Product Sync Analysis"
```

## Usage — write_note

```bash
# Write the generated markdown to a vault directory
swamp model method run meeting-summarizer write_note \
  --arg markdown="# TL;DR ..." \
  --arg outputDir="$HOME/git/Obsidian/Meetings" \
  --arg filename="2026-05-28 Standup Analysis.md"
```

## Workflow Integration

The meeting-summarizer is designed to chain with
[`@mgreten/mlx-whisper`](https://swamp-club.com/extensions/@mgreten/mlx-whisper)
and `@mgreten/pyannote-diarizer` in the `meeting-process` workflow:

```yaml
# In a workflow step:
task:
  type: model_method
  modelIdOrName: meeting-summarizer
  methodName: summarize
  inputs:
    transcriptJson: ${{ data.latest("pyannote-diarizer", "diarizedTranscript").attributes.transcriptJson }}
    instanceName: ${{ inputs.noteName }}
```

## Configuration

| Global Arg      | Default                   | Description                            |
| --------------- | ------------------------- | -------------------------------------- |
| `ollamaUrl`     | `http://localhost:11434`  | Ollama API base URL                    |
| `ollamaModel`   | `qwen3.6:35b-a3b-nvfp4`   | Ollama model tag                       |
| `chunkTokens`   | `2500`                    | Max tokens per chunk                   |
| `overlapTokens` | `200`                     | Token overlap between adjacent chunks  |

## Output Format (summarize)

The `summary` resource contains:

```json
{
  "markdown": "# TL;DR\n...",
  "model": "qwen3.6:35b-a3b-nvfp4",
  "chunkCount": 2,
  "durationMs": 45000
}
```

The markdown format follows [Granola](https://granola.ai) note conventions:
`# TL;DR`, `## Key Discussion Points`, `## Decisions`, `## Action Items`,
`## Open Questions`.

## Notes on Chunking

The token estimator uses `wordCount × 1.3` — no tiktoken dependency.  For
very long meetings (> 2 hours), reduce `chunkTokens` to 2000 to stay within
the model's context window, or use a model with a larger context window.

The overlap prevents action items and decisions from being split across chunk
boundaries.  If a meeting has dense decision-making in the first few minutes
and nothing after, a single chunk will be used without the merge step.
