import { parse } from "@std/yaml";
import { z } from "zod";
import { model as feedbackTriageModel } from "../../swamp-feedback-triage/extensions/models/feedback_triage.ts";
import { model as featureIdeaGateModel } from "../../swamp-feature-idea-gate/extensions/models/feature_idea_gate.ts";

type Step = {
  name: string;
  task: {
    type: string;
    methodName?: string;
    inputs?: Record<string, unknown>;
  };
};

type Workflow = { jobs: Array<{ steps: Step[] }> };

// Decision review, cross-source evidence, and cli-agent remain snapshots because
// their source contracts are not part of this checkout. The two repaired model
// contracts below are additionally checked directly against their Zod schemas.
const contracts: Record<string, Record<string, readonly string[]>> = {
  "workflow-readonly-decision-review.yaml": {
    prepare: ["reviewId", "input"],
    invokeAndParse: [
      "prompt",
      "invocationId",
      "provider",
      "cwd",
      "toolProfile",
      "sandboxMode",
      "sandboxRequired",
      "sandboxNetwork",
      "sandboxCredentialAccess",
    ],
    validate: [
      "reviewId",
      "request",
      "agentOutput",
      "invocation",
      "invocationClaim",
    ],
  },
  "workflow-readonly-cross-source-evidence.yaml": {
    prepare: ["requestId", "evidence"],
    invokeAndParse: [
      "prompt",
      "invocationId",
      "provider",
      "cwd",
      "toolProfile",
      "sandboxMode",
      "sandboxRequired",
      "sandboxNetwork",
      "sandboxCredentialAccess",
    ],
    validate: [
      "requestId",
      "request",
      "agentOutput",
      "invocation",
      "invocationClaim",
    ],
  },
  "workflow-readonly-feedback-triage.yaml": {
    normalize: ["requestId", "envelopes"],
    prepare: ["requestId", "artifacts"],
    invokeAndParse: [
      "prompt",
      "invocationId",
      "provider",
      "cwd",
      "toolProfile",
      "sandboxMode",
      "sandboxRequired",
      "sandboxNetwork",
      "sandboxCredentialAccess",
    ],
    validate: [
      "requestId",
      "request",
      "agentOutput",
      "invocation",
      "invocationClaim",
    ],
  },
  "workflow-readonly-quarterly-idea-gate.yaml": {
    prepare: ["gateId", "input"],
    invokeAndParse: [
      "prompt",
      "invocationId",
      "provider",
      "cwd",
      "toolProfile",
      "sandboxMode",
      "sandboxRequired",
      "sandboxNetwork",
      "sandboxCredentialAccess",
    ],
    validate: [
      "gateId",
      "request",
      "agentOutput",
      "invocation",
      "invocationClaim",
    ],
  },
};

for (const [file, methods] of Object.entries(contracts)) {
  Deno.test(`${file} uses concrete dependency method inputs`, async () => {
    const text = await Deno.readTextFile(
      new URL(`../workflows/${file}`, import.meta.url),
    );
    const workflow = parse(text) as Workflow;
    const steps = workflow.jobs.flatMap((job) => job.steps).filter((step) =>
      step.task.type === "model_method"
    );

    for (const step of steps) {
      const method = step.task.methodName!;
      const expected = methods[method];
      if (!expected) {
        throw new Error(`No concrete contract for ${step.name}:${method}`);
      }
      const actual = Object.keys(step.task.inputs ?? {}).sort();
      const wanted = [...expected].sort();
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
        throw new Error(
          `${step.name}:${method} inputs ${JSON.stringify(actual)} != ${
            JSON.stringify(wanted)
          }`,
        );
      }
    }
  });
}

type JsonSchema = {
  anyOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
};

function requiredKeys(schema: unknown): string[] {
  const json = z.toJSONSchema(
    schema as Parameters<typeof z.toJSONSchema>[0],
  ) as JsonSchema;
  const variants = json.anyOf ?? [json];
  return [...new Set(variants.flatMap((variant) => variant.required ?? []))]
    .sort();
}

function workflow(file: string): Promise<Workflow> {
  return Deno.readTextFile(new URL(`../workflows/${file}`, import.meta.url))
    .then((text) => parse(text) as Workflow);
}

Deno.test("repaired assessment method schemas match workflow inputs", async () => {
  const repaired = [
    {
      file: "workflow-readonly-feedback-triage.yaml",
      model: feedbackTriageModel,
    },
    {
      file: "workflow-readonly-quarterly-idea-gate.yaml",
      model: featureIdeaGateModel,
    },
  ] as const;

  for (const dependency of repaired) {
    const definition = await workflow(dependency.file);
    const methods = dependency.model.methods as Record<
      string,
      { arguments: unknown }
    >;
    for (const step of definition.jobs[0].steps) {
      if (
        step.task.type !== "model_method" ||
        step.task.methodName === "invokeAndParse"
      ) continue;
      const actual = Object.keys(step.task.inputs ?? {}).sort();
      const expected = requiredKeys(methods[step.task.methodName!].arguments);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
          `${dependency.file}:${step.task.methodName} does not match its live Zod method schema`,
        );
      }
    }
  }
});

Deno.test("workflow resource field assumptions match repaired resource schemas", async () => {
  const checks = [
    {
      file: "workflow-readonly-feedback-triage.yaml",
      schema: feedbackTriageModel.resources.request.schema,
      fields: ["requestId", "prompt", "promptHash", "agentCwd"],
    },
    {
      file: "workflow-readonly-quarterly-idea-gate.yaml",
      schema: featureIdeaGateModel.resources.request.schema,
      fields: ["gateId", "prompt", "promptHash", "agentCwd"],
    },
  ] as const;

  for (const check of checks) {
    const text = await Deno.readTextFile(
      new URL(`../workflows/${check.file}`, import.meta.url),
    );
    const resourceKeys = requiredKeys(check.schema);
    for (const field of check.fields) {
      if (
        !resourceKeys.includes(field) || !text.includes(`attributes.${field}`)
      ) {
        throw new Error(
          `${check.file} request resource contract is missing ${field}`,
        );
      }
    }
  }
});

Deno.test("quarterly gate accepts complete cli-agent resources without outputHash", () => {
  const validateSchema = featureIdeaGateModel.methods.validate.arguments;
  const request = {
    schemaVersion: "1.0",
    gateId: "quarterly-1",
    input: {},
    prompt: "bounded",
    promptHash: "a".repeat(64),
    agentCwd: "/tmp/feature-idea-gate-agent/gate-quarterly-1",
    createdAt: "2026-08-24T00:00:00Z",
  };
  const invocation = {
    invocationId: "quarterly-1",
    provider: "amp",
    model: "synthetic-model",
    promptHash: request.promptHash,
    cwd: request.agentCwd,
    success: true,
    parsedResponse: {},
    durationMs: 100,
    outputPreview: "{}",
    tags: { capability: "quarterly-feature-idea-gate" },
  };
  const invocationClaim = {
    operation: "invokeAndParse",
    invocationId: "quarterly-1",
    provider: "amp",
    model: "synthetic-model",
    cwd: request.agentCwd,
    promptHash: request.promptHash,
    toolProfile: "readonly",
    sandbox: {
      mode: "auto",
      provider: "amp",
      credentialAccess: "provider",
      network: "allow",
      profilePath: "",
      required: true,
    },
    methodName: "invokeAndParse",
    cliPath: "/usr/local/bin/amp",
  };
  const result = validateSchema.safeParse({
    gateId: request.gateId,
    request,
    agentOutput: {},
    invocation,
    invocationClaim,
  });
  // The intentionally incomplete gate input/output may fail, but complete
  // cli-agent telemetry must not introduce unknown-key or outputHash failures.
  const diagnostics =
    result.error?.issues.map((issue) => issue.message).join(" ") ?? "";
  if (
    diagnostics.includes("Unrecognized key") ||
    diagnostics.includes("outputHash")
  ) {
    throw new Error(diagnostics);
  }
});
