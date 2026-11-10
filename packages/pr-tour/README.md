# @mgreten/pr-tour

Turn a GitHub pull request into a guided code tour, in the spirit of
Graphite's Code Tours. An agent reads the PR in a read-only checkout and orders
its real diff hunks into 4 to 10 narrated stops that follow the change's logic
rather than its file order: where the behavior starts, the rule it relies on,
each place that uses it, and the tests that prove it. One file, and even one
hunk, can be split across several stops. Lockfiles, generated files, and
mechanical edits go to a skim bucket.

The agent never writes code. Plain code fetches the PR and splits the diff into
numbered hunks; the agent only chooses line ranges and writes the prose. A
validator checks that every line of every hunk is placed exactly once and
retries the agent once with the problems listed, so the diff a reviewer reads
on a tour is always the real one.

The bundled report writes each tour as one self-contained HTML page: narrative
pinned on the left, diff pieces on the right, review checks that jump to the
lines they mean, `j`/`k` navigation, and reviewed stops remembered per head
SHA. It ships a Synthwave '84 dark theme and a GitHub-style light theme, and
every color and font is a setting.

To get tours working in your browser from scratch, follow [SETUP.md](SETUP.md).
It is written so an agent can follow it end to end.

## Installation

```bash
swamp extension pull @mgreten/pr-tour
swamp extension pull @mgreten/cli-agent
```

The extension contains the `@mgreten/pr-tour` model, the
`@mgreten/pr-tour-report` report, and the `@mgreten/pr-tour` workflow.

## Setup

Create an `@mgreten/cli-agent` instance named `cli-agent`, then a
`@mgreten/pr-tour` instance named `pr-tour` (the `@mgreten/pr-tour` workflow
runs the instance with that name):

```bash
swamp model create @mgreten/cli-agent cli-agent
swamp model create @mgreten/pr-tour pr-tour \
  --global-arg repoSlug=octo-org/octo-repo \
  --global-arg repoPath=~/code/octo-repo \
  --global-arg agentProvider=claude
```

## Usage

Build a tour and write its page:

```bash
swamp workflow run @mgreten/pr-tour --input prNumber=42
```

The run's `@mgreten/pr-tour-report` output names the page:
`<pagesDir>/42.html` for the latest head and `<pagesDir>/42-<sha12>.html` for
each head SHA. Running it again for the same head SHA reuses the stored tour and
costs no agent run. To rebuild anyway:

```bash
swamp model method run pr-tour build --input prNumber=42 --input force=true
```

To trigger tours from another page or tool, add the workflow to your
`swamp serve` as a webhook; SETUP.md has the exact flag and a signed request.

## Global Arguments

| Argument             | Type   | Default                | Description                                                                                              |
| -------------------- | ------ | ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `repoSlug`           | string | required               | GitHub `owner/repo` the PRs live in.                                                                     |
| `repoPath`           | string | required               | Local git checkout of `repoSlug`. Tour worktrees are added from it. `~/` is expanded.                    |
| `gitRemote`          | string | `origin`               | Remote in `repoPath` that points at `repoSlug`; `pull/<n>/head` is fetched from it.                      |
| `worktreeRoot`       | string | `~/.pr-tour/worktrees` | Where the per-tour detached worktree is created. Each is removed after its build.                        |
| `cliAgentModel`      | string | `cli-agent`            | Name of the `@mgreten/cli-agent` instance that runs the tour agent.                                      |
| `agentProvider`      | string | `""`                   | cli-agent provider, such as `claude` or `codex`. Empty uses the cli-agent instance's `defaultProvider`.  |
| `agentModel`         | string | `""`                   | Provider model id, such as `opus` or `sonnet`. Empty uses the cli-agent default for the provider.        |
| `wallTimeoutMs`      | number | `900000`               | Wall-clock limit for one agent attempt.                                                                  |
| `maxPromptDiffBytes` | number | `150000`               | Hunk text past this many bytes is left out of the prompt; those hunks are listed and placed whole.       |
| `pagesDir`           | string | `~/.pr-tour/pages`     | Directory the report writes pages to. Serve it to open tours in a browser.                               |
| `pageBaseUrl`        | string | `""`                   | URL `pagesDir` is served at, such as `http://localhost:8765`. Used only for the link the report prints. |
| `themeStorageKey`    | string | `pr-tour:theme`        | localStorage key that remembers light or dark mode. Give other pages the same key to keep them in step. |
| `theme`              | object | `{dark: {}, light: {}}` | CSS custom property overrides per mode, applied on top of the built-in themes. See Theming.             |

The report settings (`pagesDir` through `theme`) are global arguments of the
model because swamp hands a report its model's global arguments.

## Method: build

Fetches the PR with `gh`, builds or reuses its tour, and stores it as the
`tour` resource `tour-<prNumber>-<sha12>`. Read-only toward GitHub.

| Argument   | Type    | Default  | Description                                                |
| ---------- | ------- | -------- | ---------------------------------------------------------- |
| `prNumber` | integer | required | PR number in `repoSlug`.                                   |
| `force`    | boolean | `false`  | Rebuild even when a tour exists for the current head SHA. |

## Theming

`theme.dark` overrides the default (dark) mode and `theme.light` the light
mode. Keys are CSS custom property names, with or without the leading `--`;
values are CSS values and cannot contain `<`, `>`, `{`, `}` or `;`. For
example, an orange accent in dark mode and a different UI font in both:

```bash
swamp model create @mgreten/pr-tour pr-tour \
  --global-arg repoSlug=octo-org/octo-repo \
  --global-arg repoPath=~/code/octo-repo \
  --global-arg 'theme:json={"dark":{"accent":"#ff9e64","font-ui":"Inter, sans-serif"},"light":{"font-ui":"Inter, sans-serif"}}'
```

| Tokens                                                    | What they color                                          |
| --------------------------------------------------------- | -------------------------------------------------------- |
| `bg`, `bg-image`, `panel`, `code`, `line`                 | Page background and its gradient, panels, code blocks, borders |
| `ink`, `muted`, `dim`                                     | Text, secondary text, line numbers                       |
| `accent`, `accent2`, `glow`                               | Stop numbers and primary buttons, review checks, the neon text glow (`none` turns it off) |
| `add`, `del`, `add-bg`, `del-bg`                          | Added and removed lines                                  |
| `high`, `medium`, `low`, `on-done`                        | Risk badges, reviewed markers                            |
| `kw`, `st`, `sy`, `co`, `nu`, `iv`, `fn`, `cm`            | Syntax highlighting: keywords, strings, symbols, constants, numbers, instance variables, test helpers, comments |
| `code-ink`, `code-bg`, `check-bg`, `check-ring`           | Inline code in prose, review check boxes                 |
| `font-ui`, `font-code`, `radius`                          | Fonts and corner radius                                  |

## How It Works

1. `gh pr view` and `gh pr diff` fetch the PR and its unified diff. The diff is
   split into hunks `h1…hN`; a file change with no text lines (binary, pure
   rename) becomes one empty hunk so every file appears on the tour.
2. `git fetch <gitRemote> pull/<n>/head` and `git worktree add --detach` check
   out the PR head under `worktreeRoot`.
3. The model calls `invokeAndParse` on the cli-agent instance with
   `toolProfile: readonly` and the worktree as its working directory, so the
   agent can read the code around each hunk.
4. The answer is normalized and validated. On problems the agent gets one more
   attempt with the problems and its previous answer; a second failure fails the
   run. The worktree is removed either way.
5. `@mgreten/pr-tour-report` reads the stored tour and writes the page.

Prerequisites: `git`, an authenticated `gh` that can read the repository, and
a CLI agent that `@mgreten/cli-agent` supports, installed and logged in. Tours
are kept for 30 days, up to 50 versions.

## License

MIT — see [LICENSE.txt](LICENSE.txt) for details.
