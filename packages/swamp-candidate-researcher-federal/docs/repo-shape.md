# Repository Shape

This repo is intentionally a **multi-extension Swamp monorepo**.

## Canonical structure

- `models/shared/` — shared neutral schemas and helpers
- `models/colorado/` — canonical Colorado-specific model implementations
- `models/federal/` — canonical federal model implementation
- `extensions/<package>/` — publishable extension packages with their own `manifest.yaml`
- `examples/` — sample configs

## Why this shape

The user wants:

1. separate Colorado and federal candidate research
2. a separate Colorado judge path
3. one public GitHub repository hosting multiple publishable Swamp extensions
4. shared neutral logic without hard-coded private political preferences

That means the repo should behave like a workspace:
- shared implementation lives once
- each published extension gets its own manifest and entrypoint
- the public repo does not need private config examples

## Current status

The root-level manifest and model files are still present as the original published prototype.
The new `extensions/*` manifests are the preferred publish targets for the split-package design.
