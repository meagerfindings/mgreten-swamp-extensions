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
  logger: {
    info: (msg: string, properties?: Record<string, unknown>) => void;
  };
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

const WRITE_CONCURRENCY = 10;

async function writeInBatches<T>(
  items: T[],
  write: (item: T) => Promise<DataHandle>,
): Promise<DataHandle[]> {
  const handles: DataHandle[] = [];
  for (let index = 0; index < items.length; index += WRITE_CONCURRENCY) {
    const settled = await Promise.allSettled(
      items.slice(index, index + WRITE_CONCURRENCY).map((item) =>
        Promise.resolve().then(() => write(item))
      ),
    );
    const rejected = settled.find((result): result is PromiseRejectedResult =>
      result.status === "rejected"
    );
    if (rejected) throw rejected.reason;
    handles.push(
      ...settled.map((result) =>
        (result as PromiseFulfilledResult<DataHandle>).value
      ),
    );
  }
  return handles;
}

function logValue(value: string, context: MethodContext): string {
  const token = context.globalArgs.apiToken;
  return token ? value.split(token).join("[REDACTED]") : value;
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
  context.logger.info("Syncing Todoist tasks", {
    filtered: args.filter !== undefined,
  });
  const tasks = await client.getTasks(args.filter);
  const handles = await writeInBatches(
    tasks,
    (task) => context.writeResource("task", task.id, taskResourceData(task)),
  );
  context.logger.info("Synced {taskCount} Todoist tasks", {
    taskCount: handles.length,
    filtered: args.filter !== undefined,
  });
  return { dataHandles: handles };
}

/** Fetch all Todoist projects and sync them as resources. */
export async function syncProjects(
  client: TodoistClient,
  context: MethodContext,
): Promise<MethodResult> {
  context.logger.info("Syncing Todoist projects");
  const projects = await client.getProjects();
  const handles = await writeInBatches(
    projects,
    (project) =>
      context.writeResource(
        "project",
        project.id,
        projectResourceData(project),
      ),
  );
  context.logger.info("Synced {projectCount} Todoist projects", {
    projectCount: handles.length,
  });
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
  context.logger.info("Creating Todoist task", {
    projectId: logValue(input.projectId ?? "inbox", context),
  });
  const task = await client.createTask(input);
  const handle = await context.writeResource(
    "task",
    task.id,
    taskResourceData(task),
  );
  context.logger.info("Created Todoist task {taskId}", {
    taskId: logValue(task.id, context),
    projectId: logValue(task.projectId, context),
  });
  return { dataHandles: [handle] };
}

/**
 * Mark a task as completed.
 *
 * Regular tasks are archived after closing, so their final active snapshot is
 * retained with `isCompleted` set. Recurring tasks remain active with a new due
 * date, so they are fetched again after closing.
 */
export async function completeTask(
  client: TodoistClient,
  context: MethodContext,
  args: { taskId: string },
): Promise<MethodResult> {
  context.logger.info("Completing Todoist task {taskId}", {
    taskId: logValue(args.taskId, context),
  });
  const task = await client.getTask(args.taskId);
  await client.closeTask(args.taskId);
  const completedTask = task.isRecurring
    ? await client.getTask(args.taskId)
    : { ...task, isCompleted: true };
  const handle = await context.writeResource(
    "task",
    completedTask.id,
    taskResourceData(completedTask),
  );
  context.logger.info("Completed Todoist task {taskId}", {
    taskId: logValue(completedTask.id, context),
    recurring: task.isRecurring,
  });
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
  context.logger.info("Updating Todoist task {taskId}", {
    taskId: logValue(args.taskId, context),
  });
  const task = await client.updateTask(args.taskId, input);
  const handle = await context.writeResource(
    "task",
    task.id,
    taskResourceData(task),
  );
  context.logger.info("Updated Todoist task {taskId}", {
    taskId: logValue(task.id, context),
  });
  return { dataHandles: [handle] };
}

/** Permanently delete a task. */
export async function deleteTask(
  client: TodoistClient,
  context: MethodContext,
  args: { taskId: string },
): Promise<MethodResult> {
  context.logger.info("Deleting Todoist task {taskId}", {
    taskId: logValue(args.taskId, context),
  });
  await client.deleteTask(args.taskId);
  context.logger.info("Todoist task {taskId} is absent", {
    taskId: logValue(args.taskId, context),
  });
  return { dataHandles: [] };
}
