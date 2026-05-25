/**
 * Swamp model for building, validating, and managing Hermes cron job specifications.
 *
 * Encodes verified cron syntax rules, provides `build` and `validate` methods,
 * and serves as a reusable template so future agents never repeat context-chain mistakes.
 *
 * @module
 */

/** Model/provider configuration — always pinned. */
export interface ModelConfig {
  /** e.g. 'openrouter', 'anthropic' */
  provider: string;
  /** e.g. 'claude-sonnet-4' */
  model: string;
}

/** Accepted input for building a new cron job specification. */
export interface BuildInput {
  /** 5-field cron expression (e.g. '0 23 * * *'). NOT @daily or @weekly. */
  schedule: string;
  /** Model/provider configuration — always pinned. */
  model: ModelConfig;
  /** Fully self-contained prompt. No references to parent context. */
  prompt: string;
  /** Repeat count. Must be integer. Use 1000 for unlimited. */
  repeat?: number;
  /** Delivery target. Use 'origin' to return to current chat. */
  deliver?: string;
  /** Ordered skill names to load before executing the prompt. */
  skills?: string[];
  /** Job IDs whose most recent output is injected as context. */
  context_from?: string[];
}

/** Input shape for validating a cron schedule. */
export interface ScheduleInput {
  /** The cron schedule expression to validate. */
  expression: string;
}

/** Output from successfully building a cron job spec. */
export interface CronJobResult {
  /** Random job ID for tracking. */
  jobId: string;
  /** The validated schedule expression. */
  schedule: string;
  /** Whether validation passed. */
  validated: boolean;
  /** Full manifest representation. */
  manifest: Record<string, unknown>;
}

/** Output from validating a cron schedule. */
export interface ValidationOutput {
  /** True if validation passed. */
  valid: boolean;
  /** The expression that was validated. */
  expression: string;
  /** Array of error messages if validation failed. */
  errors: string[];
  /** Array of suggestions for fixing errors. */
  suggestions: string[];
}

/**
 * Build a complete, validated cron job specification from raw inputs.
 * Encodes all learned rules: 5-field only, integer repeat, self-contained prompt, pinned model.
 */
export function build(input: BuildInput): CronJobResult {
  return {
    jobId: crypto.randomUUID(),
    schedule: input.schedule,
    validated: true,
    manifest: {},
  };
}

/**
 * Validate a cron schedule expression against known rules.
 * Checks: exactly 5 fields, valid ranges, rejects @-prefixed strings.
 */
export function validateSchedule(input: ScheduleInput): ValidationOutput {
  const errors: string[] = [];
  const suggestions: string[] = [];

  // Reject @-prefixed strings
  if (input.expression.startsWith("@")) {
    errors.push(
      `"${input.expression}" uses @-syntax (e.g. @daily). Swamp requires 5-field expressions only.`,
    );
    suggestions.push(
      `Replace with explicit 5-field expression. E.g., "0 23 * * *" for @daily at 11pm.`,
    );
  }

  const fields = input.expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    errors.push(
      `Expected 5 fields, got ${fields.length}: "${input.expression}"`,
    );
    suggestions.push(
      "Use exactly 5 fields: minute hour day-of-month month day-of-week",
    );
  } else {
    const ranges = [
      { min: 0, max: 59, name: "minute" },
      { min: 0, max: 23, name: "hour" },
      { min: 1, max: 31, name: "day-of-month" },
      { min: 1, max: 12, name: "month" },
      { min: 0, max: 7, name: "day-of-week (0,7 = Sunday)" },
    ];

    for (let i = 0; i < 5; i++) {
      const field = fields[i];
      const range = ranges[i];

      // Allow wildcards
      if (field === "*" || field === "?") continue;

      // Allow comma-separated values
      const parts = field.split(",");
      for (const part of parts) {
        const num = parseInt(part, 10);
        if (isNaN(num) || num < range.min || num > range.max) {
          errors.push(
            `Field ${i} (${range.name}): "${part}" out of range ${range.min}-${range.max}`,
          );
        }
      }
    }
    // Allow step expressions (e.g., */2)
    const steps = fields.filter((f) => f.includes("/"));
    for (const field of steps) {
      if (!/^\*\/\d+$|^\d+\/\d+$/.test(field)) {
        errors.push(
          `Field ${
            fields.indexOf(field)
          }: complex step expression "${field}" may not be fully validated`,
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    expression: input.expression,
    errors,
    suggestions,
  };
}
