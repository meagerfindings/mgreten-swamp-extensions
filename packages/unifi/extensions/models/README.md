# @mgreten/unifi

Manage a Ubiquiti UniFi Dream Machine (UDM / UDM Pro / UDM SE) via the
**legacy Network API** — firewall groups, firewall rules, clients, PoE device
restarts, and networks — as first-class swamp models. Complements
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
| `@mgreten/unifi/client`         | Known clients and wired PoE devices    | `sync` (factory), `power-cycle-poe`  |
| `@mgreten/unifi/network`        | Configured networks (VLANs / subnets)  | `sync` (factory)                     |

## Authentication

All four models share a `globalArguments` schema (`host`, `username`,
`password`, optional `totpSecret`, and `site`). Use either a **local-only admin**
on the UDM or an MFA-enabled account with its TOTP secret. To create a local
account, go to **UniFi Console → Settings → Admins & Users → Add New Admin** and
enable "Restrict to local access only."

Store credentials in any swamp vault and reference them via CEL:

```yaml
globalArguments:
  host: 192.0.2.1
  username: ${{ vault.get(udm, username) }}
  password: ${{ vault.get(udm, password) }}
  site: default
```

### MFA-enabled accounts (TOTP)

Accounts with MFA enabled reject password-only logins with
`MFA_AUTH_REQUIRED`. Set the optional `totpSecret` global argument to the
account's base32 TOTP seed (the string behind the QR code shown at MFA
enrollment) and the extension derives the current code in-process at login —
no authenticator app in the loop, so methods stay runnable unattended:

```yaml
globalArguments:
  host: 192.0.2.1
  username: ${{ vault.get(udm, username) }}
  password: ${{ vault.get(udm, password) }}
  totpSecret: ${{ vault.get(udm, totp_secret) }}
  site: default
```

Local-only admin accounts bypass SSO MFA — omit `totpSecret` for those.

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

## Restart a PoE device

`power-cycle-poe` resolves the active wired client's current switch and port,
then asks UniFi to cycle that port's PoE power. It accepts a client name,
hostname, or MAC address (names are case-insensitive, and uniquely matching
camel-cased words may be reordered). The method rejects ambiguous names,
wireless clients, missing topology, non-PoE ports, uplinks, and ports with
multiple learned clients rather than risking the wrong port.

```bash
swamp model method run my-clients power-cycle-poe \
  --input device=front-door-camera
```

For a device whose physical topology should not change, pin the expected switch
and port as additional assertions:

```bash
swamp model method run my-clients power-cycle-poe \
  --input device=front-door-camera \
  --input expectedSwitch='Example PoE Switch' \
  --input expectedPort=7
```

This briefly removes power from the resolved switch port and will interrupt any
device connected to it. Each controller-accepted command is recorded as a
`power_cycle` data artifact with the client, switch, port, controller response,
and acknowledgment timestamp. Acceptance does not independently prove physical
power loss or completion; verify the device reconnects when that distinction
matters.

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
