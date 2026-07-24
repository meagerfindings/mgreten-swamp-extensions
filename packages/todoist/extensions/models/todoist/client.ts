/**
 * Todoist API v1 client abstraction.
 *
 * Normalizes the API's snake_case responses into typed, camelCase
 * interfaces for use by swamp method implementations. Uses Zod to validate
 * untrusted API responses and the runtime's built-in `fetch` for transport.
 *
 * @module
 */

import { z } from "npm:zod@4";

const BASE_URL = "https://api.todoist.com/api/v1";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_GET_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 30_000;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

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
  isRecurring: boolean;
  isCompleted: boolean;
  url: string;
  createdAt: string | null;
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

const RawDueSchema = z.object({
  string: z.string(),
  date: z.string(),
  is_recurring: z.boolean(),
  datetime: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
});

const RawTaskSchema = z.object({
  id: z.string().regex(SAFE_ID_PATTERN),
  content: z.string(),
  description: z.string(),
  project_id: z.string(),
  section_id: z.string().nullable(),
  parent_id: z.string().nullable(),
  labels: z.array(z.string()),
  priority: z.number().int().min(1).max(4),
  due: RawDueSchema.nullable(),
  checked: z.boolean(),
  added_at: z.string().nullable(),
  responsible_uid: z.string().nullable(),
  child_order: z.number().int(),
});

const RawProjectSchema = z.object({
  id: z.string().regex(SAFE_ID_PATTERN),
  name: z.string(),
  color: z.string(),
  parent_id: z.string().nullable().optional(),
  child_order: z.number().int(),
  is_shared: z.boolean(),
  is_favorite: z.boolean(),
  inbox_project: z.boolean().optional(),
});

type RawTask = z.infer<typeof RawTaskSchema>;
type RawProject = z.infer<typeof RawProjectSchema>;

function listResponseSchema<T>(itemSchema: z.ZodType<T>) {
  return z.object({
    results: z.array(itemSchema),
    next_cursor: z.string().nullable(),
  });
}

function parseResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  operation: string,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const field = issue?.path.length ? issue.path.join(".") : "response";
  throw new Error(
    `Todoist API ${operation} returned an invalid response at ${field}: ${
      issue?.message ?? "validation failed"
    }`,
  );
}

class TodoistApiError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
    detail: string,
    readonly retryAfterMs?: number,
  ) {
    super(
      `Todoist API ${method} ${path} → ${status}${
        detail ? `: ${detail.slice(0, 1_000)}` : ""
      }`,
    );
    this.name = "TodoistApiError";
  }
}

function redactSecret(value: string, secret: string): string {
  return secret ? value.split(secret).join("[REDACTED]") : value;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - Date.now();
  if (!Number.isFinite(delay) || delay < 0) return undefined;
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError");
}

function timeoutError(method: string, path: string): Error {
  return new Error(
    `Todoist API ${method} ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`,
  );
}

function resourcePath(resource: "tasks" | "projects", id: string): string {
  if (!SAFE_ID_PATTERN.test(id)) {
    const resourceName = resource === "tasks" ? "task" : "project";
    throw new Error(
      `Invalid Todoist ${resourceName} ID: expected a safe ID segment`,
    );
  }
  return `/${resource}/${id}`;
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
    isRecurring: raw.due?.is_recurring ?? false,
    isCompleted: raw.checked,
    url: `https://app.todoist.com/app/task/${raw.id}`,
    createdAt: raw.added_at,
    assigneeId: raw.responsible_uid ?? "",
    order: raw.child_order,
  };
}

function normalizeProject(raw: RawProject): ProjectData {
  return {
    id: raw.id,
    name: raw.name,
    color: raw.color,
    parentId: raw.parent_id ?? "",
    order: raw.child_order,
    isShared: raw.is_shared,
    isFavorite: raw.is_favorite,
    isInboxProject: raw.inbox_project ?? false,
    url: `https://app.todoist.com/app/project/${raw.id}`,
  };
}

/** Fetch all pages of a cursor-paginated list endpoint. */
async function fetchAllPages<T>(
  apiToken: string,
  path: string,
  itemSchema: z.ZodType<T>,
  params: Record<string, string> = {},
): Promise<T[]> {
  const all: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const pageParams: Record<string, string> = { ...params, limit: "200" };
    if (cursor) pageParams.cursor = cursor;
    const page = await request(
      apiToken,
      "GET",
      path,
      undefined,
      pageParams,
      listResponseSchema(itemSchema),
    );
    all.push(...page.results);
    const nextCursor = page.next_cursor;
    if (nextCursor && seenCursors.has(nextCursor)) {
      throw new Error(
        `Todoist API GET ${path} returned a repeated pagination cursor`,
      );
    }
    if (nextCursor) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);
  return all;
}

async function requestOnce<T>(
  apiToken: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  params?: Record<string, string>,
  responseSchema?: z.ZodType<T>,
): Promise<T> {
  const safePath = redactSecret(path, apiToken);
  let url = `${BASE_URL}${path}`;
  if (params && Object.keys(params).length > 0) {
    url = `${url}?${new URLSearchParams(params)}`;
  }
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeoutError(error)) throw timeoutError(method, safePath);
    const detail = redactSecret(
      error instanceof Error ? error.message : String(error),
      apiToken,
    );
    throw new Error(
      `Todoist API ${method} ${safePath} network request failed: ${detail}`,
    );
  }
  if (!resp.ok) {
    let text: string;
    try {
      text = await resp.text();
    } catch (error) {
      if (isTimeoutError(error)) throw timeoutError(method, safePath);
      const detail = redactSecret(
        error instanceof Error ? error.message : String(error),
        apiToken,
      );
      throw new TodoistApiError(
        resp.status,
        method,
        safePath,
        `response body could not be read: ${detail}`,
      );
    }
    throw new TodoistApiError(
      resp.status,
      method,
      safePath,
      redactSecret(text, apiToken),
      parseRetryAfter(resp.headers.get("Retry-After")),
    );
  }
  if (resp.status === 204) return undefined as T;
  let json: unknown;
  try {
    json = await resp.json();
  } catch (error) {
    if (isTimeoutError(error)) throw timeoutError(method, safePath);
    const detail = redactSecret(
      error instanceof Error ? error.message : String(error),
      apiToken,
    );
    throw new Error(
      `Todoist API ${method} ${safePath} returned invalid JSON: ${detail}`,
    );
  }
  return responseSchema
    ? parseResponse(responseSchema, json, `${method} ${safePath}`)
    : json as T;
}

async function request<T>(
  apiToken: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  params?: Record<string, string>,
  responseSchema?: z.ZodType<T>,
): Promise<T> {
  for (let attempt = 0;; attempt += 1) {
    try {
      return await requestOnce(
        apiToken,
        method,
        path,
        body,
        params,
        responseSchema,
      );
    } catch (error) {
      const retryable = method === "GET" &&
        error instanceof TodoistApiError &&
        (error.status === 429 || error.status === 503) &&
        attempt < MAX_GET_RETRIES;
      if (!retryable) throw error;
      const delayMs = error.retryAfterMs ?? 250 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
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
      const path = filter ? "/tasks/filter" : "/tasks";
      const params: Record<string, string> = filter ? { query: filter } : {};
      const raw = await fetchAllPages(apiToken, path, RawTaskSchema, params);
      return raw.map(normalizeTask);
    },

    async getTask(id: string): Promise<TaskData> {
      const path = resourcePath("tasks", id);
      const raw = await request(
        apiToken,
        "GET",
        path,
        undefined,
        undefined,
        RawTaskSchema,
      );
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
      if (input.assigneeId !== undefined) {
        body.assignee_id = input.assigneeId;
      }
      if (input.order !== undefined) body.order = input.order;
      const raw = await request(
        apiToken,
        "POST",
        "/tasks",
        body,
        undefined,
        RawTaskSchema,
      );
      return normalizeTask(raw);
    },

    async updateTask(id: string, input: UpdateTaskInput): Promise<TaskData> {
      const path = resourcePath("tasks", id);
      const body: Record<string, unknown> = {};
      if (input.content !== undefined) body.content = input.content;
      if (input.description !== undefined) body.description = input.description;
      if (input.labels !== undefined) body.labels = input.labels;
      if (input.priority !== undefined) body.priority = input.priority;
      if (input.dueString !== undefined) body.due_string = input.dueString;
      if (input.dueLang !== undefined) body.due_lang = input.dueLang;
      if (input.assigneeId !== undefined) {
        body.assignee_id = input.assigneeId;
      }
      const raw = await request<RawTask>(
        apiToken,
        "POST",
        path,
        body,
        undefined,
        RawTaskSchema,
      );
      return normalizeTask(raw);
    },

    async closeTask(id: string): Promise<void> {
      const path = `${resourcePath("tasks", id)}/close`;
      await request<void>(apiToken, "POST", path);
    },

    async reopenTask(id: string): Promise<void> {
      const path = `${resourcePath("tasks", id)}/reopen`;
      await request<void>(apiToken, "POST", path);
    },

    async deleteTask(id: string): Promise<void> {
      const path = resourcePath("tasks", id);
      try {
        await request<void>(apiToken, "DELETE", path);
      } catch (error) {
        if (error instanceof TodoistApiError && error.status === 404) return;
        throw error;
      }
    },

    async getProjects(): Promise<ProjectData[]> {
      const raw = await fetchAllPages(
        apiToken,
        "/projects",
        RawProjectSchema,
      );
      return raw.map(normalizeProject);
    },

    async getProject(id: string): Promise<ProjectData> {
      const path = resourcePath("projects", id);
      const raw = await request(
        apiToken,
        "GET",
        path,
        undefined,
        undefined,
        RawProjectSchema,
      );
      return normalizeProject(raw);
    },
  };
}
