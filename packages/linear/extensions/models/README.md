# @mgreten/linear

Linear project management integration for swamp. Provides issue CRUD, viewer
auto-assignment, label management by name, and team/project/state listing — all
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
`teamId`, `projectId`, `priority`, `stateId`, `assigneeId`.

### listTeams

List all Linear teams. Writes each team as a `team` resource.

### listProjects

List projects, optionally filtered by team or name substring. Writes each
project as a `project` resource.

### listStates

List workflow states for a team. Writes each state as a `workflowState`
resource.

## Resources

| Resource        | Description                     | Lifetime | GC  |
| --------------- | ------------------------------- | -------- | --- |
| `issue`         | Linear issue with relations     | infinite | 200 |
| `team`          | Linear team                     | infinite | 50  |
| `project`       | Linear project                  | infinite | 100 |
| `workflowState` | Workflow state (Backlog, etc.)  | infinite | 50  |
| `viewer`        | Authenticated Linear user       | infinite | 5   |
| `label`         | Issue label                     | infinite | 100 |

## How It Works

Uses the official `@linear/sdk@80.0.0` TypeScript SDK to communicate with
Linear's GraphQL API. The SDK is instantiated at method execution time from the
`apiKey` global argument — no credentials are stored in the extension source.

The client layer normalizes the SDK's promise-based relation loading (where
`issue.state`, `issue.team`, etc. are separate promises) into flat data objects
before writing them as swamp resources.

## License

MIT — see LICENSE.txt for details.
