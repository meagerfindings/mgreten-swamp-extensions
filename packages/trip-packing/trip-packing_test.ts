import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildPlan,
  markerFor,
  model,
  TripInputSchema,
} from "./trip-packing.ts";
import familyRoadTrip from "./fixtures/family-road-trip.json" with {
  type: "json",
};

Deno.test("preview plan is deterministic and contains conditional categories", () => {
  const first = buildPlan(familyRoadTrip);
  const second = buildPlan(familyRoadTrip);
  assertEquals(first, second);
  assertEquals(first.marker, markerFor(TripInputSchema.parse(familyRoadTrip)));
  const clothing = first.categories.find((category) =>
    category.key === "clothing"
  );
  assert(clothing?.items.includes("Hiking shoes"));
  assert(clothing?.items.includes("Farm clothes and sturdy boots"));
  assert(first.categories.some((category) => category.key === "kids"));
  assert(first.categories.some((category) => category.key === "vehicle"));
});

Deno.test("plan rejects invalid compact inputs before any API path is reachable", () => {
  const invalid = { ...familyRoadTrip, days: 0 };
  let threw = false;
  try {
    buildPlan(invalid);
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("same normalized inputs keep their marker despite input order", () => {
  const reordered = {
    ...familyRoadTrip,
    activities: ["farm", "casual", "hiking"],
    customItems: [...familyRoadTrip.customItems].reverse(),
  };
  assertEquals(buildPlan(familyRoadTrip).marker, buildPlan(reordered).marker);
});

Deno.test("retry reconciles a marked partial project without creating a duplicate", async () => {
  const plan = buildPlan(familyRoadTrip);
  const markerSection = {
    id: "marker",
    name: plan.marker,
    url: "https://app.todoist.com/app/section/marker",
  };
  const sections = [markerSection, {
    id: "clothing",
    name: "Clothing",
    url: "https://app.todoist.com/app/section/clothing",
  }];
  const tasks = [{
    id: "existing-clothing",
    content: "Casual outfits",
    project_id: "project-1",
    section_id: "clothing",
    url: "https://app.todoist.com/app/task/existing-clothing",
  }];
  const projectPosts: unknown[] = [];
  const originalFetch = globalThis.fetch;
  let nextId = 0;
  // deno-lint-ignore require-await
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith("/projects") && method === "GET") {
      return Response.json([{
        id: "project-1",
        name: plan.projectName,
        url: "https://app.todoist.com/app/project/project-1",
      }]);
    }
    if (url.includes("/sections?project_id=project-1")) {
      return Response.json(sections);
    }
    if (url.includes("/tasks?project_id=project-1")) {
      return Response.json(tasks);
    }
    if (url.endsWith("/projects") && method === "POST") {
      projectPosts.push(body);
      return Response.json({ id: "duplicate-project", name: body.name });
    }
    if (url.endsWith("/sections") && method === "POST") {
      const section = {
        id: `section-${++nextId}`,
        name: body.name,
        project_id: body.project_id,
      };
      sections.push(section);
      return Response.json(section);
    }
    if (url.endsWith("/tasks") && method === "POST") {
      const task = {
        id: `task-${++nextId}`,
        content: body.content,
        project_id: body.project_id,
        section_id: body.section_id,
      };
      tasks.push(task);
      return Response.json(task);
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };
  try {
    let persisted: unknown;
    const context = {
      globalArgs: { apiToken: "test-token" },
      logger: { info: () => undefined },
      // deno-lint-ignore require-await
      writeResource: async (
        _resource: string,
        _name: string,
        value: unknown,
      ) => {
        persisted = value;
        return { resource: "tripProject" };
      },
    };
    await model.methods.createProject.execute({
      ...familyRoadTrip,
      confirmation: familyRoadTrip.projectName,
    }, context as never);
    assertEquals(projectPosts, []);
    const result = persisted as {
      sections: Array<{ name: string }>;
      tasks: Array<{ content: string }>;
    };
    assertEquals(
      result.sections.map((section) => section.name).sort(),
      plan.categories.map((category) => category.title).sort(),
    );
    assertEquals(
      result.tasks.map((task) => task.content).sort(),
      plan.categories.flatMap((category) => category.items).sort(),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
