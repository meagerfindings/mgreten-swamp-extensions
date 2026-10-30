/**
 * @module @mgreten/ext-gate
 *
 * Publish gate for this catalog repo. One method per gate step; each is a
 * fan-out over every package in catalog.yaml and writes one `result` resource
 * per run, so "which packages failed the privacy step?" is a `swamp data
 * query`. Steps are read-only. The dry-run step only ever runs
 * `swamp extension push --dry-run`; nothing here can publish.
 *
 * The step logic lives in tools/gate.ts so it also runs without swamp.
 */
import { z } from "npm:zod@4";
import { runStep, type Step } from "../../tools/gate.ts";

const GlobalArgsSchema = z.object({
  repoDir: z.string().default("").describe("Catalog repo root. Empty uses the working directory."),
  swampBin: z.string().default("").describe("swamp binary for read-only registry calls. Empty uses $HOME/.local/bin/swamp."),
  denoBin: z.string().default("").describe("deno binary for package tests. Empty uses $HOME/.deno/bin/deno."),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const PackageResultSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const ResultSchema = z.object({
  step: z.string(),
  today: z.string(),
  ok: z.boolean(),
  passed: z.number(),
  failed: z.number(),
  packages: z.array(PackageResultSchema),
});

type MethodContext = {
  globalArgs: GlobalArgs;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
    options?: { tags?: Record<string, string> },
  ) => Promise<Record<string, unknown>>;
};

const StepArgs = z.object({
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Gate date (YYYY-MM-DD); the gate never reads the clock."),
});

function stepMethod(step: Step, description: string) {
  return {
    description,
    arguments: StepArgs,
    execute: async (args: { today: string }, context: MethodContext) => {
      const g = context.globalArgs;
      const root = g.repoDir || Deno.cwd();
      const swamp = g.swampBin || `${Deno.env.get("HOME")}/.local/bin/swamp`;
      const deno = g.denoBin || `${Deno.env.get("HOME")}/.deno/bin/deno`;
      const packages = await runStep(step, { root, today: args.today, swamp, deno });
      const failed = packages.filter((p) => !p.ok);
      for (const p of packages) {
        (p.ok ? context.logger.info : context.logger.warning)(`${p.ok ? "PASS" : "FAIL"} {step} {name}: {detail}`, { step, name: p.name, detail: p.detail });
      }
      const record = { step, today: args.today, ok: failed.length === 0, passed: packages.length - failed.length, failed: failed.length, packages };
      const handle = await context.writeResource("result", step, record as unknown as Record<string, unknown>, {
        tags: { step, ok: String(record.ok), today: args.today },
      });
      if (failed.length) {
        throw new Error(`${step}: ${failed.length}/${packages.length} package(s) failed: ${failed.map((p) => `${p.name} (${p.detail})`).join("; ")}`);
      }
      return { dataHandles: [handle] };
    },
  };
}

export const model = {
  type: "@mgreten/ext-gate",
  version: "2026.10.30.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    result: {
      description: "Per-step gate result: one row per package with pass/fail, detail, and step data (version decision, redacted privacy hits).",
      schema: ResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 500,
    },
  },
  methods: {
    consistency: stepMethod("consistency", "Catalog and manifest agree: scope, path, name, version, dependencies (no @companycam/@matg), public repository URL, and recorded content hash."),
    tests: stepMethod("tests", "Run each package's deterministic tests with the frozen root deno.lock."),
    version: stepMethod("version", "Content-hash CalVer decision per package: unchanged, baseline, release (next YYYY.MM.DD.N), or drift (source behind registry)."),
    privacy: stepMethod("privacy", "Privacy scan over each package's full history in this repo; hits are redacted to rule, path, commit, and fingerprint."),
    "dry-run": stepMethod("dry-run", "swamp extension push --dry-run per package. Never pushes."),
  },
};
