/**
 * Hermes review report.
 *
 * Consumes the collector model's summary and turns it into a concise nightly
 * review with publishability hints and approval questions.
 *
 * @module
 */
import { z } from "npm:zod@4";

const SessionSummarySchema = z.object({
  sessionId: z.string(),
  sessionStart: z.string().optional(),
  lastUpdated: z.string().optional(),
  messageCount: z.number().int(),
  userRequests: z.array(z.string()),
  assistantResponses: z.array(z.string()),
  topics: z.array(z.string()),
});

const ReviewSummarySchema = z.object({
  generatedAt: z.string(),
  timezone: z.string(),
  lookbackHours: z.number().int(),
  windowStart: z.string(),
  windowEnd: z.string(),
  sessionCount: z.number().int(),
  fileCount: z.number().int(),
  sessions: z.array(SessionSummarySchema),
  recentFiles: z.array(z.object({ path: z.string(), mtime: z.string() })),
  reusablePatterns: z.array(z.string()),
  publishableIdeas: z.array(z.string()),
  approvalNeeded: z.array(z.string()),
});

type ReviewSummary = z.infer<typeof ReviewSummarySchema>;

function bullets(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- None";
}

function sessionBlock(summary: ReviewSummary): string {
  return summary.sessions.length
    ? summary.sessions.map((session) => {
      const prompt = session.userRequests[0] ?? "(no user message captured)";
      const response = session.assistantResponses[0] ??
        "(no assistant response captured)";
      return [
        `### ${session.sessionId}`,
        `- **Messages**: ${session.messageCount}`,
        `- **Topics**: ${session.topics.join(", ") || "none"}`,
        `- **User request**: ${prompt}`,
        `- **Assistant response**: ${response}`,
      ].join("\n");
    }).join("\n\n")
    : "No sessions were captured in the review window.";
}

/**
 * Workflow-scope report for the Hermes review kit.
 *
 * The report consumes the collector's saved summary and renders a human-first
 * nightly review with reusable patterns, publishable ideas, and any approval
 * prompts that should be surfaced to you.
 */
export const report = {
  name: "@mgreten/hermes-review-report",
  description:
    "Summarize nightly Hermes review collection into reusable actions, publishable ideas, and approval questions.",
  scope: "workflow",
  labels: ["hermes", "review", "daily", "publishability"],
  execute: async (context) => {
    const collectorStep = context.stepExecutions.find((step) =>
      step.modelType === "@mgreten/hermes-review-collector" ||
      step.stepName === "collect"
    );

    if (!collectorStep) {
      return {
        markdown: [
          "# Hermes Review Report",
          "",
          "No collector step output was found in this workflow run.",
        ].join("\n"),
        json: {
          error: true,
          message: "No collector step output was found.",
        },
      };
    }

    const handle =
      collectorStep.dataHandles.find((h) => h.specName === "summary") ??
        collectorStep.dataHandles[0];
    if (!handle) {
      return {
        markdown: [
          "# Hermes Review Report",
          "",
          "The collector step ran, but no data handle was attached.",
        ].join("\n"),
        json: {
          error: true,
          message: "Collector step produced no data handles.",
        },
      };
    }

    const raw = await context.dataRepository.getContent(
      collectorStep.modelType,
      collectorStep.modelId,
      handle.name,
      handle.version,
    );
    if (!raw) {
      return {
        markdown: [
          "# Hermes Review Report",
          "",
          `Could not read collector output: ${handle.name} v${handle.version}`,
        ].join("\n"),
        json: {
          error: true,
          message: "Could not read collector output.",
        },
      };
    }

    const summary = ReviewSummarySchema.parse(
      JSON.parse(new TextDecoder().decode(raw)),
    );

    const markdown = [
      "# Hermes Review Report",
      "",
      `- **Window**: ${summary.windowStart} → ${summary.windowEnd}`,
      `- **Timezone**: ${summary.timezone}`,
      `- **Sessions reviewed**: ${summary.sessionCount}`,
      `- **Recent files**: ${summary.fileCount}`,
      "",
      "## What happened",
      "",
      sessionBlock(summary),
      "",
      "## What is reusable",
      "",
      bullets(summary.reusablePatterns),
      "",
      "## Publishable ideas",
      "",
      bullets(summary.publishableIdeas),
      "",
      "## What needs your approval",
      "",
      bullets(summary.approvalNeeded),
      "",
      "## Recent files",
      "",
      summary.recentFiles.length
        ? summary.recentFiles.map((file) => `- ${file.path} (${file.mtime})`)
          .join("\n")
        : "- None",
    ].join("\n");

    return {
      markdown,
      json: {
        windowStart: summary.windowStart,
        windowEnd: summary.windowEnd,
        timezone: summary.timezone,
        sessionCount: summary.sessionCount,
        fileCount: summary.fileCount,
        reusablePatterns: summary.reusablePatterns,
        publishableIdeas: summary.publishableIdeas,
        approvalNeeded: summary.approvalNeeded,
      },
    };
  },
};
