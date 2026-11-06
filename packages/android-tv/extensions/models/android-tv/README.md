# Android TV Diagnostics and Gated Cleanup

An independently written Swamp model for bounded identification and inventory of
Android TV devices, plus narrowly scoped, approval-gated package cleanup and
recovery methods. The project targets the Sony BRAVIA Android 7 generation as an
interoperability use case; it does not include Sony code or assets and is not
affiliated with or endorsed by Sony.

## Current scope

The model exposes read methods and four explicit cleanup operations:

- **`identifySony`** validates an IPv4 host and sends one fixed HTTP POST to
  `http://<host>/sony/system` using Sony's public
  [`getInterfaceInformation` v1.0 reference](https://pro-bravia.sony.net/remote-display-control/rest-api/reference/).
  It bounds the response, rejects HTTP and JSON-RPC errors (including errors in
  HTTP 200 responses), and validates the five returned interface fields. The
  Sony `modelName` is the retail identity; it is not inferred from Android's
  separate `ro.product.model` property.
- **`checkAdbVersion`** invokes only the locally configured ADB executable with
  the `version` argument. It does not query devices. The executable path is a
  local configuration input; keep that configuration and associated Swamp run
  records private. No machine-specific path is included in the published files.
- **`inventory`** accepts only an explicit IPv4 `host:port` target that is
  already connected to ADB, and requires `hostServerReviewed: true` to record
  the operator's separate authorization/review of the host-server lifecycle. It
  runs a fixed sequence of reads, each selected with `adb -s <exact-host:port>`:
  five named build/model/API properties, enabled and disabled user-0 package
  lists, `/proc/meminfo`, and `df -k /data`. It writes only parsed values to the
  inventory resource; the target address and raw command output are not fields
  in that resource payload. Swamp may retain method inputs and global
  configuration in local definitions or execution records, so the target,
  `adbBinary`, and related records must be treated as private.
- **`prepareCleanup`**, **`applyCleanup`**, **`verifyCleanup`**, and
  **`restoreCleanup`** implement a one-active-plan, per-package flow. A caller
  privately selects at most three package names for a plan and supplies exact
  target/build approval; that selected set is the plan's complete package
  allowlist, not a recommendation. No per-TV candidate list is embedded in the
  distributable source. Built-in protected categories and live Home, Settings,
  TV-input and input-method roles cannot be overridden by caller selection.
  Shared-UID, persistent, and reserved system-UID packages are rejected; the
  SYSTEM flag alone is not a blanket rejection. Each `applyCleanup` invocation
  targets exactly one user-0 package from the immutable baseline.

The inventory deliberately omits full `getprop`, package-manager dumps,
`dumpsys`, logs, users, accounts, device owners, MAC addresses, serials,
root-path searches, and unrelated filesystem or application data. A missing,
malformed, oversized, timed-out, or failed response is an error; it is never
converted into a successful empty inventory. Outputs have bounded schemas and
seven-day retention for device inventory. Cleanup baselines, plans and journals
are separate private Swamp resources with infinite lifecycle and a
10,000-version retention cap, independent of inventory's seven-day policy.

## Safety and readiness boundary

One live, read-only validation has completed on an owner-authorized Sony BRAVIA
running Android 7.0 / API 24. Through Swamp, `identifySony` and `inventory`
succeeded after ADB authorization, and a targeted state check confirmed an
authorized device session. This complements the synthetic contract checks. No
app installation/disablement, firmware or TV setting change, cleanup, or restore
was performed during that read-only validation. This is a single-device
interoperability sample, not a general compatibility guarantee; cleanup and
restore have not been validated on a live TV.

Separately, the cleanup implementation received a focused independent review,
and its isolated contract suite passed 27/27 tests. Those tests use a synthetic
command runner and resource store; they do not verify the real Swamp persistence
adapter or Sony firmware. During development, two live apply attempts changed
package state but returned an error because their Swamp output repeated handle
names. That output-handle defect is fixed and covered by a regression test, but
the corrected apply path and live restore have not been exercised. Treat cleanup
as experimental: a mutation error does not prove the TV was unchanged. Read back
device state before considering any retry, and review each selected package for
the features you need to preserve.

The extension itself does not implement ADB connect, pair, TCP/IP enablement, or
server start/stop. For the one live read-only validation, a private fixed
`command/shell` Swamp behavior orchestrated the ADB connect; it is not a public
extension method and is not included in this package. The first ADB connect
process returned exit code 0 even though its output reported authentication
failure. Do not infer an authorized session from the process exit code alone;
check a targeted device state before running inventory. The device owner
approved the TV authorization prompt before the read-only inventory and Sony
identity request proceeded.

**Every ADB method run requires a separate review and authorization of the ADB
host-server lifecycle.** The required `hostServerReviewed: true` argument
records that review; it does not check whether a server is running or
compatible. Ordinary ADB client operations may start the local server, and the
client can kill/restart it after a protocol-version mismatch. A `-H` host
selection alone is not a no-restart guarantee. The inventory method does not
start or restart a server explicitly, but it cannot prevent ADB client behavior
from doing so. The one live validation does not remove this per-run review
requirement or establish a no-side-effects guarantee for the host server.

The fixed command forms have been exercised once on an Android 7 / API 24 Sony
BRAVIA, but that does not establish compatibility across the generation.
Android's `ro.product.model` is retained as the generic Android property and
must not be presented as Sony's retail model. Package state reads are separate,
so a concurrently changing device is not a transactional snapshot. Inventory may
expose installed package names and build details. Package presence does not
prove playback, DRM or service availability, and this validation did not verify
which Home activity is selected. Swamp may retain definitions and execution
inputs outside the resource payload; keep local runtime records and model
configuration private.

## Cleanup contract and limitations

Cleanup changes only an Android package's user-0 enabled-state setting. The plan
binds the exact IPv4 target and observed Android 7/API 24 build; that pair is
not a globally unique physical-device identity, so a same-model replacement at
the same address cannot be ruled out by the binding alone. A fresh matching
approval is required for each selected package operation. Package dumps and role
checks are narrowly scoped and bounded. A selected-package dump can contain
other-user state and shared-user details; the parser uses the active package
block, discards unrelated fields, and persists only selected package state. Raw
output, other-user fields, owners and device-wide package lists are not
persisted. The local Swamp definition, method inputs, run records and recovery
resources can still contain private package names and target details and must
remain private.

The `approval` inputs are exact-match operation guards; they are not an
interactive prompt, cryptographic authorization, or proof that a person reviewed
the package. Operator review must happen separately before invoking a mutating
method. The caller's private selected package set is capped at three, and each
later operation must name a package in that immutable baseline.

Swamp's explicit `kind: "update"` methods serialize against runs of the same
behavior definition. They do not lock out another definition/process, manual
ADB, or other software. Observable build, package version/UID/flags and enabled
state drift is checked; an invisible intervening change cannot be prevented or
necessarily detected. Android 7 package changes can broadcast package-change
events and affect running processes, so restoring a numeric state is not a full
rollback of those side effects.

The immutable baseline records each selected package's exact original numeric
state and package identity before any apply. The immutable baseline and the
durable plan/pointer use Swamp resources with infinite lifecycle and a
10,000-version cap, separate from the short-lived inventory. An apply intent is
persisted before the fixed `pm disable-user --user 0 PACKAGE` command;
read-back, not process exit code, determines the outcome. A timeout or error may
have an unknown result and is never blindly retried. Restore reads the named
baseline version and latest journal pointer through Swamp, requires fresh
build/package/state checks, and restores only an attempted package: original
state `0` uses `pm default-state`, state `1` uses `pm enable`, and pre-existing
state `3` remains disabled. States `2` and `4`, absent or ambiguous packages,
drift, and inconclusive role checks are blocked rather than mapped to a generic
restore command. There is no enable-all fallback or automatic deletion of
recovery data. A prior uncertain restore requires a fresh read and explicit
retry approval.

The Android 7 package-manager contract permits shell transitions only among
default state `0`, enabled state `1`, and disabled-user state `3`; this model
uses only the matching fixed operations and refuses states `2` or `4`. A
targeted dump can include a hidden factory copy of an updated system app; only
the uniquely parsed block under the active `Packages:` section is considered,
never a matching `Hidden system packages:` block. The relevant AOSP source is
linked for reference:
[`pm` command](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-7.0.0_r1/cmds/pm/src/com/android/commands/pm/Pm.java#L1177-L1223),
[`package` queries](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-7.0.0_r1/services/core/java/com/android/server/pm/PackageManagerShellCommand.java#L810-L952),
[`dumpsys` package output](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-7.0.0_r1/services/core/java/com/android/server/pm/Settings.java#L4340-L4670),
and
[state-transition checks](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-7.0.0_r1/services/core/java/com/android/server/pm/PackageManagerService.java#L17672-L17865).

Baseline, plan, and pointer writes are separate Swamp writes, not an atomic
transaction. A failed preparation can leave immutable orphan recovery records;
no device command runs until the baseline, plan, and active pointer have been
written. Recovery records are not automatically deleted and a plan is not closed
after a disable; Swamp retains the latest versions indefinitely and up to 10,000
versions of history. The finite version cap is a recovery-history limit, not a
7-day expiry. `kind: "update"` is the same-definition serialization boundary,
not a global lease or lock against another process or manual ADB user.

The operation is intentionally one package at a time so a person can inspect
Home, Settings and inputs between invocations. It does not claim to preserve
every app-specific feature or guarantee speed/casting improvement. Mat's
required preservation boundary is TV settings and menus, Chromecast, PBS KIDS,
Prime Video, stock Home, inputs, CEC and remote functions; protected categories
cannot be overridden, and a candidate is never inferred from a community list.
The code adds no AirPlay receiver or launcher change.

The cleanup review and isolated contract tests are source-level evidence, not
verification of a corrected live apply or restore against Swamp and Sony
firmware. The mutation methods remain experimental; read back device state after
any error, and do not infer general compatibility from the single read-only
Android 7/API 24 validation.

AirPlay receiver evaluation remains a later, separate decision; this model does
not add AirPlay support or make any compatibility claim.

## Local setup

Use the standard Swamp model configuration. Set the global `adbBinary` value to
the executable chosen by the operator before invoking either ADB method; do not
put a machine-specific executable path in tracked configuration. Sony
identification does not require ADB. Example network identities in the tests use
RFC 5737 documentation-only IPv4 addresses.

The following snippets are illustrative only. `192.0.2.10` belongs to a
documentation-only network and is not a real device address; the inventory
method should not be invoked until its separate host-server review is complete.

Example local global arguments:

```json
{
  "adbBinary": "/path/to/locally-selected/adb",
  "commandTimeoutMs": 10000,
  "sonyTimeoutMs": 8000
}
```

Example Sony identification input:

```json
{
  "host": "192.0.2.10"
}
```

The canonical public source is the
[`@mgreten` extensions monorepo](https://github.com/meagerfindings/mgreten-swamp-extensions).
Original code is MIT-licensed; see [`LICENSE`](LICENSE). The public beta can be
installed with:

```sh
swamp extension pull @mgreten/android-tv --channel beta
```

## Related projects and attribution

These links identify related projects considered during design, not source
material redistributed here. This adapter was written independently; it does not
copy their code, package lists, classification data, scripts, APKs, SDKs, fonts,
icons, or other assets. No endorsement is implied.

- Mat's
  [CleanYourTV fork at `fc148d5`](https://github.com/meagerfindings/cleanyourtv/commit/fc148d5a9707b30e8f49f489625947421740dc55)
  and
  [Gathin23's upstream at `3c122bc`](https://github.com/Gathin23/cleanyourtv/commit/3c122bc073f7a9a83de251621e6e31d90dd96109)
  are related cleanup projects. The upstream carries its own MIT notice; no code
  from either is included here.
- [johnsontsai11's legacy CleanYourTV fork at `7bb0b33`](https://github.com/johnsontsai11/cleanyourtv-legacy/commit/7bb0b33a733ea04bb3074cc4a35234d6bc0ce9cd)
  is noted as related Android 7 work; no legacy-fork code or assets are
  included.
- The broader Swamp Android package `@shrug/android` was reviewed at source
  revision `7fe60ab4a3330b108207c5df2f7c1370fa64b818`. Its broader
  package/device collection does not match this adapter's minimal-data/API-24
  contract. No package code or classification data is included.
- [jqssun's Android AirPlay server at `a46cca0`](https://github.com/jqssun/android-airplay-server/commit/a46cca0a6a1274e9e33c0e750f0f1c1eb1d881ea)
  is a separate GPLv3 project with separately licensed native dependencies. It
  is mentioned only as related work; no code or APK is included.

Sony documentation is linked for interoperability reference only. Sony's
[Terms of Use](https://pro-bravia.sony.net/terms-of-use) govern its site
materials; this project links to the documentation and does not reproduce its
text, sample code, branding, or supplied software. The site terms do not by
themselves establish whether independently written API use is permitted or
prohibited. This project makes no legal conclusion on that question.

## License

Original code in this repository is licensed under the MIT License in
[`LICENSE`](LICENSE). Related-project references above do not change that
license because no third-party project code or assets are redistributed.
