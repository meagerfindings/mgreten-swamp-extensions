import { z } from "npm:zod@4";
import {
  aggregateGroceries,
  applyRecipeVersion,
  MAX_STORAGE_RESPONSE_BYTES,
  mealieStructuredRecipeInput,
  normalizePantryItems,
  type PantryItem,
  type RecipeContent,
  recipeContentFromMealie,
} from "../domain.ts";

const TRUSTED_STORAGE_API_URL = "http://meal-planner-api:3000";
const TRUSTED_STORAGE_TOKEN_FILE = "/run/secrets/meal-planner/storage-token";
const STORAGE_REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_CANCEL_WAIT_MS = 100;
const MAX_MEALIE_RECEIPT_BYTES = 8 * 1_048_576;
const EXTERNAL_RECIPE_WRITE_KINDS = new Set([
  "recipe.create",
  "recipe.import-url",
  "recipe.import-photo",
  "recipe.update",
]);

const GlobalArgs = z.object({
  storageApiUrl: z.string().url(),
  storageTokenFile: z.string().min(1),
});

const OperationArgs = z.object({
  operationId: z.string().regex(/^[a-f0-9]{32}$/),
});

type Operation = {
  id: string;
  householdId: string;
  actorId: string;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed";
  payload: Record<string, unknown>;
};

type StorageEnvelope<T> = { data: T } | {
  error: { code?: string; message?: string };
};

type OperationError = {
  code: string;
  message: string;
  externalWriteAttempted?: boolean;
};

type SwampDataHandle = {
  kind: "resource" | "file";
  name: string;
  specName: string;
  version: number;
};

type SwampDataRecord = {
  name: string;
  specName: string;
  modelType: unknown;
  modelId: string;
  attributes?: unknown;
};

type RunModelResult =
  | { ok: true; resources: SwampDataHandle[] }
  | { ok: false; error: { message: string; stack?: string } };

type RuntimeContext = {
  globalArgs: { storageApiUrl: string; storageTokenFile: string };
  runModel: (options: {
    definition: string;
    method: string;
    arguments?: Record<string, unknown>;
  }) => Promise<RunModelResult>;
  readModelData: (
    definition: string,
    spec: string,
  ) => Promise<SwampDataRecord[]>;
  dataRepository: {
    getContent: (
      modelType: unknown,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
};

class StorageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

async function cancelStorageResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController,
): Promise<void> {
  controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancellation = reader.cancel().catch(() => undefined);
  try {
    await Promise.race([
      cancellation,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, RESPONSE_CANCEL_WAIT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function boundedStorageResponseBytes(
  response: Response,
  controller: AbortController,
): Promise<Uint8Array> {
  if (!response.body) {
    throw new StorageError(
      "STORAGE_UNAVAILABLE",
      "The app storage service returned an unusable response.",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_STORAGE_RESPONSE_BYTES) {
        await cancelStorageResponse(reader, controller);
        throw new StorageError(
          "STORAGE_UNAVAILABLE",
          "The app storage service returned an unusable response.",
        );
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    reader.releaseLock();
  }
}

async function requestStorage<T>(
  baseUrl: string,
  token: string,
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    STORAGE_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(new URL(path, baseUrl), {
      ...init,
      redirect: "error",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...init.headers,
      },
    });
    const bytes = await boundedStorageResponseBytes(response, controller);
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw new StorageError(
        "STORAGE_UNAVAILABLE",
        "The app storage service returned an unusable response.",
      );
    }
    if (!isRecord(decoded)) {
      throw new StorageError(
        "STORAGE_UNAVAILABLE",
        "The app storage service returned an unusable response.",
      );
    }
    const body = decoded as StorageEnvelope<T>;
    if (!response.ok || !("data" in body)) {
      const error = "error" in body ? body.error : undefined;
      throw new StorageError(
        error?.code ?? "STORAGE_REQUEST_FAILED",
        error?.message ?? "The app storage request failed.",
      );
    }
    return body.data;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(
      "STORAGE_UNAVAILABLE",
      "The app storage service is unavailable.",
    );
  } finally {
    clearTimeout(timer);
  }
}

function operationPath(operationId: string, suffix = ""): string {
  if (!/^[a-f0-9]{32}$/.test(operationId)) {
    throw new StorageError("VALIDATION_ERROR", "Invalid operation identifier.");
  }
  return `/internal/v1/operations/${operationId}${suffix}`;
}

function operationWeekPath(operation: Operation, suffix = ""): string {
  const weekStart = operation.payload.weekStart;
  if (
    typeof weekStart !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart) ||
    Number.isNaN(Date.parse(`${weekStart}T00:00:00Z`)) ||
    new Date(`${weekStart}T00:00:00Z`).toISOString().slice(0, 10) !== weekStart
  ) {
    throw new StorageError(
      "VALIDATION_ERROR",
      "The operation has an invalid week date.",
    );
  }
  return `/internal/v1/households/${
    encodeURIComponent(operation.householdId)
  }/weeks/${weekStart}${suffix}`;
}

function operationRevision(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new StorageError(
      "VALIDATION_ERROR",
      `The operation has an invalid ${field}.`,
    );
  }
  return value;
}

async function exactMealieOutput(
  context: RuntimeContext,
  method: string,
  args: Record<string, unknown>,
  specName: "access" | "recipePage" | "recipe",
  isWrite: boolean,
): Promise<Record<string, unknown>> {
  let result: RunModelResult;
  try {
    result = await context.runModel({
      definition: "meal-planner-mealie",
      method,
      arguments: args,
    });
  } catch {
    throw new StorageError(
      isWrite ? "OPERATION_OUTCOME_UNKNOWN" : "MEALIE_METHOD_FAILED",
      isWrite
        ? "The Mealie write may have completed. Inspect its canonical recipe before retrying."
        : "The Mealie method could not be completed.",
    );
  }
  if (!result.ok) {
    throw new StorageError(
      isWrite ? "OPERATION_OUTCOME_UNKNOWN" : "MEALIE_METHOD_FAILED",
      isWrite
        ? "The Mealie write may have completed. Inspect the canonical recipe before retrying."
        : "The Mealie method failed; no recipe result was accepted.",
    );
  }
  const handle = result.resources.find((resource) =>
    resource.kind === "resource" && resource.specName === specName &&
    resource.name === "current"
  );
  if (!handle || !Number.isSafeInteger(handle.version) || handle.version < 1) {
    throw new StorageError(
      isWrite ? "OPERATION_OUTCOME_UNKNOWN" : "MEALIE_OUTPUT_MISSING",
      isWrite
        ? "The Mealie write may have completed, but this invocation returned no usable recipe handle. Inspect the canonical library before retrying."
        : "The Mealie invocation did not return its expected output handle.",
    );
  }
  let target: SwampDataRecord | undefined;
  try {
    const records = await context.readModelData(
      "meal-planner-mealie",
      handle.specName,
    );
    target = records.find((record) =>
      record.name === handle.name && record.specName === handle.specName
    );
  } catch {
    throw new StorageError(
      isWrite ? "OPERATION_OUTCOME_UNKNOWN" : "MEALIE_OUTPUT_UNAVAILABLE",
      isWrite
        ? "The Mealie write may have completed, but its exact invocation data could not be resolved. Inspect the canonical library before retrying."
        : "The exact Mealie invocation output could not be resolved.",
    );
  }
  if (!target || typeof target.modelId !== "string" || !target.modelId) {
    throw new StorageError(
      isWrite ? "OPERATION_OUTCOME_UNKNOWN" : "MEALIE_OUTPUT_UNAVAILABLE",
      isWrite
        ? "The Mealie write may have completed, but its exact invocation identity is unavailable. Inspect the canonical library before retrying."
        : "The exact Mealie invocation identity is unavailable.",
    );
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await context.dataRepository.getContent(
      target.modelType,
      target.modelId,
      handle.name,
      handle.version,
    );
  } catch {
    bytes = null;
  }
  if (bytes === null) {
    throw new StorageError(
      isWrite ? "OPERATION_OUTCOME_UNKNOWN" : "MEALIE_OUTPUT_UNAVAILABLE",
      isWrite
        ? "The Mealie write may have completed, but its exact output version is unavailable. Inspect the canonical library before retrying."
        : "The exact Mealie invocation output version is unavailable.",
    );
  }
  if (bytes.byteLength > MAX_MEALIE_RECEIPT_BYTES) {
    throw new StorageError(
      isWrite ? "OPERATION_OUTCOME_UNKNOWN" : "MEALIE_OUTPUT_INVALID",
      isWrite
        ? "The Mealie write may have completed, but its canonical receipt exceeded the supported size. Inspect the library before retrying."
        : "The exact Mealie output exceeded the supported size.",
    );
  }
  try {
    const decoded: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!isRecord(decoded)) throw new Error("Recipe output must be an object");
    return decoded;
  } catch {
    throw new StorageError(
      isWrite ? "OPERATION_OUTCOME_UNKNOWN" : "MEALIE_OUTPUT_INVALID",
      isWrite
        ? "The Mealie write may have completed, but its exact output could not be parsed. Inspect the canonical library before retrying."
        : "The exact Mealie invocation output is not valid JSON.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recipeContentFromPayload(value: unknown): RecipeContent {
  if (
    !isRecord(value) || typeof value.title !== "string" ||
    typeof value.servings !== "number" || !Number.isFinite(value.servings) ||
    !Array.isArray(value.ingredients) || !Array.isArray(value.instructions) ||
    value.instructions.some((instruction) => typeof instruction !== "string")
  ) {
    throw new StorageError(
      "VALIDATION_ERROR",
      "The saved recipe content is malformed.",
    );
  }
  const ingredients = value.ingredients.map((raw, index) => {
    if (
      !isRecord(raw) || typeof raw.name !== "string" ||
      (raw.amount !== null &&
        (typeof raw.amount !== "number" || !Number.isFinite(raw.amount))) ||
      (raw.unit !== null && typeof raw.unit !== "string") ||
      (raw.id !== undefined && typeof raw.id !== "string") ||
      (raw.ingredientKey !== undefined && raw.ingredientKey !== null &&
        typeof raw.ingredientKey !== "string") ||
      (raw.unparsed !== undefined && typeof raw.unparsed !== "boolean")
    ) {
      throw new StorageError(
        "VALIDATION_ERROR",
        `Saved recipe ingredient ${index + 1} is malformed.`,
      );
    }
    return {
      ...(typeof raw.id === "string" ? { id: raw.id } : {}),
      name: raw.name,
      amount: raw.amount,
      unit: raw.unit,
      ...(raw.ingredientKey === undefined
        ? {}
        : { ingredientKey: raw.ingredientKey as string | null }),
      ...(typeof raw.unparsed === "boolean" ? { unparsed: raw.unparsed } : {}),
    };
  });
  const instructions = value.instructions.map((instruction) =>
    instruction as string
  );
  try {
    return applyRecipeVersion({
      title: value.title,
      servings: value.servings,
      ingredients,
      instructions,
    }, {
      title: value.title,
      servings: value.servings,
      ingredients,
      instructions,
    });
  } catch {
    throw new StorageError(
      "VALIDATION_ERROR",
      "The saved recipe content failed structured validation.",
    );
  }
}

function internalRecipeFromData(value: unknown): {
  id: string;
  mealieId: string;
  revision: number;
  familyVersionId: string;
  family: RecipeContent;
} {
  if (
    !isRecord(value) || typeof value.id !== "string" ||
    typeof value.mealieId !== "string" ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.familyVersionId !== "string"
  ) {
    throw new StorageError(
      "STORAGE_REQUEST_FAILED",
      "The canonical app recipe record is incomplete.",
    );
  }
  return {
    id: value.id,
    mealieId: value.mealieId,
    revision: Number(value.revision),
    familyVersionId: value.familyVersionId,
    family: recipeContentFromPayload(value.family),
  };
}

function normalizedMealieRecipe(
  value: unknown,
  imported: boolean,
  isWrite: boolean,
): {
  mealieId: string;
  content: RecipeContent;
} {
  try {
    return recipeContentFromMealie(value, imported);
  } catch {
    throw new StorageError(
      isWrite ? "OPERATION_OUTCOME_UNKNOWN" : "MEALIE_OUTPUT_INVALID",
      isWrite
        ? "The Mealie write may have completed, but its canonical recipe could not be normalized. Inspect it before retrying."
        : "The canonical Mealie recipe could not be normalized for review.",
    );
  }
}

function groceryInputs(snapshot: unknown, pantryValue: unknown): {
  meals: Array<
    {
      id: string;
      recipe: RecipeContent;
      portions: number;
      groceryResponsibility: "household" | "other" | "unresolved";
    }
  >;
  pantry: PantryItem[];
} {
  if (
    !isRecord(snapshot) || !Array.isArray(snapshot.meals) ||
    !Array.isArray(pantryValue)
  ) {
    throw new StorageError(
      "VALIDATION_ERROR",
      "Approved recipe and pantry data are unavailable for grocery calculation.",
    );
  }
  const meals = snapshot.meals.flatMap((value) => {
    if (!isRecord(value) || typeof value.id !== "string") {
      throw new StorageError(
        "VALIDATION_ERROR",
        "An approved meal snapshot has an invalid shape.",
      );
    }
    if (
      !["home", "other_cook", "offsite", "unresolved"].includes(
        String(value.arrangement),
      ) ||
      !["household", "other", "unresolved"].includes(
        String(value.groceryResponsibility),
      )
    ) {
      throw new StorageError(
        "VALIDATION_ERROR",
        "An approved meal has invalid arrangement or grocery responsibility.",
      );
    }
    if (
      value.arrangement === "unresolved" ||
      value.groceryResponsibility === "unresolved" ||
      (isRecord(value.condition) && value.condition.status === "unresolved")
    ) {
      throw new StorageError(
        "MEAL_COVERAGE_UNRESOLVED",
        "An approved meal still has unresolved coverage.",
      );
    }
    if (value.leftoverFor !== null && value.leftoverFor !== undefined) {
      throw new StorageError(
        "LEFTOVER_UNSUPPORTED",
        "Leftover links cannot suppress grocery needs until their source and portions are validated.",
      );
    }
    if (value.recipeSnapshot === null) {
      if (
        value.safetyStatus !== "not_assessed_no_recipe" ||
        !["other_cook", "offsite"].includes(String(value.arrangement))
      ) {
        throw new StorageError(
          "VALIDATION_ERROR",
          "A no-recipe meal is not an explicitly unassessed offsite or other-provider meal.",
        );
      }
      if (value.groceryResponsibility === "household") {
        throw new StorageError(
          "GROCERY_COVERAGE_INCOMPLETE",
          "Household groceries cannot be calculated for a meal without a reviewed recipe.",
        );
      }
      return [];
    }
    if (
      typeof value.portions !== "number" || !isRecord(value.recipeSnapshot) ||
      !isRecord(value.recipeSnapshot.content) ||
      value.safetyStatus !== "validated"
    ) {
      throw new StorageError(
        "VALIDATION_ERROR",
        "An approved recipe meal has invalid grocery fields.",
      );
    }
    const recipe = value.recipeSnapshot.content;
    if (
      typeof recipe.title !== "string" || typeof recipe.servings !== "number" ||
      !Array.isArray(recipe.ingredients) || !Array.isArray(recipe.instructions)
    ) {
      throw new StorageError(
        "VALIDATION_ERROR",
        "An approved recipe snapshot has invalid structured content.",
      );
    }
    return [{
      id: value.id,
      recipe: recipe as unknown as RecipeContent,
      portions: value.portions,
      groceryResponsibility: value.groceryResponsibility as
        | "household"
        | "other"
        | "unresolved",
    }];
  });
  let pantry: PantryItem[];
  try {
    pantry = normalizePantryItems(pantryValue);
  } catch {
    throw new StorageError(
      "VALIDATION_ERROR",
      "A pantry item has invalid or duplicate compatible-unit fields.",
    );
  }
  return { meals, pantry };
}

export async function executeOperation(
  operationId: string,
  context: RuntimeContext,
  fetchImpl: typeof fetch = fetch,
  readStorageToken: (path: string) => Promise<string> = (path) =>
    Deno.readTextFile(path),
): Promise<void> {
  if (
    context.globalArgs.storageApiUrl !== TRUSTED_STORAGE_API_URL ||
    context.globalArgs.storageTokenFile !== TRUSTED_STORAGE_TOKEN_FILE
  ) {
    throw new StorageError(
      "CONFIGURATION_ERROR",
      "The runtime storage target must use the app-owned service URL and secret mount.",
    );
  }
  const storageToken =
    (await readStorageToken(context.globalArgs.storageTokenFile)).trim();
  if (storageToken.length < 32 || storageToken.length > 4096) {
    throw new StorageError(
      "CONFIGURATION_ERROR",
      "The storage credential is invalid.",
    );
  }
  const baseUrl = context.globalArgs.storageApiUrl;
  const claimed = await requestStorage<
    { claimed: boolean; operation: Operation }
  >(
    baseUrl,
    storageToken,
    operationPath(operationId, "/claim"),
    { method: "POST", body: "{}" },
    fetchImpl,
  );
  if (!claimed.claimed) return;

  const operation = claimed.operation;
  let externalWriteAttempted = false;
  try {
    const householdPath = `/internal/v1/households/${
      encodeURIComponent(operation.householdId)
    }`;
    switch (operation.kind) {
      case "household.restrictions.save":
        await requestStorage<Record<string, unknown>>(
          baseUrl,
          storageToken,
          `${householdPath}/restrictions`,
          {
            method: "PUT",
            body: JSON.stringify({ ...operation.payload, operationId }),
          },
          fetchImpl,
        );
        break;
      case "household.diners.save":
        await requestStorage<Record<string, unknown>>(
          baseUrl,
          storageToken,
          `${householdPath}/diners`,
          {
            method: "PUT",
            body: JSON.stringify({ ...operation.payload, operationId }),
          },
          fetchImpl,
        );
        break;
      case "household.diner-restrictions.save":
        await requestStorage<Record<string, unknown>>(
          baseUrl,
          storageToken,
          `${householdPath}/diner-restrictions`,
          {
            method: "PUT",
            body: JSON.stringify({ ...operation.payload, operationId }),
          },
          fetchImpl,
        );
        break;
      case "household.planning.save":
        await requestStorage<Record<string, unknown>>(
          baseUrl,
          storageToken,
          `${householdPath}/planning`,
          {
            method: "PUT",
            body: JSON.stringify({ ...operation.payload, operationId }),
          },
          fetchImpl,
        );
        break;
      case "recipe.import-url": {
        const sourceUrl = operation.payload.url;
        if (typeof sourceUrl !== "string") {
          throw new StorageError(
            "VALIDATION_ERROR",
            "The recipe import URL is missing.",
          );
        }
        const sourceLookup = new URL(
          `${householdPath}/recipes/source`,
          baseUrl,
        );
        sourceLookup.searchParams.set("operationId", operationId);
        sourceLookup.searchParams.set("url", sourceUrl);
        const existing = await requestStorage<{ recipe: unknown | null }>(
          baseUrl,
          storageToken,
          `${sourceLookup.pathname}${sourceLookup.search}`,
          { method: "GET" },
          fetchImpl,
        );
        if (existing.recipe !== null) {
          const recipe = internalRecipeFromData(existing.recipe);
          await requestStorage<Record<string, unknown>>(
            baseUrl,
            storageToken,
            `${householdPath}/recipes/${
              encodeURIComponent(recipe.id)
            }/import-reuse`,
            { method: "POST", body: JSON.stringify({ operationId }) },
            fetchImpl,
          );
          break;
        }
        externalWriteAttempted = true;
        const output = await exactMealieOutput(
          context,
          "importRecipeFromUrl",
          {
            url: sourceUrl,
            includeTags: false,
            includeCategories: false,
          },
          "recipe",
          true,
        );
        const captured = normalizedMealieRecipe(output, true, true);
        await requestStorage<Record<string, unknown>>(
          baseUrl,
          storageToken,
          `${householdPath}/recipes`,
          {
            method: "POST",
            body: JSON.stringify({
              operationId,
              mealieId: captured.mealieId,
              sourceKind: "url",
              sourceUrl,
              content: captured.content,
              capturedAt: new Date().toISOString(),
            }),
          },
          fetchImpl,
        );
        break;
      }
      case "recipe.create": {
        const content = recipeContentFromPayload(operation.payload.content);
        let recipeInput: ReturnType<typeof mealieStructuredRecipeInput>;
        try {
          recipeInput = mealieStructuredRecipeInput(content);
        } catch (error) {
          throw new StorageError(
            "MEALIE_REFERENCE_UNSUPPORTED",
            error instanceof Error
              ? error.message
              : "Mealie Food/Unit references are not configured.",
          );
        }
        externalWriteAttempted = true;
        const output = await exactMealieOutput(
          context,
          "createStructuredRecipe",
          recipeInput,
          "recipe",
          true,
        );
        const captured = normalizedMealieRecipe(output, false, true);
        await requestStorage<Record<string, unknown>>(
          baseUrl,
          storageToken,
          `${householdPath}/recipes`,
          {
            method: "POST",
            body: JSON.stringify({
              operationId,
              mealieId: captured.mealieId,
              sourceKind: "manual",
              sourceUrl: null,
              content: captured.content,
              capturedAt: new Date().toISOString(),
            }),
          },
          fetchImpl,
        );
        break;
      }
      case "recipe.update": {
        const recipeId = operation.payload.recipeId;
        const expectedRevision = operation.payload.expectedRevision;
        if (
          typeof recipeId !== "string" || !/^[a-f0-9]{32}$/.test(recipeId) ||
          !Number.isSafeInteger(expectedRevision) ||
          Number(expectedRevision) < 1
        ) {
          throw new StorageError(
            "VALIDATION_ERROR",
            "The recipe version request has invalid revision inputs.",
          );
        }
        const currentUrl = new URL(
          `${householdPath}/recipes/${encodeURIComponent(recipeId)}`,
          baseUrl,
        );
        currentUrl.searchParams.set("operationId", operationId);
        const currentData = await requestStorage<{ recipe: unknown }>(
          baseUrl,
          storageToken,
          `${currentUrl.pathname}${currentUrl.search}`,
          { method: "GET" },
          fetchImpl,
        );
        const current = internalRecipeFromData(currentData.recipe);
        if (current.revision !== expectedRevision) {
          throw new StorageError(
            "REVISION_CONFLICT",
            "The recipe changed before this version could be saved.",
          );
        }
        const content = recipeContentFromPayload(operation.payload.content);
        if (content.title !== current.family.title) {
          throw new StorageError(
            "VALIDATION_ERROR",
            "Recipe titles cannot be changed through the ingredient version editor.",
          );
        }
        let recipeInput: ReturnType<typeof mealieStructuredRecipeInput>;
        try {
          recipeInput = mealieStructuredRecipeInput(content);
        } catch (error) {
          throw new StorageError(
            "MEALIE_REFERENCE_UNSUPPORTED",
            error instanceof Error
              ? error.message
              : "Mealie Food/Unit references are not configured.",
          );
        }
        externalWriteAttempted = true;
        const output = await exactMealieOutput(
          context,
          "updateStructuredRecipe",
          {
            slug: current.mealieId,
            ...recipeInput,
          },
          "recipe",
          true,
        );
        const updated = normalizedMealieRecipe(output, false, true);
        if (updated.mealieId !== current.mealieId) {
          throw new StorageError(
            "OPERATION_OUTCOME_UNKNOWN",
            "Mealie returned a different canonical recipe after the update. Inspect the library before retrying.",
          );
        }
        await requestStorage<Record<string, unknown>>(
          baseUrl,
          storageToken,
          `${householdPath}/recipes/${encodeURIComponent(recipeId)}/versions`,
          {
            method: "POST",
            body: JSON.stringify({
              operationId,
              expectedRevision,
              mealieId: updated.mealieId,
              content: updated.content,
            }),
          },
          fetchImpl,
        );
        break;
      }
      case "recipe.review": {
        const recipeId = operation.payload.recipeId;
        const expectedRevision = operation.payload.expectedRevision;
        const versionId = operation.payload.versionId;
        if (
          typeof recipeId !== "string" || !/^[a-f0-9]{32}$/.test(recipeId) ||
          !Number.isSafeInteger(expectedRevision) ||
          Number(expectedRevision) < 1 ||
          typeof versionId !== "string" || !/^[a-f0-9]{32}$/.test(versionId)
        ) {
          throw new StorageError(
            "VALIDATION_ERROR",
            "The recipe review request has invalid revision inputs.",
          );
        }
        const currentUrl = new URL(
          `${householdPath}/recipes/${encodeURIComponent(recipeId)}`,
          baseUrl,
        );
        currentUrl.searchParams.set("operationId", operationId);
        const currentData = await requestStorage<{ recipe: unknown }>(
          baseUrl,
          storageToken,
          `${currentUrl.pathname}${currentUrl.search}`,
          { method: "GET" },
          fetchImpl,
        );
        const current = internalRecipeFromData(currentData.recipe);
        if (
          current.revision !== expectedRevision ||
          current.familyVersionId !== versionId
        ) {
          throw new StorageError(
            "REVISION_CONFLICT",
            "Only the current recipe revision and version can be reviewed.",
          );
        }
        if (
          current.family.ingredients.some((ingredient) =>
            ingredient.unparsed === true
          )
        ) {
          throw new StorageError(
            "RECIPE_CONTENT_UNPARSED",
            "Structure every imported ingredient before reviewing this recipe version.",
          );
        }
        const output = await exactMealieOutput(
          context,
          "getRecipe",
          { slug: current.mealieId },
          "recipe",
          false,
        );
        const canonical = normalizedMealieRecipe(output, false, false);
        if (canonical.mealieId !== current.mealieId) {
          throw new StorageError(
            "REVISION_CONFLICT",
            "The canonical Mealie recipe identity changed before review.",
          );
        }
        await requestStorage<Record<string, unknown>>(
          baseUrl,
          storageToken,
          `${householdPath}/recipes/${encodeURIComponent(recipeId)}/review`,
          {
            method: "POST",
            body: JSON.stringify({
              operationId,
              expectedRevision,
              versionId,
              canonicalContent: canonical.content,
            }),
          },
          fetchImpl,
        );
        break;
      }
      case "grocery.manual-item.add":
        await requestStorage<Record<string, unknown>>(
          baseUrl,
          storageToken,
          `${householdPath}/weeks/${
            encodeURIComponent(String(operation.payload.weekStart))
          }/groceries/manual-items`,
          {
            method: "POST",
            body: JSON.stringify({
              operationId,
              expectedRevision: operation.payload.expectedRevision,
              expectedWeekRevision: operation.payload.expectedWeekRevision,
              expectedPantryRevision: operation.payload.expectedPantryRevision,
              item: operation.payload.item,
            }),
          },
          fetchImpl,
        );
        break;
      case "week.save":
        await requestStorage<Record<string, unknown>>(
          baseUrl,
          storageToken,
          operationWeekPath(operation),
          {
            method: "PUT",
            body: JSON.stringify({
              operationId,
              expectedRevision: operation.payload.expectedRevision,
              meals: operation.payload.meals,
            }),
          },
          fetchImpl,
        );
        break;
      case "week.approve":
        await requestStorage<Record<string, unknown>>(
          baseUrl,
          storageToken,
          operationWeekPath(operation, "/approve"),
          {
            method: "POST",
            body: JSON.stringify({
              operationId,
              expectedRevision: operation.payload.expectedRevision,
              expectedRestrictionsRevision:
                operation.payload.expectedRestrictionsRevision,
            }),
          },
          fetchImpl,
        );
        break;
      case "pantry.save": {
        const expectedRevision = operationRevision(
          operation.payload.expectedRevision,
          "pantry revision",
        );
        const expectedWeekRevision = operationRevision(
          operation.payload.expectedWeekRevision,
          "week revision",
        );
        let items: PantryItem[];
        try {
          items = normalizePantryItems(operation.payload.items);
        } catch {
          throw new StorageError(
            "VALIDATION_ERROR",
            "Pantry items are invalid or repeat a compatible-unit row.",
          );
        }
        await requestStorage<Record<string, unknown>>(
          baseUrl,
          storageToken,
          operationWeekPath(operation, "/pantry"),
          {
            method: "PUT",
            body: JSON.stringify({
              operationId,
              expectedRevision,
              expectedWeekRevision,
              items,
            }),
          },
          fetchImpl,
        );
        break;
      }
      case "grocery.recalculate": {
        const expectedWeekRevision = Number(
          operation.payload.expectedWeekRevision,
        );
        const expectedPantryRevision = Number(
          operation.payload.expectedPantryRevision,
        );
        if (
          !Number.isSafeInteger(expectedWeekRevision) ||
          expectedWeekRevision < 0 ||
          !Number.isSafeInteger(expectedPantryRevision) ||
          expectedPantryRevision < 0
        ) {
          throw new StorageError(
            "VALIDATION_ERROR",
            "The grocery calculation has invalid revision inputs.",
          );
        }
        const inputPath = operationWeekPath(operation, "/grocery-input");
        const inputUrl = new URL(inputPath, baseUrl);
        inputUrl.searchParams.set("operationId", operationId);
        const data = await requestStorage<{
          week: {
            revision: number;
            status: string;
            approvedSnapshot: { content: unknown } | null;
          };
          pantry: { revision: number; items: unknown[] };
        }>(baseUrl, storageToken, `${inputUrl.pathname}${inputUrl.search}`, {
          method: "GET",
        }, fetchImpl);
        if (
          data.week.status !== "approved" || !data.week.approvedSnapshot ||
          data.week.revision !== expectedWeekRevision ||
          data.pantry.revision !== expectedPantryRevision
        ) {
          throw new StorageError(
            "REVISION_CONFLICT",
            "The approved week or pantry changed before groceries were calculated.",
          );
        }
        const calculated = groceryInputs(
          data.week.approvedSnapshot.content,
          data.pantry.items,
        );
        const items = aggregateGroceries(calculated.meals, calculated.pantry);
        await requestStorage<Record<string, unknown>>(
          baseUrl,
          storageToken,
          operationWeekPath(operation, "/groceries/recalculate"),
          {
            method: "POST",
            body: JSON.stringify({
              operationId,
              expectedWeekRevision,
              expectedPantryRevision,
              items,
            }),
          },
          fetchImpl,
        );
        break;
      }
      default:
        throw new StorageError(
          "OPERATION_UNAVAILABLE",
          "That operation is not enabled by this app runtime.",
        );
    }
  } catch (error) {
    const isExternalRecipeWrite = EXTERNAL_RECIPE_WRITE_KINDS.has(
      operation.kind,
    );
    const failure: OperationError = externalWriteAttempted
      ? {
        code: "OPERATION_OUTCOME_UNKNOWN",
        message:
          "The external recipe write may have completed. Inspect the canonical recipe library before retrying.",
        externalWriteAttempted: true,
      }
      : {
        ...(error instanceof StorageError
          ? { code: error.code, message: error.message }
          : {
            code: "OPERATION_FAILED",
            message: "The operation could not be completed.",
          }),
        ...(isExternalRecipeWrite ? { externalWriteAttempted: false } : {}),
      };
    await requestStorage<unknown>(
      baseUrl,
      storageToken,
      operationPath(operationId, "/complete"),
      {
        method: "POST",
        body: JSON.stringify({ error: failure }),
      },
      fetchImpl,
    );
  }
}

export const model = {
  type: "@mgreten/meal-planner",
  version: "2026.11.09.1",
  globalArguments: GlobalArgs,
  resources: {},
  methods: {
    executeOperation: {
      description:
        "Execute one allowlisted meal-planner command and persist only through its authenticated storage API",
      arguments: OperationArgs,
      execute: async (
        args: z.infer<typeof OperationArgs>,
        context: RuntimeContext,
      ) => {
        await executeOperation(args.operationId, context);
        return {};
      },
    },
  },
};
