import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  createMealieClient,
  createModel,
  CreateRecipeArgsSchema,
  CreateStructuredRecipeArgsSchema,
  GetRecipeArgsSchema,
  GlobalArgumentsSchema,
  ImportRecipeFromPhotoArgsSchema,
  ImportRecipeFromUrlArgsSchema,
  ListRecipesArgsSchema,
  MealieApiError,
  MealieFeatureUnavailableError,
  MealieIngredientReferenceSchema,
  MealieInputTooLargeError,
  MealiePartialCreateError,
  MealiePhotoImportRejectedError,
  MealiePhotoSourceNotAllowedError,
  MealiePhotoSourceReadError,
  MealieReadbackError,
  MealieRecipeEditableFieldsSchema,
  MealieRecipeIngredientReferenceSchema,
  MealieRecipeInputSchema,
  MealieRecipePatchSchema,
  MealieResponseError,
  MealieResponseTooLargeError,
  MealieStructuredIngredientSchema,
  MealieWriteOutcomeUnknownError,
  UpdateRecipeArgsSchema,
  UpdateStructuredRecipeArgsSchema,
  VerifyAccessArgsSchema,
} from "../../mod.ts";

const TEST_TOKEN = "SYNTHETIC_TEST_TOKEN_NOT_A_CREDENTIAL";
const SERVICE_URL = "https://mealie.example.invalid";
const ERROR_CANARIES = [
  "CANARY_RECIPE_SLUG_6ad7d8",
  "CANARY_RECIPE_TITLE_1e2f3a",
  "https://recipes.example.com/CANARY_IMPORT_URL_4b5c6d",
  "CANARY_INGREDIENT_NAME_7e8f9a",
  "CANARY_RESPONSE_BODY_0a1b2c",
  "CANARY_BEARER_CREDENTIAL_3d4e5f",
  "CANARY_PRIVATE_FILE_PATH_7a8b9c",
];

function assertCanariesAbsentFromMessage(error: Error): void {
  for (const canary of ERROR_CANARIES) {
    assertEquals(
      error.message.includes(canary),
      false,
      "generic error message must not expose synthetic privacy canaries",
    );
  }
}

const syntheticRecipe = (overrides: Record<string, unknown> = {}) => ({
  id: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  householdId: "00000000-0000-4000-8000-000000000003",
  groupId: "00000000-0000-4000-8000-000000000004",
  name: "Synthetic Fixture Recipe",
  slug: "synthetic-fixture-recipe",
  recipeServings: 2,
  recipeYieldQuantity: 2,
  recipeYield: "portions",
  recipeIngredient: [{
    quantity: 1,
    unit: { id: "unit-fixture", name: "fixture-unit" },
    food: { id: "food-fixture", name: "fixture-food" },
    note: "synthetic ingredient",
    display: "1 fixture item",
    referenceId: "00000000-0000-4000-8000-000000000005",
  }],
  recipeInstructions: [{
    id: "00000000-0000-4000-8000-000000000006",
    title: "Fixture step",
    summary: null,
    text: "Synthetic test instruction.",
    ingredientReferences: [{
      ingredientId: "00000000-0000-4000-8000-000000000005",
    }],
    noteReferences: [],
    durationSeconds: 30,
  }],
  futureServerField: { preserved: true },
  ...overrides,
});

type RequestRecord = { url: URL; init: RequestInit };
type FetchHandler = (
  url: URL,
  init: RequestInit,
) => Response | Promise<Response>;

function fakeFetch(
  handler: FetchHandler,
  requests: RequestRecord[] = [],
): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request
      ? new URL(input.url)
      : new URL(input.toString());
    const requestInit = init ?? {};
    requests.push({ url, init: requestInit });
    return await handler(url, requestInit);
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function catalogPage(items: unknown[], totalPages = 1) {
  return {
    page: 1,
    per_page: 100,
    total: items.length,
    total_pages: totalPages,
    items,
    next: null,
    previous: null,
  };
}

function clientConfig(overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: SERVICE_URL,
    apiToken: TEST_TOKEN,
    ...overrides,
  };
}

function contextFor(
  globalArgs = GlobalArgumentsSchema.parse(clientConfig()),
  dataRepository?: {
    findByName: (
      modelType: string,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<
      {
        size?: number;
        metadata?: { size?: number; contentType?: string };
        tags?: Record<string, string>;
      } | null
    >;
    getContent: (
      modelType: string,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  },
) {
  const writes: Array<{ specName: string; name: string; data: unknown }> = [];
  const context = {
    globalArgs,
    logger: { info() {} },
    writeResource(
      specName: string,
      name: string,
      data: Record<string, unknown>,
    ) {
      writes.push({ specName, name, data });
      return Promise.resolve({ name });
    },
    ...(dataRepository ? { dataRepository } : {}),
  };
  return { context, writes };
}

Deno.test("standalone model exposes the complete typed Swamp contract", () => {
  const definitions = createModel();
  assertEquals(definitions.type, "@mgreten/mealie");
  const upgrade = definitions.upgrades[0];
  assertEquals(upgrade.toVersion, definitions.version);
  const vaultExpression =
    "${{ vault.get(example-vault, EXAMPLE_MEALIE_API_TOKEN) }}";
  const existingGlobals: Record<string, unknown> = {
    baseUrl: SERVICE_URL,
    apiToken: vaultExpression,
    requestTimeoutMs: 45_000,
  };
  for (const typeVersion of ["2026.11.08.1", "2026.11.09.1"]) {
    const syntheticDefinition = {
      typeVersion,
      globalArguments: existingGlobals,
    };
    const applicableUpgrades = definitions.upgrades.filter((candidate) =>
      candidate.toVersion > syntheticDefinition.typeVersion
    );
    assertEquals(applicableUpgrades.map((candidate) => candidate.toVersion), [
      definitions.version,
    ]);
    const migratedGlobals = applicableUpgrades.reduce(
      (attributes, candidate) => candidate.upgradeAttributes(attributes),
      syntheticDefinition.globalArguments,
    );
    assertEquals(migratedGlobals, {
      ...existingGlobals,
      photoSourceAllowlist: [],
    });
    assertEquals(migratedGlobals.apiToken, vaultExpression);
  }
  const configuredAllowlist = [{
    modelType: "@fixture/source",
    modelId: "allowed-fixture-model-id",
  }];
  assertEquals(
    upgrade.upgradeAttributes({
      ...existingGlobals,
      photoSourceAllowlist: configuredAllowlist,
    }),
    {
      ...existingGlobals,
      photoSourceAllowlist: configuredAllowlist,
    },
  );
  const explicitNull = upgrade.upgradeAttributes({
    ...existingGlobals,
    photoSourceAllowlist: null,
  });
  assertEquals(explicitNull.photoSourceAllowlist, null);
  assertEquals(GlobalArgumentsSchema.safeParse(explicitNull).success, false);
  assertEquals(Object.keys(definitions.methods), [
    "verifyAccess",
    "listRecipes",
    "getRecipe",
    "createRecipe",
    "createStructuredRecipe",
    "updateRecipe",
    "updateStructuredRecipe",
    "importRecipeFromUrl",
    "importRecipeFromPhoto",
  ]);
  assertEquals(VerifyAccessArgsSchema.safeParse({}).success, true);
  assertEquals(
    ListRecipesArgsSchema.safeParse({ search: "fixture" }).success,
    true,
  );
  assertEquals(
    GetRecipeArgsSchema.safeParse({ slug: "fixture-recipe" }).success,
    true,
  );
  assertEquals(
    CreateRecipeArgsSchema.safeParse({
      recipe: { name: "Synthetic Fixture Recipe" },
    })
      .success,
    true,
  );
  assertEquals(
    UpdateRecipeArgsSchema.safeParse({
      slug: "fixture-recipe",
      recipe: { recipeYieldQuantity: 4 },
    }).success,
    true,
  );
  assertEquals(
    CreateStructuredRecipeArgsSchema.safeParse({
      recipe: { name: "Synthetic Structured Recipe" },
      ingredients: [{ name: "salt", quantity: null, unit: null }],
    }).success,
    true,
  );
  assertEquals(
    UpdateStructuredRecipeArgsSchema.safeParse({
      slug: "fixture-recipe",
      ingredients: [{ name: "salt", quantity: null }],
    }).success,
    true,
  );
  assertEquals(
    MealieStructuredIngredientSchema.safeParse({
      name: " salt ",
      quantity: null,
      unit: " g ",
    }).success,
    true,
  );
  assertEquals(
    MealieRecipeIngredientReferenceSchema.safeParse({
      quantity: null,
      food: {
        id: "00000000-0000-4000-8000-000000000010",
        name: "salt",
      },
      unit: null,
      note: "to taste",
    }).success,
    true,
  );
  assertEquals(
    MealieIngredientReferenceSchema.safeParse({
      id: "00000000-0000-4000-8000-000000000010",
      name: "salt",
    }).success,
    true,
  );
  assertEquals(MealieRecipePatchSchema.safeParse({}).success, false);
  assertEquals(
    MealieRecipeInputSchema.safeParse({
      name: "Synthetic recipe",
      userId: "synthetic-user-id",
    }).success,
    false,
  );
  assertEquals(
    MealieRecipeEditableFieldsSchema.safeParse({
      name: "Synthetic recipe",
      description: "Synthetic description",
    }).success,
    true,
  );
  assertEquals(
    MealieRecipePatchSchema.safeParse({
      recipeServings: 2,
      description: "Synthetic description",
    }).success,
    true,
  );
  for (const field of ["id", "slug", "userId", "householdId", "groupId"]) {
    assertEquals(
      MealieRecipePatchSchema.safeParse({ [field]: "synthetic-identity" })
        .success,
      false,
    );
  }
  assertEquals(
    MealieRecipePatchSchema.safeParse({
      futureAdministrativeField: "synthetic-value",
    }).success,
    false,
  );
  assertEquals(
    ImportRecipeFromUrlArgsSchema.safeParse({
      url: "https://recipes.example.com/item",
    })
      .success,
    true,
  );
  assertEquals(
    ImportRecipeFromPhotoArgsSchema.safeParse({
      source: {
        modelType: "@fixture/source",
        modelId: "fixture-model-id",
        dataName: "fixture-image",
        version: 1,
      },
      fileName: "fixture.png",
      mediaType: "image/png",
    }).success,
    true,
  );
  assertEquals(
    ImportRecipeFromPhotoArgsSchema.safeParse({
      source: {
        modelType: "@fixture/source",
        modelId: "fixture-model-id",
        dataName: "fixture-image",
        version: 1,
      },
      fileName: "fixture.png",
      mediaType: "image/png",
      photoSourceAllowlist: [{
        modelType: "@fixture/source",
        modelId: "fixture-model-id",
      }],
    }).success,
    false,
  );
  assertEquals(GlobalArgumentsSchema.safeParse(clientConfig()).success, true);
  const runtimeGlobals = GlobalArgumentsSchema.parse(clientConfig());
  assertEquals(runtimeGlobals.photoSourceAllowlist, []);
  assertEquals(
    GlobalArgumentsSchema.safeParse(clientConfig({
      photoSourceAllowlist: [{
        modelType: "@fixture/source",
        modelId: "allowed-model-id",
        extra: "not allowed",
      }],
    })).success,
    false,
  );
  const importMethodArgs = definitions.methods.importRecipeFromUrl.arguments
    .parse({
      ...runtimeGlobals,
      url: "https://recipes.example.com/item",
    });
  assertEquals(importMethodArgs, {
    url: "https://recipes.example.com/item",
    includeTags: false,
    includeCategories: false,
  });
  assertEquals(
    ImportRecipeFromUrlArgsSchema.safeParse({
      ...runtimeGlobals,
      url: "https://recipes.example.com/item",
    }).success,
    false,
  );
  assertEquals(
    GlobalArgumentsSchema.safeParse({
      ...clientConfig(),
      baseUrl: "https://user:pass@mealie.example.invalid",
    }).success,
    false,
  );
});

Deno.test("write methods use a bounded authenticated access preflight", async () => {
  const calls: RequestRecord[] = [];
  const definitions = createModel(fakeFetch((url) => {
    if (url.pathname.endsWith("/api/app/about")) {
      return jsonResponse({ version: "3.30.0" });
    }
    return jsonResponse({
      page: 1,
      per_page: 1,
      total: 0,
      total_pages: 0,
      items: [],
    });
  }, calls));
  assertEquals(definitions.checks["mealie-access"].labels, ["live"]);
  assertEquals(definitions.checks["mealie-access"].appliesTo, [
    "createRecipe",
    "createStructuredRecipe",
    "updateRecipe",
    "updateStructuredRecipe",
    "importRecipeFromUrl",
    "importRecipeFromPhoto",
  ]);
  const globalArgs = GlobalArgumentsSchema.parse(clientConfig());
  assertEquals(
    await definitions.checks["mealie-access"].execute({ globalArgs }),
    { pass: true },
  );
  assertEquals(calls.length, 2);

  const denied = createModel(fakeFetch(() => jsonResponse({}, 401)));
  assertEquals(
    await denied.checks["mealie-access"].execute({ globalArgs }),
    {
      pass: false,
      errors: [
        "Mealie access verification failed; confirm the service URL and vault-backed token",
      ],
    },
  );
});

Deno.test("verifyAccess authenticates, checks version and writes the access resource", async () => {
  const calls: RequestRecord[] = [];
  const definitions = createModel(fakeFetch((url) => {
    if (url.pathname.endsWith("/api/app/about")) {
      return jsonResponse({
        version: "3.30.0",
        extra: "preserved server response not persisted",
      });
    }
    return jsonResponse({
      page: 1,
      per_page: 1,
      total: 0,
      total_pages: 0,
      items: [],
      next: null,
      previous: null,
    });
  }, calls));
  const { context, writes } = contextFor();
  await definitions.methods.verifyAccess.execute({}, context);
  assertEquals(calls.length, 2);
  assertEquals(calls.map((call) => call.init.redirect), ["error", "error"]);
  assertEquals(
    calls.map((call) => new Headers(call.init.headers).get("Authorization")),
    [`Bearer ${TEST_TOKEN}`, `Bearer ${TEST_TOKEN}`],
  );
  assertEquals(writes[0].specName, "access");
  assertEquals((writes[0].data as { version: string }).version, "3.30.0");
});

Deno.test("list and get preserve Mealie payload fields without remapping", async () => {
  const calls: RequestRecord[] = [];
  const page = {
    page: 2,
    per_page: 3,
    total: 5,
    total_pages: 2,
    items: [{
      id: "fixture-id",
      slug: "fixture",
      name: "Fixture",
      newField: true,
    }],
    next: "/api/recipes?page=2",
    previous: "/api/recipes?page=1",
    apiField: { retained: true },
  };
  const recipe = syntheticRecipe();
  const client = createMealieClient(
    clientConfig(),
    fakeFetch((url) => {
      if (url.pathname === "/api/recipes") return jsonResponse(page);
      return jsonResponse(recipe);
    }, calls),
  );
  const listed = await client.listRecipes({
    search: "fixture",
    page: 2,
    perPage: 3,
  });
  const fetched = await client.getRecipe("synthetic-fixture-recipe");
  assertEquals(listed, page);
  assertEquals(listed.items[0].newField, true);
  assertEquals(fetched.futureServerField, { preserved: true });
  assertEquals(calls[0].url.searchParams.get("search"), "fixture");
  assertEquals(calls[0].url.searchParams.get("page"), "2");
  assertEquals(calls[0].url.searchParams.get("perPage"), "3");
  assertEquals(calls[1].url.pathname, "/api/recipes/synthetic-fixture-recipe");
});

Deno.test("manual create applies structured fields and reads the canonical recipe back", async () => {
  const calls: RequestRecord[] = [];
  const canonical = syntheticRecipe();
  const client = createMealieClient(
    clientConfig(),
    fakeFetch((_url, init) => {
      if (init.method === "POST") {
        return jsonResponse("synthetic-fixture-recipe", 201);
      }
      if (init.method === "GET") {
        return jsonResponse(canonical);
      }
      if (init.method === "PUT") return new Response(null, { status: 200 });
      throw new Error("unexpected fixture method");
    }, calls),
  );
  const created = await client.createRecipe({
    name: "Synthetic Fixture Recipe",
    recipeServings: 2,
    recipeYield: "portions",
    recipeYieldQuantity: 2,
    recipeIngredient: [{
      quantity: 1,
      unit: { id: "unit-fixture", name: "fixture-unit" },
      food: { id: "food-fixture", name: "fixture-food" },
      note: "synthetic ingredient",
      display: "1 fixture item",
      referenceId: "00000000-0000-4000-8000-000000000005",
    }],
    recipeInstructions: [{
      text: "Synthetic test instruction.",
      ingredientReferences: [{ ingredientId: "fixture-reference" }],
    }],
  });
  assertEquals(calls.map((call) => call.init.method), [
    "POST",
    "GET",
    "PUT",
    "GET",
  ]);
  assertEquals(JSON.parse(calls[0].init.body as string), {
    name: "Synthetic Fixture Recipe",
  });
  const putBody = JSON.parse(calls[2].init.body as string);
  assertEquals(putBody.recipeServings, 2);
  assertEquals(putBody.recipeIngredient[0].display, "1 fixture item");
  assertEquals(
    putBody.recipeInstructions[0].ingredientReferences[0].ingredientId,
    "fixture-reference",
  );
  assertEquals(putBody.futureServerField, { preserved: true });
  assertEquals(created.futureServerField, { preserved: true });
});

Deno.test("update uses Mealie partial PATCH semantics and canonical readback", async () => {
  const calls: RequestRecord[] = [];
  const updated = syntheticRecipe({
    description: "Synthetic description",
    recipeYieldQuantity: 4,
  });
  const client = createMealieClient(
    clientConfig(),
    fakeFetch((_url, init) => {
      if (init.method === "PATCH") {
        return jsonResponse({ ignored: "response; canonical read follows" });
      }
      if (init.method === "GET") return jsonResponse(updated);
      throw new Error("unexpected fixture method");
    }, calls),
  );
  const result = await client.updateRecipe("synthetic-fixture-recipe", {
    description: "Synthetic description",
    recipeYieldQuantity: 4,
  });
  assertEquals(calls.map((call) => call.init.method), ["PATCH", "GET"]);
  assertEquals(JSON.parse(calls[0].init.body as string), {
    description: "Synthetic description",
    recipeYieldQuantity: 4,
  });
  assertEquals(result.recipeYieldQuantity, 4);
  assertEquals(result.recipeIngredient, updated.recipeIngredient);
  assertEquals(result.futureServerField, { preserved: true });
});

Deno.test("recipe writes reject identity and unknown fields before any API request", async () => {
  const calls: RequestRecord[] = [];
  const client = createMealieClient(
    clientConfig(),
    fakeFetch(() => {
      throw new Error("invalid patch must not issue a request");
    }, calls),
  );
  const invalidPatches: Record<string, unknown>[] = [
    { id: "synthetic-recipe-id" },
    { slug: "synthetic-recipe-slug" },
    { userId: "synthetic-user-id" },
    { householdId: "synthetic-household-id" },
    { groupId: "synthetic-group-id" },
    { recipe_servings: 2 },
    { unrecognizedPatchField: "CANARY_RECIPE_TITLE_1e2f3a" },
  ];

  for (const recipe of invalidPatches) {
    const error = await assertRejects(
      () => client.updateRecipe("synthetic-fixture-recipe", recipe as never),
      Error,
    );
    assertCanariesAbsentFromMessage(error);
  }
  await assertRejects(
    () =>
      client.createRecipe({
        name: "Synthetic recipe",
        householdId: "synthetic-household-id",
      } as never),
    Error,
  );
  await assertRejects(
    () =>
      client.createRecipe({
        name: "Synthetic recipe",
        unknownCreateField: "synthetic-value",
      } as never),
    Error,
  );

  assertEquals(calls.length, 0);
});

Deno.test("structured update resolves exact Food/Unit references before PATCH", async () => {
  const calls: RequestRecord[] = [];
  const saltId = "00000000-0000-4000-8000-000000000010";
  const gramId = "00000000-0000-4000-8000-000000000011";
  const pepperId = "00000000-0000-4000-8000-000000000012";
  const pinchId = "00000000-0000-4000-8000-000000000013";
  let patchBody: Record<string, unknown> | undefined;
  const client = createMealieClient(
    clientConfig(),
    fakeFetch((url, init) => {
      if (url.pathname === "/api/foods" && init.method === "GET") {
        return jsonResponse(catalogPage([{
          id: saltId,
          name: "salt",
          aliases: [{ name: "table salt" }],
        }]));
      }
      if (url.pathname === "/api/units" && init.method === "GET") {
        return jsonResponse(catalogPage([{
          id: gramId,
          name: "gram",
          abbreviation: "g",
        }]));
      }
      if (url.pathname === "/api/foods" && init.method === "POST") {
        assertEquals(JSON.parse(init.body as string), { name: "pepper" });
        return jsonResponse({ id: pepperId, name: "pepper" }, 201);
      }
      if (url.pathname === "/api/units" && init.method === "POST") {
        assertEquals(JSON.parse(init.body as string), { name: "pinch" });
        return jsonResponse({ id: pinchId, name: "pinch" }, 201);
      }
      if (
        url.pathname === "/api/recipes/synthetic-fixture-recipe" &&
        init.method === "PATCH"
      ) {
        patchBody = JSON.parse(init.body as string);
        return new Response(null, { status: 200 });
      }
      if (
        url.pathname === "/api/recipes/synthetic-fixture-recipe" &&
        init.method === "GET"
      ) {
        return jsonResponse(syntheticRecipe({
          ...patchBody,
          recipeIngredient: patchBody?.recipeIngredient,
        }));
      }
      throw new Error(
        `unexpected fixture request ${init.method} ${url.pathname}`,
      );
    }, calls),
  );

  const result = await client.updateStructuredRecipe(
    "synthetic-fixture-recipe",
    {
      description: "Synthetic structured update",
      recipeServings: 4,
      recipeYield: "portions",
      recipeYieldQuantity: 4,
    },
    [
      { name: "Salt", quantity: null, unit: "g", note: "to taste" },
      { name: "pepper", quantity: 1, unit: "pinch" },
      { name: " PEPPER ", quantity: 2, unit: " PINCH " },
    ],
  );

  assertEquals(calls.map((call) => [call.init.method, call.url.pathname]), [
    ["GET", "/api/foods"],
    ["GET", "/api/units"],
    ["POST", "/api/foods"],
    ["POST", "/api/units"],
    ["PATCH", "/api/recipes/synthetic-fixture-recipe"],
    ["GET", "/api/recipes/synthetic-fixture-recipe"],
  ]);
  assertEquals(calls[0].url.searchParams.get("page"), "1");
  assertEquals(calls[0].url.searchParams.get("perPage"), "100");
  assert(patchBody);
  assertEquals(patchBody.description, "Synthetic structured update");
  assertEquals(patchBody.recipeServings, 4);
  assertEquals(patchBody.recipeYield, "portions");
  assertEquals(patchBody.recipeYieldQuantity, 4);
  assertEquals(patchBody.recipeIngredient, [
    {
      quantity: null,
      food: { id: saltId, name: "salt" },
      unit: { id: gramId, name: "gram" },
      note: "to taste",
    },
    {
      quantity: 1,
      food: { id: pepperId, name: "pepper" },
      unit: { id: pinchId, name: "pinch" },
    },
    {
      quantity: 2,
      food: { id: pepperId, name: "pepper" },
      unit: { id: pinchId, name: "pinch" },
    },
  ]);
  assertEquals(result.recipeIngredient, patchBody.recipeIngredient);
  assertEquals(result.recipeYieldQuantity, 4);
  assertEquals(
    JSON.stringify(patchBody).includes("referenceId"),
    false,
    "the package leaves volatile reference IDs and display fields to Mealie",
  );
});

Deno.test("structured create is a standalone Swamp method and writes canonical recipe data", async () => {
  const calls: RequestRecord[] = [];
  const foodId = "00000000-0000-4000-8000-000000000020";
  let putBody: Record<string, unknown> | undefined;
  const definitions = createModel(fakeFetch((url, init) => {
    if (url.pathname === "/api/foods" && init.method === "GET") {
      return jsonResponse(catalogPage([], 0));
    }
    if (url.pathname === "/api/foods" && init.method === "POST") {
      assertEquals(JSON.parse(init.body as string), { name: "tomato" });
      return jsonResponse({ id: foodId, name: "tomato" }, 201);
    }
    if (url.pathname === "/api/recipes" && init.method === "POST") {
      return jsonResponse("synthetic-structured-recipe", 201);
    }
    if (
      url.pathname === "/api/recipes/synthetic-structured-recipe" &&
      init.method === "GET"
    ) {
      return jsonResponse(syntheticRecipe({
        slug: "synthetic-structured-recipe",
        name: "Synthetic Structured Recipe",
        ...(putBody ?? {}),
      }));
    }
    if (
      url.pathname === "/api/recipes/synthetic-structured-recipe" &&
      init.method === "PUT"
    ) {
      putBody = JSON.parse(init.body as string);
      return new Response(null, { status: 200 });
    }
    throw new Error(
      `unexpected fixture request ${init.method} ${url.pathname}`,
    );
  }, calls));
  const { context, writes } = contextFor();

  const result = await definitions.methods.createStructuredRecipe.execute({
    recipe: {
      name: "Synthetic Structured Recipe",
      recipeServings: 2,
      recipeYield: "portions",
      recipeYieldQuantity: 2,
    },
    ingredients: [{ name: "tomato", quantity: null, unit: null }],
  }, context);

  assertEquals(result.dataHandles, [{ name: "current" }]);
  assertEquals(writes[0].specName, "recipe");
  assertEquals(writes[0].name, "current");
  assertEquals(
    (writes[0].data as { slug: string }).slug,
    "synthetic-structured-recipe",
  );
  assert(putBody);
  assertEquals(putBody.recipeIngredient, [{
    quantity: null,
    food: { id: foodId, name: "tomato" },
    unit: null,
  }]);
  assertEquals(calls.filter((call) => call.init.method === "PUT").length, 1);
});

Deno.test("ambiguous Food creation is reported once without retrying or patching", async () => {
  const calls: RequestRecord[] = [];
  const client = createMealieClient(
    clientConfig(),
    fakeFetch((url, init) => {
      if (url.pathname === "/api/foods" && init.method === "GET") {
        return jsonResponse(catalogPage([], 0));
      }
      if (url.pathname === "/api/foods" && init.method === "POST") {
        throw new DOMException("synthetic timeout", "AbortError");
      }
      throw new Error("ambiguous Food write must stop the method");
    }, calls),
  );

  const error = await assertRejects(
    () =>
      client.updateStructuredRecipe(
        "synthetic-fixture-recipe",
        {},
        [{ name: "tomato", quantity: 1 }],
      ),
    MealieWriteOutcomeUnknownError,
  );
  assertEquals(error.operation, "createFood");
  assertEquals(calls.map((call) => call.init.method), ["GET", "POST"]);
  assertEquals(calls.filter((call) => call.init.method === "POST").length, 1);
});

Deno.test("URL import validates public HTTPS, persists once and reads the saved recipe", async () => {
  const calls: RequestRecord[] = [];
  const client = createMealieClient(
    clientConfig(),
    fakeFetch((url, _init) => {
      if (url.pathname === "/api/recipes/create/url") {
        return jsonResponse("synthetic-fixture-recipe", 201);
      }
      return jsonResponse(syntheticRecipe());
    }, calls),
  );
  const result = await client.importRecipeFromUrl({
    url: "https://recipes.example.com/synthetic-fixture",
    includeTags: true,
    includeCategories: false,
  });
  assertEquals(calls.length, 2);
  assertEquals(JSON.parse(calls[0].init.body as string), {
    url: "https://recipes.example.com/synthetic-fixture",
    includeTags: true,
    includeCategories: false,
  });
  assertEquals(result.slug, "synthetic-fixture-recipe");
  for (
    const unsafeUrl of [
      "http://recipes.example.com/recipe",
      "https://127.0.0.1/recipe",
      "https://localhost/recipe",
      "https://user:pass@recipes.example.com/recipe",
      "https://recipes.example.com/with\nnewline",
    ]
  ) {
    await assertRejects(
      () => client.importRecipeFromUrl({ url: unsafeUrl }),
      Error,
      "Recipe import URL",
    );
  }
  assertEquals(calls.length, 2, "unsafe URL inputs must not reach Mealie");
});

Deno.test("photo import sends only a validated image and marks provider errors explicitly", async () => {
  const calls: RequestRecord[] = [];
  const png = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0x00,
  ]);
  const client = createMealieClient(
    clientConfig(),
    fakeFetch((url, _init) => {
      if (url.pathname === "/api/recipes/create/ai") {
        return jsonResponse("synthetic-fixture-recipe", 201);
      }
      return jsonResponse(syntheticRecipe());
    }, calls),
  );
  await client.importRecipeFromPhoto({
    bytes: png,
    fileName: "fixture.png",
    mediaType: "image/png",
  });
  const form = calls[0].init.body as FormData;
  const file = form.get("images");
  assert(file instanceof Blob);
  assertEquals((file as File).name, "fixture.png");
  assertEquals((file as Blob).type, "image/png");
  assertEquals(calls.length, 2);

  const missingProvider = createMealieClient(
    clientConfig(),
    fakeFetch(() => jsonResponse({ detail: "synthetic provider error" }, 400)),
  );
  const providerError = await assertRejects(
    () =>
      missingProvider.importRecipeFromPhoto({
        bytes: png,
        fileName: "fixture.png",
        mediaType: "image/png",
      }),
    MealiePhotoImportRejectedError,
  );
  assert(providerError.message.includes("image-capable provider"));
  assertEquals(
    providerError.message.includes("synthetic provider error"),
    false,
  );

  const missingRoute = createMealieClient(
    clientConfig(),
    fakeFetch(() => new Response(null, { status: 404 })),
  );
  await assertRejects(
    () =>
      missingRoute.importRecipeFromPhoto({
        bytes: png,
        fileName: "fixture.png",
        mediaType: "image/png",
      }),
    MealieFeatureUnavailableError,
  );
});

Deno.test("Swamp photo method reads a versioned Swamp file record, not a host path", async () => {
  const requests: RequestRecord[] = [];
  const png = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0x01,
  ]);
  let metadataRead = 0;
  let contentRead = 0;
  const { context, writes } = contextFor(
    GlobalArgumentsSchema.parse(clientConfig({
      photoSourceAllowlist: [{
        modelType: "@fixture/source",
        modelId: "fixture-model-id",
      }],
    })),
    {
      findByName: (...args) => {
        metadataRead++;
        assertEquals(args, [
          "@fixture/source",
          "fixture-model-id",
          "fixture-image",
          1,
        ]);
        return Promise.resolve({
          size: png.length,
          metadata: { contentType: "image/png" },
          tags: { type: "file" },
        });
      },
      getContent: () => {
        contentRead++;
        return Promise.resolve(png);
      },
    },
  );
  const definitions = createModel(fakeFetch((url, init) => {
    if (url.pathname === "/api/recipes/create/ai") {
      assert(init.body instanceof FormData);
      return jsonResponse("synthetic-fixture-recipe", 201);
    }
    return jsonResponse(syntheticRecipe());
  }, requests));
  await definitions.methods.importRecipeFromPhoto.execute({
    source: {
      modelType: "@fixture/source",
      modelId: "fixture-model-id",
      dataName: "fixture-image",
      version: 1,
    },
    fileName: "fixture.png",
    mediaType: "image/png",
  }, context);
  assertEquals(metadataRead, 1);
  assertEquals(contentRead, 1);
  assertEquals(requests.length, 2);
  assertEquals(writes[0].specName, "recipe");
  assertEquals(
    (writes[0].data as { slug: string }).slug,
    "synthetic-fixture-recipe",
  );
});

Deno.test("photo source allowlist distinguishes same-type model IDs before reads", async () => {
  const allowedModelId = "allowed-fixture-model-id";
  const rejectedModelId = "rejected-fixture-model-id";
  const sourceReads: string[] = [];
  const { context } = contextFor(
    GlobalArgumentsSchema.parse(clientConfig({
      photoSourceAllowlist: [{
        modelType: "@fixture/source",
        modelId: allowedModelId,
      }],
    })),
    {
      findByName: (...args) => {
        sourceReads.push(`metadata:${args[1]}`);
        return Promise.resolve(null);
      },
      getContent: (...args) => {
        sourceReads.push(`content:${args[1]}`);
        return Promise.resolve(null);
      },
    },
  );
  const definitions = createModel(fakeFetch(() => {
    throw new Error("rejected photo source must not reach Mealie");
  }));
  const error = await assertRejects(
    () =>
      definitions.methods.importRecipeFromPhoto.execute({
        source: {
          modelType: "@fixture/source",
          modelId: rejectedModelId,
          dataName: "synthetic-image",
          version: 1,
        },
        fileName: "fixture.png",
        mediaType: "image/png",
      }, context),
    MealiePhotoSourceNotAllowedError,
  );

  assertEquals(sourceReads, []);
  assertEquals(error.message.includes(rejectedModelId), false);
});

Deno.test("photo import defaults to deny before any data repository read", async () => {
  const sourceReads: string[] = [];
  const { context } = contextFor(GlobalArgumentsSchema.parse(clientConfig()), {
    findByName: () => {
      sourceReads.push("metadata");
      return Promise.resolve(null);
    },
    getContent: () => {
      sourceReads.push("content");
      return Promise.resolve(null);
    },
  });
  const definitions = createModel(fakeFetch(() => {
    throw new Error("default-deny photo source must not reach Mealie");
  }));

  await assertRejects(
    () =>
      definitions.methods.importRecipeFromPhoto.execute({
        source: {
          modelType: "@fixture/source",
          modelId: "fixture-model-id",
          dataName: "synthetic-image",
          version: 1,
        },
        fileName: "fixture.png",
        mediaType: "image/png",
      }, context),
    MealiePhotoSourceNotAllowedError,
  );
  assertEquals(sourceReads, []);
});

Deno.test("photo repository failures expose only sanitized stage metadata", async () => {
  const source = {
    modelType: "@fixture/source",
    modelId: "fixture-model-id",
    dataName: "synthetic-image",
    version: 1,
  };
  const arguments_ = {
    source,
    fileName: "fixture.png",
    mediaType: "image/png" as const,
  };
  const globals = GlobalArgumentsSchema.parse(clientConfig({
    photoSourceAllowlist: [{
      modelType: source.modelType,
      modelId: source.modelId,
    }],
  }));
  const definitions = createModel(fakeFetch(() => {
    throw new Error("repository failures must not reach Mealie");
  }));
  const metadataFailure = contextFor(globals, {
    findByName: () =>
      Promise.reject(new Error("CANARY_PRIVATE_FILE_PATH_7a8b9c")),
    getContent: () => Promise.resolve(null),
  });
  const metadataError = await assertRejects(
    () =>
      definitions.methods.importRecipeFromPhoto.execute(
        arguments_,
        metadataFailure.context,
      ),
    MealiePhotoSourceReadError,
  );
  assertEquals(metadataError.stage, "metadata");
  assertCanariesAbsentFromMessage(metadataError);

  const contentFailure = contextFor(globals, {
    findByName: () =>
      Promise.resolve({
        size: 9,
        metadata: { contentType: "image/png" },
        tags: { type: "file" },
      }),
    getContent: () =>
      Promise.reject(new Error("CANARY_PRIVATE_FILE_PATH_7a8b9c")),
  });
  const contentError = await assertRejects(
    () =>
      definitions.methods.importRecipeFromPhoto.execute(
        arguments_,
        contentFailure.context,
      ),
    MealiePhotoSourceReadError,
  );
  assertEquals(contentError.stage, "content");
  assertCanariesAbsentFromMessage(contentError);
});

Deno.test("credentials never appear in sanitized status or transport failures", async () => {
  const badStatus = createMealieClient(
    clientConfig(),
    fakeFetch(() => jsonResponse({ token: TEST_TOKEN }, 403)),
  );
  const statusError = await assertRejects(
    () => badStatus.getRecipe("fixture-recipe"),
    MealieApiError,
  );
  assertEquals(statusError.status, 403);
  assertEquals(statusError.message.includes(TEST_TOKEN), false);

  const transport = createMealieClient(
    clientConfig(),
    fakeFetch(() => {
      throw new DOMException(`Authorization ${TEST_TOKEN}`, "AbortError");
    }),
  );
  const transportError = await assertRejects(
    () => transport.createRecipe({ name: "Synthetic Fixture Recipe" }),
    MealieWriteOutcomeUnknownError,
  );
  assertEquals(transportError.message.includes(TEST_TOKEN), false);
});

Deno.test("ambiguous write timeouts are unknown and never retried", async () => {
  let calls = 0;
  const client = createMealieClient(
    clientConfig(),
    fakeFetch(() => {
      calls++;
      throw new DOMException("synthetic timeout", "AbortError");
    }),
  );
  await assertRejects(
    () =>
      client.importRecipeFromUrl({ url: "https://recipes.example.com/item" }),
    MealieWriteOutcomeUnknownError,
  );
  assertEquals(calls, 1);
});

Deno.test("HTTP 5xx after an import is ambiguous and must not be retried", async () => {
  let calls = 0;
  const client = createMealieClient(
    clientConfig(),
    fakeFetch(() => {
      calls++;
      return jsonResponse({ detail: "synthetic failure" }, 502);
    }),
  );
  await assertRejects(
    () =>
      client.importRecipeFromUrl({ url: "https://recipes.example.com/item" }),
    MealieWriteOutcomeUnknownError,
  );
  assertEquals(calls, 1);
});

Deno.test("generic API and write errors exclude recipe and credential canaries", async () => {
  const [slug, title, importUrl, ingredient, responseBody, token] =
    ERROR_CANARIES;

  const apiFailure = createMealieClient(
    clientConfig({ apiToken: token }),
    fakeFetch(() =>
      jsonResponse({
        detail: [title, ingredient, responseBody, token, importUrl],
      }, 403)
    ),
  );
  const apiError = await assertRejects(
    () => apiFailure.getRecipe(slug),
    MealieApiError,
  );
  assertCanariesAbsentFromMessage(apiError);

  const ambiguous = createMealieClient(
    clientConfig({ apiToken: token }),
    fakeFetch(() => {
      throw new DOMException(ERROR_CANARIES.join(" "), "AbortError");
    }),
  );
  const unknown = await assertRejects(
    () => ambiguous.updateRecipe(slug, { description: title }),
    MealieWriteOutcomeUnknownError,
  );
  assertEquals(unknown.slug, slug);
  assertCanariesAbsentFromMessage(unknown);

  const importFailure = createMealieClient(
    clientConfig({ apiToken: token }),
    fakeFetch(() =>
      jsonResponse({ detail: [responseBody, title, ingredient, token] }, 502)
    ),
  );
  const importError = await assertRejects(
    () => importFailure.importRecipeFromUrl({ url: importUrl }),
    MealieWriteOutcomeUnknownError,
  );
  assertCanariesAbsentFromMessage(importError);

  const readback = createMealieClient(
    clientConfig({ apiToken: token }),
    fakeFetch((_url, init) =>
      init.method === "PATCH"
        ? new Response(null, { status: 200 })
        : jsonResponse({ detail: ERROR_CANARIES.join(" "), token }, 403)
    ),
  );
  const failedReadback = await assertRejects(
    () => readback.updateRecipe(slug, { description: title }),
    MealieReadbackError,
  );
  assertEquals(failedReadback.slug, slug);
  assertCanariesAbsentFromMessage(failedReadback);

  const partialCreate = createMealieClient(
    clientConfig({ apiToken: token }),
    fakeFetch((_url, init) =>
      init.method === "POST"
        ? jsonResponse(slug, 201)
        : jsonResponse({ detail: ERROR_CANARIES.join(" "), token }, 403)
    ),
  );
  const partial = await assertRejects(
    () => partialCreate.createRecipe({ name: title }),
    MealiePartialCreateError,
  );
  assertEquals(partial.slug, slug);
  assertEquals(partial.phase, "initial-read");
  assertCanariesAbsentFromMessage(partial);
});

Deno.test("bad JSON, oversized responses, oversized requests and failed readback are explicit", async () => {
  const invalidJson = createMealieClient(
    clientConfig(),
    fakeFetch(() => new Response("not-json", { status: 200 })),
  );
  await assertRejects(
    () => invalidJson.getRecipe("fixture-recipe"),
    MealieResponseError,
    "invalid JSON",
  );

  const largeResponse = createMealieClient(
    clientConfig({ maximumResponseBytes: 1_024 }),
    fakeFetch(() => new Response("x".repeat(1_025), { status: 200 })),
  );
  await assertRejects(
    () => largeResponse.getRecipe("fixture-recipe"),
    MealieResponseTooLargeError,
  );

  let requests = 0;
  const smallRequest = createMealieClient(
    clientConfig({ maximumRequestBytes: 1_024 }),
    fakeFetch(() => {
      requests++;
      return jsonResponse("unused", 201);
    }),
  );
  await assertRejects(
    () =>
      smallRequest.createRecipe({
        name: "Synthetic Fixture Recipe",
        description: "x".repeat(2_000),
      }),
    MealieInputTooLargeError,
  );
  assertEquals(requests, 0);

  const readback = createMealieClient(
    clientConfig(),
    fakeFetch((_url, init) => {
      if (init.method === "PATCH") return new Response(null, { status: 200 });
      return new Response("not-json", { status: 200 });
    }),
  );
  await assertRejects(
    () => readback.updateRecipe("fixture-recipe", { recipeYieldQuantity: 3 }),
    MealieReadbackError,
  );
});

Deno.test("recipe output field values survive the exported schema", () => {
  const input = syntheticRecipe();
  const result = createModel();
  const outputSchema = result.resources.recipe.schema;
  const recipe = outputSchema.parse(input);
  assertEquals(recipe.recipeIngredient, input.recipeIngredient);
  assertEquals(recipe.recipeInstructions, input.recipeInstructions);
  assertEquals(recipe.futureServerField, { preserved: true });
});

Deno.test("photo input rejects a MIME mismatch, unsafe filename and request overage", async () => {
  const bytes = new Uint8Array([0x00, 0x01, 0x02]);
  const client = createMealieClient(
    clientConfig(),
    fakeFetch(() => {
      throw new Error("invalid photo input must not reach the network");
    }),
  );
  await assertRejects(
    () =>
      client.importRecipeFromPhoto({
        bytes,
        fileName: "fixture.png",
        mediaType: "image/png",
      }),
    Error,
    "do not match",
  );
  await assertRejects(
    () =>
      client.importRecipeFromPhoto({
        bytes,
        fileName: "../fixture.png",
        mediaType: "image/png",
      }),
    Error,
    "plain filename",
  );
  const tooSmall = createMealieClient(
    clientConfig({ maximumRequestBytes: 1_024 }),
    fakeFetch(() => {
      throw new Error("oversized photo must not reach the network");
    }),
  );
  const png = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...new Uint8Array(1_100),
  ]);
  await assertRejects(
    () =>
      tooSmall.importRecipeFromPhoto({
        bytes: png,
        fileName: "fixture.png",
        mediaType: "image/png",
      }),
    MealieInputTooLargeError,
  );
});

Deno.test("invalid slug and non-URL API base cannot issue a request", async () => {
  assertThrows(
    () =>
      GlobalArgumentsSchema.parse({
        baseUrl: "file:///tmp/mealie",
        apiToken: TEST_TOKEN,
      }),
    Error,
  );
  let calls = 0;
  const client = createMealieClient(
    clientConfig(),
    fakeFetch(() => {
      calls++;
      return jsonResponse(syntheticRecipe());
    }),
  );
  await assertRejects(() => client.getRecipe("../fixture"), Error);
  assertEquals(calls, 0);
});
