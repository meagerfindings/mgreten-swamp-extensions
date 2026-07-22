/**
 * Deterministic trip-packing planner and explicitly confirmed Todoist project creator.
 * Preview is entirely local and read-only; createProject calls Todoist REST API v2 only
 * after an exact confirmation match and persists the resulting remote identifiers.
 *
 * @module
 */

import { z } from "npm:zod@4";

const TODOIST_API = "https://api.todoist.com/rest/v2";
const CATEGORY_ORDER = [
  "clothing",
  "documentsSafety",
  "techPersonal",
  "techWork",
  "food",
  "kids",
  "toiletries",
  "vehicle",
  "beforeLeavingHouse",
] as const;

/** Stable category identifiers used in plans and Todoist section names. */
export const PackingCategorySchema = z.enum(CATEGORY_ORDER);
/** A compact caller-supplied item to append to one category. */
export const CustomItemSchema = z.object({
  category: PackingCategorySchema,
  item: z.string().trim().min(1).max(200),
});
/** Shared compact trip input that drives both preview and creation. */
export const TripInputSchema = z.object({
  projectName: z.string().trim().min(1).max(120),
  days: z.number().int().min(1).max(60),
  travelMode: z.enum(["car", "plane", "train", "bus", "other"]),
  lodging: z.enum(["home", "hotel", "rental", "camping", "family", "other"]),
  activities: z.array(
    z.enum(["casual", "dress", "farm", "hiking", "swimming", "work"]),
  ).max(12).default([]),
  travelers: z.number().int().min(1).max(20),
  includesKids: z.boolean().default(false),
  includeWorkGear: z.boolean().default(false),
  international: z.boolean().default(false),
  customItems: z.array(CustomItemSchema).max(100).default([]),
});
/** Model-level configuration; configure apiToken with a vault expression, never plaintext. */
export const GlobalArgsSchema = z.object({
  apiToken: z.string().min(1).meta({ sensitive: true }).describe(
    "Todoist API token; configure as ${{ vault.get(my-vault, TODOIST_API_TOKEN) }}.",
  ),
});
/** A named packing category and its stable, de-duplicated items. */
export const PlanCategorySchema = z.object({
  key: PackingCategorySchema,
  title: z.string(),
  items: z.array(z.string()),
});
/** Deterministic output of planning compact trip inputs. */
export const PlanSchema = z.object({
  projectName: z.string(),
  days: z.number().int(),
  marker: z.string(),
  categories: z.array(PlanCategorySchema),
});
const TodoistEntitySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  content: z.string().optional(),
  project_id: z.string().optional(),
  section_id: z.string().nullable().optional(),
  url: z.string().url().optional(),
});
/** Persisted result of a preview or confirmed Todoist creation. */
export const ProjectResourceSchema = z.object({
  status: z.enum(["preview", "created", "existing"]),
  marker: z.string(),
  project: z.object({ id: z.string(), url: z.string().url() }).nullable(),
  sections: z.array(
    z.object({ id: z.string(), name: z.string(), url: z.string().url() }),
  ),
  tasks: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      sectionId: z.string().nullable(),
      url: z.string().url(),
    }),
  ),
  plan: PlanSchema,
});

/** Convert a category key to a user-facing Todoist section title. */
export function categoryTitle(
  key: z.infer<typeof PackingCategorySchema>,
): string {
  return {
    clothing: "Clothing",
    documentsSafety: "Documents & safety",
    techPersonal: "Tech — personal",
    techWork: "Tech — work",
    food: "Food",
    kids: "Kids",
    toiletries: "Toiletries",
    vehicle: "Vehicle",
    beforeLeavingHouse: "Before leaving / house",
  }[key];
}
/** Create a stable FNV-1a hash without timestamps, randomness, or secret material. */
export function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
/** Generate an opaque deterministic marker from normalized non-secret plan inputs. */
export function markerFor(input: z.infer<typeof TripInputSchema>): string {
  const normalized = {
    projectName: input.projectName,
    days: input.days,
    travelMode: input.travelMode,
    lodging: input.lodging,
    activities: [...input.activities].sort(),
    travelers: input.travelers,
    includesKids: input.includesKids,
    includeWorkGear: input.includeWorkGear,
    international: input.international,
    customItems: [...input.customItems].map((item) => ({
      category: item.category,
      item: item.item,
    })).sort((left, right) =>
      `${left.category}:${left.item}`.localeCompare(
        `${right.category}:${right.item}`,
      )
    ),
  };
  return `[[swamp-trip-packing:v1:${fnv1a(JSON.stringify(normalized))}]]`;
}
/** Build the deterministic packing plan without network or clock access. */
export function buildPlan(rawInput: unknown): z.infer<typeof PlanSchema> {
  const input = TripInputSchema.parse(rawInput);
  const items: Record<z.infer<typeof PackingCategorySchema>, string[]> = {
    clothing: [
      "Casual outfits",
      "Sleepwear",
      "Socks and underwear",
      "Weather-appropriate layer",
    ],
    documentsSafety: [
      "Wallet and ID",
      "Health insurance card",
      "Emergency contacts",
    ],
    techPersonal: ["Phone", "Phone charger", "Personal charging cable"],
    techWork: [],
    food: ["Travel snacks", "Water bottles"],
    kids: [],
    toiletries: ["Toothbrush and toothpaste", "Deodorant", "Medications"],
    vehicle: [],
    beforeLeavingHouse: [
      "Lock doors and windows",
      "Set lights/thermostat",
      "Take out trash",
    ],
  };
  if (input.days >= 4) items.clothing.push("Laundry bag");
  if (input.activities.includes("dress")) {
    items.clothing.push("Dress outfit and shoes");
  }
  if (input.activities.includes("farm")) {
    items.clothing.push("Farm clothes and sturdy boots");
  }
  if (input.activities.includes("hiking")) {
    items.clothing.push("Hiking shoes", "Daypack", "Sun protection");
  }
  if (input.activities.includes("swimming")) {
    items.clothing.push("Swimsuit", "Towel");
  }
  if (input.international) {
    items.documentsSafety.push(
      "Passport",
      "Travel itinerary",
      "Payment backup",
    );
  }
  if (input.includeWorkGear || input.activities.includes("work")) {
    items.techWork.push("Work laptop", "Work charger", "Headset");
  }
  if (input.includesKids) {
    items.kids.push(
      "Kids clothing",
      "Comfort item",
      "Kids medications/diapers as needed",
      "Activities for travel",
    );
  }
  if (input.travelMode === "car") {
    items.vehicle.push(
      "Fuel/charge check",
      "Vehicle documents",
      "Emergency kit",
    );
    items.beforeLeavingHouse.push("Load vehicle");
  }
  if (input.lodging === "camping") {
    items.food.push("Cooler and ice", "Camp meals");
  }
  for (const custom of input.customItems) {
    items[custom.category].push(custom.item);
  }
  return {
    projectName: input.projectName,
    days: input.days,
    marker: markerFor(input),
    categories: CATEGORY_ORDER.map((key) => ({
      key,
      title: categoryTitle(key),
      items: [...new Set(items[key])],
    })).filter((category) => category.items.length > 0),
  };
}
function projectUrl(id: string): string {
  return `https://app.todoist.com/app/project/${id}`;
}
function sectionUrl(id: string): string {
  return `https://app.todoist.com/app/section/${id}`;
}
function taskUrl(id: string): string {
  return `https://app.todoist.com/app/task/${id}`;
}
/** Issue one Todoist REST API v2 request and validate errors before parsing a response. */
async function todoistRequest(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(`${TODOIST_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Todoist ${init?.method ?? "GET"} ${path} failed (${response.status}): ${
        text.slice(0, 500)
      }`,
    );
  }
  return text.length === 0 ? null : JSON.parse(text);
}
type TodoistEntity = z.infer<typeof TodoistEntitySchema>;
type ReconciledProject = {
  project: TodoistEntity;
  sections: TodoistEntity[];
  tasks: TodoistEntity[];
};

/** Locate an existing project only by its stable, non-task marker section. */
async function findExistingProject(
  token: string,
  plan: z.infer<typeof PlanSchema>,
): Promise<ReconciledProject | null> {
  const projects = z.array(TodoistEntitySchema).parse(
    await todoistRequest(token, "/projects"),
  );
  for (
    const project of projects.filter((candidate) =>
      candidate.name === plan.projectName
    )
  ) {
    const sections = z.array(TodoistEntitySchema).parse(
      await todoistRequest(
        token,
        `/sections?project_id=${encodeURIComponent(project.id)}`,
      ),
    );
    if (sections.some((section) => section.name === plan.marker)) {
      const tasks = z.array(TodoistEntitySchema).parse(
        await todoistRequest(
          token,
          `/tasks?project_id=${encodeURIComponent(project.id)}`,
        ),
      );
      return { project, sections, tasks };
    }
  }
  return null;
}

/** Create only the missing user-facing sections and planned tasks in a marked project. */
async function reconcileProject(
  token: string,
  plan: z.infer<typeof PlanSchema>,
  state: ReconciledProject,
): Promise<ReconciledProject> {
  const sections = [...state.sections];
  const tasks = [...state.tasks];
  for (const category of plan.categories) {
    let section = sections.find((candidate) =>
      candidate.name === category.title
    );
    if (!section) {
      section = TodoistEntitySchema.parse(
        await todoistRequest(token, "/sections", {
          method: "POST",
          body: JSON.stringify({
            project_id: state.project.id,
            name: category.title,
          }),
        }),
      );
      sections.push(section);
    }
    for (const content of category.items) {
      if (
        !tasks.some((task) =>
          task.section_id === section.id && task.content === content
        )
      ) {
        const task = TodoistEntitySchema.parse(
          await todoistRequest(token, "/tasks", {
            method: "POST",
            body: JSON.stringify({
              project_id: state.project.id,
              section_id: section.id,
              content,
            }),
          }),
        );
        tasks.push(task);
      }
    }
  }
  return { project: state.project, sections, tasks };
}
function resourceValue(
  status: "created" | "existing",
  plan: z.infer<typeof PlanSchema>,
  state: ReconciledProject,
) {
  const desiredNames = new Set(
    plan.categories.map((category) => category.title),
  );
  const desiredSectionIds = new Set(
    state.sections.filter((section) => desiredNames.has(section.name ?? ""))
      .map((section) => section.id),
  );
  return {
    status,
    marker: plan.marker,
    project: {
      id: state.project.id,
      url: state.project.url ?? projectUrl(state.project.id),
    },
    sections: state.sections.filter((section) =>
      desiredSectionIds.has(section.id)
    ).map((section) => ({
      id: section.id,
      name: section.name ?? "Untitled section",
      url: section.url ?? sectionUrl(section.id),
    })),
    tasks: state.tasks.filter((task) =>
      task.section_id !== null && desiredSectionIds.has(task.section_id)
    ).map((task) => ({
      id: task.id,
      content: task.content ?? "",
      sectionId: task.section_id ?? null,
      url: task.url ?? taskUrl(task.id),
    })),
    plan,
  };
}

/** Model definition for local preview and explicitly-confirmed Todoist project creation. */
export const model = {
  type: "@mgreten/trip-packing",
  version: "2026.07.22.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    tripProject: {
      description:
        "Previewed packing plan or idempotently created Todoist project identifiers and URLs.",
      schema: ProjectResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  checks: {
    confirmation: {
      description:
        "Require an exact project-name confirmation before Todoist mutation.",
      labels: ["policy"],
      execute: (context) => {
        const args = context.methodArgs as {
          projectName?: string;
          confirmation?: string;
        } | undefined;
        return args?.confirmation === args?.projectName ? { pass: true } : {
          pass: false,
          errors: [
            "confirmation must exactly equal projectName before Todoist mutation",
          ],
        };
      },
    },
  },
  methods: {
    preview: {
      description:
        "Generate and persist a deterministic, read-only categorized packing plan.",
      arguments: TripInputSchema,
      execute: async (args, context) => {
        const plan = buildPlan(args);
        context.logger.info(
          "Generated read-only trip packing preview for {projectName}",
          { projectName: plan.projectName },
        );
        const handle = await context.writeResource(
          "tripProject",
          `preview-${fnv1a(plan.marker)}`,
          {
            status: "preview",
            marker: plan.marker,
            project: null,
            sections: [],
            tasks: [],
            plan,
          },
        );
        context.logger.info(
          "Persisted read-only trip packing preview for {projectName}",
          { projectName: plan.projectName },
        );
        return { dataHandles: [handle] };
      },
    },
    createProject: {
      description:
        "Create or reconcile a marked Todoist project, sections, and tasks only after exact confirmation.",
      arguments: TripInputSchema.extend({ confirmation: z.string().max(120) }),
      execute: async (args, context) => {
        const input = TripInputSchema.parse(args);
        const confirmation = z.string().max(120).parse(
          (args as { confirmation: unknown }).confirmation,
        );
        if (confirmation !== input.projectName) {
          throw new Error(
            "confirmation must exactly equal projectName before Todoist mutation",
          );
        }
        const plan = buildPlan(input);
        const token = context.globalArgs.apiToken;
        context.logger.info(
          "Checking Todoist for an existing marked trip project for {projectName}",
          { projectName: plan.projectName },
        );
        const existing = await findExistingProject(token, plan);
        if (existing) {
          const reconciled = await reconcileProject(token, plan, existing);
          const handle = await context.writeResource(
            "tripProject",
            `project-${fnv1a(plan.marker)}`,
            resourceValue("existing", plan, reconciled),
          );
          context.logger.info(
            "Reconciled existing marked Todoist project for {projectName}",
            { projectName: plan.projectName },
          );
          return { dataHandles: [handle] };
        }
        const project = TodoistEntitySchema.parse(
          await todoistRequest(token, "/projects", {
            method: "POST",
            body: JSON.stringify({ name: input.projectName }),
          }),
        );
        const markerSection = TodoistEntitySchema.parse(
          await todoistRequest(token, "/sections", {
            method: "POST",
            body: JSON.stringify({ project_id: project.id, name: plan.marker }),
          }),
        );
        const reconciled = await reconcileProject(token, plan, {
          project,
          sections: [markerSection],
          tasks: [],
        });
        const handle = await context.writeResource(
          "tripProject",
          `project-${fnv1a(plan.marker)}`,
          resourceValue("created", plan, reconciled),
        );
        context.logger.info("Created Todoist trip project for {projectName}", {
          projectName: plan.projectName,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
