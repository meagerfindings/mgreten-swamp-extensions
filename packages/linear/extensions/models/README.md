# @mgreten/linear

Linear project management integration for swamp. Provides verified issue CRUD, viewer
auto-assignment, label management by name, comment threads, and
document/project-resource retrieval alongside team/project/state listing — all
backed by the official `@linear/sdk`. Every API response is written as a swamp
resource, making it available for CEL expressions, data queries, and workflow
chaining.

## Installation

```bash
swamp extension pull @mgreten/linear
```

## Setup

Create a Linear personal API key at https://linear.app/settings/api and store
it in a swamp vault:

```bash
swamp vault put my-vault linear_api_key <your-key>
```

Then create a model instance:

```bash
swamp model create @mgreten/linear my-linear \
  --global-arg apiKey='${{ vault.get(my-vault, linear_api_key) }}' \
  --global-arg defaultTeamId="<your-team-uuid>" \
  --global-arg defaultProjectId="<your-project-uuid>"
```

## Usage

```bash
# Resolve who you are
swamp model method run my-linear getViewer

# Create an issue auto-assigned to you
swamp model method run my-linear createMyIssue \
  --input title="Fix login bug" \
  --input description="Users report 500 on /login" \
  --input priority=2

# Fetch an issue by identifier
swamp model method run my-linear getIssue --input identifier="ENG-123"

# Update an issue
swamp model method run my-linear updateIssue \
  --input identifier="ENG-123" \
  --input priority=4

# Permanently delete an issue after verifying its identifier and team
swamp model method run my-linear deleteIssue \
  --input identifier="ENG-123" \
  --input expectedTeamKey="ENG" \
  --input confirm="delete"

# List your in-progress issues
swamp model method run my-linear listIssues \
  --input assignedToMe=true \
  --input stateType=started

# Add labels by name
swamp model method run my-linear addLabels \
  --input identifier="ENG-123" \
  --input labels="Bug, P1"

# List available labels
swamp model method run my-linear listLabels

# List teams / projects / workflow states
swamp model method run my-linear listTeams
swamp model method run my-linear listProjects
swamp model method run my-linear listStates

# Fetch a document by UUID, slug ID, or canonical Linear URL
swamp model method run my-linear getDocument \
  --input idOrUrl="https://linear.app/acme/document/runbook-998cb1fe27f8"

# Fetch every document and external link in a project's Resources section
swamp model method run my-linear listProjectResources \
  --input projectId="<project-uuid>"

# Fetch the full comment thread on an issue
swamp model method run my-linear listComments --input identifier="ENG-123"

# Post a comment
swamp model method run my-linear createComment \
  --input identifier="ENG-123" \
  --input body="Deployed in v1.2.3"
```

## Global Arguments

| Argument           | Type   | Required | Description                                          |
| ------------------ | ------ | -------- | ---------------------------------------------------- |
| `apiKey`           | string | Yes      | Linear personal API key (use a vault expression)     |
| `defaultTeamId`    | string | No       | Default team ID when no `teamId` is specified        |
| `defaultProjectId` | string | No       | Default project ID for `createMyIssue`               |

## Methods

### getViewer

Resolve the authenticated user's ID, name, and email. Writes a `viewer`
resource.

### createMyIssue

Create an issue auto-assigned to the authenticated user, using `defaultTeamId`
and `defaultProjectId` from global arguments. Accepts optional `priority`,
`projectId` override, and comma-separated `labels` (resolved by name).

### getIssue

Fetch a single issue by identifier (e.g. `ENG-123`) or UUID. Writes an `issue`
resource with full details including state, assignee, labels, and project.

### updateIssue

Update fields on an existing issue. Only sends fields that are provided — pass
any combination of `title`, `description`, `stateId`, `priority`, `assigneeId`,
`projectId`.

### deleteIssue

Permanently delete one issue with a fail-closed identity check. The method
requires the exact human-readable `identifier`, the `expectedTeamKey`, and the
literal confirmation `delete`. It resolves the issue first, refuses to mutate
when either live value differs, checks Linear's deletion result, and writes an
`issueDeletion` audit resource only after success. Replaying the same deletion
returns the matching stored evidence without issuing another Linear mutation;
mismatched or malformed evidence fails closed.

### listIssues

Query issues with filters: `teamId`, `assignedToMe`, `stateType` (backlog /
unstarted / started / completed / canceled), `projectId`, `labelName`. Writes
each matching issue as an `issue` resource.

### addLabels

Attach labels to an issue by name. Resolves label names to IDs via the team's
label list and merges with existing labels (additive).

### listLabels

List available labels for a team. Writes each label as a `label` resource.

### createIssue

Create an issue with full control over all fields: `title`, `description`,
`teamId`, `projectId`, `priority`, `stateId`, `assigneeId`, `parentId`,
`estimate`.

Pass `parentId` (an existing issue ID) to create the new issue as a
**sub-issue** of that parent. Pass `estimate` to set the story-point
estimate on the team's configured estimation scale. To create a whole epic
in one call, prefer `createEpic` below.

### createEpic

Create an epic in a single call: one parent issue plus N child sub-issues
linked to it. The parent is created first; each child is then created with
its `parentId` set to the parent's returned ID, inheriting the parent's
`teamId` unless it sets its own.

```yaml
# method inputs
parent:
  title: "Epic: photo upload pipeline"
  teamId: "team-abc"
  estimate: 8
children:
  - { title: "Slice 1: upload endpoint + minimal UI", estimate: 2 }
  - { title: "Slice 2: thumbnail render + gallery UI", estimate: 3 }
```

Every issue (parent and each child) is written as an `issue` resource.
Linear has no multi-issue transaction, so creation is **not atomic**: if a
child fails after the parent (and some siblings) succeeded, the method
throws an error naming how many children were created, so you can reconcile
rather than blindly recreate the whole epic.

### listTeams

List all Linear teams. Writes each team as a `team` resource.

### listProjects

List projects, optionally filtered by team or name substring. Writes each
project as a `project` resource.

### getDocument

Fetch one Linear document by UUID, 12-character slug ID, or canonical
`linear.app/.../document/...` URL. Writes a `document` resource containing the
title, Markdown content, canonical URL, sort order, timestamps, and associated
project. Documents without a project use empty `projectId` and `projectName`
fields.

### listProjectResources

Fetch all entries displayed in a Linear project's **Resources** section. The
method follows pagination for both entity types and writes Documents as
`document` resources and external links as `projectExternalLink` resources. It
also refreshes the owning `project` resource, including when the Resources
section is empty.

### listStates

List workflow states for a team. Writes each state as a `workflowState`
resource.

### listComments

Fetch all comments on an issue as a single thread resource, sorted
oldest-first. Follows pagination to exhaustion. Writes one `commentThread`
resource keyed by issue ID.

### createComment

Post a markdown `body` comment on an issue, then re-fetch and write the
refreshed `commentThread` resource so consumers always read from one spec.

## Resources

| Resource              | Description                              | Lifetime | GC  |
| --------------------- | ---------------------------------------- | -------- | --- |
| `issue`               | Linear issue with relations              | infinite | 200 |
| `team`                | Linear team                              | infinite | 50  |
| `project`             | Linear project                           | infinite | 100 |
| `document`            | Document with Markdown and project       | infinite | 200 |
| `projectExternalLink` | External link from a project's Resources | infinite | 200 |
| `workflowState`       | Workflow state (Backlog, etc.)           | infinite | 50  |
| `viewer`              | Authenticated Linear user                | infinite | 5   |
| `label`               | Issue label                              | infinite | 100 |
| `commentThread`       | Full comment thread on an issue          | infinite | 200 |
| `issueDeletion`       | Verified issue deletion audit            | infinite | 50  |

## How It Works

Uses the official `@linear/sdk@80.0.0` TypeScript SDK to communicate with
Linear's GraphQL API. The SDK is instantiated at method execution time from the
`apiKey` global argument — no credentials are stored in the extension source.

The client layer normalizes the SDK's promise-based relation loading (where
`issue.state`, `issue.team`, etc. are separate promises) into flat data objects
before writing them as swamp resources. Linear Documents and external project
links are separate API entities; `listProjectResources` preserves that
distinction while retrieving both parts of the Resources UI.

## Acknowledgments

The client abstraction pattern (typed `LinearSDKLike` interface, `buildLinearClient`
factory, promise-based relation resolution) is derived from
[`@hivemq/linear`](https://swamp.club/extensions/@hivemq/linear) by HiveMQ.
This extension extends their foundation with viewer resolution, issue updates,
label management, and filtered listing.

## License

MIT — see LICENSE.txt for details.
