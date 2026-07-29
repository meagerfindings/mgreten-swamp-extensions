# @mgreten/todoist

Typed Todoist API v1 integration for Swamp. It supports task CRUD, project sync,
and evidence-preserving task-comment sync. Read operations use a bounded 15-second
timeout; comments are written as durable, normalized resources that can be used by
workflows and review agents.

## Install and configure

```bash
swamp extension pull @mgreten/todoist
swamp vault put todoist-secrets TODOIST_API_TOKEN <your-token>
```

Create a model whose `apiToken` global argument references the `TODOIST_API_TOKEN`
secret in that vault. Keep the token in a vault expression; never put it in a model
definition or task comment.

## Comment evidence

Fetch all comments for one known task ID. The method follows Todoist pagination,
validates response data, and writes one `comment` resource per comment.

```bash
swamp model method run my-todoist syncTaskComments \
  --input taskId="<task-id>"
```

Create a comment only when a human has approved its content:

```bash
swamp model method run my-todoist createTaskComment \
  --input taskId="<task-id>" \
  --input content="Android Chrome: tested installed PWA capture and relaunch recovery."
```

## Existing task and project operations

```bash
swamp model method run my-todoist syncTasks --input filter="#Work"
swamp model method run my-todoist syncProjects
swamp model method run my-todoist createTask --input content="Review release"
swamp model method run my-todoist createTask \
  --input content="Verify the release" \
  --input projectId="<project-id>" \
  --input parentId="<parent-task-id>"
swamp model method run my-todoist updateTask --input taskId="<task-id>" --input priority=4
swamp model method run my-todoist completeTask --input taskId="<task-id>"
swamp model method run my-todoist deleteTask --input taskId="<task-id>"
```

## Resources

- `task`: normalized active-task snapshot.
- `project`: normalized Todoist project snapshot.
- `comment`: normalized task-comment snapshot with `taskId`, `content`, `postedAt`,
  optional attachment data, and `syncedAt`.

For example, after comment sync:

```text
data.latest("my-todoist", "comment/<comment-id>").attributes.content
```

## Safety and behavior

Task IDs are validated before any request. Comment list reads are cursor-paginated
and fail on malformed data or repeated cursors. Comment creation is a mutation and
is not retried automatically. This is an independent integration and is not
created by, affiliated with, or supported by Doist.

## License

MIT — see LICENSE.txt.
