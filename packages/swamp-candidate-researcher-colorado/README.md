# swamp-candidate-researcher

A public Swamp monorepo for neutral candidate and judicial research.

This repo now acts as a **workspace** for multiple publishable extensions:
- Colorado candidate research
- federal candidate research
- Colorado judge / retention research

The shared neutral logic lives once in the root `models/` tree as canonical implementation only.
Publishable package entrypoints live under `extensions/*/` and are the only publish targets.
That keeps the repo reusable without hard-coding one political worldview or one audience profile.

## Repo layout

See [`docs/repo-shape.md`](docs/repo-shape.md) for the full structure.

## What this repo provides

- shared schemas and helpers for source normalization and report synthesis
- Colorado-specific candidate research helpers
- federal candidate research helpers
- Colorado judicial research helpers
- publishable extension manifests under `extensions/`

## Model surface

This repo’s published extensions are built from a single shared model family.
The CLI dry-run output only shows package metadata, so this section documents
the actual model surface in the style of a Swamp model page.

### `@mgreten/candidate-research-core`

- **Global arguments:** `{}`
- **Methods:** `plan`, `sourcePack`, `collect`, `synthesize`
- **Resources:** `plan`, `packet`, `sourcePack`, `brief`

### `@mgreten/candidate-research-colorado`

- **Global arguments:** `{}`
- **Methods:** `plan`, `collect`, `synthesize`
- **Resources:** `plan`, `packet`, `brief`

### `@mgreten/candidate-research-federal`

- **Global arguments:** `{}`
- **Methods:** `plan`, `collect`, `synthesize`
- **Resources:** `plan`, `packet`, `brief`

### `@mgreten/candidate-research-colorado-judge`

- **Global arguments:** `{}`
- **Methods:** `plan`, `collect`, `synthesize`
- **Resources:** `plan`, `packet`, `brief`

## Example usage

### Colorado candidate

```yaml
jurisdiction: colorado
officeType: candidate
subject: "County Commissioner, District 2"
audience: informed-voter
reportTone: neutral
issueLenses:
  - abortion
  - homeschooling
  - second amendment
  - free speech
```

### Federal candidate

```yaml
jurisdiction: federal
officeType: candidate
subject: "U.S. Senate"
audience: informed-voter
reportTone: neutral
issueLenses:
  - abortion
  - second amendment
  - free speech
```

### Colorado judge

```yaml
jurisdiction: colorado
officeType: judge
subject: "Judge Jane Doe"
audience: informed-voter
reportTone: neutral
issueLenses:
  - sentencing patterns
  - public safety
  - judicial discipline
```

## Publishable extension packages

- `extensions/colorado-candidate/manifest.yaml`
- `extensions/federal-candidate/manifest.yaml`
- `extensions/colorado-judge/manifest.yaml`

Each package re-exports the canonical root model, so the repo can publish multiple
extensions without duplicating the implementation logic. The root of this repo is
shared implementation only and is not a publish target.

## Design notes

The key design goal is separation of concerns:
- shared normalization and report formatting live in common helpers
- Colorado and federal models encode jurisdiction-specific source priorities
- the judge model keeps retention and discipline concerns separate from ordinary candidate research

If you want a viewpoint-specific presentation mode, keep that in the private prompt/config layer that calls these models.
The public repo should remain a neutral toolset that can support different audiences.

## Installation

To inspect the workspace:

```sh
swamp extension fmt extensions/colorado-candidate/manifest.yaml --repo-dir . --check
```

To publish a package, point `swamp extension push` at one of the submanifests.

## License

MIT. See LICENSE for details.
