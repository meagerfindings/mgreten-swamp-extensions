/**
 * Swamp extension model for building and validating Hermes cron job specifications.
 * Encodes verified syntax rules: 5-field expressions only, integer repeat, pinned model/provider.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Model/provider configuration schema — always pinned. */
const ModelConfigSchema = z.object({
  provider: z.string().describe(
    "Provider name, e.g. 'openrouter', 'anthropic'",
  ),
  model: z.string().describe("Model identifier, e.g. 'claude-sonnet-4'"),
});

/** Global configuration for a Hermes cron job instance. */
const GlobalArgsSchema = z.object({
  /** 5-field cron expression (e.g. '0 23 * * *'). NOT @daily or @weekly. */
  schedule: z
    .string()
    .describe(
      "5-field cron expression, e.g. '0 23 * * *'. NOT @daily/@weekly.",
    ),
  /** Model/provider configuration — always pinned. */
  model: ModelConfigSchema.describe("Model/provider config — always pinned."),
  /** Fully self-contained prompt. No references to parent context. */
  prompt: z.string().describe(
    "Fully self-contained prompt. No parent context references.",
  ),
  /** Repeat count. Must be integer. Use 1000 for unlimited. */
  repeat: z.number().int().optional().describe(
    "Repeat count (integer). Use 1000 for unlimited.",
  ),
  /** Delivery target. Use 'origin' to return to current chat. */
  deliver: z
    .string()
    .optional()
    .describe("Delivery target. Use 'origin' to return to current chat."),
  /** Ordered skill names to load before executing the prompt. */
  skills: z
    .array(z.string())
    .optional()
    .describe("Ordered skill names to load before prompt."),
  /** Job IDs whose most recent output is injected as context. */
  context_from: z
    .array(z.string())
    .optional()
    .describe("Job IDs whose recent output is injected as context."),
});

/** Resource schema for a built cron job specification. */
const CronSpecSchema = z.object({
  /** Unique job ID. */
  jobId: z.string().uuid().describe("Unique job ID."),
  /** The validated schedule expression. */
  schedule: z.string().describe("The validated schedule expression."),
  /** Whether schedule validation passed. */
  validated: z.boolean().describe("Whether schedule validation passed."),
  /** The model/provider config used. */
  model: ModelConfigSchema.describe("The model/provider config used."),
  /** The prompt text. */
  prompt: z.string().describe("The prompt text."),
  /** Repeat count. */
  repeat: z.number().int().optional().describe("Repeat count."),
  /** Delivery target. */
  deliver: z.string().optional().describe("Delivery target."),
  /** Skill names list. */
  skills: z.array(z.string()).optional().describe("Skill names list."),
  /** Context job IDs. */
  context_from: z.array(z.string()).optional().describe("Context job IDs."),
  /** ISO 8601 timestamp of when the spec was built. */
  builtAt: z.string().describe(
    "ISO 8601 timestamp of when the spec was built.",
  ),
});

/** Resource schema for a schedule expression validation result. */
const ValidationResultSchema = z.object({
  /** True if the expression passed all validation rules. */
  valid: z.boolean().describe(
    "True if the expression passed all validation rules.",
  ),
  /** The expression that was validated. */
  expression: z.string().describe("The expression that was validated."),
  /** Validation error messages, if any. */
  errors: z.array(z.string()).describe("Validation error messages, if any."),
  /** Suggestions for fixing errors. */
  suggestions: z.array(z.string()).describe("Suggestions for fixing errors."),
  /** ISO 8601 timestamp of when validation ran. */
  validatedAt: z.string().describe(
    "ISO 8601 timestamp of when validation ran.",
  ),
});

/** Validate a cron schedule expression against Hermes syntax rules. */
function validateScheduleExpression(
  expression: string,
): { errors: string[]; suggestions: string[] } {
  const errors: string[] = [];
  const suggestions: string[] = [];

  // Reject @-prefixed shorthand strings
  if (expression.startsWith("@")) {
    errors.push(
      `"${expression}" uses @-syntax (e.g. @daily). Swamp requires 5-field expressions only.`,
    );
    suggestions.push(
      `Replace with explicit 5-field expression. E.g., "0 23 * * *" for @daily at 11pm.`,
    );
  }

  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    errors.push(`Expected 5 fields, got ${fields.length}: "${expression}"`);
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

      const parts = field.split(",");
      for (const part of parts) {
        // Allow step expressions (e.g., */2 or 1/5)
        if (part.includes("/")) {
          if (!/^\*\/\d+$|^\d+\/\d+$/.test(part)) {
            errors.push(
              `Field ${i} (${range.name}): complex step expression "${part}" may not be fully validated`,
            );
          }
          continue;
        }
        const num = parseInt(part, 10);
        if (isNaN(num) || num < range.min || num > range.max) {
          errors.push(
            `Field ${i} (${range.name}): "${part}" out of range ${range.min}-${range.max}`,
          );
        }
      }
    }
  }

  return { errors, suggestions };
}

/**
 * Swamp model for building and validating Hermes cron job specifications.
 *
 * Configure a model instance with your cron job parameters (schedule, model/provider,
 * prompt, repeat count). Then run `build` to produce a validated spec resource, or
 * run `validate` to check any schedule expression against Hermes syntax rules.
 */
export const model = {
  type: "@mgreten/cron-builder",
  version: "2026.07.10.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    cronSpec: {
      description: "The built and validated cron job specification",
      schema: CronSpecSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    validationResult: {
      description: "Schedule expression validation result",
      schema: ValidationResultSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  methods: {
    build: {
      description:
        "Build a Hermes cron job specification from global arguments. Throws if the schedule is invalid. Encodes all Hermes rules: 5-field schedule, integer repeat, pinned model/provider, self-contained prompt.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context) => {
        const { schedule } = context.globalArgs;

        context.logger.info("Building cron spec for schedule {schedule}", {
          schedule,
        });

        const { errors } = validateScheduleExpression(schedule);

        if (errors.length > 0) {
          const errorMsg = errors.join("; ");
          context.logger.error("Invalid cron schedule {schedule}: {errors}", {
            schedule,
            errors: errorMsg,
          });
          throw new Error(`Invalid cron schedule "${schedule}": ${errorMsg}`);
        }

        const handle = await context.writeResource("cronSpec", "current", {
          jobId: crypto.randomUUID(),
          schedule,
          validated: true,
          model: context.globalArgs.model,
          prompt: context.globalArgs.prompt,
          repeat: context.globalArgs.repeat,
          deliver: context.globalArgs.deliver,
          skills: context.globalArgs.skills,
          context_from: context.globalArgs.context_from,
          builtAt: new Date().toISOString(),
        });

        context.logger.info(
          "Cron spec built successfully for schedule {schedule}",
          { schedule },
        );

        return { dataHandles: [handle] };
      },
    },
    validate: {
      description:
        "Validate a cron schedule expression against Hermes syntax rules. Checks 5-field format, valid field ranges, and rejects @-prefixed shorthand. Always writes a result resource — check the 'valid' field for pass/fail.",
      arguments: z.object({
        /** The cron schedule expression to validate. */
        expression: z
          .string()
          .describe(
            "The cron schedule expression to validate, e.g. '0 23 * * *'",
          ),
      }),
      execute: async (args: { expression: string }, context) => {
        context.logger.info("Validating cron expression {expression}", {
          expression: args.expression,
        });

        const { errors, suggestions } = validateScheduleExpression(
          args.expression,
        );

        const valid = errors.length === 0;

        if (!valid) {
          context.logger.warning(
            "Cron expression invalid {expression}: {errors}",
            {
              expression: args.expression,
              errors: errors.join("; "),
            },
          );
        }

        const handle = await context.writeResource(
          "validationResult",
          `validate-${Date.now()}`,
          {
            valid,
            expression: args.expression,
            errors,
            suggestions,
            validatedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Validation complete for {expression}: valid={valid}",
          {
            expression: args.expression,
            valid,
          },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
