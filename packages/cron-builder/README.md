# @mgreten/cron-builder

Swamp model for building, validating, and managing Hermes cron job specifications. Encodes all verified syntax rules learned from real agent interactions so that any future cron job is built correctly without needing to re-learn lessons from chat context.

## What It Solves

Hermes cron jobs have recurring syntax pitfalls:

- Uses `@daily` or `@weekly` instead of explicit 5-field cron expressions
- Passes `repeat: "forever"` as a string instead of an integer
- Misses `deliver: "origin"` (uses `"original"` instead)
- Missing pinned model/provider
- Prompts that depend on parent context (which is lost at cron run time)

This model encodes every rule into a reusable `build` and `validate` method. Any agent or workflow that needs a cron job calls this model and gets a validated, correct specification.

## Installation

```sh
swamp extension install @mgreten/cron-builder
```

## Usage

### 1. Create a model instance with your cron configuration

```sh
swamp model create my-nightly-job --type @mgreten/cron-builder \
  --arg schedule="0 23 * * *" \
  --arg model.provider=openrouter \
  --arg model.model="anthropic/claude-sonnet-4" \
  --arg prompt="Review today's output and summarize key findings. No external context needed." \
  --arg repeat=1 \
  --arg deliver=origin
```

### 2. Build the validated cron spec

```sh
swamp model method run my-nightly-job build
```

This writes a `cronSpec` resource with the validated schedule, model config, and prompt. The method throws if the schedule expression is invalid, so you know immediately if the config is wrong.

### 3. Validate any schedule expression independently

```sh
swamp model method run my-nightly-job validate \
  --arg expression="0 23 * * *"
```

Returns a `validationResult` resource with `valid: true/false`, any `errors`, and `suggestions` for fixing them.

### Example: catching an invalid schedule

```sh
swamp model method run my-nightly-job validate --arg expression="@daily"
# validationResult.valid = false
# validationResult.errors = ['"@daily" uses @-syntax. Swamp requires 5-field expressions only.']
# validationResult.suggestions = ['Replace with "0 23 * * *" for @daily at 11pm.']
```

## Rules Encoded

1. **5-field expressions only** — rejects `@daily`, `@weekly`, `@monthly`
2. **`repeat` must be integer** — use `1000` for unlimited, never `"forever"`
3. **`deliver` must be `"origin"`** — never `"original"`
4. **Model/provider always pinned** — never rely on default
5. **Prompt must be self-contained** — no parent context references
6. **Valid field ranges** — minute 0-59, hour 0-23, day 1-31, month 1-12, dow 0-7

## Reading output in workflows

After running `build`, reference the spec in downstream workflow steps with a CEL expression:

```
data.latest("my-nightly-job", "cronSpec").attributes.schedule
data.latest("my-nightly-job", "cronSpec").attributes.validated
```

## License

MIT
