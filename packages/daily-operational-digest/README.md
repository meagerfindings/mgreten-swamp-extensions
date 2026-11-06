# Daily operational digest

`@mgreten/daily-operational-digest` is a standalone Swamp model that reduces
already-normalized evidence into a bounded, deterministic operational digest. It
is neutral to products and providers: callers supply identifiers, redacted
summaries, freshness metadata, and advisory recommendations. It makes no network
requests, agent invocations, or external changes.

The `build` method accepts exactly the six neutral digest sections in
`DIGEST_SECTIONS`, emits them in that fixed order, cites every item to an
available source, and fails closed when evidence is stale, future-dated,
unredacted, or uncited. Full normalized-evidence, freshness, redaction, and
output-bound contracts are in [CONTRACTS.md](CONTRACTS.md).

The generic `build` API remains primary. For existing consumers, the model also
retains `buildFromBetterStackTriage` and `buildPhaseOnePulse`, persists Phase 1
pulses, and exports `phaseOnePulseSchema`. These compatibility methods are pure,
strict adapters over colocated contracts and add no database or reader runtime.

```ts
import { buildOperationalDigest } from "./extensions/models/operational_digest.ts";

const digest = buildOperationalDigest({
  digestId: "daily-2026-08-23",
  generatedAt: "2026-08-23T12:00:00Z",
  sections: [/* six complete available or explicitly missing sections */],
});
```

```sh
deno test extensions/models/operational_digest_test.ts
swamp extension fmt manifest.yaml --check --json
```

Licensed under the MIT License. See [LICENSE](LICENSE).
