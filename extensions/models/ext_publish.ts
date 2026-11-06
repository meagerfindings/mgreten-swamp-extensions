/**
 * @module @mgreten/ext-publish
 *
 * The stage after ext-gate (see tools/publish.ts for the rules). One method,
 * `publish`, takes the same workflow run's ext-gate results, publishes or
 * dry-runs each changed package, and records one `run` resource with the
 * per-package outcome, observation streak, and a deduped notify decision.
 * Live pushes happen only when `enabled` is true (the ext-release workflow's
 * extPublishEnabled tag); otherwise everything runs except the real push.
 */
import { z } from "npm:zod@4";
import { type GateStepRecord, type Previous, realIo, runPublish } from "../../tools/publish.ts";

const GlobalArgsSchema = z.object({
  repoDir: z.string().default("").describe("Catalog repo root. Empty uses the working directory."),
  swampBin: z.string().default("").describe("swamp binary. Empty uses $HOME/.local/bin/swamp."),
  pushTimeoutMs: z.number().int().positive().default(300_000).describe("A push running longer is an unknown outcome."),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const PackageRunSchema = z.object({
  name: z.string(),
  failedSteps: z.array(z.string()),
  action: z.string(),
  version: z.string(),
  outcome: z.string(),
  detail: z.string(),
});

const UnknownSchema = z.object({ name: z.string(), version: z.string(), detail: z.string(), at: z.string() });

const RunSchema = z.object({
  runAt: z.string(),
  today: z.string(),
  gateRunId: z.string(),
  mode: z.enum(["live", "dry-run"]),
  ok: z.boolean(),
  repoCommitsOk: z.boolean(),
  packages: z.array(PackageRunSchema),
  readyAwaitingActivation: z.array(z.string()),
  failures: z.array(z.string()),
  unknown: UnknownSchema.nullable(),
  observationStart: z.string(),
  greenSince: z.string().nullable(),
  observationDays: z.number(),
  a7Eligible: z.boolean(),
  autoPush: z.object({
    status: z.enum(["none", "pushed", "skipped", "failed"]),
    detail: z.string(),
    originBefore: z.string().nullable(),
    headAfter: z.string().nullable(),
    commits: z.number(),
  }).nullable(),
  signature: z.string(),
  notify: z.boolean(),
  lastNotifiedAt: z.string().nullable(),
  lastNotifiedSignature: z.string().nullable(),
  title: z.string(),
  message: z.string(),
});

const ArgsSchema = z.object({
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Release day YYYY-MM-DD (America/Denver)."),
  now: z.string().describe("ISO timestamp of this run, used for notify dedupe."),
  gateRunId: z.string().min(1).describe("Workflow run id whose ext-gate results are supplied."),
  enabled: z.boolean().default(false).describe("Live publish. False runs everything except the real push."),
  observationStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  gateResults: z.array(z.unknown()).describe("ext-gate `result` data from gateRunId (data.query rows or their attributes)."),
  previous: z.unknown().optional().describe("Previous ext-publish run attributes (streak, dedupe, unresolved unknown)."),
  clearUnknown: z.boolean().default(false).describe("Human override after resolving an unknown push outcome."),
});

type MethodContext = {
  globalArgs: GlobalArgs;
  logger: { info: (msg: string, props?: Record<string, unknown>) => void; warning: (msg: string, props?: Record<string, unknown>) => void };
  writeResource: (spec: string, instance: string, data: Record<string, unknown>, options?: { tags?: Record<string, string> }) => Promise<Record<string, unknown>>;
};

/** Accept data.query rows ({attributes} / {content}) or bare result records. */
function toRecord(row: unknown): GateStepRecord | null {
  const r = row as Record<string, unknown> | null;
  const a = (r?.attributes ?? r?.content ?? r) as Record<string, unknown> | null;
  return a && typeof a.step === "string" && Array.isArray(a.packages) ? (a as unknown as GateStepRecord) : null;
}

export const model = {
  type: "@mgreten/ext-publish",
  version: "2026.11.01.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    run: {
      description: "One row per ext-publish run: per-package outcome, ready-awaiting-activation list, unresolved unknown outcome, observation streak, and the deduped notify decision.",
      schema: RunSchema,
      lifetime: "infinite" as const,
      garbageCollection: 2000,
    },
  },
  methods: {
    publish: {
      description: "Publish (or, unless enabled, dry-run) every catalog package whose content changed and whose gate in the same run is green; verify against the registry. Never retries an unknown outcome.",
      arguments: ArgsSchema,
      execute: async (args: z.infer<typeof ArgsSchema>, context: MethodContext) => {
        const g = context.globalArgs;
        const root = g.repoDir || Deno.cwd();
        const swamp = g.swampBin || `${Deno.env.get("HOME")}/.local/bin/swamp`;
        const gate = args.gateResults.map(toRecord).filter((r): r is GateStepRecord => r !== null);
        const prev = (args.previous ?? null) as Previous | null;
        const run = await runPublish({
          root,
          today: args.today,
          now: args.now,
          gateRunId: args.gateRunId,
          enabled: args.enabled,
          observationStart: args.observationStart,
          gate,
          previous: prev && typeof prev === "object" ? prev : null,
          clearUnknown: args.clearUnknown,
          io: realIo(swamp, g.pushTimeoutMs),
        });
        for (const p of run.packages) {
          (p.outcome === "failed" || p.outcome === "unknown" ? context.logger.warning : context.logger.info)(
            "{name}: {outcome} {version} {detail}",
            { ...p },
          );
        }
        const handle = await context.writeResource("run", "run", run as unknown as Record<string, unknown>, {
          tags: { mode: run.mode, ok: String(run.ok), notify: String(run.notify), today: run.today, gateRunId: run.gateRunId },
        });
        if (!run.ok) throw new Error(`ext-publish: ${run.unknown ? `unknown outcome for ${run.unknown.name}@${run.unknown.version}; ` : ""}${run.failures.join("; ")}`);
        return { dataHandles: [handle] };
      },
    },
  },
};
