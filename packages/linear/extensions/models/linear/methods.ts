/**
 * Method implementations for the Linear swamp model.
 *
 * Each exported function receives a {@link LinearClient}, a swamp
 * {@link MethodContext}, and method-specific arguments. Returns a
 * {@link MethodResult} containing data handles for all written resources.
 * @module
 */

import type { IssueFilter, LinearClient } from "./client.ts";

/** Global arguments available to all methods. */
export interface GlobalArgs {
  apiKey: string;
  defaultTeamId?: string;
  defaultProjectId?: string;
}

/** Opaque handle returned by `context.writeResource`. */
export interface DataHandle {
  spec: string;
  instance: string;
  data: Record<string, unknown>;
}

/** Swamp method execution context. */
export interface MethodContext {
  globalArgs: GlobalArgs;
  logger: { info: (msg: string) => void };
  writeResource: (
    spec: string,
    instance: string,
    data: Record<string, unknown>,
  ) => Promise<DataHandle>;
}

/** Return type for all method implementations. */
export interface MethodResult {
  dataHandles: DataHandle[];
}

/** Map an {@link IssueData} to the flat resource shape for `writeResource`. */
function issueResourceData(
  issue: Awaited<ReturnType<LinearClient["getIssue"]>>,
): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: issue.url,
    priority: issue.priority,
    stateId: issue.state?.id ?? "",
    stateName: issue.state?.name ?? "",
    stateType: issue.state?.type ?? "",
    teamId: issue.team?.id ?? "",
    teamKey: issue.team?.key ?? "",
    projectId: issue.project?.id ?? "",
    projectName: issue.project?.name ?? "",
    assigneeId: issue.assignee?.id ?? "",
    assigneeName: issue.assignee?.name ?? "",
    labelNames: issue.labels.map((l) => l.name).join(", "),
    syncedAt: new Date().toISOString(),
  };
}

/** Resolve the authenticated user's ID, name, and email. */
export async function getViewer(
  client: LinearClient,
  context: MethodContext,
): Promise<MethodResult> {
  context.logger.info("Resolving authenticated viewer");
  const viewer = await client.getViewer();
  const handle = await context.writeResource("viewer", "me", {
    id: viewer.id,
    name: viewer.name,
    email: viewer.email,
    syncedAt: new Date().toISOString(),
  });
  return { dataHandles: [handle] };
}

/** Create an issue auto-assigned to the authenticated user. */
export async function createMyIssue(
  client: LinearClient,
  context: MethodContext,
  args: {
    title: string;
    description?: string;
    priority?: number;
    projectId?: string;
    labels?: string;
  },
): Promise<MethodResult> {
  const teamId = context.globalArgs.defaultTeamId;
  if (!teamId) {
    throw new Error("defaultTeamId is required for createMyIssue");
  }

  const viewer = await client.getViewer();
  context.logger.info(
    `Creating issue "${args.title}" assigned to ${viewer.name}`,
  );

  const projectId = args.projectId || context.globalArgs.defaultProjectId ||
    undefined;

  let labelIds: string[] | undefined;
  if (args.labels) {
    const labelNames = args.labels.split(",").map((s) => s.trim());
    const allLabels = await client.listLabels(teamId);
    labelIds = [];
    for (const name of labelNames) {
      const found = allLabels.find(
        (l) => l.name.toLowerCase() === name.toLowerCase(),
      );
      if (!found) {
        throw new Error(
          `Label "${name}" not found in team. Available: ${
            allLabels.map((l) => l.name).join(", ")
          }`,
        );
      }
      labelIds.push(found.id);
    }
  }

  const issue = await client.createIssue({
    title: args.title,
    description: args.description,
    teamId,
    projectId,
    priority: args.priority,
    assigneeId: viewer.id,
    labelIds,
  });

  const handle = await context.writeResource(
    "issue",
    issue.id,
    issueResourceData(issue),
  );
  return { dataHandles: [handle] };
}

/** Fetch a single issue by identifier or UUID. */
export async function getIssue(
  client: LinearClient,
  context: MethodContext,
  args: { identifier: string },
): Promise<MethodResult> {
  context.logger.info(`Fetching issue ${args.identifier}`);
  const issue = await client.getIssue(args.identifier);
  const handle = await context.writeResource(
    "issue",
    issue.id,
    issueResourceData(issue),
  );
  return { dataHandles: [handle] };
}

/** Update fields on an existing issue. */
export async function updateIssue(
  client: LinearClient,
  context: MethodContext,
  args: {
    identifier: string;
    title?: string;
    description?: string;
    stateId?: string;
    priority?: number;
    assigneeId?: string;
    projectId?: string;
  },
): Promise<MethodResult> {
  context.logger.info(`Updating issue ${args.identifier}`);

  const existing = await client.getIssue(args.identifier);

  const input: Record<string, unknown> = {};
  if (args.title !== undefined) input.title = args.title;
  if (args.description !== undefined) input.description = args.description;
  if (args.stateId !== undefined) input.stateId = args.stateId;
  if (args.priority !== undefined) input.priority = args.priority;
  if (args.assigneeId !== undefined) input.assigneeId = args.assigneeId;
  if (args.projectId !== undefined) input.projectId = args.projectId;

  const updated = await client.updateIssue(existing.id, input);
  const handle = await context.writeResource(
    "issue",
    updated.id,
    issueResourceData(updated),
  );
  return { dataHandles: [handle] };
}

/** Query issues with filters. */
export async function listIssues(
  client: LinearClient,
  context: MethodContext,
  args: {
    teamId?: string;
    assignedToMe?: boolean;
    stateType?: string;
    projectId?: string;
    labelName?: string;
  },
): Promise<MethodResult> {
  const filter: IssueFilter = {};

  filter.teamId = args.teamId || context.globalArgs.defaultTeamId;

  if (args.assignedToMe) {
    const viewer = await client.getViewer();
    filter.assigneeId = viewer.id;
  }
  if (args.stateType) filter.stateType = args.stateType;
  if (args.projectId) filter.projectId = args.projectId;
  if (args.labelName) filter.labelName = args.labelName;

  context.logger.info(`Listing issues with filter: ${JSON.stringify(filter)}`);

  const result = await client.listIssues(filter);
  const handles: DataHandle[] = [];

  for (const issue of result.issues) {
    handles.push(
      await context.writeResource("issue", issue.id, issueResourceData(issue)),
    );
  }

  return { dataHandles: handles };
}

/** Attach labels to an issue by name (additive — preserves existing labels). */
export async function addLabels(
  client: LinearClient,
  context: MethodContext,
  args: { identifier: string; labels: string },
): Promise<MethodResult> {
  const teamId = context.globalArgs.defaultTeamId;
  if (!teamId) {
    throw new Error("defaultTeamId is required to resolve label names");
  }

  const labelNames = args.labels.split(",").map((s) => s.trim());
  context.logger.info(
    `Adding labels [${labelNames.join(", ")}] to ${args.identifier}`,
  );

  const existing = await client.getIssue(args.identifier);
  const allLabels = await client.listLabels(teamId);

  const existingLabelIds = existing.labels.map((l) => l.id);
  const newLabelIds: string[] = [];

  for (const name of labelNames) {
    const found = allLabels.find(
      (l) => l.name.toLowerCase() === name.toLowerCase(),
    );
    if (!found) {
      throw new Error(
        `Label "${name}" not found. Available: ${
          allLabels.map((l) => l.name).join(", ")
        }`,
      );
    }
    newLabelIds.push(found.id);
  }

  const mergedIds = [...new Set([...existingLabelIds, ...newLabelIds])];
  const updated = await client.updateIssue(existing.id, {
    labelIds: mergedIds,
  });
  const handle = await context.writeResource(
    "issue",
    updated.id,
    issueResourceData(updated),
  );
  return { dataHandles: [handle] };
}

/** List available labels for a team. */
export async function listLabels(
  client: LinearClient,
  context: MethodContext,
  args: { teamId?: string },
): Promise<MethodResult> {
  const teamId = args.teamId || context.globalArgs.defaultTeamId;
  if (!teamId) {
    throw new Error("No teamId specified and no defaultTeamId configured");
  }

  context.logger.info(`Listing labels for team ${teamId}`);
  const labels = await client.listLabels(teamId);
  const handles: DataHandle[] = [];

  for (const l of labels) {
    handles.push(
      await context.writeResource("label", l.id, {
        id: l.id,
        name: l.name,
        color: l.color,
        syncedAt: new Date().toISOString(),
      }),
    );
  }

  return { dataHandles: handles };
}

/** Create an issue with full control over all fields. */
export async function createIssue(
  client: LinearClient,
  context: MethodContext,
  args: {
    title: string;
    description?: string;
    teamId?: string;
    projectId?: string;
    priority?: number;
    stateId?: string;
    assigneeId?: string;
  },
): Promise<MethodResult> {
  const teamId = args.teamId || context.globalArgs.defaultTeamId;
  if (!teamId) {
    throw new Error("No teamId specified and no defaultTeamId configured");
  }

  context.logger.info(`Creating issue "${args.title}" in team ${teamId}`);

  const issue = await client.createIssue({
    title: args.title,
    description: args.description,
    teamId,
    projectId: args.projectId,
    priority: args.priority,
    stateId: args.stateId,
    assigneeId: args.assigneeId,
  });

  const handle = await context.writeResource(
    "issue",
    issue.id,
    issueResourceData(issue),
  );
  return { dataHandles: [handle] };
}

/** List all Linear teams and sync them as resources. */
export async function listTeams(
  client: LinearClient,
  context: MethodContext,
): Promise<MethodResult> {
  context.logger.info("Listing Linear teams");
  const teams = await client.listTeams();
  const handles: DataHandle[] = [];

  for (const t of teams) {
    handles.push(
      await context.writeResource("team", t.id, {
        id: t.id,
        name: t.name,
        key: t.key,
        syncedAt: new Date().toISOString(),
      }),
    );
  }

  return { dataHandles: handles };
}

/** List Linear projects, optionally filtered by team. */
export async function listProjects(
  client: LinearClient,
  context: MethodContext,
  args: { teamId?: string; filter?: string },
): Promise<MethodResult> {
  const teamId = args.teamId || context.globalArgs.defaultTeamId;
  context.logger.info(
    teamId ? `Listing projects for team ${teamId}` : "Listing all projects",
  );

  const projects = await client.listProjects(teamId);
  const handles: DataHandle[] = [];

  for (const p of projects) {
    if (args.filter && !p.name.includes(args.filter)) continue;
    handles.push(
      await context.writeResource("project", p.id, {
        id: p.id,
        name: p.name,
        state: p.state,
        syncedAt: new Date().toISOString(),
      }),
    );
  }

  return { dataHandles: handles };
}

/** List workflow states for a team and sync them as resources. */
export async function listStates(
  client: LinearClient,
  context: MethodContext,
  args: { teamId?: string },
): Promise<MethodResult> {
  const teamId = args.teamId || context.globalArgs.defaultTeamId;
  if (!teamId) {
    throw new Error("No teamId specified and no defaultTeamId configured");
  }

  context.logger.info(`Listing workflow states for team ${teamId}`);
  const states = await client.listStates(teamId);
  const handles: DataHandle[] = [];

  for (const s of states) {
    handles.push(
      await context.writeResource("workflowState", s.id, {
        id: s.id,
        name: s.name,
        type: s.type,
        color: s.color,
        syncedAt: new Date().toISOString(),
      }),
    );
  }

  return { dataHandles: handles };
}
