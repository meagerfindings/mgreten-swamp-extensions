# Colorado Candidate Extension

This package publishes the Colorado candidate research entrypoint from the monorepo.
It re-exports the canonical root model and keeps the public package boundary small.

## Use it

```sh
swamp extension fmt /opt/data/swamp-candidate-researcher/extensions/colorado-candidate/manifest.yaml   --repo-dir /opt/data/swamp-candidate-researcher/extensions/colorado-candidate --check
```

```sh
swamp extension push /opt/data/swamp-candidate-researcher/extensions/colorado-candidate/manifest.yaml   --repo-dir /opt/data/swamp-candidate-researcher/extensions/colorado-candidate --dry-run
```

### Notes

- Jurisdiction: Colorado
- Office type: candidate
- Shared neutral source normalization lives in the root `models/shared/` code.
- Viewpoint-specific preferences should stay in downstream prompts or private config.
