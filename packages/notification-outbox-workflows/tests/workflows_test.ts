/** Contract tests for the notification-outbox workflow package.
 *
 * Parses every workflow and fixture shipped by the manifest and checks the
 * structural contract (ids, jobs, steps, dependsOn), that every `inputs.X`
 * reference names a declared input, that fixtures satisfy the input schema of
 * the workflow they target, and that workflow-to-workflow calls pass exactly
 * the inputs the callee declares.
 */

import {
  assert,
  assertEquals,
  assertGreater,
  assertMatch,
  assertNotEquals,
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

const manifest = parse(await read("manifest.yaml")) as {
  workflows: string[];
  additionalFiles: string[];
};
const workflowFiles = manifest.workflows;
const workflows = new Map<string, Workflow>();
for (const file of workflowFiles) {
  workflows.set(file, parse(await read(file)) as Workflow);
}
const byName = new Map([...workflows.values()].map((w) => [w.name, w]));

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

// ---------------------------------------------------------------------------

Deno.test("manifest lists files that exist, and every workflow on disk is listed", async () => {
  for (const rel of [...manifest.workflows, ...manifest.additionalFiles]) {
    const stat = await Deno.stat(new URL(rel, PKG));
    assert(stat.isFile, `${rel} is not a file`);
  }
  const onDisk: string[] = [];
  for await (const e of Deno.readDir(new URL("workflows/", PKG))) {
    if (e.name.endsWith(".yaml")) onDisk.push(`workflows/${e.name}`);
  }
  assertEquals(onDisk.sort(), [...manifest.workflows].sort());
  assertEquals(workflows.size, 3);
});

Deno.test("each workflow has a unique uuid id, a name, and jobs with uniquely named steps", () => {
  const ids = new Set<string>();
  for (const [file, w] of workflows) {
    assertMatch(w.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, file);
    assert(!ids.has(w.id), `${file}: duplicate id`);
    ids.add(w.id);
    assertMatch(w.name, /^@mgreten\/[a-z0-9-]+$/, file);
    assertEquals(w.version, 1, file);
    assertGreater(w.jobs.length, 0, file);
    const jobNames = w.jobs.map((j) => j.name);
    assertEquals(new Set(jobNames).size, jobNames.length, `${file}: job names`);
    for (const job of w.jobs) {
      assertGreater(job.steps.length, 0, `${file}:${job.name}`);
      const names = job.steps.map((s) => s.name);
      assertEquals(new Set(names).size, names.length, `${file}:${job.name}`);
      for (const s of job.steps) {
        assert(
          ["model_method", "workflow", "assert"].includes(s.task.type),
          `${file}:${s.name}: task type ${s.task.type}`,
        );
      }
    }
  }
  assertEquals(byName.size, 3);
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
          assert(
            earlier.has(dep.step),
            `${file}:${s.name} depends on unknown/later step ${dep.step}`,
          );
          assert(
            ["succeeded", "failed"].includes(dep.condition.type),
            `${file}:${s.name}: condition ${dep.condition.type}`,
          );
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
    assertGreater(refs, 3, file);
  }
});

Deno.test("fixtures satisfy the input schema of the workflow they target", async () => {
  for (const file of workflowFiles) {
    const fixture = file.replace(/^workflows\/workflow-(.*)\.yaml$/, "fixtures/$1.json");
    assert(manifest.additionalFiles.includes(fixture), `${fixture} not shipped`);
    const input = JSON.parse(await read(fixture));
    assertEquals(validate(workflows.get(file)!.inputs, input), [], fixture);
  }
});

Deno.test("schema validation rejects broken fixtures (negative controls)", async () => {
  const send = workflows.get("workflows/workflow-send-one-notification.yaml")!;
  const good = JSON.parse(await read("fixtures/send-one-notification.json"));

  const missing = structuredClone(good);
  delete missing.notification.dedupKey;
  assertEquals(validate(send.inputs, missing), [
    "$.notification.dedupKey: required",
  ]);

  const badEnum = structuredClone(good);
  badEnum.notification.status = "delivered";
  assertEquals(validate(send.inputs, badEnum), [
    '$.notification.status: "delivered" not in enum',
  ]);

  const extra = structuredClone(good);
  extra.transportToken = "synthetic";
  assertEquals(validate(send.inputs, extra), [
    "$.transportToken: additional property not allowed",
  ]);

  const dispatch = workflows.get(
    "workflows/workflow-dispatch-enqueued-notifications.yaml",
  )!;
  const d = JSON.parse(await read("fixtures/dispatch-enqueued-notifications.json"));
  d.sourceWorkflowRunId = "not-a-uuid";
  assertEquals(validate(dispatch.inputs, d), [
    "$.sourceWorkflowRunId: not a uuid",
  ]);
});

Deno.test("workflow-to-workflow calls pass exactly the callee's declared inputs", () => {
  let calls = 0;
  for (const caller of workflows.values()) {
    for (const s of steps(caller)) {
      if (s.task.type !== "workflow") continue;
      calls++;
      const callee = resolveCallee(caller, s.task.workflowIdOrName!);
      const passed = Object.keys(s.task.inputs ?? {});
      const declared = callee.inputs.properties ?? {};
      for (const key of passed) {
        assert(key in declared, `${caller.name}:${s.name} passes undeclared ${key} to ${callee.name}`);
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
  assertEquals(calls, 2);
});

Deno.test("dispatch scope points at this run's own enqueueNotification step", () => {
  const deliver = byName.get("@mgreten/deliver-thin-watchdog-alert")!;
  const dispatchStep = findStep(deliver, "dispatch-fresh-pending");
  const inputs = dispatchStep.task.inputs as Record<string, string>;
  assertEquals(inputs.sourceWorkflowRunId, "${{ run.id }}");

  const job = deliver.jobs.find((j) => j.name === inputs.enqueueJobName);
  assert(job, `no job ${inputs.enqueueJobName}`);
  const enqueue = job.steps.find((x) => x.name === inputs.enqueueStepName);
  assert(enqueue, `no step ${inputs.enqueueStepName}`);
  assertEquals(enqueue.task.methodName, "enqueueNotification");
  assertEquals(enqueue.task.modelIdOrName, inputs.outboxModel);
  assertEquals(dispatchStep.dependsOn, [
    { step: enqueue.name, condition: { type: "succeeded" } },
  ]);

  // The dispatch query must filter on every scope input it receives.
  const dispatch = byName.get("@mgreten/dispatch-enqueued-notifications")!;
  const query = findStep(dispatch, "send-fresh-pending").forEach!.in;
  for (
    const [field, input] of [
      ["workflowRunId", "sourceWorkflowRunId"],
      ["jobName", "enqueueJobName"],
      ["stepName", "enqueueStepName"],
      ["modelName", "outboxModel"],
      ["modelType", "outboxModelType"],
    ]
  ) {
    assert(
      query.includes(`${field} == "' + inputs.${input} + '"`),
      `dispatch query does not scope ${field} by inputs.${input}`,
    );
  }
  assert(query.includes('specName == "notification"'));
});

Deno.test("enqueue maps watchdog events onto events the send workflow accepts", () => {
  const deliver = byName.get("@mgreten/deliver-thin-watchdog-alert")!;
  const expr = findStep(deliver, "enqueue-alert").task.inputs!.event as string;
  const m = expr.match(/inputs\.alert\.event == "(\w+)" \? "([\w-]+)" : "([\w-]+)"/);
  assert(m, `unexpected event mapping ${expr}`);
  const alertEvents = deliver.inputs.properties!.alert.properties!.event.enum!;
  assert(alertEvents.includes(m[1]));
  const send = byName.get("@mgreten/send-one-notification")!;
  const sendEvents = send.inputs.properties!.notification.properties!.event.enum!;
  assert(sendEvents.includes(m[2]), m[2]);
  assert(sendEvents.includes(m[3]), m[3]);
  assertNotEquals(m[2], m[3]);
});

Deno.test("send workflow drains success and failure on mutually exclusive branches", () => {
  const send = byName.get("@mgreten/send-one-notification")!;
  const sendStep = findStep(send, "send");
  assertEquals(sendStep.allowFailure, true);
  assertEquals(sendStep.task.inputs!.idempotencyKey, "${{ inputs.notification.dedupKey }}");

  const success = findStep(send, "drain-success");
  const failure = findStep(send, "drain-failure");
  assertEquals(success.dependsOn, [{ step: "send", condition: { type: "succeeded" } }]);
  assertEquals(failure.dependsOn, [{ step: "send", condition: { type: "failed" } }]);
  for (const drain of [success, failure]) {
    assertEquals(drain.task.methodName, "drainNotifications");
    assertEquals(drain.task.modelIdOrName, "${{ inputs.outboxModel }}");
    assertEquals(drain.task.inputs!.notifications, ["${{ inputs.notification }}"]);
  }
  assertEquals(success.task.inputs!.transportResults, [
    { dedupKey: "${{ inputs.notification.dedupKey }}", delivered: true },
  ]);
  // The failure branch records a fixed message, never the raw transport error.
  assertEquals(failure.task.inputs!.transportResults, [
    {
      dedupKey: "${{ inputs.notification.dedupKey }}",
      delivered: false,
      error: "transport delivery failed",
    },
  ]);
});
