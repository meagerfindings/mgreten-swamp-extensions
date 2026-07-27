/**
 * Method-scoped operator brief for the latest release-adoption campaign.
 * Aggregates campaign artifacts without network access or nondeterministic AI.
 *
 * @module
 */

interface DataEntry {
  name: string;
  version: number;
  tags: Record<string, string>;
  createdAt?: string;
}

interface ReportContext {
  definition: { name: string };
  methodName: string;
  executionStatus: string;
  modelType: string;
  modelId: string;
  methodArgs?: Record<string, unknown>;
  dataHandles: Array<{ name: string; specName: string; version: number }>;
  dataRepository: {
    getContent: (
      type: string,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
    findAllForModel: (type: string, modelId: string) => Promise<DataEntry[]>;
  };
  logger: {
    info: (message: string, properties?: Record<string, unknown>) => void;
  };
}

interface Artifact extends Record<string, unknown> {
  __name: string;
  __createdAt: string;
}

interface ReportResult {
  markdown: string;
  json: Record<string, unknown>;
}

async function loadArtifacts(
  context: ReportContext,
): Promise<Map<string, Artifact[]>> {
  const grouped = new Map<string, Artifact[]>();
  const entries = await context.dataRepository.findAllForModel(
    context.modelType,
    context.modelId,
  );
  for (const entry of entries) {
    const specName = entry.tags?.specName;
    if (!specName) continue;
    const raw = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      entry.name,
      entry.version,
    );
    if (!raw) continue;
    try {
      const value = JSON.parse(new TextDecoder().decode(raw)) as Record<
        string,
        unknown
      >;
      const artifact: Artifact = {
        ...value,
        __name: entry.name,
        __createdAt: entry.createdAt ?? "",
      };
      grouped.set(specName, [...(grouped.get(specName) ?? []), artifact]);
    } catch { /* skip corrupt historical artifacts */ }
  }
  return grouped;
}

function latest(items: Artifact[]): Artifact | undefined {
  return [...items].sort((a, b) =>
    b.__createdAt.localeCompare(a.__createdAt)
  )[0];
}

function campaignIdFromContext(context: ReportContext): string | undefined {
  const direct = context.methodArgs?.campaignId ?? context.methodArgs?.id;
  if (typeof direct === "string") return direct;
  for (const handle of context.dataHandles) {
    if (handle.name.startsWith("campaign-")) {
      return handle.name.slice("campaign-".length);
    }
    if (handle.name.startsWith("notes-")) {
      return handle.name.slice("notes-".length);
    }
    if (handle.name.startsWith("inventory-")) {
      return handle.name.slice("inventory-".length);
    }
  }
  return undefined;
}

function firstBodyLines(body: unknown): string {
  if (typeof body !== "string" || body.length === 0) {
    return "_No release body._";
  }
  return body.split(/\r?\n/).slice(0, 40).join("\n");
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function markdownLink(commit: unknown, repo: unknown): string {
  if (typeof commit !== "string" || !commit) return "";
  if (commit.startsWith("http://") || commit.startsWith("https://")) {
    return `[${commit}](${commit})`;
  }
  if (typeof repo === "string" && /^[^/]+\/[^/]+$/.test(repo)) {
    return `[${commit}](https://github.com/${repo}/commit/${commit})`;
  }
  return `\`${commit}\``;
}

/** Latest release-adoption campaign brief report export. */
export const report = {
  name: "@mgreten/release-adoption-brief",
  description:
    "Latest release-adoption campaign brief with releases, CLI changes, fleet inventory, and opportunity outcomes.",
  scope: "method" as const,
  labels: ["release-adoption", "brief"],
  execute: async (context: ReportContext): Promise<ReportResult> => {
    if (context.modelType !== "@mgreten/release-adoption") {
      return {
        markdown:
          "Report skipped — this report only supports `@mgreten/release-adoption`.",
        json: { skipped: true, reason: "wrong_model_type" },
      };
    }
    context.logger.info("Building release-adoption brief for {model}", {
      model: context.definition.name,
    });
    const artifacts = await loadArtifacts(context);
    const requestedId = campaignIdFromContext(context);
    const campaigns = artifacts.get("campaign") ?? [];
    const campaign = requestedId
      ? campaigns.find((item) => item.id === requestedId) ?? latest(campaigns)
      : latest(campaigns);
    if (!campaign) {
      return {
        markdown:
          "# Release Adoption Brief\n\nNo campaign data found. Run `open-campaign` first.",
        json: { skipped: true, reason: "no_campaign" },
      };
    }
    const campaignId = String(campaign.id);
    const notes = latest(
      (artifacts.get("releaseNotes") ?? []).filter((item) =>
        item.campaignId === campaignId
      ),
    );
    const inventory = latest(
      (artifacts.get("fleetInventory") ?? []).filter((item) =>
        item.campaignId === campaignId
      ),
    );
    const diff = latest(
      (artifacts.get("surfaceDiff") ?? []).filter((item) =>
        item.fromVersion === campaign.fromVersion &&
        item.toVersion === campaign.toVersion
      ),
    );
    const opportunities = (artifacts.get("opportunity") ?? []).filter((item) =>
      item.campaignId === campaignId
    );

    let markdown = `# Release Adoption Brief: ${campaignId}\n\n`;
    markdown +=
      `- **Upgrade:** ${campaign.fromVersion} → ${campaign.toVersion}\n`;
    markdown +=
      `- **Phase:** ${campaign.phase}\n- **Opened:** ${campaign.openedAt}\n`;
    if (campaign.notes) markdown += `- **Notes:** ${campaign.notes}\n`;

    markdown += "\n## Release Notes\n\n";
    const releases = Array.isArray(notes?.releases)
      ? notes.releases as Array<Record<string, unknown>>
      : [];
    if (!releases.length) markdown += "No release notes captured.\n";
    for (const release of releases) {
      markdown += `### [${release.tag}](${release.url}) — ${
        String(release.name)
      } (${String(release.body ?? "").length} chars)\n\n`;
      markdown += `${firstBodyLines(release.body)}\n\n`;
    }

    markdown += "## CLI Surface Diff\n\n";
    markdown += "| Change | Count | Items |\n|---|---:|---|\n";
    for (
      const [label, key] of [
        ["Added commands", "addedCommands"],
        ["Removed commands", "removedCommands"],
        ["Added options", "addedOptions"],
        ["Removed options", "removedOptions"],
      ] as const
    ) {
      const values = Array.isArray(diff?.[key]) ? diff[key] as unknown[] : [];
      const rendered = values.map((value) =>
        typeof value === "string"
          ? value
          : `${(value as Record<string, unknown>).command} ${
            (value as Record<string, unknown>).option
          }`
      ).join("<br>");
      markdown += `| ${label} | ${values.length} | ${rendered || "—"} |\n`;
    }

    markdown +=
      "\n## Fleet Inventory\n\n| Repo | Present | Workflows | Models | Extensions | Reports | Scripts |\n|---|---|---:|---:|---:|---:|---:|\n";
    const repos = Array.isArray(inventory?.repos)
      ? inventory.repos as Array<Record<string, unknown>>
      : [];
    for (const repo of repos) {
      markdown += `| ${repo.name} | ${
        repo.present ? "yes" : `no — ${repo.error ?? "unknown error"}`
      } | ${countArray(repo.workflows)} | ${countArray(repo.models)} | ${
        countArray(repo.extensionModels)
      } | ${countArray(repo.reports)} | ${
        countArray(repo.swampInvokingScripts)
      } |\n`;
    }
    if (!repos.length) {
      markdown += "| _No inventory captured_ | — | 0 | 0 | 0 | 0 | 0 |\n";
    }

    markdown += "\n## Opportunities\n";
    for (const status of ["proposed", "applied", "blocked", "skipped"]) {
      markdown += `\n### ${status[0].toUpperCase()}${status.slice(1)}\n\n`;
      const group = opportunities.filter((item) => item.status === status);
      if (!group.length) markdown += "- _None_\n";
      for (const item of group) {
        const checked = status === "applied" ? "x" : " ";
        const commit = markdownLink(item.commit, item.repo);
        markdown +=
          `- [${checked}] **${item.repo} / ${item.target}** — ${item.feature}: ${item.proposal}${
            commit ? ` (${commit})` : ""
          }${item.notes ? ` — ${item.notes}` : ""}\n`;
      }
    }

    const json = {
      campaign,
      releaseNotes: notes ?? null,
      surfaceDiff: diff ?? null,
      fleetInventory: inventory ?? null,
      opportunities,
    };
    context.logger.info(
      "Built release-adoption brief with {opportunities} opportunities",
      { opportunities: opportunities.length },
    );
    return { markdown, json };
  },
};
