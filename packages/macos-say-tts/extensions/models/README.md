# @mgreten/macos-say-tts

Speak text aloud on macOS from any swamp model or workflow, using the built-in
[`say`](https://ss64.com/mac/say.html) voice synthesizer. One method, one
purpose: synthesize text to audio and play it through the speakers, with
optional voice and speech-rate control.

No cloud service, no API key, no external dependencies — just the native macOS
`say` and `afplay` binaries.

## Requirements

**macOS only.** This extension shells out to `say` and `afplay`, which ship with
macOS. It is published with `platforms: [darwin]` and will not work on Linux or
Windows.

## Installation

```sh
swamp extension pull @mgreten/macos-say-tts
```

## Setup

Create a model instance. Both global arguments are optional — omit them to use
the macOS system default voice and rate:

```sh
swamp model create speak --type @mgreten/macos-say-tts
```

Or pin a default voice and rate for the instance:

```sh
swamp model create speak --type @mgreten/macos-say-tts \
  --global-args '{"voice": "Samantha", "rate": 190}'
```

List the voices installed on your Mac with `say -v '?'`. Additional
high-quality Siri/enhanced voices can be downloaded in **System Settings →
Accessibility → Spoken Content → System Voice → Manage Voices**, then selected
by name.

## Usage

Speak a line of text:

```sh
swamp model method run speak speak --input '{"text": "Claude can talk now."}'
```

Override the voice and rate per call:

```sh
swamp model method run speak speak \
  --input '{"text": "Deploy finished.", "voice": "Daniel", "rate": 220}'
```

Synthesize without playing (useful for testing or headless runs):

```sh
swamp model method run speak speak --input '{"text": "Silent run.", "play": false}'
```

## Global Arguments

| Argument | Type   | Default              | Description                          |
| -------- | ------ | -------------------- | ------------------------------------ |
| `voice`  | string | *(system default)*   | Default `say` voice name             |
| `rate`   | number | *(system default)*   | Default speech rate (words/min)      |

## Method: `speak`

| Argument | Type    | Required | Description                                      |
| -------- | ------- | -------- | ------------------------------------------------ |
| `text`   | string  | yes      | The text to speak aloud                          |
| `voice`  | string  | no       | Override the instance default voice              |
| `rate`   | number  | no       | Override the instance default rate (words/min)   |
| `play`   | boolean | no       | Play through speakers (default `true`)           |

Per-call `voice`/`rate` win over the instance global arguments, which in turn
fall back to the macOS system defaults.

## How It Works

The model runs `say -v <voice> -r <rate> -o <tmpfile>.aiff "<text>"` to
synthesize the text to a temporary AIFF file, then (unless `play` is `false`)
runs `afplay <tmpfile>.aiff` to play it through the speakers. The temporary file
is removed once playback completes.

Each call records an `utterance` resource capturing the text, the effective
voice and rate, whether it was played, and how long synthesis + playback took —
handy for auditing in workflows. Note that the recorded `audioPath` is the
temporary file's path; the file itself is deleted after the call, so the path is
provenance metadata rather than a retrievable artifact.

A missing `say`/`afplay` binary (e.g. running on a non-macOS host) surfaces as a
spawn error; a non-zero exit from either binary is raised with its exit code and
the tail of its stderr.

## License

MIT — see LICENSE for details.
