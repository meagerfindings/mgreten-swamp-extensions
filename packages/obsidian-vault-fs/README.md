# @mgreten/obsidian-vault-fs

Headless, filesystem-first Obsidian vault operations for Swamp automation.

This extension is for agents, cron jobs, and workflow runners that can see an Obsidian vault as a mounted directory but **cannot** or should not depend on the desktop Obsidian app or an Obsidian-specific CLI. It focuses on safe, deterministic file operations and writes structured Swamp data artifacts for follow-up workflow steps.

It is intentionally narrower than richer Obsidian integrations: it does not build a full note graph, index backlinks, or manage the desktop app. Its job is to make mounted-vault automation predictable from Linux containers, servers, and other headless environments.

## Model type

`@mgreten/obsidian-vault-fs`

## Global arguments

- `vaultRoot` — mounted vault root. Default: `/vault`
- `defaultFileMode` — chmod mode attempted after writes. Default: `0o664`
- `defaultDirectoryMode` — chmod mode attempted after parent directory creation. Default: `0o775`
- `blockDotObsidian` — refuse `.obsidian` internals by default. Default: `true`

If your vault is mounted somewhere else, set `vaultRoot` explicitly. For example, a Docker container might mount a vault at `/mnt/obsidian/Personal Vault` or `/data/vault`.

## Methods

- `read` — read a vault-relative or in-vault absolute markdown file
- `write` — create or overwrite a file; refuses existing files unless `overwrite=true`
- `append` — append markdown text, creating the file if needed
- `stat` — return filesystem metadata
- `list` — list vault files, optionally recursively and by extension
- `search` — search markdown files by plain text or regex
- `properties` — read scalar YAML frontmatter
- `setProperties` — merge scalar YAML frontmatter properties

## Safety model

Path handling is the main safety boundary:

- Every path is resolved under `vaultRoot`.
- `..` traversal outside the vault is rejected.
- Absolute paths must already be inside the configured vault root.
- `.obsidian` internals are blocked unless `allowDotObsidian=true` is passed for that operation.
- `write` refuses to replace an existing file unless `overwrite=true` is explicit.
- Writes attempt to set group-friendly file/directory modes for mounted Docker or shared-volume vaults.

## Example: write and read a scratch note

```bash
swamp model @mgreten/obsidian-vault-fs method run write obsidian-vault \
  --input vaultRoot=/vault \
  --input file='Agentic/Experiments/Obsidian Swamp Smoke Test.md' \
  --input content='Smoke test from Swamp.'

swamp model @mgreten/obsidian-vault-fs method run read obsidian-vault \
  --input vaultRoot=/vault \
  --input file='Agentic/Experiments/Obsidian Swamp Smoke Test.md'
```

## Example: set frontmatter properties

```bash
swamp model @mgreten/obsidian-vault-fs method run setProperties obsidian-vault \
  --input vaultRoot=/vault \
  --input file='Agentic/Experiments/Obsidian Swamp Smoke Test.md' \
  --input 'properties:json={"source":"swamp","status":"tested"}'
```

## Example: search a folder

```bash
swamp model @mgreten/obsidian-vault-fs method run search obsidian-vault \
  --input vaultRoot=/vault \
  --input folder='Projects' \
  --input query='launch checklist' \
  --input limit=25
```

The model stores each operation as Swamp data artifacts, so follow-up workflow steps can reference the latest `note`, `writeResult`, `fileInfo`, `fileList`, `searchResults`, or `properties` resources instead of reparsing stdout.

## When to use this instead of another Obsidian integration

Use this model when you want minimal, mounted-filesystem automation:

- create a note from a cron job
- append a transcript or report
- update simple frontmatter fields
- search a folder from a workflow
- safely let an agent read/write only under a configured vault root

Use a richer Obsidian integration when you need graph-aware operations such as backlinks, unresolved links, daily-note conventions, tags across the full vault, or desktop-app behavior.

## Development checks

```bash
swamp extension fmt manifest.yaml --check
swamp extension quality manifest.yaml --json
swamp extension push manifest.yaml --dry-run --json
```
