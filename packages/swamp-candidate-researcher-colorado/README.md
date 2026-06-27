# swamp-candidate-researcher

Configurable Swamp models for building election and judicial research packets without baking in a single political worldview.
The repo is split into a shared core plus Colorado and federal variants, with a separate Colorado judge-focused model for retention,
discipline, and sentencing-pattern research. The public defaults stay neutral; viewpoint-specific preferences belong in private
configs or downstream prompts, not in the repo itself.

## What this repo provides

- a shared research core for plans, source packets, and report synthesis
- Colorado-specific candidate research helpers
- federal candidate research helpers
- Colorado judicial research helpers
- a synthesizer model that turns curated findings into a unified briefing

## Example usage

```yaml
# sample input shape for a Colorado race
jurisdiction: colorado
officeType: candidate
subject: "County Commissioner, District 2"
issueLenses:
  - abortion
  - homeschooling
  - second amendment
  - free speech
sources:
  - name: official campaign site
    url: https://example.org/candidate
    kind: candidate
  - name: local reporting
    url: https://example.org/article
    kind: news
```

```ts
import { model } from "./models/shared/candidate-research-core.ts";

// The collector can turn a candidate + source list into structured packets.
// The synthesizer can then combine those packets into a readable brief.
```

## Design notes

The key design goal is separation of concerns:
- shared normalization and report formatting live in common helpers
- Colorado and federal models encode jurisdiction-specific source priorities
- the judge model keeps retention and discipline concerns separate from ordinary candidate research

If you want a conservative-friendly or progressive-friendly presentation mode, keep that in the private prompt/config layer that calls these models.
The public repo should remain a neutral toolset that can support different audiences.

## Installation

```sh
swamp extension pull @meagerfindings/swamp-candidate-researcher
```

## License

MIT. See LICENSE for details.
