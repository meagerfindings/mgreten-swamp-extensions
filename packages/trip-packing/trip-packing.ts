/**
 * Deterministic trip-packing planner with an explicit Todoist confirmation gate.
 * Preview is local and read-only; project creation requires exact confirmation.
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
/** Stable category identifiers used in plans and Todoist sections. */
export const PackingCategorySchema = z.enum(CATEGORY_ORDER);
/** A caller-supplied item assigned to one packing category. */
export const CustomItemSchema = z.object({
  category: PackingCategorySchema,
  item: z.string().trim().min(1).max(200),
});
/** Validated trip input shared by deterministic preview and creation. */
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
  homeOccupied: z.boolean().default(false).describe(
    "Whether someone remains at home; omits house-shutdown tasks when true.",
  ),
  customItems: z.array(CustomItemSchema).max(100).default([]),
});
/** Model-level configuration; provide the API token through a vault. */
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
/** Deterministic output of planning validated trip inputs. */
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
/** Persisted result of a preview or confirmed Todoist project operation. */
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
type Category = z.infer<typeof PackingCategorySchema>;
type TripInput = z.infer<typeof TripInputSchema>;
type TodoistEntity = z.infer<typeof TodoistEntitySchema>;
type ReconciledProject = {
  project: TodoistEntity;
  sections: TodoistEntity[];
  tasks: TodoistEntity[];
};
interface ModelContext {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  methodArgs?: unknown;
  logger: { info: (message: string, values: Record<string, unknown>) => void };
  writeResource: (
    resource: string,
    name: string,
    value: unknown,
  ) => Promise<Record<string, unknown>>;
}

/** Convert a category identifier to its user-facing Todoist section title. */
export function categoryTitle(key: Category): string {
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
/** Create a stable FNV-1a hash without timestamps or secret material. */
export function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
/** Generate an opaque deterministic marker from normalized trip inputs. */
export function markerFor(input: TripInput): string {
  const normalized = {
    ...input,
    activities: [...input.activities].sort(),
    customItems: [...input.customItems].map((item) => ({
      category: item.category,
      item: item.item,
    })).sort((a, b) =>
      `${a.category}:${a.item}`.localeCompare(`${b.category}:${b.item}`)
    ),
  };
  return `[[swamp-trip-packing:v2:${fnv1a(JSON.stringify(normalized))}]]`;
}
function quantityLabel(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
function clothingItems(input: TripInput): string[] {
  const shirts = `${input.days} ${
    input.activities.includes("work") ? "work/casual" : "casual"
  } shirts${input.days > 1 ? ` (wear 1; pack ${input.days - 1})` : ""}`;
  const underwear = `${
    quantityLabel(input.days + 1, "pair", "pairs")
  } underwear (${input.days} day${input.days === 1 ? "" : "s"} + 1 spare)`;
  const socks = `${
    quantityLabel(input.days + 1, "pair", "pairs")
  } socks (${input.days} day${input.days === 1 ? "" : "s"} + 1 spare)`;
  const pantsCount = Math.max(1, Math.ceil(input.days / 3));
  const pants = `${quantityLabel(pantsCount, "pair", "pairs")} ${
    input.activities.includes("work") ? "work/casual" : "casual"
  } pants${pantsCount > 1 ? " (wear 1; pack 1)" : ""}`;
  const items = [
    shirts,
    underwear,
    socks,
    pants,
    "1 sleep outfit",
    "1 weather-appropriate layer",
  ];
  if (input.days >= 4) items.push("Laundry bag");
  return items;
}
/** Build the deterministic packing plan without network or clock access. */
export function buildPlan(rawInput: unknown): z.infer<typeof PlanSchema> {
  const input = TripInputSchema.parse(rawInput);
  const items: Record<Category, string[]> = {
    clothing: clothingItems(input),
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
    beforeLeavingHouse: input.homeOccupied
      ? []
      : ["Lock doors and windows", "Set lights/thermostat", "Take out trash"],
  };
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
      "Load vehicle",
    );
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
      typeof task.section_id === "string" &&
      desiredSectionIds.has(task.section_id)
    ).map((task) => ({
      id: task.id,
      content: task.content ?? "",
      sectionId: task.section_id ?? null,
      url: task.url ?? taskUrl(task.id),
    })),
    plan,
  };
}
/** Model definition for local preview and explicitly-confirmed project creation. */
export const model = {
  type: "@mgreten/trip-packing",
  version: "2026.07.23.1",
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
      execute: (context: ModelContext) => {
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
      execute: async (args: TripInput, context: ModelContext) => {
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
        return { dataHandles: [handle] };
      },
    },
    createProject: {
      description:
        "Create or reconcile a marked Todoist project, sections, and tasks only after exact confirmation.",
      arguments: TripInputSchema.extend({ confirmation: z.string().max(120) }),
      execute: async (
        args: TripInput & { confirmation: string },
        context: ModelContext,
      ) => {
        const input = TripInputSchema.parse(args);
        if (args.confirmation !== input.projectName) {
          throw new Error(
            "confirmation must exactly equal projectName before Todoist mutation",
          );
        }
        const plan = buildPlan(input);
        const existing = await findExistingProject(
          context.globalArgs.apiToken,
          plan,
        );
        const reconciled = existing
          ? await reconcileProject(context.globalArgs.apiToken, plan, existing)
          : await (async () => {
            const project = TodoistEntitySchema.parse(
              await todoistRequest(context.globalArgs.apiToken, "/projects", {
                method: "POST",
                body: JSON.stringify({ name: input.projectName }),
              }),
            );
            const marker = TodoistEntitySchema.parse(
              await todoistRequest(context.globalArgs.apiToken, "/sections", {
                method: "POST",
                body: JSON.stringify({
                  project_id: project.id,
                  name: plan.marker,
                }),
              }),
            );
            return await reconcileProject(context.globalArgs.apiToken, plan, {
              project,
              sections: [marker],
              tasks: [],
            });
          })();
        const handle = await context.writeResource(
          "tripProject",
          `project-${fnv1a(plan.marker)}`,
          resourceValue(existing ? "existing" : "created", plan, reconciled),
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
