# Swamp Extension Radar

`@mgreten/extension-radar` turns a Swamp extension-registry search export into a compact, explainable discovery report.

It is intentionally **read-only**:

- does not scrape the registry
- does not install, pull, publish, or mutate extensions
- does not send notifications
- stores its ranked report as a typed Swamp resource

## Why pass registry data in?

The Swamp CLI is the supported registry client. This model keeps fetching separate from ranking: export candidates with the CLI, then give the normalized entries to the model. That makes the scoring deterministic, testable, and compatible with any registry source that uses the documented entry shape.

## Install

```bash
swamp extension pull @mgreten/extension-radar
swamp model create @mgreten/extension-radar extension-radar
```

## Produce a registry export

Use one or more focused searches. For example:

```bash
swamp extension search homelab --sort new --per-page 50 --json > homelab.json
```

Extract the `extensions` array from one or more exports and pass it as the `extensions` method input. The exact shell or orchestration step is intentionally outside this extension so users can use their preferred scheduler and source collection strategy.

## Analyze

```bash
swamp model method run extension-radar analyze \
  --input-file candidates.json
```

`candidates.json` should have this shape:

```json
{
  "extensions": [
    {
      "name": "@example/service-monitor",
      "description": "Checks a self-hosted service.",
      "repository": "https://example.com/source",
      "repositoryVerified": true,
      "createdAt": "2026-07-18T12:00:00.000Z",
      "labels": ["homelab", "monitoring"],
      "contentTypes": ["models"]
    }
  ]
}
```

Read the persisted result with:

```bash
swamp data get extension-radar current --json
```

The resource includes structured candidates plus a ready-to-share `markdown` field.

## Configuration

Model global arguments are optional:

- `interests`: terms that make an entry relevant
- `excludeTerms`: terms that suppress categories you do not want
- `freshnessDays`: how recently an entry must have been created or updated to earn freshness points
- `maxResults`: maximum candidates returned (1–20)

## Scoring

The ranking is deliberately simple and visible:

- +2 for each matched interest term, up to three
- +3 for a recent timestamp within the freshness window
- +1 for a moderately recent timestamp
- +2 for a registry-verified repository, or +1 for an unverified public repository

It also emits caveats for missing timestamps, absent source URLs, missing content types, short descriptions, and unverified repositories.

A high score is a prompt to inspect an extension, **not** a security review or automatic installation recommendation.

## Privacy and safety

Do not put private hostnames, local paths, API tokens, delivery routes, user/device names, or runtime state in the candidate input. The extension itself has no private defaults and no network side effects.

## License

MIT. See [LICENSE.md](LICENSE.md).
