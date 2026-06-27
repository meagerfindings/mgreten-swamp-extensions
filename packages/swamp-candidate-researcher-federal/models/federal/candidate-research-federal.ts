/**
 * Federal candidate research model.
 *
 * @module
 */

import { z } from "npm:zod@4";
import { buildFederalCandidatePlan, buildResearchBrief, buildSourcePacket, ResearchBriefSchema, ResearchPlanSchema, SourcePacketSchema, SourceSpecSchema, slugify } from "../shared/candidate-research-shared.ts";

/** Plan input for federal candidate research. */
const PlanInputSchema = z.object({
  subject: z.string().min(1),
  issueLenses: z.array(z.string()).default([]),
  audience: z.string().default("informed-voter"),
  reportTone: z.string().default("neutral"),
});

/** Collection input for federal candidate research. */
const CollectInputSchema = z.object({
  subject: z.string().min(1),
  sources: z.array(SourceSpecSchema).min(1),
  fetchTimeoutMs: z.number().int().positive().max(60000).default(15000),
});

/** Synthesis input for federal candidate research. */
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

/** Federal candidate research model. */
export const model = {
  type: "@meagerfindings/candidate-research-federal",
  version: "2026.06.27.1",
  globalArguments: z.object({}),
  resources: {
    plan: {
      description: "Federal candidate research plan.",
      schema: ResearchPlanSchema,
      lifetime: "infinite",
      garbageCollection: 25,
    },
    packet: {
      description: "Federal candidate source packet.",
      schema: SourcePacketSchema,
      lifetime: "infinite",
      garbageCollection: 25,
    },
    brief: {
      description: "Federal candidate briefing summary.",
      schema: ResearchBriefSchema,
      lifetime: "infinite",
      garbageCollection: 25,
    },
  },
  methods: {
    plan: {
      description: "Build a federal candidate research plan.",
      arguments: PlanInputSchema,
      execute: (async (args: z.infer<typeof PlanInputSchema>, context: any) => {
        const plan = buildFederalCandidatePlan(args.subject, args.issueLenses);
        const handle = await context.writeResource("plan", slugify(args.subject), plan);
        return { dataHandles: [handle], plan };
      }),
    },
    collect: {
      description: "Collect federal source pages into normalized source packets.",
      arguments: CollectInputSchema,
      execute: (async (args: z.infer<typeof CollectInputSchema>, context: any) => {
        const packets: z.infer<typeof SourcePacketSchema>[] = [];
        const dataHandles: string[] = [];
        for (const source of args.sources) {
          if (!source.enabled || !source.url) continue;
          const fetchedAt = new Date().toISOString();
          const result = await fetchPage(source.url, args.fetchTimeoutMs);
          const packet = buildSourcePacket({
            subject: args.subject,
            sourceName: source.name,
            kind: source.kind,
            url: source.url,
            jurisdiction: "federal",
            fetchedAt,
            body: result.body,
            notes: source.notes,
            accessStatus: result.accessStatus,
          });
          const handle = await context.writeResource("packet", slugify(`${args.subject}-${source.name}`), packet);
          packets.push(packet);
          dataHandles.push(handle);
        }
        return { dataHandles, packets };
      }),
    },
    synthesize: {
      description: "Store a neutral federal candidate briefing packet.",
      arguments: SynthesizeInputSchema,
      execute: (async (args: z.infer<typeof SynthesizeInputSchema>, context: any) => {
        const brief = buildResearchBrief({
          subject: args.subject,
          jurisdiction: "federal",
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
