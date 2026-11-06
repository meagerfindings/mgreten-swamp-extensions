/**
 * Shared synthesis model that turns curated packets into a readable
 * briefing package.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  buildResearchBrief,
  renderMarkdownReport,
  ResearchBriefSchema,
  SourcePacketSchema,
  JurisdictionSchema,
  OfficeTypeSchema,
  slugify,
} from "./candidate-research-shared.ts";

/** Input for report synthesis. */
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

/**
 * Synthesis model definition.
 */
export const model = {
  type: "@mgreten/candidate-research-synthesizer",
  version: "2026.06.27.1",
  globalArguments: z.object({}),
  resources: {
    brief: {
      description: "Structured final brief for voters and downstream agents.",
      schema: ResearchBriefSchema,
      lifetime: "infinite",
      garbageCollection: 25,
    },
  },
  methods: {
    synthesize: {
      description: "Build a unified brief and markdown report from curated findings.",
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
        const report = renderMarkdownReport(brief, args.packets);
        const briefHandle = await context.writeResource("brief", slugify(args.subject), brief);
        return { dataHandles: [briefHandle], brief, report };
      }),
    },
  },
};
