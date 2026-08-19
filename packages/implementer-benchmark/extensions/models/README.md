# @mgreten/implementer-benchmark

This Swamp extension compares coding implementers against five deterministic synthetic JavaScript tasks. Every candidate receives the same bounded packet, candidates run serially, responses may change only explicitly allowed files, and visible plus hidden tests execute in a Bubblewrap sandbox. The model persists bounded evidence, case results, and an aggregate suite summary. It is intended for controlled routing experiments, not for evaluating changes against a real application repository.

## Installation

```bash
swamp extension pull @mgreten/implementer-benchmark
```

## Setup

Create or reuse an `@mgreten/cli-agent` model that supports `invokeAndParse`, then create the benchmark model. The default agent model name is the generic `benchmark-agent`; override it when your agent instance has another name.

```bash
swamp model create @mgreten/implementer-benchmark benchmark \
  --global-arg agentModelName=benchmark-agent
```

Linux hosts need `git`, Node.js, and Bubblewrap. Command locations remain configurable for installations that do not expose them on the normal path.

## Usage

Run all five tasks with a candidate. `effortLevel` is optional and defaults to `default` for backward compatibility.

```bash
swamp model method run benchmark runSuite --input candidates='[{"id":"candidate-a","provider":"codex","model":"gpt-5","effortLevel":"medium"}]'
```

Run a subset with explicit budgets:

```bash
swamp model method run benchmark runSuite \
  --input taskIds='["task-01","task-05"]' \
  --input maxPacketBytes=32768 \
  --input maxOutputBytes=65536 \
  --input maxChangedLines=150
```

## Global Arguments

| Argument | Type | Default | Purpose |
|---|---|---|---|
| `workspaceRoot` | string | `/tmp/implementer-benchmark-runs` | Isolated suite workspace outside the Swamp repository |
| `swampPath` | string | `swamp` | Swamp executable path or command |
| `nodePath` | string | `node` | Node.js executable path or command |
| `bubblewrapPath` | string | `/usr/bin/bwrap` | Bubblewrap executable path |
| `agentModelName` | safe slug | `benchmark-agent` | Existing agent model exposing `invokeAndParse` |

## Method: runSuite

| Argument | Type | Default |
|---|---|---|
| `suiteId` | safe slug | generated |
| `taskIds` | task ID array | all five tasks |
| `candidates` | candidate array | bundled local example |
| `wallTimeoutMs` | integer | `180000` |
| `maxPacketBytes` | integer | `32768` |
| `maxOutputBytes` | integer | `65536` |
| `maxChangedLines` | integer | `150` |

## How It Works

The harness materializes a fresh git fixture, hashes a deterministic context packet, invokes each candidate without tool access, validates complete replacement files, and enforces packet, output, and changed-line budgets. Visible and hidden Node tests run with networking and host access unshared. Hidden verifier files are mounted read-only and removed after each case. Candidate execution is deliberately serial to avoid contention and make evidence ordering stable. Results include provider, model, effort level, token and cost metadata, changed paths, test status, and references to bounded JSON evidence.

## License

MIT — see LICENSE.txt for details.
