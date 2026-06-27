# Colorado Judge Extension

This package publishes the Colorado judge / retention research entrypoint from the monorepo.
It re-exports the canonical root model and keeps the public package boundary small.

## Use it

```sh
swamp extension fmt /opt/data/swamp-candidate-researcher/extensions/colorado-judge/manifest.yaml   --repo-dir /opt/data/swamp-candidate-researcher/extensions/colorado-judge --check
```

```sh
swamp extension push /opt/data/swamp-candidate-researcher/extensions/colorado-judge/manifest.yaml   --repo-dir /opt/data/swamp-candidate-researcher/extensions/colorado-judge --dry-run
```

### Notes

- Jurisdiction: Colorado
- Office type: judge
- Focus areas include retention, discipline, sentencing patterns, and public-safety signals when supported by source records.
- Shared neutral source normalization lives in the root `models/shared/` code.
