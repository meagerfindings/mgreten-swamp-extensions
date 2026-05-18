# @mgreten/unifi

Manage a Ubiquiti UniFi Dream Machine (UDM / UDM Pro / UDM SE) via the
**legacy Network firewall API** — firewall groups, firewall rules, clients,
and networks — as first-class swamp models. Complements
[`@stack72/ubiquity`](https://github.com/stack72/swamp-ubiquity) (which focuses
on traffic collection) by enabling configuration-as-data workflows.

This extension was built to solve a concrete homelab problem: blocking a fleet
of IP cameras from reaching the internet while preserving their access to local
NVR, NTP, and Home Assistant — without clicking through the UniFi web UI for
every change. The same primitives work for any UniFi configuration task that
the legacy Network API exposes.

## Models

| Type                            | Purpose                                | Key methods                          |
| ------------------------------- | -------------------------------------- | ------------------------------------ |
| `@mgreten/unifi/firewall-group` | IPv4/IPv6 address and port groups      | `sync` (factory), `set-members`      |
| `@mgreten/unifi/firewall-rule`  | LAN/WAN/GUEST firewall rules           | `sync`, `create`, `delete`, `toggle-enabled` |
| `@mgreten/unifi/client`         | Known clients (active + configured)    | `sync` (factory)                     |
| `@mgreten/unifi/network`        | Configured networks (VLANs / subnets)  | `sync` (factory)                     |

## Authentication

All four models share a `globalArguments` schema (`host`, `username`,
`password`, `site`). A **local-only admin** on the UDM is required — Ubiquiti
Cloud accounts cannot authenticate against the local API. Create one under
**UniFi Console → Settings → Admins & Users → Add New Admin** with
"Restrict to local access only" enabled.

Store credentials in any swamp vault and reference them via CEL:

```yaml
globalArguments:
  host: 192.0.2.1
  username: ${{ vault.get(udm, username) }}
  password: ${{ vault.get(udm, password) }}
  site: default
```

## Quickstart

```bash
# 1. Store credentials
swamp vault create local_encryption udm
echo "$ADMIN_USER" | swamp vault put udm username
echo "$ADMIN_PASS" | swamp vault put udm password

# 2. Create a model instance for firewall groups
swamp model create '@mgreten/unifi/firewall-group' my-groups \
  --global-arg host=192.0.2.1 \
  --global-arg 'username=${{ vault.get(udm, username) }}' \
  --global-arg 'password=${{ vault.get(udm, password) }}' \
  --global-arg site=default

# 3. Sync existing groups from the UDM
swamp model method run my-groups sync

# 4. Reconcile a group's membership (full-replacement)
swamp model method run my-groups set-members \
  --input name='IP Cameras' \
  --input 'members:json=["192.0.2.22","192.0.2.23"]'
```

## TLS notes

UDM controllers ship with a self-signed certificate. Deno's `fetch` cannot
skip TLS verification, so this extension shells out to `curl -sk` for every
request. `curl` must be on `PATH` (default on macOS and most Linux distros).

## Status

Built and field-tested against a UDM Pro running UniFi Network 8.x.
Not yet exercised against UDM SE or the newer Unified Console (UC) line —
PRs welcome.

## License

MIT — see [LICENSE](LICENSE.txt).
