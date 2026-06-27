/**
 * @mgreten/todoist — Todoist task management integration for swamp.
 *
 * Provides task and project CRUD via the Todoist REST API v2. Every API
 * response is written as a swamp resource, making it available for CEL
 * expressions, data queries, and workflow chaining.
 *
 * No external npm dependencies — uses the runtime's built-in `fetch`.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { buildTodoistClient } from "./todoist/client.ts";
import type { MethodContext, MethodResult } from "./todoist/methods.ts";
import {
  completeTask,
  createTask,
  deleteTask,
  syncProjects,
  syncTasks,
  updateTask,
} from "./todoist/methods.ts";

const GlobalArgsSchema = z.object({
  apiToken: z
    .string()
    .describe("Todoist API token")
    .meta({ sensitive: true }),
  defaultProjectId: z
    .string()
    .optional()
    .describe("Default project ID used when no projectId is specified"),
});

const TaskSchema = z.object({
  id: z.string(),
  content: z.string(),
  description: z.string(),
  projectId: z.string(),
  sectionId: z.string(),
  parentId: z.string(),
  labels: z.array(z.string()),
  priority: z.number(),
  dueDate: z.string(),
  dueDatetime: z.string(),
  dueString: z.string(),
  isCompleted: z.boolean(),
  url: z.string(),
  createdAt: z.string(),
  assigneeId: z.string(),
  order: z.number(),
  syncedAt: z.string(),
});

const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  parentId: z.string(),
  order: z.number(),
  isShared: z.boolean(),
  isFavorite: z.boolean(),
  isInboxProject: z.boolean(),
  url: z.string(),
  syncedAt: z.string(),
});

function getClient(
  context: MethodContext,
): ReturnType<typeof buildTodoistClient> {
  return buildTodoistClient(context.globalArgs.apiToken);
}

/**
 * Todoist task management model for swamp.
 *
 * Provides 6 methods for managing tasks and projects via the Todoist REST
 * API v2. Supports Todoist's native filter syntax for task queries and
 * natural language due dates for task creation and updates.
 */
export const model = {
  type: "@mgreten/todoist",
  version: "2026.06.27.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    task: {
      description: "A Todoist task with full metadata",
      schema: TaskSchema,
      lifetime: "infinite" as const,
      garbageCollection: 500,
    },
    project: {
      description: "A Todoist project",
      schema: ProjectSchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
  },
  methods: {
    syncTasks: {
      description:
        "Fetch active tasks and write them as resources. Accepts Todoist filter syntax (e.g. 'today', '#Work', '@label', 'priority 1').",
      arguments: z.object({
        filter: z
          .string()
          .optional()
          .describe(
            "Todoist filter query (e.g. 'today', '#Work', 'priority 1'). Omit to fetch all active tasks.",
          ),
      }),
      execute: (args: unknown, context: unknown): Promise<MethodResult> =>
        syncTasks(
          getClient(context as MethodContext),
          context as MethodContext,
          args as { filter?: string },
        ),
    },

    syncProjects: {
      description: "Fetch all Todoist projects and sync them as resources",
      arguments: z.object({}),
      execute: (_args: unknown, context: unknown): Promise<MethodResult> =>
        syncProjects(
          getClient(context as MethodContext),
          context as MethodContext,
        ),
    },

    createTask: {
      description: "Create a new Todoist task",
      arguments: z.object({
        content: z.string().describe("Task content (title)"),
        description: z
          .string()
          .optional()
          .describe("Task description (Markdown)"),
        projectId: z
          .string()
          .optional()
          .describe("Project ID (defaults to defaultProjectId)"),
        sectionId: z
          .string()
          .optional()
          .describe("Section ID within the project"),
        labels: z
          .string()
          .optional()
          .describe("Comma-separated label names"),
        priority: z
          .number()
          .min(1)
          .max(4)
          .optional()
          .describe("Priority: 1=normal, 2=medium, 3=high, 4=urgent"),
        dueString: z
          .string()
          .optional()
          .describe(
            "Natural language due date (e.g. 'today', 'next Monday', 'in 3 days')",
          ),
      }),
      execute: (args: unknown, context: unknown): Promise<MethodResult> =>
        createTask(
          getClient(context as MethodContext),
          context as MethodContext,
          args as {
            content: string;
            description?: string;
            projectId?: string;
            sectionId?: string;
            labels?: string;
            priority?: number;
            dueString?: string;
          },
        ),
    },

    completeTask: {
      description: "Mark a task as completed",
      arguments: z.object({
        taskId: z.string().describe("Todoist task ID"),
      }),
      execute: (args: unknown, context: unknown): Promise<MethodResult> =>
        completeTask(
          getClient(context as MethodContext),
          context as MethodContext,
          args as { taskId: string },
        ),
    },

    updateTask: {
      description: "Update fields on an existing task",
      arguments: z.object({
        taskId: z.string().describe("Todoist task ID"),
        content: z.string().optional().describe("New task content"),
        description: z.string().optional().describe("New description"),
        labels: z
          .string()
          .optional()
          .describe("Comma-separated label names (replaces existing labels)"),
        priority: z
          .number()
          .min(1)
          .max(4)
          .optional()
          .describe("New priority: 1=normal, 2=medium, 3=high, 4=urgent"),
        dueString: z
          .string()
          .optional()
          .describe("New due date in natural language"),
      }),
      execute: (args: unknown, context: unknown): Promise<MethodResult> =>
        updateTask(
          getClient(context as MethodContext),
          context as MethodContext,
          args as {
            taskId: string;
            content?: string;
            description?: string;
            labels?: string;
            priority?: number;
            dueString?: string;
          },
        ),
    },

    deleteTask: {
      description: "Permanently delete a task",
      arguments: z.object({
        taskId: z.string().describe("Todoist task ID"),
      }),
      execute: (args: unknown, context: unknown): Promise<MethodResult> =>
        deleteTask(
          getClient(context as MethodContext),
          context as MethodContext,
          args as { taskId: string },
        ),
    },
  },
};
