# @mgreten/storage-health

A [swamp](https://swamp.club) extension model for monitoring disk usage and
backup snapshot inventory. Inspects one or more mount points on the local
machine or any SSH-accessible host, and optionally inventories snapshot-style
backup directories. Each run produces typed, versioned artifacts — making it
easy to query health status over time, detect drift in backup retention, and
wire notifications when thresholds are breached.

## Installation

```bash
swamp extension pull @mgreten/storage-health
```

## Setup

Create a model instance. Use `sshHost=local` to inspect the machine where
swamp runs, or provide an SSH hostname for a remote target.

```bash
# Local machine — inspect root and two external drives
swamp model create @mgreten/storage-health my-storage \
  --global-arg sshHost=local \
  --global-arg mounts=/,/mnt/data,/mnt/backup \
  --global-arg warnPercent=75 \
  --global-arg criticalPercent=90 \
  --global-arg backupPaths=/mnt/backup/snapshots,/mnt/backup/docker \
  --global-arg backupKeepTarget=30

# Remote host
swamp model create @mgreten/storage-health remote-storage \
  --global-arg sshHost=myserver.example.com \
  --global-arg mounts=/,/srv/data
```

## Usage

### Scan mount points and backup directories

```bash
swamp model method run my-storage scan
```

Produces one `mountStatus` resource per mount, one `backupInventory` resource
per backup path, and one `storageReport` with the aggregate health status and
human-readable recommendations.

### Discover filesystems on the target host

```bash
swamp model method run my-storage listMounts
```

Lists all mounted filesystems — useful for deciding which mounts to pass as
`mounts` in your model configuration.

### Read the latest report

```bash
swamp model resource get my-storage storageReport
```

## Global Arguments

| Argument | Required | Default | Description |
|---|---|---|---|
| `sshHost` | no | `local` | SSH hostname or IP. Use `local` to run on the local machine. |
| `mounts` | no | `/` | Comma-separated mount paths to inspect. |
| `warnPercent` | no | `75` | Usage % that sets status to `warning`. |
| `criticalPercent` | no | `90` | Usage % that sets status to `critical`. |
| `backupPaths` | no | `` | Comma-separated directories containing timestamped snapshot subdirectories. |
| `backupKeepTarget` | no | `0` | Expected max snapshot count. `0` disables compliance checking. |

## Method: scan

Runs `df` on each configured mount and enumerates snapshot subdirectories in
each backup path. Writes typed resources for each result and an aggregate
`storageReport`.

No arguments.

**Output resources:** `mountStatus` (one per mount), `backupInventory` (one
per backup path), `storageReport` (aggregate).

## Method: listMounts

Runs `df -Pm` on the target host and returns a complete list of mounted
filesystems with their sizes and usage percentages.

No arguments.

**Output resource:** `mountList`

## Resource: storageReport

The `overallStatus` field is the worst of all mount and backup results:

- `ok` — all mounts below `warnPercent`, all backup paths compliant
- `warning` — at least one mount at or above `warnPercent`, or a backup path
  has more snapshots than `backupKeepTarget`
- `critical` — at least one mount at or above `criticalPercent`

The `recommendations` array contains human-readable action items for any
non-`ok` findings.

## How It Works

For local execution (`sshHost=local`), commands run via `/bin/sh -c` using
`Deno.Command`. For remote execution, commands run via `ssh -o BatchMode=yes`,
requiring key-based authentication with no passphrase prompt.

Mount inspection uses `df -Pm` (POSIX MiB output) for consistent parsing
across Linux distributions. Backup inventory enumerates subdirectories whose
names begin with `20` (matching `YYYY_MM_DD-HH_MM_SS` and `YYYY-MM-DD`
timestamp conventions).

## License

MIT — see LICENSE.txt for details.
