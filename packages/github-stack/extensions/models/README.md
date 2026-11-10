# @mgreten/github-stack

A [swamp](https://swamp.club) model for the composition lifecycle of a GitHub
stack: native stacked pull requests, grouped with the
[`gh stack`](https://github.github.com/gh-stack/) CLI extension. It is the
GitHub-stacks counterpart of `@mgreten/graphite-stack`, which keeps using
Graphite (`gt`).

A stack is an ordered, strictly **linear** chain of PR units — each unit is exactly one commit ahead of
its declared parent — plus a composed head the whole stack validates against.
The single-commit / single-PR contract is kept **per unit**, so a stack of N
units is N commits, each on its own branch and its own draft PR. A length-1
stack degenerates cleanly to an ordinary single-PR flow.

Its defining invariant: every base relation is a declared **field**
(`baseUnit`), never inferred from a stack tool's view or a branch-name
convention. Live parentage is always read from `git` and compared against the
declared plan — it is never trusted from `gh stack`'s own view. That is what lets the model reject a
drifted, collapsed, or non-linear stack instead of silently shipping it.

## Installation

```sh
swamp extension pull @mgreten/github-stack
```

## Setup

Create a model instance. The only global argument is the repository base branch
used when a `submitStack` call does not pass one explicitly:

```sh
swamp model create github-stack \
  --type @mgreten/github-stack \
  --global-arg defaultBaseBranch=main
```

## Usage

Drive one stack through its lifecycle by its path-safe `stack` identifier.
Validate the plan, finalize each unit's commit, restack after a lower-unit
patch, validate the composed head, then submit:

```sh
# 1. Validate + persist a declared linear plan
swamp model method run github-stack validateStackPlan \
  --arg stack=feature-x \
  --arg-json plan='{"baseBranch":"main","policyVersion":"1","units":[...]}'

# 2. Assert unit 0 is exactly one commit ahead of the repo base
swamp model method run github-stack finalizeStackUnitCommit \
  --arg stack=feature-x --arg index=0 \
  --arg repoPath=/abs/path/to/repo \
  --arg unitBaseSha=<40-char-sha> \
  --arg expectedBranch=feature-x-0 --arg baseBranch=main

# 3. Cascade a restack after patching a lower unit
swamp model method run github-stack restackAbove \
  --arg stack=feature-x --arg patchedIndex=0 \
  --arg repoPath=/abs/path/to/repo \
  --arg-json plan='{...}'

# 4. Pin the composed head over the ordered tips
swamp model method run github-stack validateComposedHead \
  --arg stack=feature-x --arg repoPath=/abs/path/to/repo \
  --arg-json plan='{...}' --arg-json unitTipShas='["<sha0>","<sha1>"]'

# 5. Submit gated, idempotent, ordered draft PRs
swamp model method run github-stack submitStack \
  --arg stack=feature-x --arg repoPath=/abs/path/to/repo \
  --arg baseBranch=main --arg-json plan='{...}' \
  --arg-json unitTipShas='["<sha0>","<sha1>"]'
```

## Global Arguments

| Argument            | Type   | Default | Description                                                          |
| ------------------- | ------ | ------- | -------------------------------------------------------------------- |
| `defaultBaseBranch` | string | `main`  | Repo base branch used when `submitStack` receives no `baseBranch`.   |

## Method: validateStackPlan

Validates a declared plan and persists it as `stack-plan-<stack>`. Enforces a
strict linear chain and a complete, non-overlapping acceptance-criterion
partition. Throws and writes nothing on any inferred, cyclic, gapped, or
duplicate ordering, or a criterion assigned to two units or to none.

| Argument | Type      | Description                                        |
| -------- | --------- | -------------------------------------------------- |
| `stack`  | string    | Path-safe stack identifier; names all records.     |
| `plan`   | StackPlan | The declared base branch plus ordered linear units.|

## Method: finalizeStackUnitCommit

Asserts one unit is clean, parented on its declared base, and exactly one commit
ahead, then persists `stack-unit-<stack>-<index>` evidence pinned to the unit's
base and head SHA. Fails closed on a multi-commit unit or a wrong parent.

| Argument         | Type   | Description                                          |
| ---------------- | ------ | ---------------------------------------------------- |
| `stack`          | string | Stack identifier.                                    |
| `index`          | number | Zero-based unit index.                               |
| `repoPath`       | string | Absolute path to the working tree.                   |
| `unitBaseSha`    | string | Full 40-char SHA of the unit's declared parent head. |
| `expectedBranch` | string | Branch the unit must be checked out on.              |
| `baseBranch`     | string | Human-readable base branch recorded on the evidence. |

## Method: restackAbove

Rebases every unit above a patched unit onto its new parent head via
`git rebase --onto`, asserts each stays exactly one commit ahead and linear,
and records a `stack-restack-<stack>` audit trail marking every affected unit
stale so its evidence is regenerated. The cascade is bounded by the unit count.

| Argument       | Type      | Description                             |
| -------------- | --------- | --------------------------------------- |
| `stack`        | string    | Stack identifier.                       |
| `patchedIndex` | number    | Index of the unit whose commit changed. |
| `plan`         | StackPlan | The declared linear plan.               |
| `repoPath`     | string    | Absolute path to the working tree.      |

## Method: validateComposedHead

Asserts the live stack is linear and each unit's actual parent matches the
declared plan (read from git, never a stack tool's view), then pins the composed head and
the ordered per-unit tips into `composed-head-validation-<stack>`. Rejects any
mixed or stale SHA.

| Argument      | Type      | Description                                     |
| ------------- | --------- | ----------------------------------------------- |
| `stack`       | string    | Stack identifier.                               |
| `plan`        | StackPlan | The declared linear plan.                       |
| `repoPath`    | string    | Absolute path to the working tree.              |
| `unitTipShas` | string[]  | Ordered per-unit tip SHAs (bottom-up).          |

## Method: submitStack

Submits the stack bottom-up as gated, idempotent, ordered draft PRs:
each unit's parent comes from the declared plan. A conforming open draft PR is
reused if one exists (no duplicate on resume); otherwise the exact validated tip
is pushed with `git push --force-with-lease` (pinned to the remote SHA observed
just before) and `gh pr create --draft --base <parent> --head <branch>` opens
the PR, or `gh pr edit --base` retargets an existing one. Each resulting PR's
head/base/draft state is then verified. With two or more units, the verified
PRs are grouped bottom-up as one GitHub stack with
`gh stack link --base <base> --remote origin <pr...>` (additive and idempotent). Persists per-unit `stack-draft-pr-*`
records and a composed `stack-draft-prs-<stack>`, and fails via a collapse guard
unless the submitted-or-reused PR count equals the declared unit count.

| Argument      | Type      | Default | Description                                     |
| ------------- | --------- | ------- | ----------------------------------------------- |
| `stack`       | string    | —       | Stack identifier.                               |
| `repoPath`    | string    | —       | Absolute path to the working tree.              |
| `baseBranch`  | string    | `main`  | Repo base branch for the bottom unit.           |
| `plan`        | StackPlan | —       | The declared linear plan.                       |
| `unitTipShas` | string[]  | —       | Ordered per-unit tip SHAs (bottom-up).          |

## How It Works

The model shells out to two pure CLIs — `git` and `gh` (GitHub, with the
`gh stack` extension) — always non-interactively, and stores structured records
via swamp's resource model. It does no issue-tracker reconciliation and holds
no service credentials; authentication is whatever `git` and `gh` already have
configured in the working tree. It never runs `gh stack submit`, `sync`, or any
interactive `gh stack` command: stack membership lives on GitHub (each PR's
base is the layer below), so plain pushes keep the stack intact.

Parentage is always the ground truth: it is read from `git` (`rev-parse`,
`rev-list --count`, `HEAD^`) and compared against the declared plan. Restacks
use `git rebase --onto <newBase> <oldBase> <branch>` so they are deterministic
and independent of any stack tool, and a failed rebase is aborted so
the worktree is left clean. Submission is idempotent: a conforming open draft PR
found via `gh pr list --head <branch>` is reused rather than re-created, so a
re-run after an interruption submits only the missing units.

**Prerequisites:** a working `git` repository with the stack branches present,
an `origin` remote, an authenticated `gh` CLI with the `gh stack` extension
(`gh extension install github/gh-stack`) on `PATH` for `submitStack`, and
stacked PRs enabled on the GitHub repository.

## License

MIT — see LICENSE for details.
