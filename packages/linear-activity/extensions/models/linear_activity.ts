/**
 * @module @mgreten/linear-activity
 *
 * Gather a Linear user's daily activity -- issues completed, moved to review,
 * created, comments authored, and in-flight assignments. Read-only, scoped to
 * configurable team keys. Designed as a data source for EOD reports and standup
 * summaries.
 *
 * Auth: requires a Linear personal API key (`lin_api_...`) stored as a
 * sensitive global argument. Obtain one from https://linear.app/settings/api.
 *
 * For write operations (creating/updating issues), see `@hivemq/linear`.
 */

import { z } from "npm:zod@4";

/**
 * Global arguments shared across all methods.
 *
 * - `apiKey` -- Linear personal API key, marked sensitive so swamp never logs it.
 * - `teamKeys` -- Linear team keys to scope activity to. When empty (the
 *   default), activity is gathered across all teams visible to the viewer.
 */
const GlobalArgsSchema: z.ZodObject<{
  apiKey: z.ZodString;
  teamKeys: z.ZodDefault<z.ZodArray<z.ZodString>>;
}> = z.object({
  apiKey: z
    .string()
    .describe("Linear personal API key (lin_api_...)")
    .meta({ sensitive: true }),
  teamKeys: z
    .array(z.string())
    .default([])
    .describe(
      "Linear team keys to scope activity to (e.g. ['ENG']). Empty = all teams.",
    ),
});

/** Summary of a single Linear issue returned in activity results. */
const IssueSummarySchema: z.ZodObject<{
  id: z.ZodString;
  identifier: z.ZodString;
  title: z.ZodString;
  url: z.ZodString;
  stateName: z.ZodString;
  stateType: z.ZodString;
  teamKey: z.ZodString;
  priority: z.ZodNumber;
  assigneeEmail: z.ZodNullable<z.ZodString>;
  updatedAt: z.ZodString;
  completedAt: z.ZodNullable<z.ZodString>;
}> = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  stateName: z.string(),
  stateType: z.string(),
  teamKey: z.string(),
  priority: z.number(),
  assigneeEmail: z.string().nullable(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});

/** Summary of a single comment authored by the viewer. */
const CommentSummarySchema: z.ZodObject<{
  id: z.ZodString;
  createdAt: z.ZodString;
  body: z.ZodString;
  issueIdentifier: z.ZodString;
  issueTitle: z.ZodString;
  issueUrl: z.ZodString;
  issueStateName: z.ZodString;
}> = z.object({
  id: z.string(),
  createdAt: z.string(),
  body: z.string(),
  issueIdentifier: z.string(),
  issueTitle: z.string(),
  issueUrl: z.string(),
  issueStateName: z.string(),
});

/** Full activity snapshot for a single day. */
const LinearActivitySchema: z.ZodObject<{
  date: z.ZodString;
  viewerId: z.ZodString;
  viewerEmail: z.ZodString;
  teamKeys: z.ZodArray<z.ZodString>;
  issuesCompleted: z.ZodArray<typeof IssueSummarySchema>;
  issuesMovedToReview: z.ZodArray<typeof IssueSummarySchema>;
  issuesCreated: z.ZodArray<typeof IssueSummarySchema>;
  commentsByMe: z.ZodArray<typeof CommentSummarySchema>;
  issuesInFlight: z.ZodArray<typeof IssueSummarySchema>;
  fetchedAt: z.ZodString;
}> = z.object({
  date: z.string(),
  viewerId: z.string(),
  viewerEmail: z.string(),
  teamKeys: z.array(z.string()),
  issuesCompleted: z.array(IssueSummarySchema),
  issuesMovedToReview: z.array(IssueSummarySchema),
  issuesCreated: z.array(IssueSummarySchema),
  commentsByMe: z.array(CommentSummarySchema),
  issuesInFlight: z.array(IssueSummarySchema),
  fetchedAt: z.string(),
});

/** Linear GraphQL API endpoint. */
const LINEAR_ENDPOINT: string = "https://api.linear.app/graphql";

/** Shape of a raw Linear GraphQL response. */
interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/**
 * Execute a GraphQL query against the Linear API.
 *
 * @param apiKey - Linear personal API key used for authorization.
 * @param query - GraphQL query string.
 * @param variables - Optional variables to pass with the query.
 * @returns The `data` portion of the GraphQL response.
 * @throws On HTTP errors, GraphQL errors, or missing data.
 */
async function gql<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const resp: Response = await fetch(LINEAR_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    const text: string = await resp.text();
    throw new Error(`Linear GraphQL HTTP ${resp.status}: ${text}`);
  }
  const payload = (await resp.json()) as GqlResponse<T>;
  if (payload.errors && payload.errors.length > 0) {
    throw new Error(
      `Linear GraphQL errors: ${
        payload.errors.map((e) => e.message).join("; ")
      }`,
    );
  }
  if (!payload.data) {
    throw new Error("Linear GraphQL returned no data");
  }
  return payload.data;
}

/**
 * Return the provided date string, or today's date in YYYY-MM-DD format.
 *
 * @param date - Optional YYYY-MM-DD string. Defaults to today.
 */
function todayString(date?: string): string {
  if (date) return date;
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Convert a YYYY-MM-DD date to the start-of-day ISO timestamp.
 * Uses local midnight converted to UTC.
 */
function startOfDayIso(date: string): string {
  const d: Date = new Date(`${date}T00:00:00`);
  return d.toISOString();
}

/**
 * Convert a YYYY-MM-DD date to the end-of-day ISO timestamp.
 * Uses local 23:59:59.999 converted to UTC.
 */
function endOfDayIso(date: string): string {
  const d: Date = new Date(`${date}T23:59:59.999`);
  return d.toISOString();
}

/** Raw issue node shape from Linear GraphQL. */
interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: number;
  updatedAt: string;
  completedAt: string | null;
  state: { id: string; name: string; type: string } | null;
  team: { id: string; key: string } | null;
  assignee: { id: string; email: string } | null;
}

/**
 * Transform a raw GraphQL issue node into a flat summary object.
 *
 * @param node - Raw issue node from the Linear GraphQL API.
 * @returns An `IssueSummary` matching the `IssueSummarySchema`.
 */
function summarizeIssue(node: IssueNode): z.infer<typeof IssueSummarySchema> {
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    url: node.url,
    stateName: node.state?.name ?? "",
    stateType: node.state?.type ?? "",
    teamKey: node.team?.key ?? "",
    priority: node.priority ?? 0,
    assigneeEmail: node.assignee?.email ?? null,
    updatedAt: node.updatedAt,
    completedAt: node.completedAt ?? null,
  };
}

/** GraphQL issue field selection fragment. */
const ISSUE_FIELDS: string = `
  id
  identifier
  title
  url
  priority
  updatedAt
  completedAt
  state { id name type }
  team { id key }
  assignee { id email }
`;

/** Viewer query result shape. */
interface ViewerQueryResult {
  viewer: { id: string; email: string; displayName: string };
}

/** Issues query result shape. */
interface IssuesQueryResult {
  issues: { nodes: IssueNode[] };
}

/** Raw comment node shape from Linear GraphQL. */
interface CommentNode {
  id: string;
  createdAt: string;
  body: string;
  issue: {
    identifier: string;
    title: string;
    url: string;
    state: { name: string } | null;
    team: { key: string } | null;
  };
}

/** Comments query result shape. */
interface CommentsQueryResult {
  comments: { nodes: CommentNode[] };
}

/** Swamp model execution context. */
type ModelContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
};

/**
 * Swamp model definition for `@mgreten/linear-activity`.
 *
 * Provides a single method, `daily_activity`, that gathers the authenticated
 * viewer's Linear activity for a given day. Activity includes issues completed,
 * moved to review, created, comments authored, and current in-flight
 * assignments.
 */
export const model = {
  type: "@mgreten/linear-activity",
  version: "2026.05.20.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    linear_activity: {
      description:
        "Linear activity for a viewer on a given date -- completed, in-review, created, comments, in-flight",
      schema: LinearActivitySchema,
      lifetime: "1d" as const,
      garbageCollection: 14,
    },
  },

  methods: {
    daily_activity: {
      description:
        "Gather today's Linear activity for the viewer: issues completed, moved to In Review, created, comments authored, and current in-flight assignments. When teamKeys is configured, results are scoped to those teams; otherwise all teams visible to the viewer are included.",
      arguments: z.object({
        date: z
          .string()
          .optional()
          .describe("Date to query (YYYY-MM-DD, defaults to today)"),
      }),

      execute: async (
        args: { date?: string },
        context: ModelContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const date: string = todayString(args.date);
        const startIso: string = startOfDayIso(date);
        const endIso: string = endOfDayIso(date);
        const teamKeys: string[] = context.globalArgs.teamKeys;
        const apiKey: string = context.globalArgs.apiKey;
        const hasTeamFilter: boolean = teamKeys.length > 0;

        // 1. Viewer identity
        const viewerResult: ViewerQueryResult = await gql<ViewerQueryResult>(
          apiKey,
          `query { viewer { id email displayName } }`,
        );
        const viewer = viewerResult.viewer;
        context.logger.info("Linear viewer: {email} ({id})", {
          email: viewer.email,
          id: viewer.id,
        });

        // Build optional team filter -- omitted when teamKeys is empty (all teams)
        const teamFilter: Record<string, unknown> = hasTeamFilter
          ? { team: { key: { in: teamKeys } } }
          : {};

        // 2. Issues completed today (assignee=me, completedAt today, optionally scoped to teams)
        const completedResult: IssuesQueryResult = await gql<IssuesQueryResult>(
          apiKey,
          `query Q($filter: IssueFilter, $first: Int) {
            issues(filter: $filter, first: $first, orderBy: updatedAt) {
              nodes { ${ISSUE_FIELDS} }
            }
          }`,
          {
            filter: {
              ...teamFilter,
              assignee: { id: { eq: viewer.id } },
              completedAt: { gte: startIso, lte: endIso },
            },
            first: 50,
          },
        );

        // 3. Issues in started/unstarted states assigned to me (in-flight snapshot)
        //    Derive "moved to review today" from this set.
        const inFlightResult: IssuesQueryResult = await gql<IssuesQueryResult>(
          apiKey,
          `query Q($filter: IssueFilter, $first: Int) {
            issues(filter: $filter, first: $first, orderBy: updatedAt) {
              nodes { ${ISSUE_FIELDS} }
            }
          }`,
          {
            filter: {
              ...teamFilter,
              assignee: { id: { eq: viewer.id } },
              state: { type: { in: ["started", "unstarted"] } },
            },
            first: 50,
          },
        );

        const inFlightAll: z.infer<typeof IssueSummarySchema>[] = inFlightResult
          .issues.nodes.map(summarizeIssue);
        const issuesMovedToReview: z.infer<typeof IssueSummarySchema>[] =
          inFlightAll.filter((i) => {
            const updatedToday: boolean = i.updatedAt >= startIso &&
              i.updatedAt <= endIso;
            const looksLikeReview: boolean = /review/i.test(i.stateName);
            return updatedToday && looksLikeReview;
          });

        // 4. Issues created by me today (optionally scoped to teams)
        const createdResult: IssuesQueryResult = await gql<IssuesQueryResult>(
          apiKey,
          `query Q($filter: IssueFilter, $first: Int) {
            issues(filter: $filter, first: $first, orderBy: createdAt) {
              nodes { ${ISSUE_FIELDS} }
            }
          }`,
          {
            filter: {
              ...teamFilter,
              creator: { id: { eq: viewer.id } },
              createdAt: { gte: startIso, lte: endIso },
            },
            first: 50,
          },
        );

        // 5. Comments authored by me today
        //    Linear's CommentFilter has no team filter, so we filter client-side
        //    when teamKeys is configured.
        const commentsResult: CommentsQueryResult = await gql<
          CommentsQueryResult
        >(
          apiKey,
          `query Q($filter: CommentFilter, $first: Int) {
            comments(filter: $filter, first: $first, orderBy: createdAt) {
              nodes {
                id
                createdAt
                body
                issue {
                  identifier
                  title
                  url
                  state { name }
                  team { key }
                }
              }
            }
          }`,
          {
            filter: {
              user: { id: { eq: viewer.id } },
              createdAt: { gte: startIso, lte: endIso },
            },
            first: 100,
          },
        );

        const commentsByMe: z.infer<typeof CommentSummarySchema>[] =
          commentsResult.comments.nodes
            .filter((c: CommentNode) => {
              if (!hasTeamFilter) return true;
              return teamKeys.includes(c.issue.team?.key ?? "");
            })
            .map(
              (c: CommentNode): z.infer<typeof CommentSummarySchema> => ({
                id: c.id,
                createdAt: c.createdAt,
                body: c.body.slice(0, 500),
                issueIdentifier: c.issue.identifier,
                issueTitle: c.issue.title,
                issueUrl: c.issue.url,
                issueStateName: c.issue.state?.name ?? "",
              }),
            );

        const data: z.infer<typeof LinearActivitySchema> = {
          date,
          viewerId: viewer.id,
          viewerEmail: viewer.email,
          teamKeys,
          issuesCompleted: completedResult.issues.nodes.map(summarizeIssue),
          issuesMovedToReview,
          issuesCreated: createdResult.issues.nodes.map(summarizeIssue),
          commentsByMe,
          issuesInFlight: inFlightAll,
          fetchedAt: new Date().toISOString(),
        };

        context.logger.info(
          "Linear activity: {completed} completed, {review} in review, {created} created, {comments} comments, {flight} in flight",
          {
            completed: data.issuesCompleted.length,
            review: data.issuesMovedToReview.length,
            created: data.issuesCreated.length,
            comments: data.commentsByMe.length,
            flight: data.issuesInFlight.length,
          },
        );

        const handle: { name: string } = await context.writeResource(
          "linear_activity",
          `linear-${date}`,
          data,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
