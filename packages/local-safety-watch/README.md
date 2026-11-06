# Local Safety Watch

`@mgreten/local-safety-watch` is a Swamp model for frequent, quiet monitoring of official local safety sources.

It currently supports:

- National Weather Service active alerts
- Colorado official road closures and critical road reports through COtrip
- InciWeb active wildfire incidents

The model emits output only for a new, materially updated, escalated, or cleared event. It uses an at-least-once pending outbox so a failed output write is retried rather than silently lost.

## Privacy boundary

This extension does **not** include real locations, addresses, user/device names, state paths, cron jobs, Home Assistant access, or Discord delivery.

Callers supply checkpoints as method inputs at run time. Checkpoint labels are deliberately restricted to neutral logical identifiers such as `home`, `phone-1`, or `local-area-1`. Persisted state and rendered digests retain only these controlled labels, a coarse distance bucket, a category-level display summary, and opaque source identity hashes.

Keep your checkpoint JSON, state path, Home Assistant integration, scheduler, and delivery integration in private deployment configuration. Never commit generated state or output.

## Usage

Create a model instance and configure only non-sensitive global source settings. Invoke `collect` with private runtime arguments:

```text
checkpointsJson: <private JSON array of neutral labels, coordinates, and radii>
statePath: <private local state path>
forcePoll: false
```

Run the model from your own scheduler. The scheduler should deliver stdout or the generated digest only when the model emits a change.

```text
Private deployment boundary
- phone/location acquisition: private
- property anchor and state path: private
- notification delivery and cron schedule: private
- model source, tests, and generic documentation: publishable
```

## Source behavior

- NWS is eligible every two minutes.
- COtrip is eligible every two minutes.
- InciWeb is throttled to a longer interval because wildfire feed data changes less frequently.
- A provider failure never clears an active event.
- An event must be absent from two successful authoritative polls before it clears.
- NWS digests include a sanitized summary of the official alert description.

## Scope

This package is a generic source-normalization and event-lifecycle model. Private location acquisition, notification routing, local state retention policy, and scheduling are intentionally outside the extension.
