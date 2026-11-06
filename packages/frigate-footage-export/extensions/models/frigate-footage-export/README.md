# @mgreten/frigate-footage-export

Typed, dry-run-first access to the [Frigate](https://frigate.video/) API for:

- locating **event metadata** by time, camera, label, and clip status;
- inspecting a camera’s **recording availability** before exporting; and
- creating a **named server-side export per camera** for an arbitrary time range.

It does not download clips or video to the machine that runs Swamp. Frigate owns
export rendering and storage.

## Setup

Create an instance with an API root that includes `/api`. If authentication is
enabled, provide the bearer token through a vault expression.

```bash
swamp model create @mgreten/frigate-footage-export frigate-exports \
  --global-arg apiBaseUrl=https://frigate.example.com/api \
  --global-arg 'apiToken=${{ vault.get(camera-secrets, FRIGATE_API_TOKEN) }}'
```

## Camera groups stay local

The published model accepts explicit camera IDs only. Keep names such as
`house`, `shop`, or `driveway` in a private Swamp model/workflow input that
expands a group to its cameras. This prevents topology leakage while allowing a
local workflow to compose this model with Home Assistant context.

## Typical flow

1. Query events (metadata only):

```bash
swamp model method run frigate-exports listEvents \
  --input after=1760000000 --input before=1760001200 \
  --input 'labels:json=["person","car"]' --input requireClip=true
```

2. Inspect recording coverage, then prepare a named export plan:

```bash
swamp model method run frigate-exports inspectRecordings \
  --input camera=driveway --input after=1760000000 --input before=1760001200

swamp model method run frigate-exports planExports \
  --input topic="delivery review" \
  --input 'cameras:json=["driveway","front"]' \
  --input startTime=1760000000 --input endTime=1760001200
```

3. Read the generated `exportPlan` data artifact and pass it to `createExports`.
The method defaults to `dryRun=true`. Only set `dryRun=false` after reviewing
the plan; this creates persistent exports inside Frigate.

## Notes

- `listEvents` uses Frigate’s documented comma-delimited `cameras` and `labels`
  query convention; validate it against older Frigate versions if needed.
- A large or multi-camera export can take time. `createExports` records Frigate’s
  immediate response; use Frigate’s export listing/UI to watch completion.
- No automatic schedule is included. This avoids surprise footage generation or
  duplicate exports.
