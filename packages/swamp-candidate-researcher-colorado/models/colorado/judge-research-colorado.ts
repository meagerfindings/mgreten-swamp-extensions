/**
 * Colorado judge research model.
 *
 * This model stays neutral in presentation while surfacing retention,
 * discipline, sentencing-pattern, and public-safety signals when the
 * source record supports them.
 *
 * @module
 */

import { z } from "npm:zod@4";
import { buildColoradoJudgePlan, buildResearchBrief, ResearchBriefSchema, ResearchPlanSchema, SourcePacketSchema, SourceSpecSchema, slugify } from "../shared/candidate-research-shared.ts";
import { collectSourcePackets } from "../shared/candidate-research-collector.ts";

/** Plan input for Colorado judge research. */
const PlanInputSchema = z.object({
  subject: z.string().min(1),
  issueLenses: z.array(z.string()).default([]),
  audience: z.string().default("informed-voter"),
  reportTone: z.string().default("neutral"),
});

/** Collection input for Colorado judge research. */
const CollectInputSchema = z.object({
  subject: z.string().min(1),
  sources: z.array(SourceSpecSchema).min(1),
  fetchTimeoutMs: z.number().int().positive().max(60000).default(15000),
});

/** Synthesis input for Colorado judge research. */
const SynthesizeInputSchema = z.object({
  subject: z.string().min(1),
  packets: z.array(SourcePacketSchema).min(1),
  verdict: z.string().optional(),
  summary: z.string().min(1),
  strongestSupport: z.array(z.string()).default([]),
  strongestConcerns: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  audience: z.string().default("informed-voter"),
  reportTone: z.string().default("neutral"),
});

async function fetchPage(url: string, timeoutMs: number): Promise<{ body: string; accessStatus: "fetched" | "blocked" | "error" }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; swamp-candidate-researcher/1.0)" },
      signal: controller.signal,
    });
    return { body: await response.text(), accessStatus: response.ok ? "fetched" : "error" };
  } catch (error) {
    return { body: error instanceof Error ? error.message : String(error), accessStatus: "blocked" };
  } finally {
    clearTimeout(timer);
  }
}

/** Colorado judge research model. */
export const model = {
  type: "@meagerfindings/judge-research-colorado",
  version: "2026.06.27.1",
  globalArguments: z.object({}),
  resources: {
    plan: {
      description: "Colorado judge research plan with retention and discipline signals.",
      schema: ResearchPlanSchema,
      lifetime: "infinite",
      garbageCollection: 25,
    },
    packet: {
      description: "Colorado judge source packet.",
      schema: SourcePacketSchema,
      lifetime: "infinite",
      garbageCollection: 25,
    },
    brief: {
      description: "Colorado judge briefing summary.",
      schema: ResearchBriefSchema,
      lifetime: "infinite",
      garbageCollection: 25,
    },
  },
  methods: {
    plan: {
      description: "Build a Colorado judge research plan.",
      arguments: PlanInputSchema,
      execute: (async (args: z.infer<typeof PlanInputSchema>, context: any) => {
        const plan = buildColoradoJudgePlan(args.subject, args.issueLenses);
        const handle = await context.writeResource("plan", slugify(args.subject), plan);
        return { dataHandles: [handle], plan };
      }),
    },
    collect: {
      description: "Collect Colorado judicial source pages into normalized source packets.",
      arguments: CollectInputSchema,
      execute: (async (args: z.infer<typeof CollectInputSchema>, context: any) => {
        return collectSourcePackets({
          subject: args.subject,
          jurisdiction: "colorado",
          sources: args.sources,
          fetchTimeoutMs: args.fetchTimeoutMs,
          writeResource: context.writeResource ? context.writeResource.bind(context) : undefined,
        });
      }),
    },
    synthesize: {
      description: "Store a neutral Colorado judicial briefing packet.",
      arguments: SynthesizeInputSchema,
      execute: (async (args: z.infer<typeof SynthesizeInputSchema>, context: any) => {
        const brief = buildResearchBrief({
          subject: args.subject,
          jurisdiction: "colorado",
          officeType: "judge",
          audience: args.audience,
          reportTone: args.reportTone,
          packets: args.packets,
          verdict: args.verdict,
          summary: args.summary,
          strongestSupport: args.strongestSupport,
          strongestConcerns: args.strongestConcerns,
          openQuestions: args.openQuestions,
        });
        const briefHandle = await context.writeResource("brief", slugify(args.subject), brief);
        return { dataHandles: [briefHandle], brief };
      }),
    },
  },
};
