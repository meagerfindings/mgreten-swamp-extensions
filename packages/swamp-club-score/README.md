# Swamp Club Score

A read-only Swamp model that pulls a public Swamp Club profile snapshot for a
user (default: `mgreten`) and normalizes it into structured resources. It is
intended to be a small polling-friendly bridge between the public Swamp Club UI
and downstream dashboards such as Home Assistant.

## What it captures

- Current score / points
- Rank and tier
- Active-day and streak metadata
- Leaderboard rows from the public leaderboard lookup endpoint
- Top visible score buckets from the public profile breakdown

## Example use

```bash
swamp model @mgreten/swamp-club-score method run sync --input username=mgreten
```

```bash
swamp model output get swamp-club-score --json
```

## Intended use

This extension is meant to be polled periodically and then consumed by:

- Home Assistant sensors
- Pixel Watch-facing dashboards
- other Swamp workflows that need a compact score snapshot

## Example sensor shape

```yaml
sensor:
  - platform: rest
    name: Swamp Club Score
    resource: http://homeassistant.example.com:8123/api/swamp-club-score
```

## Notes

- Read-only; does not require issue creation or mutation rights.
- Uses the public profile page plus the public leaderboard lookup endpoint.
- The profile page also exposes per-day drilldowns in the browser after clicking
  a heatmap day; this model currently captures the summary fields and the
  highest-value visible categories.
- The model is safe to poll because it only fetches public data and writes
  structured resources under the Swamp model namespace.
