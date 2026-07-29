import { z } from "npm:zod@4";
import { buildTodoistClient } from "./todoist/client.ts";
import { createComment, syncTaskComments } from "./todoist/comments.ts";
import {
  completeTask,
  createTask,
  deleteTask,
  moveTasks,
  syncProjects,
  syncTasks,
  updateTask,
} from "./todoist/methods.ts";
import type { MethodContext, MethodResult } from "./todoist/methods.ts";

const GlobalArgsSchema = z.object({
  apiToken: z.string().describe("Todoist API token").meta({ sensitive: true }),
  defaultProjectId: z.string().optional().describe(
    "Default project ID used when no projectId is specified",
  ),
});
const TodoistIdSchema = z.string().regex(
  /^[A-Za-z0-9_-]+$/,
  "Todoist IDs may contain letters, numbers, hyphens, and underscores",
);
const RequestIdSchema = z.uuid().describe(
  "Stable UUID sent as X-Request-Id; reuse it when retrying task creation",
);
const MoveTaskSchema = z.object({
  taskId: TodoistIdSchema.describe("Todoist task ID"),
  projectId: TodoistIdSchema.optional().describe(
    "Destination project ID",
  ),
  sectionId: TodoistIdSchema.optional().describe(
    "Destination section ID",
  ),
  parentId: TodoistIdSchema.optional().describe(
    "Destination parent task ID",
  ),
}).refine(
  (move) =>
    [move.projectId, move.sectionId, move.parentId].filter((id) =>
      id !== undefined
    ).length === 1,
  { message: "Each move must specify exactly one destination" },
);
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
  createdAt: z.string().nullable(),
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
const CommentSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  projectId: z.string(),
  content: z.string(),
  postedAt: z.string(),
  attachment: z.unknown().nullable(),
  syncedAt: z.string(),
});
function client(context: MethodContext) {
  return buildTodoistClient(context.globalArgs.apiToken);
}

/** Typed Todoist model with task, project, and task-comment resources. */
export const model = {
  type: "@mgreten/todoist",
  version: "2026.07.29.1",
  upgrades: [
    {
      toVersion: "2026.07.23.1",
      description: "Migrate Todoist transport to API v1; no argument changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.07.24.1",
      description:
        "Harden API transport and synchronization; no argument changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.07.27.3",
      description: "Add task-comment synchronization and creation",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.07.28.1",
      description:
        "Allow createTask to assign a parent task; no stored changes",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.07.28.2",
      description:
        "Add createTask request IDs and live mutation preflight; no stored changes",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.07.29.1",
      description:
        "Add fan-out task moves and document clearing labels; no stored changes",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    task: {
      description: "A Todoist task with normalized metadata",
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
    comment: {
      description: "A Todoist task comment with normalized metadata",
      schema: CommentSchema,
      lifetime: "infinite" as const,
      garbageCollection: 1000,
    },
  },
  checks: {
    "todoist-connectivity": {
      description:
        "Verify Todoist connectivity and authentication before mutations",
      labels: ["live"],
      appliesTo: [
        "createTaskComment",
        "createTask",
        "completeTask",
        "updateTask",
        "moveTasks",
        "deleteTask",
      ],
      execute: async (context: { globalArgs: { apiToken: string } }) => {
        try {
          await buildTodoistClient(context.globalArgs.apiToken)
            .checkConnection();
          return { pass: true };
        } catch (error) {
          const token = context.globalArgs.apiToken;
          const detail =
            (error instanceof Error ? error.message : String(error))
              .split(token).join("[REDACTED]");
          return {
            pass: false,
            errors: [`Cannot connect to Todoist: ${detail}`],
          };
        }
      },
    },
  },
  methods: {
    syncTasks: {
      description:
        "Fetch active tasks and write them as resources. Accepts Todoist filter syntax.",
      arguments: z.object({
        filter: z.string().optional().describe(
          "Todoist filter query; omit to fetch all active tasks",
        ),
      }),
      execute: (args: unknown, context: unknown): Promise<MethodResult> =>
        syncTasks(
          client(context as MethodContext),
          context as MethodContext,
          args as { filter?: string },
        ),
    },
    syncProjects: {
      description: "Fetch all Todoist projects and sync them as resources",
      arguments: z.object({}),
      execute: (_args: unknown, context: unknown): Promise<MethodResult> =>
        syncProjects(
          client(context as MethodContext),
          context as MethodContext,
        ),
    },
    syncTaskComments: {
      description:
        "Fetch every comment for one Todoist task and write normalized comment resources",
      arguments: z.object({
        taskId: TodoistIdSchema.describe("Todoist task ID"),
      }),
      execute: (args: unknown, context: unknown): Promise<MethodResult> =>
        syncTaskComments(context as MethodContext, args as { taskId: string }),
    },
    createTaskComment: {
      description:
        "Create a comment on a Todoist task and write its normalized resource",
      arguments: z.object({
        taskId: TodoistIdSchema.describe("Todoist task ID"),
        content: z.string().trim().min(1).max(10_000).describe("Comment text"),
      }),
      execute: (args: unknown, context: unknown): Promise<MethodResult> =>
        createComment(
          context as MethodContext,
          args as { taskId: string; content: string },
        ),
    },
    createTask: {
      description: "Create a new Todoist task",
      arguments: z.object({
        content: z.string().describe("Task content (title)"),
        description: z.string().optional().describe(
          "Task description (Markdown)",
        ),
        projectId: z.string().optional().describe(
          "Project ID (defaults to defaultProjectId)",
        ),
        sectionId: z.string().optional().describe(
          "Section ID within the project",
        ),
        parentId: TodoistIdSchema.optional().describe(
          "Parent task ID for creating a subtask",
        ),
        labels: z.string().optional().describe("Comma-separated label names"),
        priority: z.number().int().min(1).max(4).optional().describe(
          "Priority: 1=normal, 2=medium, 3=high, 4=urgent",
        ),
        dueString: z.string().optional().describe("Natural language due date"),
        requestId: RequestIdSchema.optional(),
      }),
      execute: (args: unknown, context: unknown): Promise<MethodResult> =>
        createTask(
          client(context as MethodContext),
          context as MethodContext,
          args as {
            content: string;
            description?: string;
            projectId?: string;
            sectionId?: string;
            parentId?: string;
            labels?: string;
            priority?: number;
            dueString?: string;
            requestId?: string;
          },
        ),
    },
    completeTask: {
      description: "Mark a task as completed",
      arguments: z.object({
        taskId: TodoistIdSchema.describe("Todoist task ID"),
      }),
      execute: (args: unknown, context: unknown): Promise<MethodResult> =>
        completeTask(
          client(context as MethodContext),
          context as MethodContext,
          args as { taskId: string },
        ),
    },
    updateTask: {
      description: "Update fields on an existing task",
      arguments: z.object({
        taskId: TodoistIdSchema.describe("Todoist task ID"),
        content: z.string().optional().describe("New task content"),
        description: z.string().optional().describe("New description"),
        labels: z.string().optional().describe(
          "Comma-separated label names; replaces existing labels, and an empty string clears all labels",
        ),
        priority: z.number().int().min(1).max(4).optional().describe(
          "New priority",
        ),
        dueString: z.string().optional().describe("New due date"),
      }),
      execute: (args: unknown, context: unknown): Promise<MethodResult> =>
        updateTask(
          client(context as MethodContext),
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
    moveTasks: {
      description:
        "Move one or more existing task trees to a project, section, or parent task",
      arguments: z.object({
        moves: z.array(MoveTaskSchema).min(1).max(100).describe(
          "Task moves processed in order within one model execution",
        ),
      }),
      execute: (args: unknown, context: unknown): Promise<MethodResult> =>
        moveTasks(
          client(context as MethodContext),
          context as MethodContext,
          args as {
            moves: Array<{
              taskId: string;
              projectId?: string;
              sectionId?: string;
              parentId?: string;
            }>;
          },
        ),
    },
    deleteTask: {
      description: "Permanently delete a task",
      arguments: z.object({
        taskId: TodoistIdSchema.describe("Todoist task ID"),
      }),
      execute: (args: unknown, context: unknown): Promise<MethodResult> =>
        deleteTask(
          client(context as MethodContext),
          context as MethodContext,
          args as { taskId: string },
        ),
    },
  },
};
