import assert from "node:assert/strict";
import { MAX_STORAGE_RESPONSE_BYTES } from "../domain.ts";
import { executeOperation } from "./meal_planner_runtime.ts";

const OPERATION_ID = "a".repeat(32);
const STORAGE_API_URL = "http://meal-planner-api:3000";
const STORAGE_TOKEN_FILE = "/run/secrets/meal-planner/storage-token";
const groceryInput = {
  week: {
    revision: 3,
    status: "approved",
    approvedSnapshot: {
      content: {
        meals: [{
          id: "synthetic-dinner",
          arrangement: "home",
          groceryResponsibility: "household",
          condition: null,
          leftoverFor: null,
          safetyStatus: "validated",
          portions: 7,
          recipeSnapshot: {
            content: {
              title: "Synthetic tomato and lentil stew",
              servings: 4,
              ingredients: [
                {
                  name: "Tomato",
                  ingredientKey: "tomato",
                  amount: 400,
                  unit: "g",
                },
                {
                  name: "Lentils",
                  ingredientKey: "lentils",
                  amount: 200,
                  unit: "g",
                },
                {
                  name: "Salt",
                  ingredientKey: "salt",
                  amount: null,
                  unit: null,
                },
              ],
              instructions: ["Cook the synthetic ingredients."],
            },
          },
        }],
      },
    },
  },
  pantry: {
    revision: 2,
    items: [
      { ingredientKey: "tomato", amount: 250, unit: "g" },
      { ingredientKey: "lentils", amount: 0, unit: "g" },
    ],
  },
};

function storageFixture(weekStart: string) {
  const operation = {
    id: OPERATION_ID,
    householdId: "synthetic-household",
    actorId: "synthetic-member",
    kind: "grocery.recalculate",
    status: "running",
    payload: {
      weekStart,
      expectedWeekRevision: 3,
      expectedPantryRevision: 2,
    },
  };
  const state: {
    groceries: unknown[] | null;
    error: Record<string, unknown> | null;
    inputRead: boolean;
  } = { groceries: null, error: null, inputRead: false };
  const json = (data: unknown, status = 200) =>
    Promise.resolve(Response.json({ data }, { status }));

  const fetchImpl: typeof fetch = (input, init) => {
    const path = new URL(String(input)).pathname;
    const requestInit = init as
      | { method?: string; body?: BodyInit | null }
      | undefined;
    const method = requestInit?.method ?? "GET";

    if (method === "POST" && path.endsWith("/claim")) {
      return json({ claimed: true, operation });
    }
    if (method === "GET" && path.endsWith("/grocery-input")) {
      state.inputRead = true;
      return json(groceryInput);
    }
    if (method === "POST" && path.endsWith("/groceries/recalculate")) {
      const body = JSON.parse(String(requestInit?.body)) as {
        items: unknown[];
      };
      state.groceries = body.items;
      return json({ saved: true });
    }
    if (method === "POST" && path.endsWith("/complete")) {
      const body = JSON.parse(String(requestInit?.body)) as {
        error?: Record<string, unknown> | null;
      };
      state.error = body.error ?? null;
      return json({ completed: true });
    }
    return json({ error: { code: "FIXTURE_UNEXPECTED_REQUEST" } }, 404);
  };

  return { fetchImpl, state };
}

const runtimeContext = {
  globalArgs: {
    storageApiUrl: STORAGE_API_URL,
    storageTokenFile: STORAGE_TOKEN_FILE,
  },
  runModel: () =>
    Promise.resolve({
      ok: false as const,
      error: { message: "Mealie is not used by this fixture." },
    }),
  readModelData: () => Promise.resolve([]),
  dataRepository: { getContent: () => Promise.resolve(null) },
};
const readSyntheticToken = (_path: string) =>
  Promise.resolve("synthetic-bearer-token-12345678901234567890");

Deno.test("executeOperation calculates grocery totals through the storage contract", async () => {
  const fixture = storageFixture("2026-11-09");
  await executeOperation(
    OPERATION_ID,
    runtimeContext,
    fixture.fetchImpl,
    readSyntheticToken,
  );

  const groceries = fixture.state.groceries;
  assert.ok(groceries);
  const row = (key: string) => {
    const value = groceries.find((item) =>
      (item as Record<string, unknown>).ingredientKey === key
    );
    assert.ok(value, `expected grocery row: ${key}`);
    return value as Record<string, unknown>;
  };
  const amount = (key: string, field: string) =>
    (row(key)[field] as { amount: unknown }).amount;

  assert.equal(amount("tomato", "needed"), 700);
  assert.equal(amount("tomato", "pantry"), 250);
  assert.equal(amount("tomato", "toBuy"), 450);
  assert.equal(amount("lentils", "needed"), 350);
  assert.equal(amount("lentils", "pantry"), 0);
  assert.equal(amount("lentils", "toBuy"), 350);
  assert.equal(amount("salt", "needed"), null);
  assert.equal(amount("salt", "toBuy"), null);
  assert.equal(fixture.state.error, null);
});

Deno.test("executeOperation records invalid week dates without reading or saving groceries", async () => {
  const fixture = storageFixture("2026-02-30");
  await executeOperation(
    OPERATION_ID,
    runtimeContext,
    fixture.fetchImpl,
    readSyntheticToken,
  );

  assert.equal(fixture.state.error?.code, "VALIDATION_ERROR");
  assert.equal(fixture.state.inputRead, false);
  assert.equal(fixture.state.groceries, null);
});

function recipeWriteFixture(
  kind: "recipe.create" | "recipe.update" | "recipe.import-url",
  payload: Record<string, unknown>,
  storageFailure?: { status: number; code: string } | "committed-response-lost",
) {
  const operation = {
    id: OPERATION_ID,
    householdId: "synthetic-household",
    actorId: "synthetic-member",
    kind,
    status: "running",
    payload,
  };
  const currentContent = {
    title: "Synthetic recipe",
    servings: 4,
    ingredients: [{ name: "Synthetic beans", amount: 1, unit: "cup" }],
    instructions: ["Cook the synthetic beans."],
  };
  const canonicalMealieRecipe = {
    slug: "synthetic-canonical-recipe",
    name: "Synthetic recipe",
    recipeServings: 4,
    recipeIngredient: [{
      quantity: 1,
      unit: { name: "cup" },
      food: { name: "Synthetic beans" },
    }],
    recipeInstructions: [{ text: "Cook the synthetic beans." }],
  };
  const state: {
    externalWrites: string[];
    storageWriteBytes: number | null;
    completedError: Record<string, unknown> | null;
    operationStatus: "running" | "failed" | "succeeded";
  } = {
    externalWrites: [],
    storageWriteBytes: null,
    completedError: null,
    operationStatus: "running",
  };
  const json = (data: unknown, status = 200) =>
    Promise.resolve(Response.json({ data }, { status }));
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const requestInit = init as
      | { method?: string; body?: BodyInit | null }
      | undefined;
    const method = requestInit?.method ?? "GET";
    if (method === "POST" && url.pathname.endsWith("/claim")) {
      return json({ claimed: true, operation });
    }
    if (method === "GET" && url.pathname.endsWith("/recipes/source")) {
      return json({ recipe: null });
    }
    if (method === "GET" && /\/recipes\/[a-f0-9]{32}$/.test(url.pathname)) {
      return json({
        recipe: {
          id: "b".repeat(32),
          mealieId: "synthetic-canonical-recipe",
          revision: 1,
          familyVersionId: "c".repeat(32),
          family: currentContent,
        },
      });
    }
    if (
      method === "POST" &&
      (url.pathname.endsWith("/recipes") || url.pathname.endsWith("/versions"))
    ) {
      const body = String(requestInit?.body ?? "");
      state.storageWriteBytes = new TextEncoder().encode(body).byteLength;
      if (storageFailure === "committed-response-lost") {
        state.operationStatus = "succeeded";
        throw new TypeError(
          "Synthetic response loss after committed storage success",
        );
      }
      if (storageFailure) {
        return Response.json({
          error: {
            code: storageFailure.code,
            message: "Synthetic storage rejection",
          },
        }, {
          status: storageFailure.status,
        });
      }
      return json({ saved: true });
    }
    if (method === "POST" && url.pathname.endsWith("/complete")) {
      const body = JSON.parse(String(requestInit?.body ?? "{}")) as {
        error?: Record<string, unknown>;
      };
      state.completedError = body.error ?? null;
      if (state.operationStatus !== "succeeded") {
        state.operationStatus = "failed";
      }
      return json({ completed: true });
    }
    return Response.json({ error: { code: "FIXTURE_UNEXPECTED_REQUEST" } }, {
      status: 404,
    });
  };
  const context = {
    globalArgs: {
      storageApiUrl: STORAGE_API_URL,
      storageTokenFile: STORAGE_TOKEN_FILE,
    },
    runModel: async ({ method }: { method: string }) => {
      state.externalWrites.push(method);
      return {
        ok: true as const,
        resources: [{
          kind: "resource" as const,
          specName: "recipe",
          name: "current",
          version: 1,
        }],
      };
    },
    readModelData: async (_definition: string, specName: string) => [{
      name: "current",
      specName,
      modelType: "synthetic-mealie-model-type",
      modelId: "synthetic-mealie-model-id",
    }],
    dataRepository: {
      getContent: async (
        _modelType: unknown,
        _modelId: string,
        _name: string,
        version?: number,
      ) => {
        assert.equal(
          version,
          1,
          "recipe readback must use the exact invocation DataHandle version",
        );
        return new TextEncoder().encode(JSON.stringify(canonicalMealieRecipe));
      },
    },
  };
  return { fetchImpl, context, state };
}

Deno.test("invalid structured create/update recipes fail before any Mealie write", async () => {
  const cases = [
    {
      kind: "recipe.create" as const,
      content: {
        title: "Synthetic recipe",
        servings: 501,
        ingredients: [{ name: "Synthetic beans", amount: 1, unit: "cup" }],
        instructions: ["Cook the synthetic beans."],
      },
    },
    {
      kind: "recipe.update" as const,
      content: {
        title: "Synthetic recipe",
        servings: 4,
        ingredients: [{
          name: "Synthetic beans",
          amount: 1,
          unit: "u".repeat(65),
        }],
        instructions: ["Cook the synthetic beans."],
      },
    },
  ];

  for (const item of cases) {
    const payload = item.kind === "recipe.create"
      ? { content: item.content }
      : {
        recipeId: "b".repeat(32),
        expectedRevision: 1,
        content: item.content,
      };
    const fixture = recipeWriteFixture(item.kind, payload);
    await executeOperation(
      OPERATION_ID,
      fixture.context,
      fixture.fetchImpl,
      readSyntheticToken,
    );
    assert.deepEqual(
      fixture.state.externalWrites,
      [],
      `${item.kind} must reject before Mealie`,
    );
    assert.equal(fixture.state.completedError?.code, "VALIDATION_ERROR");
    assert.equal(fixture.state.completedError?.externalWriteAttempted, false);
  }
});

Deno.test("create, update, and URL-import persistence failures are unknown after Mealie writes", async () => {
  const validContent = {
    title: "Synthetic recipe",
    servings: 4,
    ingredients: [{ name: "Synthetic beans", amount: 1, unit: "cup" }],
    instructions: ["Cook the synthetic beans."],
  };
  const cases = [
    {
      kind: "recipe.create" as const,
      payload: { content: validContent },
      failure: { status: 413, code: "VALIDATION_ERROR" },
      expectedMethod: "createStructuredRecipe",
    },
    {
      kind: "recipe.update" as const,
      payload: {
        recipeId: "b".repeat(32),
        expectedRevision: 1,
        content: validContent,
      },
      failure: { status: 422, code: "VALIDATION_ERROR" },
      expectedMethod: "updateStructuredRecipe",
    },
    {
      kind: "recipe.create" as const,
      payload: { content: validContent },
      failure: { status: 409, code: "REVISION_CONFLICT" },
      expectedMethod: "createStructuredRecipe",
    },
    {
      kind: "recipe.import-url" as const,
      payload: { url: "https://recipes.example.invalid/synthetic" },
      failure: { status: 503, code: "STORAGE_UNAVAILABLE" },
      expectedMethod: "importRecipeFromUrl",
    },
  ];

  for (const item of cases) {
    const fixture = recipeWriteFixture(item.kind, item.payload, item.failure);
    await executeOperation(
      OPERATION_ID,
      fixture.context,
      fixture.fetchImpl,
      readSyntheticToken,
    );
    assert.deepEqual(fixture.state.externalWrites, [item.expectedMethod]);
    assert.equal(
      fixture.state.completedError?.code,
      "OPERATION_OUTCOME_UNKNOWN",
    );
    assert.equal(fixture.state.completedError?.externalWriteAttempted, true);
    assert.doesNotMatch(
      JSON.stringify(fixture.state.completedError),
      /synthetic-canonical-recipe|synthetic-mealie/,
    );
    assert.ok((fixture.state.storageWriteBytes ?? 0) < 1_048_576);
  }
});

Deno.test("late failure reporting cannot turn an atomically committed write into failure", async () => {
  const fixture = recipeWriteFixture("recipe.create", {
    content: {
      title: "Synthetic recipe",
      servings: 4,
      ingredients: [{ name: "Synthetic beans", amount: 1, unit: "cup" }],
      instructions: ["Cook the synthetic beans."],
    },
  }, "committed-response-lost");
  await executeOperation(
    OPERATION_ID,
    fixture.context,
    fixture.fetchImpl,
    readSyntheticToken,
  );

  assert.deepEqual(fixture.state.externalWrites, ["createStructuredRecipe"]);
  assert.equal(fixture.state.completedError?.code, "OPERATION_OUTCOME_UNKNOWN");
  assert.equal(fixture.state.operationStatus, "succeeded");
});

function approvalResponseFixture(
  responseFactory: () => Response,
  committedBeforeResponse = false,
) {
  const operation = {
    id: OPERATION_ID,
    householdId: "synthetic-household",
    actorId: "synthetic-member",
    kind: "week.approve",
    status: "running",
    payload: {
      weekStart: "2026-11-09",
      expectedRevision: 1,
      expectedRestrictionsRevision: 1,
    },
  };
  const state: {
    operationStatus: "running" | "failed" | "succeeded";
    completedError: Record<string, unknown> | null;
  } = { operationStatus: "running", completedError: null };
  const fetchImpl: typeof fetch = (input, init) => {
    const path = new URL(String(input)).pathname;
    const requestInit = init as
      | { method?: string; body?: BodyInit | null }
      | undefined;
    const method = requestInit?.method ?? "GET";
    if (method === "POST" && path.endsWith("/claim")) {
      return Promise.resolve(
        Response.json({ data: { claimed: true, operation } }),
      );
    }
    if (method === "POST" && path.endsWith("/approve")) {
      if (committedBeforeResponse) state.operationStatus = "succeeded";
      return Promise.resolve(responseFactory());
    }
    if (method === "POST" && path.endsWith("/complete")) {
      const body = JSON.parse(String(requestInit?.body ?? "{}")) as {
        error?: Record<string, unknown>;
      };
      state.completedError = body.error ?? null;
      if (state.operationStatus !== "succeeded") {
        state.operationStatus = "failed";
      }
      return Promise.resolve(Response.json({ data: { completed: true } }));
    }
    return Promise.resolve(
      Response.json({ error: { code: "FIXTURE_UNEXPECTED_REQUEST" } }, {
        status: 404,
      }),
    );
  };
  return { fetchImpl, state };
}

Deno.test("storage response cap counts actual streamed UTF-8 bytes, not Content-Length", async () => {
  const prefix = '{"data":{"padding":"';
  const suffix = '"}}';
  const exactBody = `${prefix}${
    "x".repeat(MAX_STORAGE_RESPONSE_BYTES - prefix.length - suffix.length)
  }${suffix}`;
  assert.equal(
    new TextEncoder().encode(exactBody).byteLength,
    MAX_STORAGE_RESPONSE_BYTES,
  );
  const fixture = approvalResponseFixture(() =>
    new Response(exactBody, {
      status: 200,
      headers: { "content-length": String(MAX_STORAGE_RESPONSE_BYTES + 1) },
    }), true);

  await executeOperation(
    OPERATION_ID,
    runtimeContext,
    fixture.fetchImpl,
    readSyntheticToken,
  );

  assert.equal(fixture.state.completedError, null);
  assert.equal(fixture.state.operationStatus, "succeeded");
});

Deno.test("over-limit storage streams are canceled and fail closed with missing or lying lengths", async () => {
  for (const contentLength of [null, "1"]) {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_STORAGE_RESPONSE_BYTES + 1));
      },
      cancel() {
        canceled = true;
        return new Promise<void>(() => {});
      },
    });
    const headers = new Headers();
    if (contentLength !== null) headers.set("content-length", contentLength);
    const fixture = approvalResponseFixture(() =>
      new Response(stream, { status: 200, headers })
    );
    const startedAt = Date.now();

    await executeOperation(
      OPERATION_ID,
      runtimeContext,
      fixture.fetchImpl,
      readSyntheticToken,
    );

    assert.ok(
      Date.now() - startedAt < 2_000,
      "a stalled cancel promise must not hold the operation open",
    );
    assert.equal(canceled, true);
    assert.equal(
      stream.locked,
      false,
      "the response reader lock must be released",
    );
    assert.equal(fixture.state.completedError?.code, "STORAGE_UNAVAILABLE");
    assert.equal(fixture.state.operationStatus, "failed");
  }
});

Deno.test("a late response-cap failure cannot replace committed approval success", async () => {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_STORAGE_RESPONSE_BYTES + 1));
    },
    cancel() {
      canceled = true;
      return new Promise<void>(() => {});
    },
  });
  const fixture = approvalResponseFixture(() =>
    new Response(stream, {
      status: 200,
      headers: { "content-length": "1" },
    }), true);

  await executeOperation(
    OPERATION_ID,
    runtimeContext,
    fixture.fetchImpl,
    readSyntheticToken,
  );

  assert.equal(canceled, true);
  assert.equal(stream.locked, false);
  assert.equal(fixture.state.completedError?.code, "STORAGE_UNAVAILABLE");
  assert.equal(fixture.state.operationStatus, "succeeded");
});

Deno.test("oversized exact Mealie receipts remain uncertain after external writes", async () => {
  const fixture = recipeWriteFixture("recipe.create", {
    content: {
      title: "Synthetic recipe",
      servings: 4,
      ingredients: [{ name: "Synthetic beans", amount: 1, unit: "cup" }],
      instructions: ["Cook the synthetic beans."],
    },
  });
  fixture.context.dataRepository.getContent = async () =>
    new Uint8Array(8 * 1_048_576 + 1).fill(0xff);

  await executeOperation(
    OPERATION_ID,
    fixture.context,
    fixture.fetchImpl,
    readSyntheticToken,
  );

  assert.deepEqual(fixture.state.externalWrites, ["createStructuredRecipe"]);
  assert.equal(fixture.state.completedError?.code, "OPERATION_OUTCOME_UNKNOWN");
  assert.equal(fixture.state.completedError?.externalWriteAttempted, true);
  assert.equal(fixture.state.storageWriteBytes, null);
  assert.doesNotMatch(
    JSON.stringify(fixture.state.completedError),
    /synthetic-canonical-recipe|synthetic-mealie/,
  );
});
