# @mgreten/pimoroni-explorer

A Swamp model for a USB-connected [Pimoroni Explorer](https://github.com/pimoroni/explorer). It uses MicroPython's `mpremote` utility to verify board identity, record firmware and filesystem observations, run temporary scripts from RAM, safely install menu applications, and render a Swamp Club score card. The model protects `boot.py`, `main.py`, and `explorer.py`, refuses accidental overwrites, and records successful operations as versioned Swamp data.

This initial beta has comprehensive mocked tests but has not yet been exercised against physical Explorer hardware. Keep the board connected over USB while invoking methods. Explorer has no onboard Wi-Fi.

## Installation

Install `mpremote` on the host, then pull the beta extension:

```sh
pipx install mpremote
swamp extension pull @mgreten/pimoroni-explorer --channel beta
```

## Setup

Create a persistent model. `auto` selects the first compatible serial device; use an explicit `id:<serial>` selector when more than one MicroPython board is attached.

```sh
swamp model create @mgreten/pimoroni-explorer explorer \
  --global-arg device=auto \
  --global-arg mpremoteCommand=mpremote \
  --json
```

## Usage

Verify the connected board and record its MicroPython version, 320×240 display bounds, and root files:

```sh
swamp model method run explorer probe
```

Render a Swamp Club score without modifying the device filesystem:

```sh
swamp model method run explorer displayScore \
  --input username=mgreten \
  --input score=1234 \
  --input rank=7 \
  --input streakDays=12
```

Run a local experiment from RAM, or install one application into the factory menu:

```sh
swamp model method run explorer run --input scriptPath=/absolute/path/demo.py
swamp model method run explorer install \
  --input appPath=/absolute/path/swamp_score.py \
  --input target=swamp_score.py
```

Install the bundled rickroll demo without locating or downloading a separate script:

```sh
swamp model method run explorer installRickRoll
```

`install` hashes both files. Identical content is a no-op. Different existing content is rejected unless `force=true` is explicitly supplied.

## Global arguments

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `device` | string | `auto` | `mpremote` selector such as `auto`, `id:<serial>`, or a serial path. |
| `mpremoteCommand` | string | `mpremote` | Executable name or absolute path. |
| `timeoutMs` | integer | `30000` | Subprocess timeout from 1 to 300 seconds. |

## Methods

- `probe` verifies Explorer identity before persisting a device observation.
- `displayScore` renders username, a comma-formatted score with responsive sizing, optional rank, and optional streak. Set `subtitle=TOKENS BURNED` for a token-burn counter view.
- `run` executes a local Python file from RAM and captures bounded output.
- `install` safely places a lowercase Python module in the factory menu.
- `installRickRoll` installs the bundled display-and-speaker demo as `rick_roll.py`.

## How it works

Each method invokes `mpremote` with an argument array rather than a shell command. Small MicroPython programs emit marked JSON responses; the model validates those responses with strict Zod schemas before writing data. Captured output is bounded, processes have timeouts, user text is encoded as a Python-safe JSON string literal, and reserved lifecycle files cannot be installation targets.

## License

MIT — see LICENSE.txt for details.
