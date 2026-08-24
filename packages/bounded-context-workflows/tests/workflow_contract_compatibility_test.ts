import { parse } from "@std/yaml";

type Step = {
  name: string;
  task: { type: string; methodName?: string; inputs?: Record<string, unknown> };
};
type Workflow = { jobs: Array<{ steps: Step[] }> };

const compilerRequiredInputs: Record<string, string[]> = {
  compileRegistered: [
    "authorityAttestation",
    "candidates",
    "evaluatedAt",
    "freshnessMaxAgeSeconds",
    "manifestId",
    "maxTokens",
    "packId",
    "purpose",
    "registryGeneratedAt",
    "registryProvenance",
    "registryRecordName",
    "registrySourceIds",
    "replayPolicy",
    "role",
    "roleTaxonomy",
  ],
  compileConstitution: [
    "authorityAttestation",
    "constitution",
    "replayPolicy",
  ],
  compileOperatingPacket: [
    "authorityAttestation",
    "contentAttestation",
    "entries",
    "expiresAt",
    "generatedAt",
    "packetId",
    "replayPolicy",
  ],
};

async function workflow(file: string): Promise<Workflow> {
  const url = new URL(`../workflows/${file}`, import.meta.url);
  return parse(await Deno.readTextFile(url)) as Workflow;
}

Deno.test("workflow inputs match the declared compiler contract", async () => {
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
      const name = step.task.methodName!;
      const expected = compilerRequiredInputs[name];
      if (!expected) {
        throw new Error(
          `${file}:${step.name} references an unknown compiler method`,
        );
      }
      const actual = Object.keys(step.task.inputs ?? {}).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
          `${file}:${step.name} inputs ${JSON.stringify(actual)} != ${
            JSON.stringify(expected)
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

Deno.test("operating attestation and chronology match the declared contract", async () => {
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
