# @mgreten/cron-builder

Swamp model for building, validating, and managing Hermes cron job specifications. Encodes all verified syntax rules learned from real agent interactions so that any future cron job is built correctly without needing to re-learn lessons from chat context.

## What It Solves

Hermes cron jobs have recurring syntax pitfalls:

- Uses `@daily` or `@weekly` instead of explicit 5-field cron expressions
- Passes `repeat: "forever"` as a string instead of an integer
- Misses `deliver: "origin"` (uses `"original"` instead)
- Missing pinned model/provider
- Prompts that depend on parent context (which is lost at cron run time)

This model encodes every rule into a reusable `build()` and `validateSchedule()` method. Any agent or workflow that needs a cron job calls this model and gets a validated, correct specification.

## Installation

```sh
swamp extension install @mgreten/cron-builder
```

## Usage

### Building a cron job spec

```ts
import { build } from "./model.ts";

const job = await build({
  schedule: "0 23 * * *",
  model: {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4",
  },
  prompt: "Review today's daily-review output and determine...",
  repeat: 1,
  deliver: "origin",
  skills: ["swamp-extension", "swamp-extension-publish"],
});
```

### Validating a schedule expression

```ts
import { validateSchedule } from "./model.ts";

const result = await validateSchedule({
  expression: "0 23 * * *",
});

// Returns:
// { valid: true, expression: "0 23 * * *", errors: [], suggestions: [] }
// or
// { valid: false, expression: "@daily", errors: ["..."], suggestions: ["Use 0 23 * * *"] }
```

## Rules Encoded

1. **5-field expressions only** — reject `@daily`, `@weekly`, `@monthly`
2. **`repeat` must be integer** — use `1000` for unlimited, never `"forever"`
3. **`deliver` must be `"origin"`** — never `"original"`
4. **Model/provider always pinned** — never rely on default
5. **Prompt must be self-contained** — no parent context references
6. **Valid field ranges** — minute 0-59, hour 0-23, day 1-31, month 1-12, dows 0-7

## License

MIT
