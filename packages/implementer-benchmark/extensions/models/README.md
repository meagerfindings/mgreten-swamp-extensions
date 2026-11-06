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

The configured Swamp/agent subprocess runs with the host environment so provider authentication can work. Treat the benchmark model and its executable-path settings as trusted operator configuration, use narrowly scoped benchmark credentials, and do not run untrusted fixtures or candidate definitions. Raw agent subprocess stdout and stderr are not persisted as benchmark evidence.

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

The actor lane has a portable wall-time bound but no portable provider-neutral turn, tool-call, token, or cost ceiling. `maxOutputBytes` is a post-invocation scoring bound based on the agent's reported output size; it does not stop provider generation or cap spend. Use provider-side limits and `wallTimeoutMs` to match the implementation and spending budget you actually permit in practice.

## How It Works

The harness materializes a fresh git fixture, hashes a deterministic context packet, and enforces packet, reported-output, and changed-line scoring budgets. `runSuite` invokes each candidate without tools and validates complete replacement files. `runActorSuite` instead permits a bounded edit-and-test session in that fixture. Visible and hardening Node tests run with networking and host access unshared. Hardening verifier files are not mounted during candidate execution, are mounted read-only only for independent verification, and are removed after each case; their output is reduced to a pass/fail value in persisted evidence. The verifier source ships with this open extension, so these tests are execution-hidden rather than secret from a party that has inspected the package. Candidate execution is deliberately serial to avoid contention and make evidence ordering stable. The temporary suite workspace is removed on success and failure after durable Swamp evidence has been written. Results include provider, model, effort level, execution mode, contract and hardening scores, token and cost metadata, changed paths, test status, and references to bounded JSON evidence.

## License

MIT — see LICENSE.txt for details.
