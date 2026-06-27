/**
 * Colorado candidate research model.
 *
 * This wrapper provides Colorado-specific source priorities while reusing
 * the shared packet and synthesis schemas.
 *
 * @module
 */

import { z } from "npm:zod@4";
import { buildColoradoCandidatePlan, buildResearchBrief, ResearchBriefSchema, ResearchPlanSchema, SourcePacketSchema, SourceSpecSchema, slugify } from "../shared/candidate-research-shared.ts";
import { collectSourcePackets } from "../shared/candidate-research-collector.ts";

/** Plan input for Colorado candidate research. */
const PlanInputSchema = z.object({
  subject: z.string().min(1),
  issueLenses: z.array(z.string()).default([]),
  audience: z.string().default("informed-voter"),
  reportTone: z.string().default("neutral"),
});

/** Collection input for Colorado candidate research. */
const CollectInputSchema = z.object({
  subject: z.string().min(1),
  sources: z.array(SourceSpecSchema).min(1),
  fetchTimeoutMs: z.number().int().positive().max(60000).default(15000),
});

/** Synthesis input for Colorado candidate research. */
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

/** Colorado candidate research model. */
export const model = {
  type: "@meagerfindings/candidate-research-colorado",
  version: "2026.06.27.1",
  globalArguments: z.object({}),
  resources: {
    plan: {
      description: "Colorado-specific candidate research plan.",
      schema: ResearchPlanSchema,
      lifetime: "infinite",
      garbageCollection: 25,
    },
    packet: {
      description: "Colorado candidate source packet.",
      schema: SourcePacketSchema,
      lifetime: "infinite",
      garbageCollection: 25,
    },
    brief: {
      description: "Colorado candidate briefing summary.",
      schema: ResearchBriefSchema,
      lifetime: "infinite",
      garbageCollection: 25,
    },
  },
  methods: {
    plan: {
      description: "Build a Colorado candidate research plan.",
      arguments: PlanInputSchema,
      execute: (async (args: z.infer<typeof PlanInputSchema>, context: any) => {
        const plan = buildColoradoCandidatePlan(args.subject, args.issueLenses);
        const handle = await context.writeResource("plan", slugify(args.subject), plan);
        return { dataHandles: [handle], plan };
      }),
    },
    collect: {
      description: "Collect Colorado source pages into normalized source packets.",
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
      description: "Store a neutral Colorado candidate briefing packet.",
      arguments: SynthesizeInputSchema,
      execute: (async (args: z.infer<typeof SynthesizeInputSchema>, context: any) => {
        const brief = buildResearchBrief({
          subject: args.subject,
          jurisdiction: "colorado",
          officeType: "candidate",
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
