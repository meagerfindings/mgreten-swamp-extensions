import { parse } from "@std/yaml";
import { z } from "zod";
import { model as compiler } from "../../swamp-context-compiler/extensions/models/context_compiler.ts";
import { compileOperatingPacketArgumentsSchema as snapshotPacketSchema } from "../../../moment-savor-standalone-swaps/extensions/models/context_compiler.ts";
import { sourceRegistrySchema as snapshotRegistrySchema } from "../../../moment-savor-standalone-swaps/extensions/models/moment_savor_source_registry.ts";

type Step = {
  name: string;
  task: { type: string; methodName?: string; inputs?: Record<string, unknown> };
};
type Workflow = { jobs: Array<{ steps: Step[] }> };

async function workflow(file: string): Promise<Workflow> {
  const url = new URL(`../workflows/${file}`, import.meta.url);
  return parse(await Deno.readTextFile(url)) as Workflow;
}

function requiredKeyVariants(schema: unknown): string[][] {
  const json = z.toJSONSchema(
    schema as Parameters<typeof z.toJSONSchema>[0],
  ) as {
    required?: string[];
    anyOf?: Array<{ required?: string[] }>;
    oneOf?: Array<{ required?: string[] }>;
  };
  const variants = json.anyOf ?? json.oneOf ?? [json];
  return variants.map((variant) => [...(variant.required ?? [])].sort());
}

function requiredKeys(schema: unknown): string[] {
  const variants = requiredKeyVariants(schema);
  if (variants.length !== 1) {
    throw new Error(`expected one schema variant, found ${variants.length}`);
  }
  return variants[0];
}

function genericRequiredKeyVariants(schema: unknown): string[][] {
  return requiredKeyVariants(schema).filter((keys) =>
    keys.includes("replayPolicy") && keys.includes("authorityAttestation")
  );
}

Deno.test("live compiler method schemas exactly match workflow inputs", async () => {
  for (
    const file of [
      "workflow-bounded-reference-context.yaml",
      "workflow-bounded-operating-context.yaml",
    ]
  ) {
    const definition = await workflow(file);
    for (const step of definition.jobs.flatMap((job) => job.steps)) {
      if (
        step.task.type !== "model_method" || step.name === "catalog-registry"
      ) continue;
      const name = step.task.methodName! as keyof typeof compiler.methods;
      const method = compiler.methods[name];
      if (!method) {
        throw new Error(
          `${file}:${step.name} references an unknown compiler method`,
        );
      }
      const actual = Object.keys(step.task.inputs ?? {}).sort();
      const variants = genericRequiredKeyVariants(method.arguments);
      const matchesExactVariant = variants.some((expected) =>
        JSON.stringify(actual) === JSON.stringify(expected)
      );
      if (!matchesExactVariant) {
        throw new Error(
          `${file}:${step.name} inputs ${JSON.stringify(actual)} != any of ${
            JSON.stringify(variants)
          }`,
        );
      }
    }
  }
});

Deno.test("reference workflow projects documented registry fields", async () => {
  const url = new URL(
    "../workflows/workflow-bounded-reference-context.yaml",
    import.meta.url,
  );
  const text = await Deno.readTextFile(url);
  for (const field of ["sourceIds", "generatedAt", "provenance"]) {
    if (!text.includes(`attributes.${field}`)) {
      throw new Error(`missing registry projection ${field}`);
    }
  }
  if (text.includes(".attributes }}")) {
    throw new Error("registry must not be passed wholesale");
  }
});

Deno.test("compiler method names are concrete rather than dynamic", async () => {
  for (
    const file of [
      "workflow-bounded-reference-context.yaml",
      "workflow-bounded-operating-context.yaml",
    ]
  ) {
    const definition = await workflow(file);
    for (const step of definition.jobs.flatMap((job) => job.steps)) {
      if (
        step.task.type === "model_method" && step.name !== "catalog-registry" &&
        step.task.methodName?.includes("${{")
      ) throw new Error(`${file}:${step.name} has a dynamic compiler method`);
    }
  }
});

Deno.test("operating attestation and chronology match live compiler", async () => {
  const definition = await workflow("workflow-bounded-operating-context.yaml");
  const packet = definition.jobs[0].steps.find((step) =>
    step.name === "operating-packet"
  )!;
  if (
    packet.task.inputs?.contentAttestation !==
      "${{ inputs.contentAttestation }}"
  ) {
    throw new Error("attestation is not forwarded");
  }
  const url = new URL(
    "../workflows/workflow-bounded-operating-context.yaml",
    import.meta.url,
  );
  const text = await Deno.readTextFile(url);
  if (
    !text.includes("timestamp(item.expiresAt) <= timestamp(inputs.expiresAt)")
  ) {
    throw new Error("entry lifetime is not bounded by packet expiry");
  }
});

Deno.test("Moment Savor snapshot packet is explicitly incompatible", () => {
  const genericVariants = genericRequiredKeyVariants(
    compiler.methods.compileOperatingPacket.arguments,
  );
  const snapshot = requiredKeys(snapshotPacketSchema);
  if (
    genericVariants.some((keys) =>
      JSON.stringify(keys) === JSON.stringify(snapshot)
    )
  ) {
    throw new Error(
      "snapshot became drop-in compatible; update the contract plan",
    );
  }
  if (
    snapshot.includes("replayPolicy") ||
    snapshot.includes("authorityAttestation")
  ) {
    throw new Error("snapshot assumptions changed; reassess adapter plan");
  }
});

Deno.test("Moment Savor snapshot registry requires adapter projection", () => {
  const keys = requiredKeys(snapshotRegistrySchema);
  if (
    !keys.includes("entries") || keys.includes("sourceIds") ||
    keys.includes("generatedAt") || keys.includes("provenance")
  ) throw new Error("snapshot registry shape changed; reassess adapter plan");
});
