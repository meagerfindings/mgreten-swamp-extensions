/**
 * @mgreten/linear — Linear project management integration for swamp.
 *
 * Provides issue CRUD, viewer resolution, label management, and team/project/state
 * listing via the official `@linear/sdk`. All data is written as swamp resources
 * for downstream CEL access and workflow chaining.
 *
 * Client abstraction pattern derived from `@hivemq/linear` by HiveMQ.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { LinearClient as LinearSDKClient } from "npm:@linear/sdk@80.0.0";
import { buildLinearClient } from "./linear/client.ts";
import type { LinearSDKLike } from "./linear/client.ts";
import type { MethodContext, MethodResult } from "./linear/methods.ts";
import {
  addLabels,
  createIssue,
  createMyIssue,
  getIssue,
  getViewer,
  listIssues,
  listLabels,
  listProjects,
  listStates,
  listTeams,
  updateIssue,
} from "./linear/methods.ts";

const GlobalArgsSchema = z.object({
  apiKey: z
    .string()
    .describe("Linear personal API key")
    .meta({ sensitive: true }),
  defaultTeamId: z
    .string()
    .optional()
    .describe("Default team ID used when no teamId is specified"),
  defaultProjectId: z
    .string()
    .optional()
    .describe("Default project ID for createMyIssue"),
});

const IssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string(),
  url: z.string(),
  priority: z.number(),
  stateId: z.string(),
  stateName: z.string(),
  stateType: z.string(),
  teamId: z.string(),
  teamKey: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  assigneeId: z.string(),
  assigneeName: z.string(),
  labelNames: z.string(),
  syncedAt: z.string(),
});

const TeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  syncedAt: z.string(),
});

const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  syncedAt: z.string(),
});

const WorkflowStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  color: z.string(),
  syncedAt: z.string(),
});

const ViewerSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  syncedAt: z.string(),
});

const LabelSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  syncedAt: z.string(),
});

function getClient(
  context: MethodContext,
): ReturnType<typeof buildLinearClient> {
  const sdk = new LinearSDKClient({
    apiKey: context.globalArgs.apiKey,
  }) as unknown as LinearSDKLike;
  return buildLinearClient(sdk);
}

/**
 * Linear project management model for swamp.
 *
 * Provides 11 methods for managing Linear issues, teams, projects, labels,
 * and workflow states. Supports auto-assignment via viewer resolution and
 * label attachment by name.
 */
export const model = {
  type: "@mgreten/linear",
  version: "2026.06.27.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    issue: {
      description: "A Linear issue with resolved relations",
      schema: IssueSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
    team: {
      description: "A Linear team",
      schema: TeamSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    project: {
      description: "A Linear project",
      schema: ProjectSchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
    workflowState: {
      description: "A Linear workflow state (e.g. Backlog, In Progress, Done)",
      schema: WorkflowStateSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    viewer: {
      description: "The authenticated Linear user",
      schema: ViewerSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    label: {
      description: "A Linear issue label",
      schema: LabelSchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
  },
  methods: {
    getViewer: {
      description: "Resolve the authenticated user's ID, name, and email",
      arguments: z.object({}),
      execute: (_args: unknown, context: unknown): Promise<MethodResult> =>
        getViewer(
          getClient(context as MethodContext),
          context as MethodContext,
        ),
    },

    createMyIssue: {
      description:
        "Create an issue auto-assigned to the authenticated user with team/project defaults",
      arguments: z.object({
        title: z.string().describe("Issue title"),
        description: z
          .string()
          .optional()
          .describe("Issue description (Markdown)"),
        priority: z
          .number()
          .min(0)
          .max(4)
          .optional()
          .describe("Priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low"),
        projectId: z
          .string()
          .optional()
          .describe("Override project ID (defaults to defaultProjectId)"),
        labels: z
          .string()
          .optional()
          .describe("Comma-separated label names to attach"),
      }),
      execute: (args: unknown, context: unknown): Promise<MethodResult> =>
        createMyIssue(
          getClient(context as MethodContext),
          context as MethodContext,
          args as {
            title: string;
            description?: string;
            priority?: number;
            projectId?: string;
            labels?: string;
          },
        ),
    },

    getIssue: {
      description: "Fetch a single issue by identifier (e.g. ENG-123) or UUID",
      arguments: z.object({
        identifier: z
          .string()
          .describe("Issue identifier (e.g. ENG-123) or UUID"),
      }),
      execute: (args: unknown, context: unknown): Promise<MethodResult> =>
        getIssue(
          getClient(context as MethodContext),
          context as MethodContext,
          args as { identifier: string },
        ),
    },

    updateIssue: {
      description: "Update fields on an existing issue",
      arguments: z.object({
        identifier: z
          .string()
          .describe("Issue identifier (e.g. ENG-123) or UUID"),
        title: z.string().optional().describe("New title"),
        description: z.string().optional().describe("New description"),
        stateId: z.string().optional().describe("New workflow state ID"),
        priority: z
          .number()
          .min(0)
          .max(4)
          .optional()
          .describe("New priority"),
        assigneeId: z.string().optional().describe("New assignee user ID"),
        projectId: z.string().optional().describe("New project ID"),
      }),
      execute: (args: unknown, context: unknown): Promise<MethodResult> =>
        updateIssue(
          getClient(context as MethodContext),
          context as MethodContext,
          args as {
            identifier: string;
            title?: string;
            description?: string;
            stateId?: string;
            priority?: number;
            assigneeId?: string;
            projectId?: string;
          },
        ),
    },

    listIssues: {
      description: "Query issues with filters",
      arguments: z.object({
        teamId: z
          .string()
          .optional()
          .describe("Filter by team ID (defaults to defaultTeamId)"),
        assignedToMe: z
          .boolean()
          .optional()
          .describe("Only show issues assigned to the authenticated user"),
        stateType: z
          .string()
          .optional()
          .describe(
            "Filter by state type: backlog, unstarted, started, completed, canceled",
          ),
        projectId: z.string().optional().describe("Filter by project ID"),
        labelName: z.string().optional().describe("Filter by label name"),
      }),
      execute: (args: unknown, context: unknown): Promise<MethodResult> =>
        listIssues(
          getClient(context as MethodContext),
          context as MethodContext,
          args as {
            teamId?: string;
            assignedToMe?: boolean;
            stateType?: string;
            projectId?: string;
            labelName?: string;
          },
        ),
    },

    addLabels: {
      description:
        "Attach labels to an issue by name (additive — preserves existing labels)",
      arguments: z.object({
        identifier: z
          .string()
          .describe("Issue identifier (e.g. ENG-123) or UUID"),
        labels: z.string().describe("Comma-separated label names to add"),
      }),
      execute: (args: unknown, context: unknown): Promise<MethodResult> =>
        addLabels(
          getClient(context as MethodContext),
          context as MethodContext,
          args as { identifier: string; labels: string },
        ),
    },

    listLabels: {
      description: "List available labels for a team",
      arguments: z.object({
        teamId: z
          .string()
          .optional()
          .describe("Team ID (defaults to defaultTeamId)"),
      }),
      execute: (args: unknown, context: unknown): Promise<MethodResult> =>
        listLabels(
          getClient(context as MethodContext),
          context as MethodContext,
          args as { teamId?: string },
        ),
    },

    createIssue: {
      description: "Create an issue with full control over all fields",
      arguments: z.object({
        title: z.string().describe("Issue title"),
        description: z
          .string()
          .optional()
          .describe("Issue description (Markdown)"),
        teamId: z
          .string()
          .optional()
          .describe("Team ID (defaults to defaultTeamId)"),
        projectId: z.string().optional().describe("Project ID"),
        priority: z
          .number()
          .min(0)
          .max(4)
          .optional()
          .describe("Priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low"),
        stateId: z.string().optional().describe("Workflow state ID"),
        assigneeId: z.string().optional().describe("Assignee user ID"),
      }),
      execute: (args: unknown, context: unknown): Promise<MethodResult> =>
        createIssue(
          getClient(context as MethodContext),
          context as MethodContext,
          args as {
            title: string;
            description?: string;
            teamId?: string;
            projectId?: string;
            priority?: number;
            stateId?: string;
            assigneeId?: string;
          },
        ),
    },

    listTeams: {
      description: "List all Linear teams and sync them as resources",
      arguments: z.object({}),
      execute: (_args: unknown, context: unknown): Promise<MethodResult> =>
        listTeams(
          getClient(context as MethodContext),
          context as MethodContext,
        ),
    },

    listProjects: {
      description:
        "List Linear projects, optionally filtered by team or name substring",
      arguments: z.object({
        teamId: z
          .string()
          .optional()
          .describe("Filter by team ID (defaults to defaultTeamId)"),
        filter: z
          .string()
          .optional()
          .describe("Only include projects whose name contains this string"),
      }),
      execute: (args: unknown, context: unknown): Promise<MethodResult> =>
        listProjects(
          getClient(context as MethodContext),
          context as MethodContext,
          args as { teamId?: string; filter?: string },
        ),
    },

    listStates: {
      description: "List workflow states for a team and sync them as resources",
      arguments: z.object({
        teamId: z
          .string()
          .optional()
          .describe("Team ID (defaults to defaultTeamId)"),
      }),
      execute: (args: unknown, context: unknown): Promise<MethodResult> =>
        listStates(
          getClient(context as MethodContext),
          context as MethodContext,
          args as { teamId?: string },
        ),
    },
  },
};
