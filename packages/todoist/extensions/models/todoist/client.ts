/**
 * Todoist REST API v2 client abstraction.
 *
 * Normalizes the REST API's snake_case responses into typed, camelCase
 * interfaces for use by swamp method implementations. No external npm
 * dependencies — uses the runtime's built-in `fetch`.
 *
 * @module
 */

const BASE_URL = "https://api.todoist.com/rest/v2";

/** Flat representation of a Todoist task with normalized field names. */
export interface TaskData {
  id: string;
  content: string;
  description: string;
  projectId: string;
  sectionId: string;
  parentId: string;
  labels: string[];
  priority: number;
  dueDate: string;
  dueDatetime: string;
  dueString: string;
  isCompleted: boolean;
  url: string;
  createdAt: string;
  assigneeId: string;
  order: number;
}

/** Flat representation of a Todoist project. */
export interface ProjectData {
  id: string;
  name: string;
  color: string;
  parentId: string;
  order: number;
  isShared: boolean;
  isFavorite: boolean;
  isInboxProject: boolean;
  url: string;
}

/** Input for creating a Todoist task. */
export interface CreateTaskInput {
  content: string;
  description?: string;
  projectId?: string;
  sectionId?: string;
  parentId?: string;
  labels?: string[];
  priority?: number;
  dueString?: string;
  dueLang?: string;
  assigneeId?: string;
  order?: number;
}

/** Input for updating a Todoist task. */
export interface UpdateTaskInput {
  content?: string;
  description?: string;
  labels?: string[];
  priority?: number;
  dueString?: string;
  dueLang?: string;
  assigneeId?: string;
}

interface RawDue {
  string?: string;
  date?: string;
  is_recurring?: boolean;
  datetime?: string;
  timezone?: string;
}

interface RawTask {
  id: string;
  content: string;
  description: string;
  project_id: string;
  section_id: string;
  parent_id: string;
  labels: string[];
  priority: number;
  due: RawDue | null;
  is_completed: boolean;
  url: string;
  created_at: string;
  assignee_id: string | null;
  order: number;
}

interface RawProject {
  id: string;
  name: string;
  color: string;
  parent_id: string | null;
  order: number;
  is_shared: boolean;
  is_favorite: boolean;
  is_inbox_project: boolean;
  url: string;
}

function normalizeTask(raw: RawTask): TaskData {
  return {
    id: raw.id,
    content: raw.content,
    description: raw.description ?? "",
    projectId: raw.project_id ?? "",
    sectionId: raw.section_id ?? "",
    parentId: raw.parent_id ?? "",
    labels: raw.labels ?? [],
    priority: raw.priority,
    dueDate: raw.due?.date ?? "",
    dueDatetime: raw.due?.datetime ?? "",
    dueString: raw.due?.string ?? "",
    isCompleted: raw.is_completed,
    url: raw.url,
    createdAt: raw.created_at,
    assigneeId: raw.assignee_id ?? "",
    order: raw.order,
  };
}

function normalizeProject(raw: RawProject): ProjectData {
  return {
    id: raw.id,
    name: raw.name,
    color: raw.color,
    parentId: raw.parent_id ?? "",
    order: raw.order,
    isShared: raw.is_shared,
    isFavorite: raw.is_favorite,
    isInboxProject: raw.is_inbox_project,
    url: raw.url,
  };
}

async function request<T>(
  apiToken: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  params?: Record<string, string>,
): Promise<T> {
  let url = `${BASE_URL}${path}`;
  if (params && Object.keys(params).length > 0) {
    url = `${url}?${new URLSearchParams(params)}`;
  }
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Todoist API ${method} ${path} → ${resp.status}: ${text}`);
  }
  if (resp.status === 204) return undefined as T;
  return resp.json() as Promise<T>;
}

/** High-level Todoist client with typed return values. */
export interface TodoistClient {
  /** Fetch active tasks, optionally filtered by Todoist query syntax. */
  getTasks(filter?: string): Promise<TaskData[]>;
  /** Fetch a single active task by ID. */
  getTask(id: string): Promise<TaskData>;
  /** Create a new task. */
  createTask(input: CreateTaskInput): Promise<TaskData>;
  /** Update fields on an existing task. */
  updateTask(id: string, input: UpdateTaskInput): Promise<TaskData>;
  /** Mark a task as completed. */
  closeTask(id: string): Promise<void>;
  /** Reopen a completed task. */
  reopenTask(id: string): Promise<void>;
  /** Permanently delete a task. */
  deleteTask(id: string): Promise<void>;
  /** Fetch all projects. */
  getProjects(): Promise<ProjectData[]>;
  /** Fetch a single project by ID. */
  getProject(id: string): Promise<ProjectData>;
}

/** Build a {@link TodoistClient} from a Todoist API token. */
export function buildTodoistClient(apiToken: string): TodoistClient {
  return {
    async getTasks(filter?: string): Promise<TaskData[]> {
      const params: Record<string, string> = {};
      if (filter) params.filter = filter;
      const raw = await request<RawTask[]>(
        apiToken,
        "GET",
        "/tasks",
        undefined,
        params,
      );
      return raw.map(normalizeTask);
    },

    async getTask(id: string): Promise<TaskData> {
      const raw = await request<RawTask>(apiToken, "GET", `/tasks/${id}`);
      return normalizeTask(raw);
    },

    async createTask(input: CreateTaskInput): Promise<TaskData> {
      const body: Record<string, unknown> = { content: input.content };
      if (input.description !== undefined) body.description = input.description;
      if (input.projectId !== undefined) body.project_id = input.projectId;
      if (input.sectionId !== undefined) body.section_id = input.sectionId;
      if (input.parentId !== undefined) body.parent_id = input.parentId;
      if (input.labels !== undefined) body.labels = input.labels;
      if (input.priority !== undefined) body.priority = input.priority;
      if (input.dueString !== undefined) body.due_string = input.dueString;
      if (input.dueLang !== undefined) body.due_lang = input.dueLang;
      if (input.assigneeId !== undefined) body.assignee_id = input.assigneeId;
      if (input.order !== undefined) body.order = input.order;
      const raw = await request<RawTask>(apiToken, "POST", "/tasks", body);
      return normalizeTask(raw);
    },

    async updateTask(id: string, input: UpdateTaskInput): Promise<TaskData> {
      const body: Record<string, unknown> = {};
      if (input.content !== undefined) body.content = input.content;
      if (input.description !== undefined) body.description = input.description;
      if (input.labels !== undefined) body.labels = input.labels;
      if (input.priority !== undefined) body.priority = input.priority;
      if (input.dueString !== undefined) body.due_string = input.dueString;
      if (input.dueLang !== undefined) body.due_lang = input.dueLang;
      if (input.assigneeId !== undefined) body.assignee_id = input.assigneeId;
      const raw = await request<RawTask>(
        apiToken,
        "POST",
        `/tasks/${id}`,
        body,
      );
      return normalizeTask(raw);
    },

    async closeTask(id: string): Promise<void> {
      await request<void>(apiToken, "POST", `/tasks/${id}/close`);
    },

    async reopenTask(id: string): Promise<void> {
      await request<void>(apiToken, "POST", `/tasks/${id}/reopen`);
    },

    async deleteTask(id: string): Promise<void> {
      await request<void>(apiToken, "DELETE", `/tasks/${id}`);
    },

    async getProjects(): Promise<ProjectData[]> {
      const raw = await request<RawProject[]>(apiToken, "GET", "/projects");
      return raw.map(normalizeProject);
    },

    async getProject(id: string): Promise<ProjectData> {
      const raw = await request<RawProject>(
        apiToken,
        "GET",
        `/projects/${id}`,
      );
      return normalizeProject(raw);
    },
  };
}
