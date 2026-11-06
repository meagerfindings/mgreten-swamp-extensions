# @mgreten/trip-packing

`@mgreten/trip-packing` turns compact trip inputs into a deterministic,
categorized packing plan. Its `preview` method is read-only: it does not use the
network, does not read Todoist, and produces the same plan and marker for the
same normalized input. The plan includes clothing (including casual, sleep,
dress, farm, and hiking conditions), documents and safety, personal and work
tech, food, kids, toiletries, vehicle, and before-leaving/house tasks where
applicable.

`createProject` is intentionally mutating and requires the `confirmation`
argument to **exactly** equal `projectName`. It scans Todoist projects with the
requested name and recognizes a deterministic **marker section** (not a visible
marker task). On a marked match it lists the project's sections and tasks,
creates only missing planned user-facing sections and tasks, and returns the
reconciled remote state. On a new project it creates the marker section first,
followed by the user-facing packing sections and tasks; the marker section is
not included in the persisted packing-plan resource sections. It never reads,
logs, or returns the API token.

## Configure

Store a Todoist token in a vault and configure the sensitive global argument
with a vault reference. Do not place a token in this extension source, README,
fixtures, or model file.

```yaml
globalArguments:
  apiToken: "${{ vault.get(my-vault, TODOIST_API_TOKEN) }}"
```

## Preview

Preview accepts only compact trip characteristics and optional category-targeted
custom items.

```yaml
projectName: "July mountain trip"
days: 5
travelMode: car
lodging: rental
activities: [casual, hiking]
travelers: 4
includesKids: true
includeWorkGear: false
international: false
customItems:
  - category: food
    item: Reusable coffee mugs
```

## Create safely

Use the exact project name as confirmation only after reviewing the preview.
Creation requires Todoist REST API v2 access and a token authorized to create
projects, sections, and tasks.

```yaml
projectName: "July mountain trip"
confirmation: "July mountain trip"
```

If a network failure occurs after the remote project is created, rerun with the
same input and confirmation. The stable marker-section scan finds the
already-created project and reconciliation fills in any planned sections or
tasks that were not created before the interruption.

### Limitation: manual marker-section deletion

Todoist REST API v2 does not provide an external, immutable idempotency key that
this model can use to recover a project after its marker section is manually
deleted. Deleting that marker section removes this model's duplicate guard; a
later retry may create another project with the same name. Keep the marker
section while the project remains managed, and do not rely on this integration
to prevent duplicate creation after an external manual deletion.
