/** Neutral content-calendar report for marketing orchestration runs. @module */
import { z } from "npm:zod@4";
import {
  calendarSchema,
  MARKETING_ORCHESTRATION_TYPE,
} from "../models/marketing_orchestration.ts";

const Handle = z.object({
  kind: z.literal("resource"),
  specName: z.literal("calendar"),
  name: z.literal("calendar-current"),
  version: z.number().int().positive(),
}).passthrough();
type Context = {
  modelType: unknown;
  modelId: string;
  methodName?: string;
  dataHandles?: unknown[];
  dataRepository: {
    getContent(
      type: unknown,
      modelId: string,
      name: string,
      version: number,
    ): Promise<Uint8Array | null>;
  };
};
const cell = (value: unknown): string =>
  String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");

/** Render the calendar snapshot produced by the calendar method. */
export async function renderMarketingCalendar(
  context: Context,
): Promise<{ markdown: string; json: Record<string, unknown> }> {
  if (
    String(context.modelType) !== MARKETING_ORCHESTRATION_TYPE ||
    context.methodName !== "calendar"
  ) return { markdown: "", json: {} };
  const handles = (context.dataHandles ?? []).map((value) =>
    Handle.safeParse(value)
  ).filter((
    result,
  ) => result.success).map((result) => result.data);
  if (handles.length !== 1) {
    throw new Error("Expected exactly one calendar snapshot handle");
  }
  const handle = handles[0];
  const raw = await context.dataRepository.getContent(
    context.modelType,
    context.modelId,
    handle.name,
    handle.version,
  );
  if (!raw) {
    throw new Error(
      `Calendar snapshot ${handle.name} version ${handle.version} is unavailable`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(raw));
  } catch (error) {
    throw new Error(
      `Calendar snapshot ${handle.name} version ${handle.version} contains invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const parsed = calendarSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Calendar snapshot ${handle.name} version ${handle.version} is invalid: ${
        z.prettifyError(parsed.error)
      }`,
    );
  }
  const calendar = parsed.data;
  const statuses = [
    "planned",
    "approval_pending",
    "approved",
    "dispatching",
    "scheduled",
    "published",
    "failed",
    "canceled",
  ];
  const counts = Object.fromEntries(
    statuses.map((status) => [
      status,
      calendar.entries.filter((entry) => entry.status === status).length,
    ]),
  );
  const rows = calendar.entries.map((entry) =>
    `| ${cell(entry.scheduledAt)} | ${cell(entry.timeZone)} | ${
      cell(entry.channel)
    } | ${cell(entry.status)} | ${cell(entry.approvalState)} | ${
      cell(entry.campaignId)
    } / ${cell(entry.ideaId)} / ${cell(entry.variantId)} | ${
      cell(entry.label)
    } | ${cell(entry.intendedPlatformState)} | ${
      cell(entry.observedPlatformState)
    } | ${cell(entry.dispatchAttemptId)} | ${cell(entry.dispatchClaimId)} | ${
      cell(entry.platformReference)
    } |`
  );
  const markdown = [
    "# Marketing Content Calendar",
    "",
    `Generated: ${calendar.generatedAt}`,
    `Window: ${calendar.from ?? "all history"} → ${
      calendar.until ?? "open ended"
    }`,
    `Counts: ${
      Object.entries(counts).map(([status, count]) => `${status}=${count}`)
        .join("; ")
    }`,
    "",
    "| Scheduled time | Timezone | Channel | Status | Approval | Campaign / idea / variant | Content | Intended | Observed | Attempt | Claim | Platform reference |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...(rows.length ? rows : [
      "| — | — | — | — | — | — | No matching content | — | — | — | — | — |",
    ]),
  ].join("\n");
  return {
    markdown,
    json: {
      handle: { name: handle.name, version: handle.version },
      counts,
      calendar,
    },
  };
}

/** Swamp method report definition. */
export const report = {
  name: "@mgreten/marketing-content-calendar",
  scope: "method" as const,
  description:
    "Intended-versus-observed content calendar with approval and lineage state",
  labels: ["marketing", "content-calendar"],
  execute: renderMarketingCalendar,
};
