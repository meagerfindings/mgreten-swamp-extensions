# @mgreten/release-adoption

Deterministic release-adoption campaigns for swamp fleets. The model captures
GitHub release notes and machine-readable CLI surfaces, computes command and
option changes, inventories local swamp repositories with isolated failures,
and maintains an agent-writable ledger of adoption proposals and outcomes. A
companion method report summarizes the latest campaign, release bodies, surface
diff, fleet counts, and opportunities grouped by status.

## Install

```sh
swamp extension pull @mgreten/release-adoption
```

`gh` must be installed and authenticated for release-note capture. `swamp` must
be on PATH for CLI surface capture. Pre-flight checks validate these dependencies
only for the methods that use them. Inventory reads the repository paths in
`fleetRepos`; a missing or malformed repository is represented as a failed row
without aborting the rest of the fleet.

## Example

```sh
swamp model create @mgreten/release-adoption adoption \
  --global-arg 'fleetRepos=[{"name":"app","path":"/srv/app"}]'
swamp model method run adoption open-campaign --input id=july \
  --input fromVersion=20260720.000000.0 --input toVersion=20260727.000000.0
swamp model method run adoption inventory-fleet --input campaignId=july
swamp model method run adoption close-campaign --input campaignId=july \
  --input outcome="Adoption work completed"
```

Campaign and ledger resources are retained indefinitely with bounded history;
fleet inventory expires after 90 days. See the repository-level README for the
complete method sequence and resource details. `close-campaign` refuses to
complete while proposed opportunities remain; completed campaign ledgers are
immutable and repeated close calls are safe no-ops.

## License

MIT — see LICENSE.
