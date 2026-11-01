# @mgreten/road-trip-risk-watch

Native Swamp model for checkpointed route-risk monitoring.

It polls official NWS endpoints for each checkpoint, computes a stable risk
fingerprint, persists the last fingerprint to a local state file, and stays
silent unless something changes materially.

## Method

### `collect`

Polls each checkpoint, classifies local route risk, updates the fingerprint state
file, and writes:

- `summary/latestSummary` — structured route-risk summary, only on changed runs.
- `digest/latestDigest` — markdown summary, only on changed runs.

## Usage

```bash
swamp model @mgreten/road-trip-risk-watch method run collect road-trip-risk-watch \
  --input tripLabel='Indianapolis IN → Denver CO' \
  --input statePath=./state/road-trip-risk-watch.json \
  --input checkpointsJson='[{"name":"Indianapolis, IN","role":"start","lat":39.7684,"lon":-86.1581},{"name":"Kansas City, MO","role":"overnight-option-a","lat":39.0997,"lon":-94.5786},{"name":"Salina, KS","role":"overnight-option-b","lat":38.8403,"lon":-97.6114},{"name":"Denver, CO","role":"destination","lat":39.7392,"lon":-104.9903}]'
```

Wire this into a workflow on whatever cadence suits your route (a 2-5 minute
cron is typical) — the fingerprint check keeps output silent between
material changes.

## State

The default state file is:

```text
./state/road-trip-risk-watch.json
```

It stores the last fingerprint, route label, overall risk, and checkpoint
fingerprints so repeated runs can stay quiet when nothing changes.
