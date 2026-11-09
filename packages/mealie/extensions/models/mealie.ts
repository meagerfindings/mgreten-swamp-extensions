/** Bounded Mealie recipe API client and Swamp behavior. @module */
import { z } from "npm:zod@4.0.17";

const MEBIBYTE = 1_048_576;
/** Maximum accepted image upload size in bytes. */
export const MAX_PHOTO_BYTES = 8 * MEBIBYTE;
/** Maximum Mealie response body size in bytes. */
export const MAX_RESPONSE_BYTES = 8 * MEBIBYTE;
/** Maximum serialized JSON or multipart request body size in bytes. */
export const MAX_REQUEST_BYTES = 16 * MEBIBYTE;
const DEFAULT_RESPONSE_BYTES = 2 * MEBIBYTE;
const DEFAULT_REQUEST_BYTES = 4 * MEBIBYTE;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_PAGE_SIZE = 100;
const MAX_CATALOG_PAGES = 10;

const JsonObjectSchema = z.record(z.string(), z.unknown());

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) return true;
  }
  return false;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

/** Mealie recipe ingredient data, retaining additional server-version fields. */
export const MealieIngredientSchema = z.object({
  quantity: z.number().nullable().optional(),
  unit: z.unknown().nullable().optional(),
  food: z.unknown().nullable().optional(),
  referencedRecipe: z.unknown().nullable().optional(),
  note: z.string().nullable().optional(),
  display: z.string().optional(),
  title: z.string().nullable().optional(),
  originalText: z.string().nullable().optional(),
  referenceId: z.string().nullable().optional(),
  referenceQuantity: z.number().nullable().optional(),
  referenceUnit: z.unknown().nullable().optional(),
  recipe_id: z.string().nullable().optional(),
  quantity_unit: z.unknown().nullable().optional(),
  original_text: z.string().nullable().optional(),
  reference_id: z.string().nullable().optional(),
}).passthrough();

/** Mealie recipe instruction data, retaining ingredient-reference structures. */
export const MealieInstructionSchema = z.object({
  id: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  text: z.string(),
  ingredientReferences: z.array(JsonObjectSchema).optional(),
  ingredient_references: z.array(JsonObjectSchema).optional(),
  time: z.number().nullable().optional(),
  duration: z.number().nullable().optional(),
  durationSeconds: z.number().nullable().optional(),
  duration_seconds: z.number().nullable().optional(),
}).passthrough();

/** Strict editable RecipeIn fields; canonical output uses a separate passthrough schema. */
export const MealieRecipeEditableFieldsSchema = z.object({
  name: z.string().min(1).max(500).refine((value) => value.trim().length > 0),
  description: z.string().nullable().optional(),
  recipeServings: z.number().finite().nullable().optional(),
  recipeYield: z.string().nullable().optional(),
  recipeYieldQuantity: z.number().finite().nullable().optional(),
  recipeIngredient: z.array(MealieIngredientSchema).max(500).nullable()
    .optional(),
  recipeInstructions: z.array(MealieInstructionSchema).max(200).nullable()
    .optional(),
}).strict();

/** Full create input; only explicitly supported RecipeIn fields are writable. */
export const MealieRecipeInputSchema = MealieRecipeEditableFieldsSchema;

/** Partial edit fields sent using Mealie's PATCH semantics. */
export const MealieRecipePatchSchema = MealieRecipeEditableFieldsSchema
  .partial()
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "recipe patch must not be empty",
  );

/** Canonical Mealie Recipe-Output, with unknown fields preserved verbatim. */
export const MealieRecipeSchema = z.object({
  id: z.string().nullable().optional(),
  slug: z.string().min(1).max(500),
  name: z.string().min(1).max(500),
  recipeServings: z.number().nullable().optional(),
  recipeYield: z.string().nullable().optional(),
  recipeYieldQuantity: z.number().nullable().optional(),
  recipe_servings: z.number().nullable().optional(),
  recipe_yield: z.string().nullable().optional(),
  recipe_yield_quantity: z.number().nullable().optional(),
  recipeIngredient: z.array(MealieIngredientSchema).nullable().optional(),
  recipeInstructions: z.array(MealieInstructionSchema).nullable().optional(),
  recipe_ingredient: z.array(MealieIngredientSchema).nullable().optional(),
  recipe_instructions: z.array(MealieInstructionSchema).nullable().optional(),
}).passthrough();

/** Full paginated recipe-list response returned by Mealie, without remapping. */
export const MealieRecipePageSchema = z.object({
  page: z.number().int().optional(),
  perPage: z.number().int().optional(),
  per_page: z.number().int().optional(),
  total: z.number().int().optional(),
  totalPages: z.number().int().optional(),
  total_pages: z.number().int().optional(),
  items: z.array(JsonObjectSchema).max(MAX_PAGE_SIZE),
  next: z.string().nullable().optional(),
  previous: z.string().nullable().optional(),
}).passthrough();

/** A Food or Unit returned by Mealie's group-scoped ingredient catalog. */
export const MealieIngredientCatalogItemSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  pluralName: z.string().nullable().optional(),
  plural_name: z.string().nullable().optional(),
  abbreviation: z.string().nullable().optional(),
  pluralAbbreviation: z.string().nullable().optional(),
  plural_abbreviation: z.string().nullable().optional(),
  aliases: z.array(z.object({ name: z.string().min(1) }).passthrough())
    .nullable().optional(),
}).passthrough();

const MealieIngredientCatalogPageSchema = z.object({
  page: z.number().int().min(1).optional(),
  perPage: z.number().int().min(1).optional(),
  per_page: z.number().int().min(1).optional(),
  total: z.number().int().min(0).optional(),
  totalPages: z.number().int().min(0).optional(),
  total_pages: z.number().int().min(0).optional(),
  items: z.array(MealieIngredientCatalogItemSchema).max(MAX_PAGE_SIZE),
  next: z.string().nullable().optional(),
  previous: z.string().nullable().optional(),
}).passthrough();

/** Existing Mealie Food/Unit references accepted in RecipeIn ingredients. */
export const MealieIngredientReferenceSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
}).strict();

/** Canonical nested ingredient shape sent to Mealie after name resolution. */
export const MealieRecipeIngredientReferenceSchema = z.object({
  quantity: z.number().finite().nullable(),
  food: MealieIngredientReferenceSchema,
  unit: MealieIngredientReferenceSchema.nullable(),
  note: z.string().max(4_000).nullable().optional(),
}).strict();

/** App-facing structured ingredient input; `name` resolves to Mealie Food. */
export const MealieStructuredIngredientSchema = z.object({
  name: z.string().trim().min(1).max(500),
  quantity: z.number().finite().nullable(),
  unit: z.string().trim().min(1).max(500).nullable().optional(),
  note: z.string().max(4_000).nullable().optional(),
}).strict();

/** Supported recipe fields paired with name-based structured ingredients. */
export const MealieStructuredRecipeFieldsSchema = z.object({
  name: z.string().min(1).max(500).refine((value) => value.trim().length > 0)
    .optional(),
  description: z.string().nullable().optional(),
  recipeServings: z.number().finite().nullable().optional(),
  recipeYield: z.string().nullable().optional(),
  recipeYieldQuantity: z.number().finite().nullable().optional(),
  recipeInstructions: z.array(MealieInstructionSchema).max(200).nullable()
    .optional(),
}).strict();

/** Recipe fields required to create a structured manual recipe. */
export const MealieStructuredRecipeCreateFieldsSchema =
  MealieStructuredRecipeFieldsSchema.extend({
    name: z.string().min(1).max(500).refine((value) => value.trim().length > 0),
  });

/** Structured recipe input accepted by the reusable Mealie client. */
export type MealieStructuredIngredient = z.input<
  typeof MealieStructuredIngredientSchema
>;
/** Supported structured recipe fields accepted by update. */
export type MealieStructuredRecipeFields = z.input<
  typeof MealieStructuredRecipeFieldsSchema
>;
/** Supported structured recipe fields accepted by create. */
export type MealieStructuredRecipeCreateFields = z.input<
  typeof MealieStructuredRecipeCreateFieldsSchema
>;
/** Nested Food/Unit reference payload accepted by the Mealie recipe API. */
export type MealieRecipeIngredientReference = z.infer<
  typeof MealieRecipeIngredientReferenceSchema
>;
/** Mealie ingredient catalog record used for reference resolution. */
export type MealieIngredientCatalogItem = z.output<
  typeof MealieIngredientCatalogItemSchema
>;

/** Exact administrator-approved source identity for photo imports. */
export const MealiePhotoSourceAllowlistEntrySchema = z.object({
  modelType: z.string().min(1).max(256),
  modelId: z.string().min(1).max(256),
}).strict();
/** One exact model type/model ID pair in the administrator allowlist. */
export type MealiePhotoSourceAllowlistEntry = z.output<
  typeof MealiePhotoSourceAllowlistEntrySchema
>;

/** Admin-configured Mealie endpoint and bounded HTTP settings. */
export const GlobalArgumentsSchema = z.object({
  baseUrl: z.string().url().max(2_048).refine(
    (value) => {
      const url = new URL(value);
      return (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username && !url.password && !url.search && !url.hash;
    },
    "baseUrl must be an HTTP(S) origin or path without credentials, query, or fragment",
  ),
  apiToken: z.string().min(1).max(8_192).meta({ sensitive: true }),
  requestTimeoutMs: z.number().int().min(1_000).max(MAX_TIMEOUT_MS)
    .default(DEFAULT_TIMEOUT_MS),
  maximumResponseBytes: z.number().int().min(1_024).max(MAX_RESPONSE_BYTES)
    .default(DEFAULT_RESPONSE_BYTES),
  maximumRequestBytes: z.number().int().min(1_024).max(MAX_REQUEST_BYTES)
    .default(DEFAULT_REQUEST_BYTES),
  photoSourceAllowlist: z.array(MealiePhotoSourceAllowlistEntrySchema).max(100)
    .default([]).meta({ sensitive: true }),
}).strict();

/** Inputs accepted by the reusable Mealie client. */
export type MealieClientConfig = z.input<typeof GlobalArgumentsSchema>;
/** Full recipe data accepted by the Mealie write API. */
export type MealieRecipeInput = z.input<typeof MealieRecipeInputSchema>;
/** Partial editable fields accepted by updateRecipe. */
export type MealieRecipePatch = z.input<typeof MealieRecipePatchSchema>;
/** Full canonical recipe response, with server-version-specific fields intact. */
export type MealieRecipe = z.output<typeof MealieRecipeSchema>;
/** One item in Mealie's recipe search response. */
export type MealieRecipeSummary = z.output<typeof JsonObjectSchema>;
/** Full paginated recipe-list response. */
export type MealieRecipePage = z.output<typeof MealieRecipePageSchema>;

/** Minimal verified Mealie version and authenticated-access result. */
export const MealieAccessResultSchema = z.object({
  version: z.string().min(1),
  authenticated: z.literal(true),
  checkedAt: z.iso.datetime(),
}).strict();
/** Parsed result written by the `verifyAccess` method. */
export type MealieAccessResult = z.infer<typeof MealieAccessResultSchema>;

const SlugSchema = z.string().min(1).max(500).refine(
  (value) =>
    value !== "." && value !== ".." &&
    !hasPathSeparator(value) && !hasControlCharacter(value),
  "slug must be one path segment",
);
const SearchSchema = z.string().min(1).max(200).refine(
  (value) => !hasControlCharacter(value),
  "search must not contain control characters",
);
/** Bounded search and pagination arguments accepted by `listRecipes`. */
export const ListRecipesArgsSchema = z.object({
  search: SearchSchema.optional(),
  page: z.number().int().min(1).max(1_000_000).default(1),
  perPage: z.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
}).strict();
/** Bounded search and pagination inputs for `listRecipes`. */
export type ListRecipesArgs = z.input<typeof ListRecipesArgsSchema>;

/** Mealie URL-import arguments; importing persists the recipe immediately. */
export const ImportRecipeFromUrlArgsSchema = z.object({
  url: z.string().min(1).max(2_048),
  includeTags: z.boolean().default(false),
  includeCategories: z.boolean().default(false),
}).strict();
/** Input accepted by the `importRecipeFromUrl` method. */
export type ImportRecipeFromUrlArgs = z.input<
  typeof ImportRecipeFromUrlArgsSchema
>;

const MediaTypeSchema = z.enum(["image/jpeg", "image/png", "image/webp"]);
/** Reusable-client photo data, already bounded and held in memory. */
export const MealiePhotoInputSchema = z.object({
  bytes: z.instanceof(Uint8Array),
  fileName: z.string().min(1).max(120),
  mediaType: MediaTypeSchema,
});
/** In-memory photo upload accepted by the reusable Mealie client. */
export type MealiePhotoInput = z.input<typeof MealiePhotoInputSchema>;

const MAX_URL_LENGTH = 2_048;
const PhotoFileReferenceSchema = z.object({
  modelType: z.string().min(1).max(256),
  modelId: z.string().min(1).max(256),
  dataName: z.string().min(1).max(256),
  version: z.number().int().min(1),
}).strict();

/** A safe client-visible API error; response bodies and credentials are omitted. */
export class MealieApiError extends Error {
  readonly status: number;
  constructor(operation: string, status: number) {
    super(`Mealie ${operation} failed with HTTP ${status}`);
    this.name = "MealieApiError";
    this.status = status;
  }
}

/** A transport or server failure where a write might already have committed. */
export class MealieWriteOutcomeUnknownError extends Error {
  readonly operation: string;
  readonly slug: string | undefined;
  constructor(operation: string, slug?: string) {
    super(
      `Mealie ${operation} outcome is unknown; inspect the service before retrying`,
    );
    this.name = "MealieWriteOutcomeUnknownError";
    this.operation = operation;
    this.slug = slug;
  }
}

/** A create that is known to have started but could not be fully populated. */
export class MealiePartialCreateError extends Error {
  readonly slug: string;
  readonly phase: "initial-read" | "populate" | "readback";
  constructor(slug: string, phase: "initial-read" | "populate" | "readback") {
    super(
      `Mealie create ${phase} phase did not complete; inspect the service before retrying`,
    );
    this.name = "MealiePartialCreateError";
    this.slug = slug;
    this.phase = phase;
  }
}

/** A successful write whose canonical post-write GET could not be completed. */
export class MealieReadbackError extends Error {
  readonly slug: string;
  readonly operation: string;
  constructor(operation: string, slug: string) {
    super(
      `Mealie ${operation} was acknowledged, but canonical readback failed`,
    );
    this.name = "MealieReadbackError";
    this.slug = slug;
    this.operation = operation;
  }
}

/** The requested Mealie capability is not present on this server version. */
export class MealieFeatureUnavailableError extends Error {
  readonly feature: string;
  constructor(feature: string) {
    super(`Mealie does not expose the ${feature} endpoint on this server`);
    this.name = "MealieFeatureUnavailableError";
    this.feature = feature;
  }
}

/** Mealie rejected an AI photo import; provider setup or input may be the cause. */
export class MealiePhotoImportRejectedError extends Error {
  readonly status = 400;
  constructor() {
    super(
      "Mealie rejected the photo AI import (HTTP 400); check that an image-capable provider is configured and that the upload is valid",
    );
    this.name = "MealiePhotoImportRejectedError";
  }
}

/** A photo source did not match an administrator-configured exact identity. */
export class MealiePhotoSourceNotAllowedError extends Error {
  constructor() {
    super("Photo source is not in the administrator-configured allowlist");
    this.name = "MealiePhotoSourceNotAllowedError";
  }
}

/** A Swamp file metadata/content read failed without exposing source identity. */
export class MealiePhotoSourceReadError extends Error {
  readonly stage: "metadata" | "content";
  constructor(stage: "metadata" | "content") {
    super(`Swamp photo ${stage} could not be read`);
    this.name = "MealiePhotoSourceReadError";
    this.stage = stage;
  }
}

/** The caller attempted to send a request larger than the configured limit. */
export class MealieInputTooLargeError extends Error {
  constructor(maximumBytes: number) {
    super(`Mealie request exceeds the ${maximumBytes}-byte limit`);
    this.name = "MealieInputTooLargeError";
  }
}

/** Mealie returned an oversized or malformed response. */
export class MealieResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MealieResponseError";
  }
}

/** Mealie response size exceeded the configured byte limit. */
export class MealieResponseTooLargeError extends MealieResponseError {
  constructor(maximumBytes: number) {
    super(`Mealie response exceeds the ${maximumBytes}-byte limit`);
    this.name = "MealieResponseTooLargeError";
  }
}

/** Public methods implemented by the reusable Mealie HTTP client. */
export interface MealieClient {
  verifyAccess(): Promise<MealieAccessResult>;
  listRecipes(args?: ListRecipesArgs): Promise<MealieRecipePage>;
  getRecipe(slug: string): Promise<MealieRecipe>;
  createRecipe(recipe: MealieRecipeInput): Promise<MealieRecipe>;
  updateRecipe(slug: string, recipe: MealieRecipePatch): Promise<MealieRecipe>;
  createStructuredRecipe(
    recipe: MealieStructuredRecipeCreateFields,
    ingredients: MealieStructuredIngredient[],
  ): Promise<MealieRecipe>;
  updateStructuredRecipe(
    slug: string,
    recipe: MealieStructuredRecipeFields,
    ingredients: MealieStructuredIngredient[],
  ): Promise<MealieRecipe>;
  importRecipeFromUrl(args: ImportRecipeFromUrlArgs): Promise<MealieRecipe>;
  importRecipeFromPhoto(photo: MealiePhotoInput): Promise<MealieRecipe>;
}

type ApiRequestBody = string | FormData | undefined;

function parseResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  kind: string,
): T {
  try {
    return schema.parse(value);
  } catch {
    throw new MealieResponseError(
      `Mealie returned an invalid ${kind} response`,
    );
  }
}

function serializeJson(value: unknown, maximumBytes: number): string {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw new MealieResponseError(
      "Mealie request could not be serialized as JSON",
    );
  }
  if (new TextEncoder().encode(body).byteLength > maximumBytes) {
    throw new MealieInputTooLargeError(maximumBytes);
  }
  return body;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already unusable; never echo response data into errors.
  }
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length > maximumBytes) {
      await cancelBody(response);
      throw new MealieResponseTooLargeError(maximumBytes);
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new MealieResponseTooLargeError(maximumBytes);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function importableRecipeUrl(input: string): string {
  if (input.length > MAX_URL_LENGTH || hasControlCharacter(input)) {
    throw new Error("Recipe import URL is invalid or exceeds the URL limit");
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Recipe import URL must be an absolute HTTPS URL");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  const ipv4Literal = /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname);
  if (
    url.protocol !== "https:" || url.username || url.password || !hostname ||
    hostname === "localhost" || hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") || hostname.endsWith(".internal") ||
    hostname.startsWith("[") || ipv4Literal
  ) {
    throw new Error(
      "Recipe import URL must use HTTPS and a public hostname without credentials or an IP literal",
    );
  }
  return url.toString();
}

function safePhotoFileName(
  fileName: string,
  mediaType: z.infer<typeof MediaTypeSchema>,
): string {
  if (
    hasPathSeparator(fileName) || hasControlCharacter(fileName) ||
    fileName === "." || fileName === ".."
  ) {
    throw new Error(
      "Photo fileName must be a plain filename without path separators",
    );
  }
  const extension = fileName.split(".").at(-1)?.toLowerCase();
  const expectedExtension = mediaType === "image/jpeg"
    ? ["jpg", "jpeg"]
    : mediaType === "image/png"
    ? ["png"]
    : ["webp"];
  if (!extension || !expectedExtension.includes(extension)) {
    throw new Error(
      "Photo fileName extension must match its supported mediaType",
    );
  }
  return fileName;
}

function assertImageBytes(
  bytes: Uint8Array,
  mediaType: z.infer<typeof MediaTypeSchema>,
): void {
  if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES) {
    throw new MealieInputTooLargeError(MAX_PHOTO_BYTES);
  }
  const isJpeg = mediaType === "image/jpeg" && bytes.length >= 3 &&
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = mediaType === "image/png" && bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
    bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a &&
    bytes[6] === 0x1a && bytes[7] === 0x0a;
  const isWebp = mediaType === "image/webp" && bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
  if (!isJpeg && !isPng && !isWebp) {
    throw new Error(
      "Photo bytes do not match the declared supported image type",
    );
  }
}

/** Create a client with a caller-controlled fetch for deterministic testing. */
export function createMealieClient(
  config: MealieClientConfig,
  request: typeof fetch = fetch,
  callerSignal?: AbortSignal,
): MealieClient {
  const settings = GlobalArgumentsSchema.parse(config);
  const baseUrl = settings.baseUrl.endsWith("/")
    ? settings.baseUrl
    : `${settings.baseUrl}/`;

  function apiUrl(path: string): URL {
    return new URL(path.replace(/^\/+/, ""), baseUrl);
  }

  async function send(
    method: string,
    path: string,
    operation: string,
    body: ApiRequestBody,
    expectedStatus: number,
    isWrite: boolean,
    slug?: string,
  ): Promise<Response> {
    const headers = new Headers({
      Authorization: `Bearer ${settings.apiToken}`,
      Accept: "application/json",
    });
    if (typeof body === "string") {
      headers.set("Content-Type", "application/json");
    }
    const timeout = AbortSignal.timeout(settings.requestTimeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeout])
      : timeout;
    let response: Response;
    try {
      response = await request(apiUrl(path), {
        method,
        headers,
        body,
        redirect: "error",
        signal,
      });
    } catch {
      if (isWrite) throw new MealieWriteOutcomeUnknownError(operation, slug);
      throw new MealieResponseError(
        `Mealie ${operation} transport failed or timed out`,
      );
    }
    if (response.status !== expectedStatus) {
      await cancelBody(response);
      if (
        isWrite &&
        (response.status >= 500 ||
          (response.status >= 300 && response.status < 400))
      ) {
        throw new MealieWriteOutcomeUnknownError(operation, slug);
      }
      throw new MealieApiError(operation, response.status);
    }
    return response;
  }

  async function sendJson<T>(
    method: string,
    path: string,
    operation: string,
    schema: z.ZodType<T>,
    body?: unknown,
    expectedStatus = 200,
    isWrite = false,
  ): Promise<T> {
    const encodedBody = body === undefined
      ? undefined
      : serializeJson(body, settings.maximumRequestBytes);
    const response = await send(
      method,
      path,
      operation,
      encodedBody,
      expectedStatus,
      isWrite,
    );
    try {
      const bytes = await readBoundedBody(
        response,
        settings.maximumResponseBytes,
      );
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const value: unknown = JSON.parse(text);
      return parseResponse(schema, value, operation);
    } catch (error) {
      if (isWrite) throw new MealieWriteOutcomeUnknownError(operation);
      if (error instanceof MealieResponseError) throw error;
      throw new MealieResponseError(
        `Mealie returned invalid JSON for ${operation}`,
      );
    }
  }

  async function sendEmpty(
    method: string,
    path: string,
    operation: string,
    body: unknown,
    slug?: string,
  ): Promise<void> {
    const encodedBody = serializeJson(body, settings.maximumRequestBytes);
    const response = await send(
      method,
      path,
      operation,
      encodedBody,
      200,
      true,
      slug,
    );
    await cancelBody(response);
  }

  async function readCanonical(
    slug: string,
    operation: string,
  ): Promise<MealieRecipe> {
    try {
      return await getRecipe(slug);
    } catch {
      throw new MealieReadbackError(operation, slug);
    }
  }

  async function getRecipe(slug: string): Promise<MealieRecipe> {
    const validSlug = SlugSchema.parse(slug);
    return await sendJson(
      "GET",
      `api/recipes/${encodeURIComponent(validSlug)}`,
      "getRecipe",
      MealieRecipeSchema,
    );
  }

  async function loadIngredientCatalog(
    collection: "foods" | "units",
  ): Promise<MealieIngredientCatalogItem[]> {
    const operation = collection === "foods" ? "listFoods" : "listUnits";
    const items: MealieIngredientCatalogItem[] = [];
    let expectedPages: number | undefined;

    for (let pageNumber = 1; pageNumber <= MAX_CATALOG_PAGES; pageNumber++) {
      const query = new URLSearchParams({
        page: String(pageNumber),
        perPage: String(MAX_PAGE_SIZE),
      });
      const page = await sendJson(
        "GET",
        `api/${collection}?${query.toString()}`,
        operation,
        MealieIngredientCatalogPageSchema,
      );
      const reportedPages = page.totalPages ?? page.total_pages;
      if (reportedPages !== undefined && reportedPages > MAX_CATALOG_PAGES) {
        throw new MealieResponseError(
          `Mealie ${collection} catalog exceeds the safe page limit`,
        );
      }
      if (
        expectedPages !== undefined && reportedPages !== undefined &&
        reportedPages !== expectedPages
      ) {
        throw new MealieResponseError(
          `Mealie ${collection} catalog changed during pagination`,
        );
      }
      expectedPages ??= reportedPages;
      if (expectedPages === 0 && page.items.length > 0) {
        throw new MealieResponseError(
          `Mealie returned inconsistent ${collection} pagination`,
        );
      }
      items.push(...page.items);

      const finished = expectedPages !== undefined
        ? pageNumber >= expectedPages
        : page.items.length < MAX_PAGE_SIZE;
      if (finished) return items;
      if (page.items.length === 0) {
        throw new MealieResponseError(
          `Mealie returned incomplete ${collection} pagination`,
        );
      }
      if (pageNumber === MAX_CATALOG_PAGES) {
        throw new MealieResponseError(
          `Mealie ${collection} catalog exceeds the safe page limit`,
        );
      }
    }

    throw new MealieResponseError(
      `Mealie ${collection} catalog exceeds the safe page limit`,
    );
  }

  function normalizeIngredientName(value: string): string {
    return value.normalize("NFKC").trim().toLowerCase();
  }

  function catalogNames(
    item: MealieIngredientCatalogItem,
    kind: "food" | "unit",
  ): string[] {
    const names = [item.name, item.pluralName, item.plural_name];
    if (kind === "unit") {
      names.push(
        item.abbreviation,
        item.pluralAbbreviation,
        item.plural_abbreviation,
      );
    }
    names.push(...(item.aliases ?? []).map((alias) => alias.name));
    return names.filter((name): name is string => typeof name === "string");
  }

  function findExactCatalogItem(
    items: MealieIngredientCatalogItem[],
    name: string,
    kind: "food" | "unit",
  ): MealieIngredientCatalogItem | undefined {
    const normalized = normalizeIngredientName(name);
    const matches = items.filter((item) =>
      catalogNames(item, kind).some((candidate) =>
        normalizeIngredientName(candidate) === normalized
      )
    );
    const uniqueMatches = [...new Map(matches.map((item) => [item.id, item]))
      .values()];
    if (uniqueMatches.length > 1) {
      throw new MealieResponseError(
        `Mealie has multiple exact matches for a structured ${kind} reference`,
      );
    }
    return uniqueMatches[0];
  }

  async function findOrCreateCatalogItem(
    collection: "foods" | "units",
    kind: "food" | "unit",
    name: string,
    items: MealieIngredientCatalogItem[],
    cache: Map<string, MealieIngredientCatalogItem>,
  ): Promise<MealieIngredientCatalogItem> {
    const normalized = normalizeIngredientName(name);
    const cached = cache.get(normalized);
    if (cached) return cached;

    const existing = findExactCatalogItem(items, name, kind);
    if (existing) {
      cache.set(normalized, existing);
      return existing;
    }

    const operation = kind === "food" ? "createFood" : "createUnit";
    const created = await sendJson(
      "POST",
      `api/${collection}`,
      operation,
      MealieIngredientCatalogItemSchema,
      { name },
      201,
      true,
    );
    items.push(created);
    cache.set(normalized, created);
    return created;
  }

  async function resolveStructuredIngredients(
    ingredients: MealieStructuredIngredient[],
  ): Promise<MealieRecipeIngredientReference[]> {
    if (ingredients.length === 0) return [];

    // Read both catalogs before creating anything, so a failed/oversized list
    // request cannot leave partial Food or Unit records behind.
    const foods = await loadIngredientCatalog("foods");
    const units = ingredients.some((ingredient) => ingredient.unit != null)
      ? await loadIngredientCatalog("units")
      : [];
    const foodCache = new Map<string, MealieIngredientCatalogItem>();
    const unitCache = new Map<string, MealieIngredientCatalogItem>();
    const resolved: MealieRecipeIngredientReference[] = [];

    for (const ingredient of ingredients) {
      const food = await findOrCreateCatalogItem(
        "foods",
        "food",
        ingredient.name,
        foods,
        foodCache,
      );
      const unit = ingredient.unit == null
        ? null
        : await findOrCreateCatalogItem(
          "units",
          "unit",
          ingredient.unit,
          units,
          unitCache,
        );
      resolved.push(MealieRecipeIngredientReferenceSchema.parse({
        quantity: ingredient.quantity,
        food: { id: food.id, name: food.name },
        unit: unit ? { id: unit.id, name: unit.name } : null,
        ...(ingredient.note === undefined ? {} : { note: ingredient.note }),
      }));
    }

    return resolved;
  }

  async function importByIdentifier(
    operation: string,
    requestPath: string,
    requestBody: ApiRequestBody,
  ): Promise<MealieRecipe> {
    const response = await send(
      "POST",
      requestPath,
      operation,
      requestBody,
      201,
      true,
    );
    let slug: string;
    try {
      const bytes = await readBoundedBody(
        response,
        settings.maximumResponseBytes,
      );
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      slug = z.string().min(1).max(500).parse(JSON.parse(text));
    } catch {
      throw new MealieWriteOutcomeUnknownError(operation);
    }
    return await readCanonical(slug, operation);
  }

  const client: MealieClient = {
    async verifyAccess() {
      const about = await sendJson(
        "GET",
        "api/app/about",
        "verifyAccess app-info",
        z.object({ version: z.string().min(1) }).passthrough(),
      );
      await sendJson(
        "GET",
        "api/recipes?page=1&perPage=1",
        "verifyAccess recipe-access",
        MealieRecipePageSchema,
      );
      return MealieAccessResultSchema.parse({
        version: about.version,
        authenticated: true,
        checkedAt: new Date().toISOString(),
      });
    },

    async listRecipes(args = {}) {
      const parsed = ListRecipesArgsSchema.parse(args);
      const query = new URLSearchParams({
        page: String(parsed.page),
        perPage: String(parsed.perPage),
      });
      if (parsed.search !== undefined) query.set("search", parsed.search);
      return await sendJson(
        "GET",
        `api/recipes?${query.toString()}`,
        "listRecipes",
        MealieRecipePageSchema,
      );
    },

    getRecipe,

    async createRecipe(input) {
      const recipe = MealieRecipeInputSchema.parse(input);
      // Reject oversized input before creating the recipe shell, which would
      // otherwise leave a partial server-side recipe behind.
      serializeJson(recipe, settings.maximumRequestBytes);
      const slug = z.string().min(1).max(500).parse(
        await sendJson(
          "POST",
          "api/recipes",
          "createRecipe shell",
          z.string().min(1).max(500),
          { name: recipe.name },
          201,
          true,
        ),
      );
      let initial: MealieRecipe;
      try {
        initial = await getRecipe(slug);
      } catch {
        throw new MealiePartialCreateError(slug, "initial-read");
      }
      const identity = Object.fromEntries(
        ["id", "slug", "userId", "householdId", "groupId"].flatMap((key) =>
          initial[key] === undefined ? [] : [[key, initial[key]]]
        ),
      );
      const fullInput = { ...initial, ...recipe, ...identity };
      try {
        await sendEmpty(
          "PUT",
          `api/recipes/${encodeURIComponent(slug)}`,
          "createRecipe populate",
          fullInput,
        );
      } catch (error) {
        if (error instanceof MealieWriteOutcomeUnknownError) {
          throw new MealieWriteOutcomeUnknownError(
            "createRecipe populate",
            slug,
          );
        }
        throw new MealiePartialCreateError(slug, "populate");
      }
      try {
        return await getRecipe(slug);
      } catch {
        throw new MealiePartialCreateError(slug, "readback");
      }
    },

    async createStructuredRecipe(recipeInput, ingredientInput) {
      const recipe = MealieStructuredRecipeCreateFieldsSchema.parse(
        recipeInput,
      );
      const ingredients = z.array(MealieStructuredIngredientSchema).max(500)
        .parse(ingredientInput);
      const recipeIngredients = await resolveStructuredIngredients(ingredients);
      return await client.createRecipe({
        ...recipe,
        recipeIngredient: recipeIngredients,
      });
    },

    async updateRecipe(slug, input) {
      const validSlug = SlugSchema.parse(slug);
      const patch = MealieRecipePatchSchema.parse(input);
      await sendEmpty(
        "PATCH",
        `api/recipes/${encodeURIComponent(validSlug)}`,
        "updateRecipe",
        patch,
        validSlug,
      );
      return await readCanonical(validSlug, "updateRecipe");
    },

    async updateStructuredRecipe(slug, recipeInput, ingredientInput) {
      const validSlug = SlugSchema.parse(slug);
      const recipe = MealieStructuredRecipeFieldsSchema.parse(recipeInput);
      const ingredients = z.array(MealieStructuredIngredientSchema).max(500)
        .parse(ingredientInput);
      const recipeIngredients = await resolveStructuredIngredients(ingredients);
      return await client.updateRecipe(validSlug, {
        ...recipe,
        recipeIngredient: recipeIngredients,
      });
    },

    async importRecipeFromUrl(input) {
      const args = ImportRecipeFromUrlArgsSchema.parse(input);
      const url = importableRecipeUrl(args.url);
      const body = serializeJson({
        url,
        includeTags: args.includeTags,
        includeCategories: args.includeCategories,
      }, settings.maximumRequestBytes);
      return await importByIdentifier(
        "importRecipeFromUrl",
        "api/recipes/create/url",
        body,
      );
    },

    async importRecipeFromPhoto(input) {
      const photo = MealiePhotoInputSchema.parse(input);
      const fileName = safePhotoFileName(photo.fileName, photo.mediaType);
      assertImageBytes(photo.bytes, photo.mediaType);
      if (photo.bytes.byteLength + 1_024 > settings.maximumRequestBytes) {
        throw new MealieInputTooLargeError(settings.maximumRequestBytes);
      }
      const form = new FormData();
      const blob = new Blob([photo.bytes.slice().buffer], {
        type: photo.mediaType,
      });
      form.append("images", blob, fileName);
      try {
        return await importByIdentifier(
          "importRecipeFromPhoto",
          "api/recipes/create/ai",
          form,
        );
      } catch (error) {
        if (error instanceof MealieApiError && error.status === 404) {
          throw new MealieFeatureUnavailableError("AI photo import");
        }
        if (error instanceof MealieApiError && error.status === 400) {
          throw new MealiePhotoImportRejectedError();
        }
        throw error;
      }
    },
  };
  return client;
}

/** Swamp data-repository identity for a managed photo file. */
export interface MealieSourceFile {
  modelType: string;
  modelId: string;
  dataName: string;
  version: number;
}

type StoredFileMetadata = {
  size?: number;
  metadata?: {
    size?: number;
    contentType?: string;
  };
  tags?: Record<string, string>;
};

interface SwampContext {
  globalArgs: z.output<typeof GlobalArgumentsSchema>;
  signal?: AbortSignal;
  writeResource(
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
  dataRepository?: {
    findByName(
      modelType: string,
      modelId: string,
      dataName: string,
      version?: number,
    ): Promise<StoredFileMetadata | null>;
    getContent(
      modelType: string,
      modelId: string,
      dataName: string,
      version?: number,
    ): Promise<Uint8Array | null>;
  };
}

/** Swamp file reference and metadata for a bounded photo import. */
export const ImportRecipeFromPhotoArgsSchema = z.object({
  source: PhotoFileReferenceSchema,
  fileName: z.string().min(1).max(120),
  mediaType: MediaTypeSchema,
}).strict();
/** Input accepted by `importRecipeFromPhoto`; raw paths are not accepted. */
export type ImportRecipeFromPhotoArgs = z.input<
  typeof ImportRecipeFromPhotoArgsSchema
>;

async function readSwampPhoto(
  context: SwampContext,
  source: MealieSourceFile,
  fileName: string,
  mediaType: z.infer<typeof MediaTypeSchema>,
): Promise<MealiePhotoInput> {
  const isAllowed = context.globalArgs.photoSourceAllowlist.some((entry) =>
    entry.modelType === source.modelType && entry.modelId === source.modelId
  );
  if (!isAllowed) throw new MealiePhotoSourceNotAllowedError();

  const repository = context.dataRepository;
  if (!repository) throw new Error("Swamp file data access is unavailable");
  let metadata: StoredFileMetadata | null;
  try {
    metadata = await repository.findByName(
      source.modelType,
      source.modelId,
      source.dataName,
      source.version,
    );
  } catch {
    throw new MealiePhotoSourceReadError("metadata");
  }
  if (!metadata || metadata.tags?.type !== "file") {
    throw new Error(
      "Photo source must identify a Swamp-managed file data record",
    );
  }
  const fileSize = metadata.size ?? metadata.metadata?.size;
  if (
    !Number.isSafeInteger(fileSize) || fileSize === undefined ||
    fileSize <= 0 || fileSize > MAX_PHOTO_BYTES
  ) {
    throw new MealieInputTooLargeError(MAX_PHOTO_BYTES);
  }
  const contentType = metadata.metadata?.contentType;
  if (contentType && contentType !== mediaType) {
    throw new Error("Photo mediaType must match the Swamp file content type");
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await repository.getContent(
      source.modelType,
      source.modelId,
      source.dataName,
      source.version,
    );
  } catch {
    throw new MealiePhotoSourceReadError("content");
  }
  if (!bytes || bytes.length !== fileSize) {
    throw new Error("Swamp photo data is unavailable or changed size");
  }
  assertImageBytes(bytes, mediaType);
  return { bytes: new Uint8Array(bytes), fileName, mediaType };
}

interface MethodContext extends SwampContext {
  logger: { info(message: string, properties?: Record<string, unknown>): void };
}

/** Empty argument object for `verifyAccess`. */
export const VerifyAccessArgsSchema = z.object({}).strict();
/** Slug-or-id argument object for `getRecipe`. */
export const GetRecipeArgsSchema = z.object({ slug: SlugSchema }).strict();
/** Structured recipe input for `createRecipe`. */
export const CreateRecipeArgsSchema = z.object({
  recipe: MealieRecipeInputSchema,
}).strict();
/** Slug and non-empty partial recipe patch for `updateRecipe`. */
export const UpdateRecipeArgsSchema = z.object({
  slug: SlugSchema,
  recipe: MealieRecipePatchSchema,
}).strict();
/** Manual create arguments with name-based Food/Unit resolution. */
export const CreateStructuredRecipeArgsSchema = z.object({
  recipe: MealieStructuredRecipeCreateFieldsSchema,
  ingredients: z.array(MealieStructuredIngredientSchema).max(500),
}).strict();
/** Structured replacement arguments with name-based Food/Unit resolution. */
export const UpdateStructuredRecipeArgsSchema = z.object({
  slug: SlugSchema,
  recipe: MealieStructuredRecipeFieldsSchema.default({}),
  ingredients: z.array(MealieStructuredIngredientSchema).max(500),
}).strict();

/** Swamp supplies configured globals alongside method inputs; strip them here. */
function swampMethodArguments(schema: z.ZodObject) {
  return z.object(schema.shape);
}

/** Construct a Swamp model around the same reusable client used by consumers. */
export function createModel(request: typeof fetch = fetch) {
  return {
    type: "@mgreten/mealie",
    version: "2026.11.09.2",
    globalArguments: GlobalArgumentsSchema,
    upgrades: [{
      toVersion: "2026.11.09.2",
      description:
        "Default photo imports to an empty administrator source allowlist",
      upgradeAttributes: (old: Record<string, unknown>) =>
        Object.hasOwn(old, "photoSourceAllowlist")
          ? { ...old }
          : { ...old, photoSourceAllowlist: [] },
    }],
    resources: {
      access: {
        description:
          "Bounded Mealie version and authenticated API access check",
        schema: MealieAccessResultSchema,
        lifetime: "30d" as const,
        garbageCollection: 10,
      },
      recipePage: {
        description:
          "Full bounded pagination object returned by Mealie recipe search",
        schema: MealieRecipePageSchema,
        lifetime: "30d" as const,
        garbageCollection: 20,
      },
      recipe: {
        description: "Full canonical Mealie recipe output returned by readback",
        schema: MealieRecipeSchema,
        lifetime: "30d" as const,
        garbageCollection: 20,
      },
    },
    checks: {
      "mealie-access": {
        description:
          "Verify authenticated Mealie access before recipe mutations",
        labels: ["live"],
        appliesTo: [
          "createRecipe",
          "createStructuredRecipe",
          "updateRecipe",
          "updateStructuredRecipe",
          "importRecipeFromUrl",
          "importRecipeFromPhoto",
        ],
        execute: async (context: {
          globalArgs: z.output<typeof GlobalArgumentsSchema>;
        }) => {
          try {
            await createMealieClient(context.globalArgs, request)
              .verifyAccess();
            return { pass: true };
          } catch {
            return {
              pass: false,
              errors: [
                "Mealie access verification failed; confirm the service URL and vault-backed token",
              ],
            };
          }
        },
      },
    },
    methods: {
      verifyAccess: {
        description:
          "Check Mealie version and authenticated access with a one-item recipe request",
        arguments: swampMethodArguments(VerifyAccessArgsSchema),
        execute: async (
          _args: Record<string, never>,
          context: MethodContext,
        ) => {
          context.logger.info("Mealie operation started", {
            operation: "verifyAccess",
          });
          const client = createMealieClient(
            context.globalArgs,
            request,
            context.signal,
          );
          const result = await client.verifyAccess();
          const handle = await context.writeResource(
            "access",
            "current",
            result,
          );
          context.logger.info("Mealie operation completed", {
            operation: "verifyAccess",
          });
          return { dataHandles: [handle] };
        },
      },
      listRecipes: {
        description:
          "Search and list a bounded Mealie recipe page without remapping response fields",
        arguments: swampMethodArguments(ListRecipesArgsSchema),
        execute: async (args: ListRecipesArgs, context: MethodContext) => {
          context.logger.info("Mealie operation started", {
            operation: "listRecipes",
          });
          const client = createMealieClient(
            context.globalArgs,
            request,
            context.signal,
          );
          const page = await client.listRecipes(args);
          const handle = await context.writeResource(
            "recipePage",
            "current",
            page,
          );
          context.logger.info("Mealie operation completed", {
            operation: "listRecipes",
          });
          return { dataHandles: [handle] };
        },
      },
      getRecipe: {
        description: "Read one complete Mealie recipe by slug or id",
        arguments: swampMethodArguments(GetRecipeArgsSchema),
        execute: async (args: { slug: string }, context: MethodContext) => {
          context.logger.info("Mealie operation started", {
            operation: "getRecipe",
          });
          const client = createMealieClient(
            context.globalArgs,
            request,
            context.signal,
          );
          const recipe = await client.getRecipe(args.slug);
          const handle = await context.writeResource(
            "recipe",
            "current",
            recipe,
          );
          context.logger.info("Mealie operation completed", {
            operation: "getRecipe",
          });
          return { dataHandles: [handle] };
        },
      },
      createRecipe: {
        description:
          "Create a manual recipe, populate the full RecipeIn fields, then persist canonical readback",
        arguments: swampMethodArguments(CreateRecipeArgsSchema),
        execute: async (
          args: z.infer<typeof CreateRecipeArgsSchema>,
          context: MethodContext,
        ) => {
          context.logger.info("Mealie operation started", {
            operation: "createRecipe",
          });
          const client = createMealieClient(
            context.globalArgs,
            request,
            context.signal,
          );
          const recipe = await client.createRecipe(args.recipe);
          const handle = await context.writeResource(
            "recipe",
            "current",
            recipe,
          );
          context.logger.info("Mealie operation completed", {
            operation: "createRecipe",
          });
          return { dataHandles: [handle] };
        },
      },
      createStructuredRecipe: {
        description:
          "Create a manual recipe after resolving or creating its Food/Unit references, then read back canonical Recipe-Output",
        arguments: swampMethodArguments(CreateStructuredRecipeArgsSchema),
        execute: async (
          args: z.infer<typeof CreateStructuredRecipeArgsSchema>,
          context: MethodContext,
        ) => {
          context.logger.info("Mealie operation started", {
            operation: "createStructuredRecipe",
          });
          const client = createMealieClient(
            context.globalArgs,
            request,
            context.signal,
          );
          const recipe = await client.createStructuredRecipe(
            args.recipe,
            args.ingredients,
          );
          const handle = await context.writeResource(
            "recipe",
            "current",
            recipe,
          );
          context.logger.info("Mealie operation completed", {
            operation: "createStructuredRecipe",
          });
          return { dataHandles: [handle] };
        },
      },
      updateRecipe: {
        description:
          "Apply a partial RecipeIn patch while preserving omitted fields, then persist canonical GET readback",
        arguments: swampMethodArguments(UpdateRecipeArgsSchema),
        execute: async (
          args: z.infer<typeof UpdateRecipeArgsSchema>,
          context: MethodContext,
        ) => {
          context.logger.info("Mealie operation started", {
            operation: "updateRecipe",
          });
          const client = createMealieClient(
            context.globalArgs,
            request,
            context.signal,
          );
          const recipe = await client.updateRecipe(args.slug, args.recipe);
          const handle = await context.writeResource(
            "recipe",
            "current",
            recipe,
          );
          context.logger.info("Mealie operation completed", {
            operation: "updateRecipe",
          });
          return { dataHandles: [handle] };
        },
      },
      updateStructuredRecipe: {
        description:
          "Replace structured ingredients after resolving or creating Food/Unit references, then read back canonical Recipe-Output",
        arguments: swampMethodArguments(UpdateStructuredRecipeArgsSchema),
        execute: async (
          args: z.infer<typeof UpdateStructuredRecipeArgsSchema>,
          context: MethodContext,
        ) => {
          context.logger.info("Mealie operation started", {
            operation: "updateStructuredRecipe",
          });
          const client = createMealieClient(
            context.globalArgs,
            request,
            context.signal,
          );
          const recipe = await client.updateStructuredRecipe(
            args.slug,
            args.recipe,
            args.ingredients,
          );
          const handle = await context.writeResource(
            "recipe",
            "current",
            recipe,
          );
          context.logger.info("Mealie operation completed", {
            operation: "updateStructuredRecipe",
          });
          return { dataHandles: [handle] };
        },
      },
      importRecipeFromUrl: {
        description:
          "Import from a validated HTTPS URL (Mealie fetches and persists immediately), then read back",
        arguments: swampMethodArguments(ImportRecipeFromUrlArgsSchema),
        execute: async (
          args: ImportRecipeFromUrlArgs,
          context: MethodContext,
        ) => {
          context.logger.info("Mealie operation started", {
            operation: "importRecipeFromUrl",
          });
          const client = createMealieClient(
            context.globalArgs,
            request,
            context.signal,
          );
          const recipe = await client.importRecipeFromUrl(args);
          const handle = await context.writeResource(
            "recipe",
            "current",
            recipe,
          );
          context.logger.info("Mealie operation completed", {
            operation: "importRecipeFromUrl",
          });
          return { dataHandles: [handle] };
        },
      },
      importRecipeFromPhoto: {
        description:
          "Import one bounded Swamp-managed image via Mealie AI only when its exact source identity is in the admin allowlist and an image-capable provider is configured",
        arguments: swampMethodArguments(ImportRecipeFromPhotoArgsSchema),
        execute: async (
          rawArgs: ImportRecipeFromPhotoArgs,
          context: MethodContext,
        ) => {
          context.logger.info("Mealie operation started", {
            operation: "importRecipeFromPhoto",
          });
          const args = ImportRecipeFromPhotoArgsSchema.parse(rawArgs);
          const photo = await readSwampPhoto(
            context,
            args.source,
            args.fileName,
            args.mediaType,
          );
          const client = createMealieClient(
            context.globalArgs,
            request,
            context.signal,
          );
          const recipe = await client.importRecipeFromPhoto(photo);
          const handle = await context.writeResource(
            "recipe",
            "current",
            recipe,
          );
          context.logger.info("Mealie operation completed", {
            operation: "importRecipeFromPhoto",
          });
          return { dataHandles: [handle] };
        },
      },
    },
  };
}

/** Swamp model definition for reusable Mealie recipe operations. */
export const model = {
  ...createModel(),
  type: "@mgreten/mealie",
  version: "2026.11.09.2",
};
