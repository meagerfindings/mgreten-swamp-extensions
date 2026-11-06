/**
 * Shared candidate-research core model.
 *
 * This model builds research plans, collects source packets, and
 * stores structured outputs that downstream agents can synthesize into a
 * readable voter brief.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  buildResearchBrief,
  buildResearchPlan,
  JurisdictionSchema,
  OfficeTypeSchema,
  ResearchBriefSchema,
  ResearchPlanSchema,
  SourcePacketSchema,
  SourceSpecSchema,
  SourceKindSchema,
  slugify,
  type ResearchBrief,
  type ResearchPlan,
  type SourcePacket,
  type SourceSpec,
} from "./candidate-research-shared.ts";
import { collectSourcePackets } from "./candidate-research-collector.ts";
import { buildSourcePack } from "./candidate-research-source-packs.ts";

/** Shared input for plan generation. */
const PlanInputSchema = z.object({
  subject: z.string().min(1),
  jurisdiction: JurisdictionSchema,
  officeType: OfficeTypeSchema,
  audience: z.string().default("informed-voter"),
  reportTone: z.string().default("neutral"),
  issueLenses: z.array(z.string()).default([]),
  sourcePriority: z.array(SourceKindSchema).optional(),
  sourceSpecs: z.array(SourceSpecSchema).default([]),
  redFlagSignals: z.array(z.string()).default([]),
});

/** Shared input for collection. */
const CollectInputSchema = z.object({
  subject: z.string().min(1),
  sources: z.array(SourceSpecSchema).min(1),
  jurisdiction: JurisdictionSchema.optional(),
  fetchTimeoutMs: z.number().int().positive().max(60000).default(15000),
});

/** Shared input for synthesis. */
const SynthesizeInputSchema = z.object({
  subject: z.string().min(1),
  jurisdiction: JurisdictionSchema,
  officeType: OfficeTypeSchema,
  audience: z.string().default("informed-voter"),
  reportTone: z.string().default("neutral"),
  packets: z.array(SourcePacketSchema).min(1),
  verdict: z.string().optional(),
  summary: z.string().min(1),
  strongestSupport: z.array(z.string()).default([]),
  strongestConcerns: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
});

/** Standard response format for plan generation. */
const PlanResultSchema = z.object({
  plan: ResearchPlanSchema,
});

/** Standard response format for collection. */
const CollectResultSchema = z.object({
  packets: z.array(SourcePacketSchema),
});

/** Standard response format for synthesis. */
const SynthesizeResultSchema = z.object({
  brief: ResearchBriefSchema,
});

async function fetchPage(url: string, timeoutMs: number): Promise<{ status: number; body: string; accessStatus: SourcePacket["accessStatus"] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; swamp-candidate-researcher/1.0)",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: controller.signal,
    });
    const body = await response.text();
    return {
      status: response.status,
      body,
      accessStatus: response.ok ? "fetched" : "error",
    };
  } catch (error) {
    return {
      status: 0,
      body: error instanceof Error ? error.message : String(error),
      accessStatus: "blocked",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shared candidate research core model definition.
 */
export const model = {
  type: "@mgreten/candidate-research-core",
  version: "2026.06.27.1",
  globalArguments: z.object({}),
  resources: {
    plan: {
      description: "Normalized research plan for a candidate, race, or judge.",
      schema: ResearchPlanSchema,
      lifetime: "infinite",
      garbageCollection: 25,
    },
    packet: {
      description: "Normalized packet for one fetched or cited source.",
      schema: SourcePacketSchema,
      lifetime: "infinite",
      garbageCollection: 25,
    },
    sourcePack: {
      description: "Normalized source pack for a subject and jurisdiction.",
      schema: z.array(SourceSpecSchema),
      lifetime: "infinite",
      garbageCollection: 25,
    },
    brief: {
      description: "Synthesized voter brief built from curated source packets.",
      schema: ResearchBriefSchema,
      lifetime: "infinite",
      garbageCollection: 25,
    },
  },
  methods: {
    plan: {
      description: "Build a neutral research plan with source priorities and questions.",
      arguments: PlanInputSchema,
      execute: (async (args: z.infer<typeof PlanInputSchema>, context: any) => {
        const plan = buildResearchPlan({
          subject: args.subject,
          jurisdiction: args.jurisdiction,
          officeType: args.officeType,
          audience: args.audience,
          reportTone: args.reportTone,
          issueLenses: args.issueLenses,
          sourcePriority: args.sourcePriority,
          sourceSpecs: args.sourceSpecs,
          redFlagSignals: args.redFlagSignals,
        });
        const handle = await context.writeResource("plan", slugify(args.subject), plan);
        return { dataHandles: [handle], plan };
      }),
    },
    sourcePack: {
      description: "Build a neutral, jurisdiction-aware source pack for a subject.",
      arguments: z.object({
        subject: z.string().min(1),
        jurisdiction: JurisdictionSchema,
        officeType: OfficeTypeSchema,
        issueLenses: z.array(z.string()).default([]),
      }),
      execute: (async (args: { subject: string; jurisdiction: z.infer<typeof JurisdictionSchema>; officeType: z.infer<typeof OfficeTypeSchema>; issueLenses: string[] }, context: any) => {
        const sourceSpecs = buildSourcePack({
          subject: args.subject,
          jurisdiction: args.jurisdiction,
          officeType: args.officeType,
          issueLenses: args.issueLenses,
        });
        const handle = await context.writeResource("sourcePack", slugify(`${args.subject}-sources`), sourceSpecs);
        return { dataHandles: [handle], sourceSpecs };
      }),
    },
    collect: {
      description: "Fetch and normalize a set of source pages into source packets.",
      arguments: CollectInputSchema,
      execute: (async (args: z.infer<typeof CollectInputSchema>, context: any) => {
        const result = await collectSourcePackets({
          subject: args.subject,
          jurisdiction: args.jurisdiction,
          sources: args.sources,
          fetchTimeoutMs: args.fetchTimeoutMs,
          writeResource: context.writeResource?.bind(context),
        });
        return result;
      }),
    },
    synthesize: {
      description: "Combine source packets into a brief for downstream agents or humans.",
      arguments: SynthesizeInputSchema,
      execute: (async (args: z.infer<typeof SynthesizeInputSchema>, context: any) => {
        const brief = buildResearchBrief({
          subject: args.subject,
          jurisdiction: args.jurisdiction,
          officeType: args.officeType,
          audience: args.audience,
          reportTone: args.reportTone,
          packets: args.packets,
          verdict: args.verdict,
          summary: args.summary,
          strongestSupport: args.strongestSupport,
          strongestConcerns: args.strongestConcerns,
          openQuestions: args.openQuestions,
        });
        const handle = await context.writeResource("brief", slugify(args.subject), brief);
        return { dataHandles: [handle], brief };
      }),
    },
  },
};

export type CoreModel = typeof model;
export type PlanInput = z.infer<typeof PlanInputSchema>;
export type CollectInput = z.infer<typeof CollectInputSchema>;
export type SynthesizeInput = z.infer<typeof SynthesizeInputSchema>;
export type PlanResult = z.infer<typeof PlanResultSchema>;
export type CollectResult = z.infer<typeof CollectResultSchema>;
export type SynthesizeResult = z.infer<typeof SynthesizeResultSchema>;

export { buildResearchBrief, buildResearchPlan };
