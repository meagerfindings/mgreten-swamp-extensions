# @mgreten/todoist

Todoist task management integration for swamp. Provides task and project CRUD
via the Todoist REST API v2 — no external npm dependencies. Every API response
is written as a swamp resource, making it available for CEL expressions, data
queries, and workflow chaining.

## Installation

```bash
swamp extension pull @mgreten/todoist
```

## Setup

Create a Todoist API token at https://app.todoist.com/app/settings/integrations/developer
and store it in a swamp vault:

```bash
swamp vault put my-vault todoist_api_token <your-token>
```

Then create a model instance:

```bash
swamp model create @mgreten/todoist my-todoist \
  --global-arg apiToken='${{ vault.get(my-vault, todoist_api_token) }}' \
  --global-arg defaultProjectId="<your-project-id>"
```

Find your project ID by running `syncProjects` first — the `id` field on each
project resource is the value to use.

## Usage

```bash
# Sync all active tasks
swamp model method run my-todoist syncTasks

# Sync tasks due today
swamp model method run my-todoist syncTasks --input filter="today"

# Sync tasks in a specific project
swamp model method run my-todoist syncTasks --input filter="#Work"

# Sync tasks by priority
swamp model method run my-todoist syncTasks --input filter="priority 1"

# Sync all projects
swamp model method run my-todoist syncProjects

# Create a task
swamp model method run my-todoist createTask \
  --input content="Review PR #42" \
  --input dueString="today" \
  --input priority=3

# Create a task with labels
swamp model method run my-todoist createTask \
  --input content="Deploy hotfix" \
  --input labels="urgent, ops" \
  --input dueString="in 2 hours"

# Complete a task
swamp model method run my-todoist completeTask --input taskId="<task-id>"

# Update a task
swamp model method run my-todoist updateTask \
  --input taskId="<task-id>" \
  --input priority=4 \
  --input dueString="next Monday"

# Delete a task
swamp model method run my-todoist deleteTask --input taskId="<task-id>"
```

## Global Arguments

| Argument            | Type   | Required | Description                                              |
| ------------------- | ------ | -------- | -------------------------------------------------------- |
| `apiToken`          | string | Yes      | Todoist API token (use a vault expression)               |
| `defaultProjectId`  | string | No       | Default project ID when no `projectId` is specified      |

## Methods

### syncTasks

Fetch active tasks and write each one as a `task` resource. Accepts an optional
`filter` argument using [Todoist filter syntax](https://todoist.com/help/articles/introduction-to-filters-V98wIH):
`today`, `tomorrow`, `#ProjectName`, `@label`, `priority 1`, `assigned to: me`, etc.
Omit `filter` to fetch all active tasks.

### syncProjects

Fetch all Todoist projects and write each one as a `project` resource. Use this
first to discover project IDs for use in `createTask` or as `defaultProjectId`.

### createTask

Create a new task. `content` is required; all other fields are optional.
`labels` accepts a comma-separated string of label names. `priority` follows
Todoist's scale: 1=normal, 2=medium, 3=high, 4=urgent. `dueString` accepts
natural language: `"today"`, `"next Monday"`, `"in 3 days"`.

### completeTask

Mark a task as completed by ID. Fetches the task first to preserve full
resource data, then closes it.

### updateTask

Update fields on an existing task. Only sends fields that are explicitly
provided. `labels` replaces the existing label list (not additive).

### deleteTask

Permanently delete a task by ID. Returns no data handles.

## Resources

| Resource  | Description               | Lifetime | GC  |
| --------- | ------------------------- | -------- | --- |
| `task`    | Todoist task with metadata | infinite | 500 |
| `project` | Todoist project           | infinite | 100 |

## CEL Access

After syncing, reference task and project data in CEL expressions:

```
data.latest("my-todoist", "task/<id>").attributes.content
data.latest("my-todoist", "task/<id>").attributes.dueDate
data.latest("my-todoist", "project/<id>").attributes.name
```

## How It Works

Communicates with the [Todoist REST API v2](https://developer.todoist.com/rest/v2/)
using the runtime's built-in `fetch`. No external npm dependencies. The client
layer normalizes the API's snake_case responses into camelCase TypeScript
interfaces before writing them as swamp resources.

## License

MIT — see LICENSE.txt for details.
