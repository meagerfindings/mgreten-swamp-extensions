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

Run all five one-shot response tasks with a candidate. `effortLevel` is optional and defaults to `default` for backward compatibility.

```bash
swamp model method run benchmark runSuite --input candidates='[{"id":"candidate-a","provider":"codex","model":"gpt-5","effortLevel":"medium"}]'
```

Use the actor lane to measure bounded implementation work more like an atomic user story. The agent may inspect the tiny fixture, edit only allowed files, and run visible tests inside an isolated sandbox. Results separately count visible contract passes, hidden hardening passes, and cases that pass both.

```bash
swamp model method run benchmark runActorSuite \
  --input candidates='[{"id":"sonnet","provider":"claude","model":"sonnet","effortLevel":"medium"}]' \
  --input wallTimeoutMs=180000
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

## Method: runActorSuite

`runActorSuite` accepts the same arguments and budgets as `runSuite`. Unlike the one-shot response lane, it invokes the configured CLI agent with the `actor` tool profile in the fixture repository. The repository starts from a trusted git baseline, commits and out-of-scope changes fail closed, and Swamp independently runs visible and hidden tests afterward. Provider network access remains available because hosted CLIs and remote Ollama endpoints require it; use only the bundled trusted fixtures.

The actor lane has a portable wall-time bound but no portable provider-neutral turn or tool-call ceiling. Use `wallTimeoutMs` to match the implementation budget you actually permit in practice.

## How It Works

The harness materializes a fresh git fixture, hashes a deterministic context packet, and enforces packet, output, and changed-line budgets. `runSuite` invokes each candidate without tools and validates complete replacement files. `runActorSuite` instead permits a bounded edit-and-test session in that fixture. Visible and hidden Node tests run with networking and host access unshared. Hidden verifier files are mounted read-only and removed after each case. Candidate execution is deliberately serial to avoid contention and make evidence ordering stable. Results include provider, model, effort level, execution mode, contract and hardening scores, token and cost metadata, changed paths, test status, and references to bounded JSON evidence.

## License

MIT — see LICENSE.txt for details.
