import { z } from "npm:zod@4";
import type { DataHandle, MethodContext, MethodResult } from "./methods.ts";

const BASE_URL = "https://api.todoist.com/api/v1";
const TIMEOUT_MS = 15_000;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export interface CommentData {
  id: string;
  taskId: string;
  projectId: string;
  content: string;
  postedAt: string;
  attachment: unknown | null;
}

const RawCommentSchema = z.object({
  id: z.coerce.string().regex(SAFE_ID),
  task_id: z.coerce.string().regex(SAFE_ID),
  project_id: z.coerce.string().nullable().optional(),
  content: z.string(),
  posted_at: z.string(),
  attachment: z.unknown().nullable().optional(),
});

const CommentPageSchema = z.object({
  results: z.array(RawCommentSchema),
  next_cursor: z.string().nullable(),
});

type RawComment = z.infer<typeof RawCommentSchema>;

function normalize(raw: RawComment): CommentData {
  return {
    id: raw.id,
    taskId: raw.task_id,
    projectId: raw.project_id ?? "",
    content: raw.content,
    postedAt: raw.posted_at,
    attachment: raw.attachment ?? null,
  };
}

function assertTaskId(taskId: string): void {
  if (!SAFE_ID.test(taskId)) {
    throw new Error("Invalid Todoist task ID: expected a safe ID segment");
  }
}

async function request(
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const detail = error instanceof Error
      ? error.message.split(token).join("[REDACTED]")
      : "network request failed";
    throw new Error(
      `Todoist API ${method} ${path} network request failed: ${detail}`,
    );
  }
  if (!response.ok) {
    throw new Error(`Todoist API ${method} ${path} → ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`Todoist API ${method} ${path} returned invalid JSON`);
  }
}

export async function fetchTaskComments(
  token: string,
  taskId: string,
): Promise<CommentData[]> {
  assertTaskId(taskId);
  const comments: CommentData[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ task_id: taskId, limit: "200" });
    if (cursor) params.set("cursor", cursor);
    const result = CommentPageSchema.safeParse(
      await request(token, "GET", `/comments?${params}`),
    );
    if (!result.success) {
      throw new Error(
        `Todoist API GET /comments returned an invalid response at ${
          result.error.issues[0]?.path.join(".") || "response"
        }`,
      );
    }
    comments.push(...result.data.results.map(normalize));
    cursor = result.data.next_cursor;
    if (cursor && cursors.has(cursor)) {
      throw new Error(
        "Todoist API GET /comments returned a repeated pagination cursor",
      );
    }
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return comments;
}

export async function createTaskComment(
  token: string,
  taskId: string,
  content: string,
): Promise<CommentData> {
  assertTaskId(taskId);
  const result = RawCommentSchema.safeParse(
    await request(token, "POST", "/comments", { task_id: taskId, content }),
  );
  if (!result.success) {
    throw new Error(
      `Todoist API POST /comments returned an invalid response at ${
        result.error.issues[0]?.path.join(".") || "response"
      }`,
    );
  }
  return normalize(result.data);
}

function resourceData(comment: CommentData): Record<string, unknown> {
  return { ...comment, syncedAt: new Date().toISOString() };
}

export async function syncTaskComments(
  context: MethodContext,
  args: { taskId: string },
): Promise<MethodResult> {
  context.logger.info("Syncing Todoist task comments", {
    taskId: args.taskId.split(context.globalArgs.apiToken).join("[REDACTED]"),
  });
  const comments = await fetchTaskComments(
    context.globalArgs.apiToken,
    args.taskId,
  );
  const dataHandles: DataHandle[] = [];
  for (const comment of comments) {
    dataHandles.push(
      await context.writeResource("comment", comment.id, resourceData(comment)),
    );
  }
  context.logger.info("Synced {commentCount} Todoist task comments", {
    commentCount: dataHandles.length,
  });
  return { dataHandles };
}

export async function createComment(
  context: MethodContext,
  args: { taskId: string; content: string },
): Promise<MethodResult> {
  const comment = await createTaskComment(
    context.globalArgs.apiToken,
    args.taskId,
    args.content,
  );
  const handle = await context.writeResource(
    "comment",
    comment.id,
    resourceData(comment),
  );
  context.logger.info("Created Todoist task comment", {
    taskId: args.taskId.split(context.globalArgs.apiToken).join("[REDACTED]"),
    commentId: comment.id,
  });
  return { dataHandles: [handle] };
}
