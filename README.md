# swamp-extensions (@mgreten, public)

Pilot monorepo for Mat's public `@mgreten` swamp extensions. Source: https://github.com/meagerfindings/mgreten-swamp-extensions

```text
catalog.yaml                 # schemaVersion 1, visibility public, scope @mgreten: what may publish
deno.json / deno.lock        # one pinned dependency set for tools and every package
packages/<short>/            # one package per dir, history imported from its source repo
  extensions/models/...      # same layout as the source; manifest paths resolve unchanged
tools/
  sources.yaml               # pinned source URL, commit, and paths per package
  import-package.ts          # history-preserving import + privacy scan + catalog entry
  privacy-scan.ts            # full-history scan; redacted hits (rule, path, commit, fingerprint)
  privacy-rules.json         # pinned regex rule set (gitleaks also runs when installed)
  privacy-allowlist.json     # reviewed false positives, by rule + path + fingerprint
  gate.ts                    # gate steps, fan-out over catalog.yaml
  lib/calver.ts              # content-hash CalVer decision (tested in calver_test.ts)
extensions/models/ext_gate.ts     # @mgreten/ext-gate model (one method per gate step)
extensions/models/ext_publish.ts  # @mgreten/ext-publish model (tools/publish.ts)
workflows/workflow-ext-gate.yaml     # gate only
workflows/workflow-ext-release.yaml  # gate + publish + deduped ntfy; extPublishEnabled tag
```

## Commands

```sh
deno task import <short> [--state-dir /tmp/ext-import] [--mailmap <private file>]
deno task scan --repo . --path packages/<short>
swamp workflow run ext-gate --input today=YYYY-MM-DD    # or: deno task gate all --today YYYY-MM-DD
deno task test:tools
```

Import is idempotent per pinned ref and never touches a source checkout: it fetches the
pinned commit into a cache repo, filters a fresh staging copy with git filter-repo, scans
the full filtered history, and merges only when clean. `--mailmap` rewrites commit
identities during the filter; keep that file outside this repo.

The gate is read-only. Its dry-run step only runs `swamp extension push --dry-run`.

`ext-release` runs the gate, then ext-publish. While the workflow's `extPublishEnabled`
tag is `'false'` (default) publish applies each due version bump in a throwaway worktree
and only runs `push --dry-run`. With it `'true'` (activation A7) publish commits the bump,
pushes, and verifies the registry's latest version and repository. Already-published
versions are no-ops. An unknown push outcome halts every later run until the registry
shows the version or a human reruns with `--input clearUnknown=true`; nothing retries.
The ntfy URL lives in the local `ntfy` vault (`swamp vault put ntfy url`), not in git.
