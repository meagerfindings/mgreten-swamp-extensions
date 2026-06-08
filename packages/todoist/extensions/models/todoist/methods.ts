/**
 * Method implementations for the Todoist swamp model.
 *
 * Each exported function receives a {@link TodoistClient}, a swamp
 * {@link MethodContext}, and method-specific arguments. Returns a
 * {@link MethodResult} containing data handles for all written resources.
 *
 * @module
 */

import type {
  CreateTaskInput,
  ProjectData,
  TaskData,
  TodoistClient,
  UpdateTaskInput,
} from "./client.ts";

/** Global arguments available to all methods. */
export interface GlobalArgs {
  apiToken: string;
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

function taskResourceData(task: TaskData): Record<string, unknown> {
  return {
    id: task.id,
    content: task.content,
    description: task.description,
    projectId: task.projectId,
    sectionId: task.sectionId,
    parentId: task.parentId,
    labels: task.labels,
    priority: task.priority,
    dueDate: task.dueDate,
    dueDatetime: task.dueDatetime,
    dueString: task.dueString,
    isCompleted: task.isCompleted,
    url: task.url,
    createdAt: task.createdAt,
    assigneeId: task.assigneeId,
    order: task.order,
    syncedAt: new Date().toISOString(),
  };
}

function projectResourceData(project: ProjectData): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    color: project.color,
    parentId: project.parentId,
    order: project.order,
    isShared: project.isShared,
    isFavorite: project.isFavorite,
    isInboxProject: project.isInboxProject,
    url: project.url,
    syncedAt: new Date().toISOString(),
  };
}

/** Fetch active tasks, optionally filtered by Todoist query syntax. */
export async function syncTasks(
  client: TodoistClient,
  context: MethodContext,
  args: { filter?: string },
): Promise<MethodResult> {
  context.logger.info(
    `Syncing tasks${args.filter ? ` (filter: ${args.filter})` : ""}`,
  );
  const tasks = await client.getTasks(args.filter);
  context.logger.info(`Found ${tasks.length} tasks`);
  const handles = await Promise.all(
    tasks.map((task) =>
      context.writeResource("task", task.id, taskResourceData(task))
    ),
  );
  return { dataHandles: handles };
}

/** Fetch all Todoist projects and sync them as resources. */
export async function syncProjects(
  client: TodoistClient,
  context: MethodContext,
): Promise<MethodResult> {
  context.logger.info("Syncing projects");
  const projects = await client.getProjects();
  context.logger.info(`Found ${projects.length} projects`);
  const handles = await Promise.all(
    projects.map((project) =>
      context.writeResource(
        "project",
        project.id,
        projectResourceData(project),
      )
    ),
  );
  return { dataHandles: handles };
}

/** Create a new Todoist task. */
export async function createTask(
  client: TodoistClient,
  context: MethodContext,
  args: {
    content: string;
    description?: string;
    projectId?: string;
    sectionId?: string;
    labels?: string;
    priority?: number;
    dueString?: string;
  },
): Promise<MethodResult> {
  const input: CreateTaskInput = { content: args.content };
  if (args.description !== undefined) input.description = args.description;
  input.projectId = args.projectId ?? context.globalArgs.defaultProjectId;
  if (args.sectionId !== undefined) input.sectionId = args.sectionId;
  if (args.labels !== undefined) {
    input.labels = args.labels.split(",").map((l) => l.trim()).filter(Boolean);
  }
  if (args.priority !== undefined) input.priority = args.priority;
  if (args.dueString !== undefined) input.dueString = args.dueString;
  context.logger.info(`Creating task: ${args.content}`);
  const task = await client.createTask(input);
  const handle = await context.writeResource(
    "task",
    task.id,
    taskResourceData(task),
  );
  return { dataHandles: [handle] };
}

/**
 * Mark a task as completed.
 *
 * Fetches the task before closing so the resource reflects the final state.
 * The Todoist REST API returns 204 from the close endpoint with no body.
 */
export async function completeTask(
  client: TodoistClient,
  context: MethodContext,
  args: { taskId: string },
): Promise<MethodResult> {
  context.logger.info(`Completing task ${args.taskId}`);
  const task = await client.getTask(args.taskId);
  await client.closeTask(args.taskId);
  const data = taskResourceData(task);
  data.isCompleted = true;
  const handle = await context.writeResource("task", task.id, data);
  return { dataHandles: [handle] };
}

/** Update fields on an existing task. */
export async function updateTask(
  client: TodoistClient,
  context: MethodContext,
  args: {
    taskId: string;
    content?: string;
    description?: string;
    labels?: string;
    priority?: number;
    dueString?: string;
  },
): Promise<MethodResult> {
  const input: UpdateTaskInput = {};
  if (args.content !== undefined) input.content = args.content;
  if (args.description !== undefined) input.description = args.description;
  if (args.labels !== undefined) {
    input.labels = args.labels.split(",").map((l) => l.trim()).filter(Boolean);
  }
  if (args.priority !== undefined) input.priority = args.priority;
  if (args.dueString !== undefined) input.dueString = args.dueString;
  context.logger.info(`Updating task ${args.taskId}`);
  const task = await client.updateTask(args.taskId, input);
  const handle = await context.writeResource(
    "task",
    task.id,
    taskResourceData(task),
  );
  return { dataHandles: [handle] };
}

/** Permanently delete a task. */
export async function deleteTask(
  client: TodoistClient,
  context: MethodContext,
  args: { taskId: string },
): Promise<MethodResult> {
  context.logger.info(`Deleting task ${args.taskId}`);
  await client.deleteTask(args.taskId);
  return { dataHandles: [] };
}
