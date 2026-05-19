# @mgreten/docker-orphan-sweep

Find and remove orphaned Docker Compose containers whose git worktree directory
no longer exists. Cross-references live compose projects against git worktree
paths. Works with any repository that uses git worktrees alongside per-branch
Docker Compose stacks.

## Installation

```bash
swamp extension pull @mgreten/docker-orphan-sweep
```

## Global Arguments

| Argument          | Type   | Default | Description                                                                 |
|-------------------|--------|---------|-----------------------------------------------------------------------------|
| `repoPath`        | string | `"."`   | Path to the git repository that manages worktrees.                          |
| `containerPrefix` | string | —       | Optional prefix filter for docker container names. Omit to scan all containers. |

## Methods

### scan

Discover all Docker Compose projects on the host, cross-reference each against
git worktrees in the configured repo, and report which containers are orphaned
(their worktree directory no longer exists).

```bash
swamp model method run my-sweep scan
```

The output includes the total compose projects found, the number of live git
worktrees, and a detailed list of every orphaned container with its expected
worktree path.

### sweep

Remove orphaned containers. Defaults to `dryRun: true` for safety so you can
preview what would be removed before committing to the cleanup.

Preview orphans (safe, no containers removed):

```bash
swamp model method run my-sweep sweep
```

Actually remove orphans:

```bash
swamp model method run my-sweep sweep --args '{"dryRun": false}'
```

The output includes counts for orphans found, containers removed, and any
errors encountered, plus per-container details.

## Matching Heuristic

The model uses this strategy to determine if a container is orphaned:

1. List all Docker containers (optionally filtered by `containerPrefix`).
2. Derive the compose project name from each container by stripping the
   Docker Compose service-index suffix (e.g., `my_feature-web-1` becomes
   `my_feature`).
3. Convert the project name from underscore-separated to hyphen-separated
   to get a candidate worktree directory name (`my_feature` becomes
   `my-feature`).
4. Look for that directory in the worktree parent directory (one level above
   `repoPath`).
5. Cross-reference against `git worktree list --porcelain` output.
6. If the directory does not appear in the live worktree list, the container
   is considered orphaned.

## Common Use Cases

**Post-PR-merge cleanup** — After merging a branch and removing the worktree
with `git worktree remove`, run a sweep to clean up the leftover Docker
containers:

```bash
swamp model method run my-sweep sweep --args '{"dryRun": false}'
```

**Scheduled health check** — Use a swamp workflow or cron job to run `scan`
periodically and alert when orphan count exceeds a threshold.

**CI pipeline cleanup** — In CI environments that spin up worktree-based
Docker stacks per branch, add a sweep step at the end of each pipeline to
prevent container sprawl.

## License

MIT — see [LICENSE.txt](LICENSE.txt).
