/** Contract tests for the observability workflow package.
 *
 * Parses every workflow and example input shipped by the manifest and checks
 * the structural contract (ids, jobs, steps, dependsOn), that every
 * `inputs.X` reference names a declared input, that examples satisfy the
 * input schema of the workflow they target, that `data.query` scopes name a
 * real upstream step, and that workflow-to-workflow calls (including into the
 * declared `@mgreten/notification-outbox-workflows` dependency) pass exactly
 * the inputs the callee declares.
 */

import {
  assert,
  assertEquals,
  assertGreater,
  assertMatch,
// deno-lint-ignore no-import-prefix
} from "jsr:@std/assert@1";
// deno-lint-ignore no-import-prefix
import { parse } from "jsr:@std/yaml@1.0.5";

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  format?: string;
  default?: unknown;
  items?: Schema;
  minItems?: number;
  uniqueItems?: boolean;
  description?: string;
};
type DependsOn = { step: string; condition: { type: string } };
type Step = {
  name: string;
  description?: string;
  forEach?: { item: string; in: string };
  guard?: string;
  task: {
    type: string;
    modelIdOrName?: string;
    methodName?: string;
    workflowIdOrName?: string;
    inputs?: Record<string, unknown>;
    expr?: string;
  };
  dependsOn: DependsOn[];
  allowFailure: boolean;
};
type Job = { name: string; steps: Step[]; dependsOn: unknown[] };
type Workflow = {
  id: string;
  name: string;
  description: string;
  version: number;
  inputs: Schema;
  jobs: Job[];
};

const PKG = new URL("../", import.meta.url);
const read = (rel: string) => Deno.readTextFile(new URL(rel, PKG));

// Workflow paths in this manifest are relative to workflows/.
const manifest = parse(await read("manifest.yaml")) as {
  workflows: string[];
  additionalFiles: string[];
  dependencies: string[];
};
const workflows = new Map<string, Workflow>();
for (const file of manifest.workflows) {
  workflows.set(file, parse(await read(`workflows/${file}`)) as Workflow);
}

// Callees from the declared notification-outbox-workflows dependency.
const OUTBOX_PKG = new URL("../../notification-outbox-workflows/", import.meta.url);
const outboxManifest = parse(
  await Deno.readTextFile(new URL("manifest.yaml", OUTBOX_PKG)),
) as { name: string; workflows: string[] };
const dependencyWorkflows: Workflow[] = [];
for (const file of outboxManifest.workflows) {
  dependencyWorkflows.push(
    parse(await Deno.readTextFile(new URL(file, OUTBOX_PKG))) as Workflow,
  );
}

const byName = new Map(
  [...workflows.values(), ...dependencyWorkflows].map((w) => [w.name, w]),
);
const own = (name: string) => {
  const w = [...workflows.values()].find((x) => x.name === name);
  if (!w) throw new Error(`no workflow ${name}`);
  return w;
};

// ---------------------------------------------------------------------------
// Minimal JSON-schema validator covering exactly the keywords these workflows
// use. Unknown keywords fail loudly so the validator can't silently pass.
// ---------------------------------------------------------------------------
const KNOWN = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "enum",
  "const",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "format",
  "default",
  "items",
  "minItems",
  "uniqueItems",
  "description",
]);

function validate(schema: Schema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!KNOWN.has(key)) throw new Error(`${path}: unsupported keyword ${key}`);
  }
  const t = schema.type;
  const isObj = typeof value === "object" && value !== null &&
    !Array.isArray(value);
  if (t === "string" && typeof value !== "string") {
    return [`${path}: expected string`];
  }
  if (t === "object" && !isObj) return [`${path}: expected object`];
  if (t === "array" && !Array.isArray(value)) return [`${path}: expected array`];
  if (t === "integer" && !Number.isInteger(value)) {
    return [`${path}: expected integer`];
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  }
  if ("const" in schema && schema.const !== value) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: longer than ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: does not match ${schema.pattern}`);
    }
    if (
      schema.format === "uuid" &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      )
    ) errors.push(`${path}: not a uuid`);
    if (
      schema.format === "date-time" &&
      (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
        .test(value) || Number.isNaN(Date.parse(value)))
    ) errors.push(`${path}: not a date-time`);
  }
  if (typeof value === "number" && schema.minimum !== undefined) {
    if (value < schema.minimum) errors.push(`${path}: below minimum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: fewer than ${schema.minItems} items`);
    }
    if (schema.uniqueItems) {
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      if (seen.size !== value.length) errors.push(`${path}: duplicate items`);
    }
    if (schema.items) {
      value.forEach((v, i) =>
        errors.push(...validate(schema.items!, v, `${path}[${i}]`))
      );
    }
  }
  if (isObj) {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj)) errors.push(`${path}.${req}: required`);
    }
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k];
      if (sub) errors.push(...validate(sub, v, `${path}.${k}`));
      else if (schema.additionalProperties === false) {
        errors.push(`${path}.${k}: additional property not allowed`);
      }
    }
  }
  return errors;
}

/** Visit every string value (not keys) under a node. */
function strings(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) node.forEach((n) => strings(n, out));
  else if (node && typeof node === "object") {
    Object.values(node).forEach((n) => strings(n, out));
  }
  return out;
}

const steps = (w: Workflow) => w.jobs.flatMap((j) => j.steps);
const findStep = (w: Workflow, name: string) => {
  const s = steps(w).find((x) => x.name === name);
  if (!s) throw new Error(`${w.name}: no step ${name}`);
  return s;
};

/** Resolve a workflowIdOrName that is a literal or `${{ inputs.X }}` default. */
function resolveCallee(caller: Workflow, ref: string): Workflow {
  const m = ref.match(/^\$\{\{ inputs\.(\w+) \}\}$/);
  const name = m ? caller.inputs.properties?.[m[1]]?.default as string : ref;
  const callee = byName.get(name);
  if (!callee) throw new Error(`${caller.name}: unknown callee ${ref}`);
  return callee;
}

/** All steps a step transitively depends on within its job. */
function ancestors(job: Job, step: Step): Set<string> {
  const out = new Set<string>();
  const queue = step.dependsOn.map((d) => d.step);
  while (queue.length) {
    const name = queue.pop()!;
    if (out.has(name)) continue;
    out.add(name);
    const s = job.steps.find((x) => x.name === name);
    if (s) queue.push(...s.dependsOn.map((d) => d.step));
  }
  return out;
}

const EXAMPLES: Record<string, string> = {
  "examples/daily-digest-input.yaml": "@mgreten/observability-daily-digest",
  "examples/transition-watchdog-input.yaml":
    "@mgreten/observability-transition-watchdog",
};

// ---------------------------------------------------------------------------

Deno.test("manifest lists files that exist, and every workflow on disk is listed", async () => {
  for (const file of manifest.workflows) {
    assert((await Deno.stat(new URL(`workflows/${file}`, PKG))).isFile, file);
  }
  for (const rel of manifest.additionalFiles) {
    assert((await Deno.stat(new URL(rel, PKG))).isFile, rel);
  }
  const onDisk: string[] = [];
  for await (const e of Deno.readDir(new URL("workflows/", PKG))) {
    if (e.name.endsWith(".yaml")) onDisk.push(e.name);
  }
  assertEquals(onDisk.sort(), [...manifest.workflows].sort());
  assertEquals(workflows.size, 4);
  // Every example is shipped and mapped to a workflow in this package.
  assertEquals(
    manifest.additionalFiles.filter((f) => f.startsWith("examples/")).sort(),
    Object.keys(EXAMPLES).sort(),
  );
  assert(manifest.dependencies.includes(outboxManifest.name));
});

Deno.test("each workflow has a unique uuid id, a name, and jobs with uniquely named steps", () => {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [file, w] of workflows) {
    assertMatch(w.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, file);
    assert(!ids.has(w.id), `${file}: duplicate id`);
    ids.add(w.id);
    assertMatch(w.name, /^@mgreten\/observability-[a-z-]+$/, file);
    assert(!names.has(w.name), `${file}: duplicate name`);
    names.add(w.name);
    assertEquals(w.version, 1, file);
    assertGreater(w.jobs.length, 0, file);
    const jobNames = w.jobs.map((j) => j.name);
    assertEquals(new Set(jobNames).size, jobNames.length, `${file}: job names`);
    for (const job of w.jobs) {
      assertGreater(job.steps.length, 0, `${file}:${job.name}`);
      const stepNames = job.steps.map((s) => s.name);
      assertEquals(new Set(stepNames).size, stepNames.length, `${file}:${job.name}`);
    }
  }
  // The uuid-named file's id matches its file name.
  const cb = workflows.get("workflow-cb71471b-8ecf-49f8-8e6d-b8156d986229.yaml")!;
  assertEquals(cb.id, "cb71471b-8ecf-49f8-8e6d-b8156d986229");
});

Deno.test("dependsOn only points at earlier steps in the same job, and jobs at existing jobs", () => {
  for (const [file, w] of workflows) {
    const jobNames = new Set(w.jobs.map((j) => j.name));
    for (const job of w.jobs) {
      for (const dep of job.dependsOn) {
        const name = typeof dep === "string" ? dep : (dep as { job: string }).job;
        assert(jobNames.has(name) && name !== job.name, `${file}: job dep ${name}`);
      }
      const earlier = new Set<string>();
      for (const s of job.steps) {
        for (const dep of s.dependsOn) {
          assert(earlier.has(dep.step), `${file}:${s.name} -> ${dep.step}`);
          assertEquals(dep.condition.type, "succeeded", `${file}:${s.name}`);
        }
        earlier.add(s.name);
      }
    }
  }
});

Deno.test("every inputs.X and self.X reference names a declared input or forEach item", () => {
  for (const [file, w] of workflows) {
    const props = w.inputs.properties ?? {};
    assertEquals(w.inputs.additionalProperties, false, file);
    for (const req of w.inputs.required ?? []) {
      assert(req in props, `${file}: required ${req} not declared`);
    }
    let refs = 0;
    for (const s of steps(w)) {
      for (const text of strings([s.task, s.forEach?.in, s.guard])) {
        for (const m of text.matchAll(/\binputs((?:\.[A-Za-z_]\w*)+)/g)) {
          refs++;
          const [top, ...rest] = m[1].slice(1).split(".");
          let schema: Schema | undefined = props[top];
          assert(schema, `${file}:${s.name}: undeclared input ${top}`);
          for (const seg of rest) {
            if (!schema?.properties) break;
            schema = schema.properties[seg];
            assert(schema, `${file}:${s.name}: undeclared input ${m[1]}`);
          }
        }
        for (const m of text.matchAll(/\bself\.(\w+)/g)) {
          assertEquals(m[1], s.forEach?.item, `${file}:${s.name}: self.${m[1]}`);
        }
      }
    }
    assertGreater(refs, 5, file);
  }
});

Deno.test("example inputs satisfy the input schema of the workflow they target", async () => {
  for (const [rel, name] of Object.entries(EXAMPLES)) {
    const input = parse(await read(rel));
    assertEquals(validate(own(name).inputs, input), [], rel);
  }
});

Deno.test("schema validation rejects broken examples (negative controls)", async () => {
  const digest = own("@mgreten/observability-daily-digest");
  const d = parse(await read("examples/daily-digest-input.yaml")) as Record<string, unknown>;
  delete d.readSpecName;
  d.readMethod = "collect; rm";
  assertEquals(validate(digest.inputs, d), [
    "$.readSpecName: required",
    "$.readMethod: does not match ^[A-Za-z0-9][A-Za-z0-9._-]*$",
  ]);

  const watchdog = own("@mgreten/observability-transition-watchdog");
  const t = parse(await read("examples/transition-watchdog-input.yaml")) as Record<string, unknown>;
  t.outboxSink = "bad sink";
  t.webhookUrl = "https://example.com/hook";
  assertEquals(validate(watchdog.inputs, t), [
    "$.outboxSink: does not match ^$|^[A-Za-z0-9@][A-Za-z0-9@._/-]*$",
    "$.webhookUrl: additional property not allowed",
  ]);
});

Deno.test("each workflow validates identifiers first, matching the declared patterns", () => {
  for (const [file, w] of workflows) {
    const props = w.inputs.properties ?? {};
    for (const job of w.jobs) {
      const [first, ...rest] = job.steps;
      assertEquals(first.task.type, "assert", file);
      assertEquals(first.dependsOn, [], file);
      for (const s of rest) {
        assert(ancestors(job, s).has(first.name), `${file}:${s.name} skips ${first.name}`);
      }
      const expr = first.task.expr!;
      const checked = new Map<string, string>();
      for (const m of expr.matchAll(/inputs\.(\w+)\.matches\("([^"]+)"\)/g)) {
        checked.set(m[1], m[2]);
        const declared = props[m[1]].pattern;
        assert(
          declared === m[2] || declared === `^$|${m[2]}`,
          `${file}: ${m[1]} assert pattern ${m[2]} != schema ${declared}`,
        );
      }
      // Every dynamic model/method/workflow target is validated before use.
      for (const s of rest) {
        const targets = [
          s.task.modelIdOrName,
          s.task.methodName,
          s.task.workflowIdOrName,
        ];
        for (const t of targets) {
          const m = t?.match(/^\$\{\{ inputs\.(\w+) \}\}$/);
          if (m) assert(checked.has(m[1]), `${file}:${s.name} uses unchecked ${m[1]}`);
        }
      }
    }
  }
});

Deno.test("data.query scopes name an upstream step in this run with the same model", () => {
  let scopes = 0;
  for (const [file, w] of workflows) {
    for (const job of w.jobs) {
      for (const s of job.steps) {
        for (const text of strings([s.task, s.guard])) {
          for (
            const m of text.matchAll(
              /workflowRunId == "' \+ run\.id \+ '" && jobName == "([^"]+)" && stepName == "([^"]+)" && modelName == "' \+ (inputs\.\w+) \+ '"/g,
            )
          ) {
            scopes++;
            assertEquals(m[1], job.name, `${file}:${s.name} jobName`);
            assert(ancestors(job, s).has(m[2]), `${file}:${s.name} reads non-upstream ${m[2]}`);
            const source = job.steps.find((x) => x.name === m[2])!;
            assertEquals(source.task.modelIdOrName, `\${{ ${m[3]} }}`, `${file}:${s.name}`);
          }
        }
      }
    }
  }
  // digest: normalize, digest; watchdog: normalize, evaluate, guard, transitions.
  assertEquals(scopes, 6);
});

Deno.test("workflow-to-workflow calls pass exactly the callee's declared inputs", () => {
  const edges: string[] = [];
  for (const caller of workflows.values()) {
    for (const s of steps(caller)) {
      if (s.task.type !== "workflow") continue;
      const callee = resolveCallee(caller, s.task.workflowIdOrName!);
      edges.push(`${caller.name} -> ${callee.name}`);
      const passed = Object.keys(s.task.inputs ?? {});
      const declared = callee.inputs.properties ?? {};
      for (const key of passed) {
        assert(key in declared, `${caller.name}:${s.name} passes undeclared ${key}`);
      }
      for (const req of callee.inputs.required ?? []) {
        assert(passed.includes(req), `${caller.name}:${s.name} omits required ${req}`);
      }
      for (const [key, value] of Object.entries(s.task.inputs ?? {})) {
        if (typeof value === "string" && !value.includes("${{")) {
          assertEquals(validate(declared[key], value), [], `${s.name}.${key}`);
        }
        const ref = typeof value === "string" &&
          value.match(/^\$\{\{ inputs\.(\w+) \}\}$/);
        if (ref) {
          assertEquals(
            caller.inputs.properties![ref[1]].type,
            declared[key].type,
            `${caller.name}:${s.name}.${key} type`,
          );
        }
      }
    }
  }
  assertEquals(edges.sort(), [
    "@mgreten/observability-deliver-transition -> @mgreten/dispatch-enqueued-notifications",
    "@mgreten/observability-deliver-transitions -> @mgreten/observability-deliver-transition",
    "@mgreten/observability-transition-watchdog -> @mgreten/observability-deliver-transitions",
  ]);
});

Deno.test("transition items keep one schema end to end and fit the send contract", () => {
  const batch = own("@mgreten/observability-deliver-transitions");
  const single = own("@mgreten/observability-deliver-transition");
  const item = batch.inputs.properties!.transitions.items!;
  assertEquals(item, single.inputs.properties!.transition);
  assertEquals(findStep(batch, "deliver-transition").task.inputs!.transition, "${{ self.transition }}");

  const send = byName.get("@mgreten/send-one-notification")!;
  const notification = send.inputs.properties!.notification.properties!;
  assertEquals(item.properties!.event.enum, notification.event.enum);
  assertEquals(item.properties!.urgency.enum, notification.urgency.enum);

  // The batch assert must reject duplicate (workItem, event, era) identities.
  const expr = findStep(batch, "validate-transition-identities").task.expr!;
  for (const field of ["workItem", "event", "era"]) {
    assert(
      expr.includes(`candidate.${field} == transition.${field}`),
      `identity check misses ${field}`,
    );
  }
});

Deno.test("deliver-transition dispatches only its own enqueueNotification output", () => {
  const w = own("@mgreten/observability-deliver-transition");
  const dispatch = findStep(w, "dispatch");
  const inputs = dispatch.task.inputs as Record<string, string>;
  assertEquals(inputs.sourceWorkflowRunId, "${{ run.id }}");
  const job = w.jobs.find((j) => j.name === inputs.enqueueJobName);
  assert(job, `no job ${inputs.enqueueJobName}`);
  const enqueue = job.steps.find((s) => s.name === inputs.enqueueStepName);
  assert(enqueue, `no step ${inputs.enqueueStepName}`);
  assertEquals(enqueue.task.methodName, "enqueueNotification");
  assertEquals(enqueue.task.modelIdOrName, inputs.outboxModel);
  assertEquals(Object.keys(enqueue.task.inputs!).sort(), [
    "era",
    "event",
    "payload",
    "urgency",
    "workItem",
  ]);
  assertEquals(dispatch.dependsOn, [{ step: "enqueue", condition: { type: "succeeded" } }]);
});

Deno.test("watchdog delivery is guarded on disabled sink and on exactly the delivered scope", () => {
  const w = own("@mgreten/observability-transition-watchdog");
  const deliver = findStep(w, "deliver-transitions");
  const guard = deliver.guard!;
  assert(guard.includes('inputs.outboxSink == ""'), guard);
  const queryOf = (text: string) => {
    const m = text.match(/data\.query\('[^)]*\)/);
    assert(m, `no data.query in ${text}`);
    return m[0];
  };
  const transitions = deliver.task.inputs!.transitions as string;
  assertEquals(queryOf(guard), queryOf(transitions));
  assert(guard.includes(`size(${queryOf(guard)}) == 0`), guard);
  assert(transitions.includes('inputs.outboxSink == "" ? []'), transitions);
});
