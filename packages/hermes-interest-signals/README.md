# Hermes Interest Signals

`@mgreten/hermes-interest-signals` converts **caller-supplied, user-authorized observations** into a transparent interest-signal profile. It is designed as a small, deterministic bridge between a private context collector—such as Hermes—and downstream tools such as `@mgreten/extension-radar`.

## What it does

- groups normalized topic observations
- weights current, explicit interests and active projects more highly
- records explicit deprioritization separately
- classifies results as **Active**, **Watch**, or **Deprioritized**
- emits `downstreamSignals` directly usable by a preference-audit model
- writes a typed, reviewable Swamp resource

## What it does not do

- does **not** read Hermes conversations, notes, messages, or memory
- does **not** access external systems or call an LLM
- does **not** create a hidden user profile
- does **not** change recommendations, models, schedules, or preferences
- does **not** send notifications

A private collector chooses which authorized context to inspect and must minimize it into neutral observations. Never submit raw session transcripts, personal identifiers, credentials, local paths, hostnames, addresses, or unnecessary sensitive details.

## Install

```bash
swamp extension pull @mgreten/hermes-interest-signals
swamp model create @mgreten/hermes-interest-signals interest-signals
```

## Aggregate observations

Create an input file such as `observations.json`:

```json
{
  "observations": [
    {
      "topic": "energy monitoring",
      "kind": "active-project",
      "confidence": 3,
      "recencyDays": 4,
      "rationale": "An active, recurring project"
    },
    {
      "topic": "legacy integration",
      "kind": "declined",
      "confidence": 2,
      "recencyDays": 12,
      "rationale": "The user explicitly no longer uses it"
    }
  ]
}
```

Then run:

```bash
swamp model method run interest-signals aggregate --input-file observations.json
swamp data get interest-signals current --json
```

The profile resource includes:

- `activeInterests`, `watchInterests`, and `deprioritizedInterests`
- `downstreamSignals`: `{ term, direction, weight, rationale }` values suitable for a downstream preference-review step
- `markdown`: a concise human-reviewable summary

## Scoring

Each observation contributes a bounded score:

- confidence: 1–5
- recency multiplier: 3 for 0–30 days, 2 for 31–90 days, 1 for 91–365 days
- active projects and desires receive a 2× multiplier
- declined items contribute a negative score

The default active threshold is 3. Configure `minimumActiveScore` and `maxInterests` as model global arguments if a different threshold or cap fits your use case.

## Typical Hermes pipeline

1. A private Hermes job reviews only context it is authorized to use.
2. Hermes emits a small set of neutral observations, not raw conversation text.
3. This extension aggregates those observations into typed signals.
4. A downstream extension or human uses the signals to propose—not automatically apply—new curation preferences.

## License

MIT. See [LICENSE.md](LICENSE.md).
