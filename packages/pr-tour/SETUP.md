# Setting up PR tours

These steps take you from nothing to a tour of a pull request open in your
browser, then wire a webhook so other tools can request tours. They are written
for an agent to follow in order: each step says what to run and how to check it
worked. Replace the example values (`octo-org/octo-repo`, `~/code/octo-repo`,
PR `42`, port `8765`) with yours.

## 1. Check the prerequisites

```bash
swamp --version
gh auth status
git --version
claude --version   # or the CLI of whichever agent you will use
```

- `gh auth status` must show an account that can read the repository you will
  tour.
- The agent CLI must be installed and logged in. Any provider
  `@mgreten/cli-agent` supports works (claude, codex, opencode, amp, gemini,
  grok, pi). Tours of large PRs read a lot of code, so a strong model gives
  better stops.
- You need a local git checkout of the repository, with a remote that points
  at it on GitHub. Clone it if you do not have one:
  `gh repo clone octo-org/octo-repo ~/code/octo-repo`.

## 2. Pick a swamp repository

Use the swamp repository you already run `swamp serve` from, if you have one,
so the webhook in step 7 can live in the same process. Otherwise create one:

```bash
mkdir -p ~/pr-tours && cd ~/pr-tours && git init -q && swamp repo init
```

Run every later command from this directory.

## 3. Pull the extensions

```bash
swamp extension pull @mgreten/pr-tour
swamp extension pull @mgreten/cli-agent
```

Check: `swamp workflow get @mgreten/pr-tour --json` prints the workflow.

## 4. Create the instances

The `@mgreten/pr-tour` workflow runs the model instance named `pr-tour`, so keep that
name. Skip the first command if you already have an `@mgreten/cli-agent`
instance; pass its name as `cliAgentModel` instead.

```bash
swamp model create @mgreten/cli-agent cli-agent

swamp model create @mgreten/pr-tour pr-tour \
  --global-arg repoSlug=octo-org/octo-repo \
  --global-arg repoPath=$HOME/code/octo-repo \
  --global-arg agentProvider=claude \
  --global-arg pageBaseUrl=http://localhost:8765
```

Optional settings: `agentModel` (for example `opus`), `gitRemote` when the
checkout's GitHub remote is not `origin`, `pagesDir` (default
`~/.pr-tour/pages`), and `theme` (see the README's Theming section). To change
a setting later, run `swamp model get pr-tour --json`, edit the YAML file at its
`path`, and check it with `swamp model validate pr-tour --json`.

Check: `swamp model validate pr-tour --json` reports `"passed": true`.

## 5. Build a first tour

Pick a small open or merged PR (a few hundred changed lines) for the first run.

```bash
swamp workflow run @mgreten/pr-tour --input prNumber=42
```

This takes one to a few minutes: it fetches the PR, checks out its head in a
temporary worktree, and runs the agent. Check that the run reports
`succeeded`, and that the page exists:

```bash
ls ~/.pr-tour/pages/
swamp report get @mgreten/pr-tour-report --behavior pr-tour --json
```

You should see `42.html` and `42-<sha12>.html`. Running the workflow again for
the same PR head reuses the stored tour and finishes in seconds.

If the run failed, read why with
`swamp report get @swamp/workflow-summary --workflow @mgreten/pr-tour --json`. See
Troubleshooting below.

## 6. Serve the pages and open the tour

The pages are self-contained static HTML, so any static file server works.
With Python:

```bash
python3 -m http.server 8765 --bind 127.0.0.1 --directory ~/.pr-tour/pages
```

Open `http://localhost:8765/42.html`. Keep the server running under whatever
supervisor you like (launchd, systemd, a tmux pane). Opening the `.html` file
directly also works; serving it gives you stable links.

On the page: `j` and `k` move between stops, `r` marks the current stop
reviewed, and the button at the top right switches light and dark mode.

## 7. Request tours over a webhook

This lets a dashboard, a bookmarklet, or a script ask for a tour with an HTTP
POST of `{"prNumber": 42}`. It uses swamp's generic webhook scheme, which checks
an HMAC-SHA256 signature of the request body.

Create a secret file:

```bash
mkdir -p ~/.pr-tour && umask 077 && openssl rand -hex 32 > ~/.pr-tour/webhook-secret
```

Add this flag to the `swamp serve` command you already run, or start one:

```bash
swamp serve --host 127.0.0.1 --port 8899 \
  --webhook "/pr-tour:@mgreten/pr-tour:@file=$HOME/.pr-tour/webhook-secret:generic:X-PrTour-Signature:sha256="
```

Flag routes are fixed until serve restarts. If you keep routes in `serve.yaml`
instead, add the same route under its `webhooks` list and run
`swamp serve reload`.

Send a signed request:

```bash
BODY='{"prNumber":42}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$(cat ~/.pr-tour/webhook-secret)" -r | cut -d' ' -f1)
curl -X POST http://127.0.0.1:8899/pr-tour \
  -H 'Content-Type: application/json' \
  -H "X-PrTour-Signature: sha256=$SIG" \
  -d "$BODY"
```

Check: the response is `{"status":"queued","workflow":"@mgreten/pr-tour"}`, the serve
log shows the run completing, and `~/.pr-tour/pages/42.html` is rewritten. A
wrong signature returns `401 Invalid signature`.

A page that sends these requests from a browser has to hold the secret, so it
only proves the request came from that page. Keep serve bound to loopback or a
private network. To reach the tours from other devices, put the pages and serve
behind one private origin with a reverse proxy (for example `tailscale serve`
on a tailnet), so a page can POST to the webhook on the same origin without
CORS.

`swamp serve` runs one webhook workflow at a time by default; raise
`--max-concurrent-webhook-runs` to build several tours at once.

## Troubleshooting

- **`gh pr view ... failed`**: `gh` is not logged in, cannot see the
  repository, or `repoSlug` is wrong.
- **`git ... fetch ... pull/42/head failed`**: `repoPath` is not a checkout of
  `repoSlug`, or `gitRemote` names the wrong remote (forks often call the
  upstream `upstream`).
- **`cli-agent cli-agent failed`**: the agent CLI is missing or logged out, or
  the provider rejected the model id. Run the agent CLI by hand, and check
  `cliAgentModel`, `agentProvider` and `agentModel`.
- **`The tour agent did not place every hunk line exactly once after 2
  attempts`**: the agent's answer failed validation twice; the run's log lists
  the problems. Try a stronger `agentModel`, or lower `maxPromptDiffBytes` for
  very large PRs so more hunks are placed whole.
- **`Behavior instance not found`**: the instance is not named `pr-tour`.
