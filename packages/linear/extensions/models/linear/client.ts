/**
 * Linear SDK client abstraction layer.
 *
 * Wraps the official `@linear/sdk` with a typed interface that normalizes
 * the SDK's promise-based relation loading into flat data objects.
 * @module
 */

/** Flat representation of a Linear issue with resolved relations. */
export interface IssueData {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  priority: number;
  state: { id: string; name: string; type: string };
  team: { id: string; name: string; key: string };
  project: { id: string; name: string } | null;
  assignee: { id: string; name: string } | null;
  labels: Array<{ id: string; name: string; color: string }>;
}

/** Flat representation of a Linear team. */
export interface TeamData {
  id: string;
  name: string;
  key: string;
}

/** Flat representation of a Linear project. */
export interface ProjectData {
  id: string;
  name: string;
  state: string;
}

/** Flat representation of a Linear document and its project association. */
export interface DocumentData {
  id: string;
  slugId: string;
  title: string;
  content: string;
  url: string;
  sortOrder: number;
  project: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

/** Flat representation of an external link in a Linear project's resources. */
export interface ProjectExternalLinkData {
  id: string;
  label: string;
  url: string;
  sortOrder: number;
  project: { id: string; name: string };
  createdAt: string;
  updatedAt: string;
}

/** Documents and external links displayed in a Linear project's Resources. */
export interface ProjectResourcesData {
  project: ProjectData;
  documents: DocumentData[];
  externalLinks: ProjectExternalLinkData[];
}

/** Flat representation of a Linear workflow state. */
export interface WorkflowStateData {
  id: string;
  name: string;
  type: string;
  color: string;
}

/** Flat representation of the authenticated Linear user. */
export interface ViewerData {
  id: string;
  name: string;
  email: string;
}

/** Flat representation of a Linear issue label. */
export interface LabelData {
  id: string;
  name: string;
  color: string;
}

/** Flat representation of a single comment on an issue. */
export interface CommentData {
  id: string;
  body: string;
  authorName: string;
  authorId: string;
  isBot: boolean;
  createdAt: string;
}

/** Input for creating a Linear issue. */
export interface CreateIssueInput {
  title: string;
  description?: string;
  teamId: string;
  projectId?: string;
  priority?: number;
  stateId?: string;
  assigneeId?: string;
  labelIds?: string[];
  /** Parent issue ID — makes this a sub-issue of the given issue. */
  parentId?: string;
  /** Story-point estimate on the team's estimation scale. */
  estimate?: number;
}

/** Input for updating a Linear issue. */
export interface UpdateIssueInput {
  title?: string;
  description?: string;
  stateId?: string;
  priority?: number;
  assigneeId?: string;
  projectId?: string;
  labelIds?: string[];
}

/** Filter criteria for listing Linear issues. */
export interface IssueFilter {
  teamId?: string;
  assigneeId?: string;
  stateType?: string;
  projectId?: string;
  labelName?: string;
}

/** A single page of a Linear SDK paginated connection. */
interface SDKConnection<TNode> {
  nodes: TNode[];
  pageInfo: { hasNextPage: boolean; endCursor: string };
  fetchNext(): Promise<SDKConnection<TNode>>;
}

/** Raw SDK comment node, prior to author resolution. */
interface SDKCommentNode {
  id: string;
  body: string;
  createdAt: Date | string;
  user?: Promise<{ id: string; name: string } | undefined>;
  botActor?: { id?: string; name?: string } | undefined;
}

interface SDKDocumentNode {
  id: string;
  slugId: string;
  title: string;
  content?: string | null;
  url: string;
  sortOrder: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  project?: Promise<{ id: string; name: string } | undefined>;
}

interface SDKProjectExternalLinkNode {
  id: string;
  label: string;
  url: string;
  sortOrder: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface SDKProjectNode {
  id: string;
  name: string;
  state: string;
  documents: (
    variables?: { first?: number },
  ) => Promise<SDKConnection<SDKDocumentNode>>;
  externalLinks: (
    variables?: { first?: number },
  ) => Promise<SDKConnection<SDKProjectExternalLinkNode>>;
}

interface SDKIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  priority: number;
  state: Promise<{ id: string; name: string; type: string } | undefined>;
  team: Promise<{ id: string; name: string; key: string }>;
  project: Promise<{ id: string; name: string } | undefined>;
  assignee: Promise<{ id: string; name: string } | undefined>;
  labels: () => Promise<
    { nodes: Array<{ id: string; name: string; color: string }> }
  >;
  comments: (
    variables?: { first?: number; after?: string },
  ) => Promise<SDKConnection<SDKCommentNode>>;
}

/** Minimal subset of the `@linear/sdk` client used by this extension. */
export interface LinearSDKLike {
  viewer: Promise<{ id: string; name: string; email: string }>;
  createIssue(input: CreateIssueInput): Promise<{
    success: boolean;
    issue: Promise<SDKIssueNode | undefined>;
  }>;
  issue(id: string): Promise<SDKIssueNode>;
  updateIssue(
    id: string,
    input: UpdateIssueInput,
  ): Promise<{
    success: boolean;
    issue: Promise<SDKIssueNode | undefined>;
  }>;
  deleteIssue(id: string): Promise<{ success: boolean }>;
  issues(opts: {
    filter: Record<string, unknown>;
    first?: number;
    after?: string;
  }): Promise<{
    nodes: SDKIssueNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string };
  }>;
  teams(): Promise<{ nodes: Array<{ id: string; name: string; key: string }> }>;
  team(
    id: string,
  ): Promise<{
    projects(): Promise<
      { nodes: Array<{ id: string; name: string; state: string }> }
    >;
  }>;
  project(id: string): Promise<SDKProjectNode>;
  projects(): Promise<
    { nodes: Array<{ id: string; name: string; state: string }> }
  >;
  document(id: string): Promise<SDKDocumentNode>;
  workflowStates(opts?: unknown): Promise<{
    nodes: Array<{ id: string; name: string; type: string; color: string }>;
  }>;
  issueLabels(opts: {
    filter: Record<string, unknown>;
  }): Promise<{
    nodes: Array<{ id: string; name: string; color: string }>;
  }>;
  createComment(input: { issueId: string; body: string }): Promise<{
    success: boolean;
    comment: Promise<SDKCommentNode | undefined>;
  }>;
}

async function resolveComment(comment: SDKCommentNode): Promise<CommentData> {
  const user = comment.user ? await comment.user : undefined;
  const isBot = !user && !!comment.botActor;
  const authorName = user?.name ?? comment.botActor?.name ?? "";
  const authorId = user?.id ?? comment.botActor?.id ?? "";
  const createdAt = comment.createdAt instanceof Date
    ? comment.createdAt.toISOString()
    : comment.createdAt;
  return {
    id: comment.id,
    body: comment.body,
    authorName,
    authorId,
    isBot,
    createdAt,
  };
}

function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

async function allConnectionNodes<TNode extends { id: string }>(
  firstPage: SDKConnection<TNode>,
): Promise<TNode[]> {
  const nodes = new Map(firstPage.nodes.map((node) => [node.id, node]));
  let page = firstPage;
  while (page.pageInfo.hasNextPage) {
    page = await page.fetchNext();
    for (const node of page.nodes) nodes.set(node.id, node);
  }
  return [...nodes.values()];
}

async function resolveDocument(
  document: SDKDocumentNode,
  knownProject?: { id: string; name: string },
): Promise<DocumentData> {
  const project = knownProject ??
    (document.project ? await document.project : undefined);
  return {
    id: document.id,
    slugId: document.slugId,
    title: document.title,
    content: document.content ?? "",
    url: document.url,
    sortOrder: document.sortOrder,
    project: project ?? null,
    createdAt: isoDate(document.createdAt),
    updatedAt: isoDate(document.updatedAt),
  };
}

function documentLookupId(idOrUrl: string): string {
  try {
    const url = new URL(idOrUrl);
    const pathPart = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
    return pathPart.match(/-([a-z0-9]{12})$/i)?.[1] ?? pathPart;
  } catch {
    return idOrUrl;
  }
}

/** Fetch every comment on an issue, oldest first, paginating to exhaustion. */
async function fetchAllComments(
  issue: SDKIssueNode,
): Promise<CommentData[]> {
  let conn = await issue.comments();
  while (conn.pageInfo.hasNextPage) {
    conn = await conn.fetchNext();
  }
  const comments = await Promise.all(conn.nodes.map(resolveComment));
  comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return comments;
}

async function resolveIssue(issue: SDKIssueNode): Promise<IssueData> {
  const [state, team, project, assignee, labelsConn] = await Promise.all([
    issue.state,
    issue.team,
    issue.project,
    issue.assignee,
    issue.labels(),
  ]);
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? "",
    url: issue.url,
    priority: issue.priority,
    state: state ?? { id: "", name: "", type: "" },
    team: team ?? { id: "", name: "", key: "" },
    project: project ?? null,
    assignee: assignee ?? null,
    labels: labelsConn.nodes.map((l) => ({
      id: l.id,
      name: l.name,
      color: l.color,
    })),
  };
}

/** High-level Linear client with normalized return types. */
export interface LinearClient {
  /** Resolve the authenticated user. */
  getViewer(): Promise<ViewerData>;
  /** Create a new issue. */
  createIssue(input: CreateIssueInput): Promise<IssueData>;
  /** Fetch a single issue by identifier or UUID. */
  getIssue(id: string): Promise<IssueData>;
  /** Update fields on an existing issue. */
  updateIssue(id: string, input: UpdateIssueInput): Promise<IssueData>;
  /** Permanently delete an issue. */
  deleteIssue(id: string): Promise<void>;
  /** Query issues with filters and pagination. */
  listIssues(
    filter: IssueFilter,
    first?: number,
    after?: string,
  ): Promise<{
    issues: IssueData[];
    pageInfo: { hasNextPage: boolean; endCursor: string };
  }>;
  /** List all teams. */
  listTeams(): Promise<TeamData[]>;
  /** List projects, optionally scoped to a team. */
  listProjects(teamId?: string): Promise<ProjectData[]>;
  /** Fetch one document by UUID, slug ID, or Linear document URL. */
  getDocument(idOrUrl: string): Promise<DocumentData>;
  /** List documents and external links in a project's Resources section. */
  listProjectResources(projectId: string): Promise<ProjectResourcesData>;
  /** List workflow states for a team. */
  listStates(teamId: string): Promise<WorkflowStateData[]>;
  /** List issue labels for a team. */
  listLabels(teamId: string): Promise<LabelData[]>;
  /** Fetch every comment on an issue, oldest first. */
  listComments(issueId: string): Promise<CommentData[]>;
  /** Post a markdown comment on an issue. */
  createComment(issueId: string, body: string): Promise<CommentData>;
}

/** Build a {@link LinearClient} from a raw SDK instance. */
export function buildLinearClient(sdk: LinearSDKLike): LinearClient {
  return {
    async getViewer(): Promise<ViewerData> {
      const v = await sdk.viewer;
      return { id: v.id, name: v.name, email: v.email };
    },

    async createIssue(input: CreateIssueInput): Promise<IssueData> {
      const payload = await sdk.createIssue(input);
      if (!payload.success) {
        throw new Error("Linear issueCreate returned success=false");
      }
      const issue = await payload.issue;
      if (!issue) {
        throw new Error("Linear issueCreate returned no issue");
      }
      return resolveIssue(issue);
    },

    async getIssue(id: string): Promise<IssueData> {
      const issue = await sdk.issue(id);
      return resolveIssue(issue);
    },

    async updateIssue(
      id: string,
      input: UpdateIssueInput,
    ): Promise<IssueData> {
      const payload = await sdk.updateIssue(id, input);
      if (!payload.success) {
        throw new Error("Linear issueUpdate returned success=false");
      }
      const issue = await payload.issue;
      if (!issue) {
        throw new Error("Linear issueUpdate returned no issue");
      }
      return resolveIssue(issue);
    },

    async deleteIssue(id: string): Promise<void> {
      const payload = await sdk.deleteIssue(id);
      if (!payload.success) {
        throw new Error("Linear issueDelete returned success=false");
      }
    },

    async listIssues(
      filter: IssueFilter,
      first = 50,
      after?: string,
    ): Promise<{
      issues: IssueData[];
      pageInfo: { hasNextPage: boolean; endCursor: string };
    }> {
      const sdkFilter: Record<string, unknown> = {};
      if (filter.teamId) {
        sdkFilter.team = { id: { eq: filter.teamId } };
      }
      if (filter.assigneeId) {
        sdkFilter.assignee = { id: { eq: filter.assigneeId } };
      }
      if (filter.stateType) {
        sdkFilter.state = { type: { eq: filter.stateType } };
      }
      if (filter.projectId) {
        sdkFilter.project = { id: { eq: filter.projectId } };
      }
      if (filter.labelName) {
        sdkFilter.labels = { name: { eq: filter.labelName } };
      }

      const conn = await sdk.issues({ filter: sdkFilter, first, after });
      const issues = await Promise.all(conn.nodes.map(resolveIssue));
      return { issues, pageInfo: conn.pageInfo };
    },

    async listTeams(): Promise<TeamData[]> {
      const conn = await sdk.teams();
      return conn.nodes.map((t) => ({ id: t.id, name: t.name, key: t.key }));
    },

    async listProjects(teamId?: string): Promise<ProjectData[]> {
      if (teamId) {
        const team = await sdk.team(teamId);
        const conn = await team.projects();
        return conn.nodes.map((p) => ({
          id: p.id,
          name: p.name,
          state: p.state,
        }));
      }
      const conn = await sdk.projects();
      return conn.nodes.map((p) => ({
        id: p.id,
        name: p.name,
        state: p.state,
      }));
    },

    async getDocument(idOrUrl: string): Promise<DocumentData> {
      const document = await sdk.document(documentLookupId(idOrUrl));
      return resolveDocument(document);
    },

    async listProjectResources(
      projectId: string,
    ): Promise<ProjectResourcesData> {
      const project = await sdk.project(projectId);
      const [documentConnection, linkConnection] = await Promise.all([
        project.documents({ first: 50 }),
        project.externalLinks({ first: 50 }),
      ]);
      const [documentNodes, linkNodes] = await Promise.all([
        allConnectionNodes(documentConnection),
        allConnectionNodes(linkConnection),
      ]);
      const projectData = {
        id: project.id,
        name: project.name,
        state: project.state,
      };
      return {
        project: projectData,
        documents: await Promise.all(
          documentNodes.map((document) =>
            resolveDocument(document, {
              id: projectData.id,
              name: projectData.name,
            })
          ),
        ),
        externalLinks: linkNodes.map((link) => ({
          id: link.id,
          label: link.label,
          url: link.url,
          sortOrder: link.sortOrder,
          project: { id: projectData.id, name: projectData.name },
          createdAt: isoDate(link.createdAt),
          updatedAt: isoDate(link.updatedAt),
        })),
      };
    },

    async listStates(teamId: string): Promise<WorkflowStateData[]> {
      const conn = await sdk.workflowStates({
        filter: { team: { id: { eq: teamId } } },
      });
      return conn.nodes.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        color: s.color,
      }));
    },

    async listLabels(teamId: string): Promise<LabelData[]> {
      const conn = await sdk.issueLabels({
        filter: { team: { id: { eq: teamId } } },
      });
      return conn.nodes.map((l) => ({
        id: l.id,
        name: l.name,
        color: l.color,
      }));
    },

    async listComments(issueId: string): Promise<CommentData[]> {
      const issue = await sdk.issue(issueId);
      return fetchAllComments(issue);
    },

    async createComment(issueId: string, body: string): Promise<CommentData> {
      const payload = await sdk.createComment({ issueId, body });
      if (!payload.success) {
        throw new Error("Linear commentCreate returned success=false");
      }
      const comment = await payload.comment;
      if (!comment) {
        throw new Error("Linear commentCreate returned no comment");
      }
      return resolveComment(comment);
    },
  };
}
