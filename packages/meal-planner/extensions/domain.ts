export type RecipeIngredient = {
  id?: string;
  name: string;
  amount: number | null;
  unit: string | null;
  ingredientKey?: string | null;
  unparsed?: boolean;
};

export type RecipeContent = {
  title: string;
  servings: number;
  ingredients: RecipeIngredient[];
  instructions: string[];
};

export const MAX_RECIPE_CONTENT_JSON_BYTES = 1_000_000;
export const MAX_APP_REQUEST_JSON_BYTES = 1_048_576;
export const MAX_APPROVAL_CONTENT_BYTES = 4_000_000;
export const MAX_STORAGE_RESPONSE_BYTES = 10_000_000;
export const MAX_APPROVAL_ENVELOPE_METADATA_BYTES = 65_536;
// v1 deliberately carries the approval content twice, plus the saved week and
// bounded response metadata. Keep this derived result ceiling below the
// storage response cap instead of changing the public response shape.
export const MAX_APPROVAL_RESULT_BYTES = 2 * MAX_APPROVAL_CONTENT_BYTES +
  MAX_APP_REQUEST_JSON_BYTES +
  MAX_APPROVAL_ENVELOPE_METADATA_BYTES;

export type PlannedMeal = {
  id: string;
  date: string;
  slot: "breakfast" | "lunch" | "dinner";
  arrangement: "home" | "other_cook" | "offsite" | "unresolved";
  groceryResponsibility: "household" | "other" | "unresolved";
  recipeId: string | null;
  recipeVersionId: string | null;
  title: string | null;
  portions: number | null;
  dinerIds: string[];
  headcount: number;
  guestCount: number;
  attendeeIds: string[];
  guestRestrictions: GuestRestriction[];
  condition: {
    kind: "calendar_event";
    status: "unresolved" | "confirmed" | "cancelled";
    sourceLabel: string | null;
    sourceUrl: string | null;
    eventId: string | null;
    checkedAt: string | null;
  } | null;
  notes: string | null;
  leftoverFor: string | null;
};

export type GuestRestriction = {
  label: string | null;
  status: "known" | "unknown";
  allergies: string[];
  dietaryRestrictions: string[];
  reviewAcknowledged: boolean;
};

export type RestrictionBaseline = {
  confirmed: boolean;
  allergies: string[];
  dietaryRestrictions: string[];
  avoid: string[];
  prefer: string[];
};

export type DinerRestrictions = Omit<RestrictionBaseline, "confirmed">;

export type PantryItem = {
  ingredientKey: string;
  name?: string;
  amount: number | null;
  unit: string | null;
};

export type GroceryItem = {
  ingredientKey: string;
  name: string;
  groceryResponsibility: "household" | "other" | "unresolved";
  status: "ready" | "covered_elsewhere" | "needs_clarification";
  needed: { amount: number | null; unit: string | null };
  pantry: { amount: number | null; unit: string | null };
  toBuy: { amount: number | null; unit: string | null };
  needsReview: boolean;
  sourceMeals: string[];
};

type IngredientGroup = {
  ingredientKey: string;
  name: string;
  groceryResponsibility: "household" | "other" | "unresolved";
  unitKey: string;
  baseUnit: string | null;
  dimension: string;
  amount: number;
  pantryAmount: number;
  pantryUnresolved: boolean;
  sourceMeals: Set<string>;
  needsReview: boolean;
};

const UNIT_DEFINITIONS: Record<
  string,
  { dimension: string; baseUnit: string; factor: number }
> = {
  mg: { dimension: "mass", baseUnit: "g", factor: 0.001 },
  g: { dimension: "mass", baseUnit: "g", factor: 1 },
  kg: { dimension: "mass", baseUnit: "g", factor: 1000 },
  oz: { dimension: "mass", baseUnit: "g", factor: 28.349523125 },
  lb: { dimension: "mass", baseUnit: "g", factor: 453.59237 },
  ml: { dimension: "volume", baseUnit: "ml", factor: 1 },
  l: { dimension: "volume", baseUnit: "ml", factor: 1000 },
  tsp: { dimension: "volume", baseUnit: "ml", factor: 4.928921594 },
  tbsp: { dimension: "volume", baseUnit: "ml", factor: 14.786764782 },
  cup: { dimension: "volume", baseUnit: "ml", factor: 236.5882365 },
  "fl oz": { dimension: "volume", baseUnit: "ml", factor: 29.5735295625 },
  each: { dimension: "count", baseUnit: "each", factor: 1 },
  piece: { dimension: "count", baseUnit: "each", factor: 1 },
  pc: { dimension: "count", baseUnit: "each", factor: 1 },
  dozen: { dimension: "count", baseUnit: "each", factor: 12 },
};

const UNIT_ALIASES: Record<string, string> = {
  milligram: "mg",
  milligrams: "mg",
  gram: "g",
  grams: "g",
  kilogram: "kg",
  kilograms: "kg",
  ounce: "oz",
  ounces: "oz",
  pound: "lb",
  pounds: "lb",
  milliliter: "ml",
  milliliters: "ml",
  millilitre: "ml",
  millilitres: "ml",
  liter: "l",
  liters: "l",
  litre: "l",
  litres: "l",
  teaspoon: "tsp",
  teaspoons: "tsp",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
  cups: "cup",
  "fluid ounce": "fl oz",
  "fluid ounces": "fl oz",
  piece: "piece",
  pieces: "piece",
  each: "each",
  count: "each",
  pc: "pc",
  pcs: "pc",
};

function roundQuantity(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

export function normalizeIngredientKey(value: string): string {
  return value.trim().toLocaleLowerCase("en-US")
    .normalize("NFKC")
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normalizeUnit(value: string | null): string | null {
  if (value === null || value.trim() === "") return null;
  const normalized = value.trim().normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
  return UNIT_ALIASES[normalized] ?? normalized;
}

function toBase(amount: number, unit: string | null): {
  unitKey: string;
  baseUnit: string | null;
  dimension: string;
  amount: number;
} {
  const normalizedUnit = normalizeUnit(unit);
  if (normalizedUnit === null) {
    return {
      unitKey: "unspecified",
      baseUnit: null,
      dimension: "unspecified",
      amount,
    };
  }
  const definition = UNIT_DEFINITIONS[normalizedUnit];
  if (!definition) {
    return {
      unitKey: `unknown:${normalizedUnit}`,
      baseUnit: normalizedUnit,
      dimension: `unknown:${normalizedUnit}`,
      amount,
    };
  }
  return {
    unitKey: definition.dimension,
    baseUnit: definition.baseUnit,
    dimension: definition.dimension,
    amount: amount * definition.factor,
  };
}

export function normalizePantryItems(value: unknown): PantryItem[] {
  if (!Array.isArray(value) || value.length > 500) {
    throw new Error("Pantry items must contain at most 500 entries.");
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Pantry item ${index + 1} must be an object.`);
    }
    const item = entry as Record<string, unknown>;
    const ingredientKey = typeof item.ingredientKey === "string"
      ? normalizeIngredientKey(item.ingredientKey)
      : "";
    if (!ingredientKey || ingredientKey.length > 256) {
      throw new Error(`Pantry item ${index + 1} needs a valid ingredientKey.`);
    }
    let amount: number | null;
    if (item.amount === null) {
      amount = null;
    } else if (
      typeof item.amount === "number" && Number.isFinite(item.amount) &&
      item.amount >= 0
    ) {
      amount = item.amount;
    } else {
      throw new Error(
        `Pantry item ${index + 1} amount must be non-negative or null.`,
      );
    }
    let unit: string | null;
    if (item.unit === null) {
      unit = null;
    } else if (typeof item.unit === "string" && item.unit.length <= 64) {
      unit = item.unit.trim() || null;
    } else {
      throw new Error(
        `Pantry item ${index + 1} unit must be null or at most 64 characters.`,
      );
    }
    if (
      item.name !== undefined &&
      (typeof item.name !== "string" || item.name.length > 500)
    ) {
      throw new Error(
        `Pantry item ${index + 1} name must be at most 500 characters.`,
      );
    }
    const dimension = toBase(1, unit).dimension;
    const duplicateKey = `${ingredientKey}\u0000${dimension}`;
    if (seen.has(duplicateKey)) {
      throw new Error(
        "Pantry items cannot repeat an ingredient with compatible units.",
      );
    }
    seen.add(duplicateKey);
    return {
      ingredientKey,
      ...(typeof item.name === "string" ? { name: item.name } : {}),
      amount,
      unit,
    };
  });
}

export function scaleRecipe(
  recipe: RecipeContent,
  requestedPortions: number,
): RecipeContent {
  if (!Number.isFinite(recipe.servings) || recipe.servings <= 0) {
    throw new Error("Recipe servings must be greater than zero");
  }
  if (!Number.isFinite(requestedPortions) || requestedPortions <= 0) {
    throw new Error("Requested portions must be greater than zero");
  }
  const factor = requestedPortions / recipe.servings;
  return {
    ...recipe,
    ingredients: recipe.ingredients.map((ingredient) => ({
      ...ingredient,
      amount: ingredient.amount === null
        ? null
        : roundQuantity(ingredient.amount * factor),
    })),
    instructions: [...recipe.instructions],
  };
}

/** A reviewed version replaces structured content; it is not a note beside the old recipe. */
export function applyRecipeVersion(
  _current: RecipeContent,
  replacement: RecipeContent,
): RecipeContent {
  if (
    typeof replacement.title !== "string" || !replacement.title.trim() ||
    replacement.title.length > 200
  ) {
    throw new Error("Recipe title must contain 1–200 characters");
  }
  if (
    !Number.isFinite(replacement.servings) || replacement.servings <= 0 ||
    replacement.servings > 500
  ) {
    throw new Error(
      "Recipe servings must be greater than zero and no greater than 500",
    );
  }
  if (
    !Array.isArray(replacement.ingredients) ||
    replacement.ingredients.length === 0 ||
    replacement.ingredients.length > 500
  ) {
    throw new Error("Recipe ingredients must contain 1–500 entries");
  }
  if (
    !Array.isArray(replacement.instructions) ||
    replacement.instructions.length === 0 ||
    replacement.instructions.length > 500
  ) {
    throw new Error("Recipe instructions must contain 1–500 steps");
  }
  const content: RecipeContent = {
    title: replacement.title.trim(),
    servings: replacement.servings,
    ingredients: replacement.ingredients.map((ingredient, index) => {
      if (
        typeof ingredient.name !== "string" || !ingredient.name.trim() ||
        ingredient.name.length > 500
      ) {
        throw new Error("Ingredient names must contain 1–500 characters");
      }
      if (
        ingredient.ingredientKey !== undefined &&
        ingredient.ingredientKey !== null &&
        typeof ingredient.ingredientKey !== "string"
      ) {
        throw new Error("Ingredient identity must be text or null");
      }
      const name = ingredient.name.trim();
      const nameKey = normalizeIngredientKey(name);
      const suppliedKey = typeof ingredient.ingredientKey === "string"
        ? normalizeIngredientKey(ingredient.ingredientKey)
        : "";
      const ingredientKey = suppliedKey || nameKey;
      if (
        typeof ingredient.ingredientKey === "string" &&
        ingredient.ingredientKey.length > 500
      ) {
        throw new Error(
          "Ingredient identities must contain at most 500 characters",
        );
      }
      if (ingredientKey.length > 500) {
        throw new Error(
          "Ingredient identities must contain at most 500 characters",
        );
      }
      if (
        typeof ingredient.ingredientKey === "string" &&
        ingredient.ingredientKey.trim() && !suppliedKey
      ) {
        throw new Error("Ingredient identity must contain letters or numbers");
      }
      if (
        ingredient.amount !== null &&
        (!Number.isFinite(ingredient.amount) || ingredient.amount <= 0)
      ) {
        throw new Error("Ingredient amount must be positive or null");
      }
      if (
        ingredient.unparsed !== undefined &&
        typeof ingredient.unparsed !== "boolean"
      ) {
        throw new Error("Ingredient parsing status must be boolean");
      }
      if (
        ingredient.id !== undefined &&
        (typeof ingredient.id !== "string" || ingredient.id.length > 256)
      ) {
        throw new Error(
          "Ingredient identifiers must contain at most 256 characters",
        );
      }
      const unit = ingredient.unit;
      if (
        unit !== null &&
        (typeof unit !== "string" || !unit.trim() || unit.trim().length > 64)
      ) {
        throw new Error(
          "Ingredient units must be null or contain 1–64 characters",
        );
      }
      return {
        ...ingredient,
        id: ingredient.id ?? `ingredient-${index + 1}`,
        name,
        unit: typeof unit === "string" ? unit.trim() : null,
        ingredientKey,
      };
    }),
    instructions: replacement.instructions.map((instruction, index) => {
      if (
        typeof instruction !== "string" || !instruction.trim() ||
        instruction.length > 5000
      ) {
        throw new Error(
          `Recipe instruction ${index + 1} must contain 1–5000 characters`,
        );
      }
      return instruction.trim();
    }),
  };
  const contentBytes =
    new TextEncoder().encode(JSON.stringify(content)).byteLength;
  if (contentBytes > MAX_RECIPE_CONTENT_JSON_BYTES) {
    throw new Error(
      "Recipe content exceeds the 1,000,000-byte normalized JSON limit",
    );
  }
  return content;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedRecipeText(
  value: unknown,
  field: string,
  maximum: number,
): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(
      `Mealie ${field} is missing or exceeds its supported length`,
    );
  }
  return value.trim();
}

function mealieReferenceName(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  const reference = record(value);
  if (!reference) return null;
  for (const candidate of [reference.abbreviation, reference.name]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

/** Normalize one exact Mealie Recipe-Output into the application's review projection. */
export function recipeContentFromMealie(value: unknown, imported = false): {
  mealieId: string;
  content: RecipeContent;
} {
  const recipe = record(value);
  if (!recipe) throw new Error("Mealie returned an invalid recipe object");
  const mealieId = boundedRecipeText(recipe.slug, "slug", 256);
  const title = boundedRecipeText(recipe.name, "name", 200);
  const servings = recipe.recipeServings;
  if (
    typeof servings !== "number" || !Number.isFinite(servings) || servings <= 0
  ) {
    throw new Error("Mealie recipeServings must be a positive number");
  }
  if (
    !Array.isArray(recipe.recipeIngredient) ||
    recipe.recipeIngredient.length === 0 ||
    recipe.recipeIngredient.length > 500
  ) {
    throw new Error(
      "Mealie recipeIngredient must contain 1–500 structured ingredients",
    );
  }
  if (
    !Array.isArray(recipe.recipeInstructions) ||
    recipe.recipeInstructions.length === 0 ||
    recipe.recipeInstructions.length > 500
  ) {
    throw new Error(
      "Mealie recipeInstructions must contain 1–500 instructions",
    );
  }
  const ingredients = recipe.recipeIngredient.map((value, index) => {
    const ingredient = record(value);
    if (!ingredient) {
      throw new Error(`Mealie ingredient ${index + 1} is not an object`);
    }
    const food = record(ingredient.food);
    const unit = mealieReferenceName(ingredient.unit);
    const foodName = typeof food?.name === "string" ? food.name.trim() : "";
    const note = [ingredient.note, ingredient.originalText, ingredient.display]
      .find((entry) => typeof entry === "string" && entry.trim());
    const name = boundedRecipeText(
      foodName || note,
      `ingredient ${index + 1} name`,
      500,
    );
    const quantity = ingredient.quantity;
    const amount =
      typeof quantity === "number" && Number.isFinite(quantity) && quantity > 0
        ? quantity
        : null;
    const isUnparsed = imported &&
      (quantity === 0 || (foodName === "" && unit === null));
    return {
      id: `ingredient-${index + 1}`,
      name,
      amount,
      unit,
      ...(isUnparsed ? { unparsed: true } : {}),
    };
  });
  const instructions = recipe.recipeInstructions.map((value, index) => {
    const instruction = record(value);
    return boundedRecipeText(
      instruction?.text,
      `instruction ${index + 1}`,
      5000,
    );
  });
  let content: RecipeContent;
  try {
    content = applyRecipeVersion(
      { title, servings, ingredients, instructions },
      {
        title,
        servings,
        ingredients,
        instructions,
      },
    );
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : "Mealie recipe could not be normalized",
    );
  }
  return { mealieId, content };
}

/** Build the package's structured write input; the adapter resolves group-scoped Food/Unit names. */
export function mealieStructuredRecipeInput(content: RecipeContent): {
  recipe: Record<string, unknown>;
  ingredients: Array<{ name: string; quantity: number | null; unit?: string }>;
} {
  if (content.ingredients.some((ingredient) => ingredient.unparsed)) {
    throw new Error(
      "Imported ingredient text must be manually structured before saving",
    );
  }
  return {
    recipe: {
      name: content.title,
      recipeServings: content.servings,
      recipeInstructions: content.instructions.map((text) => ({ text })),
    },
    ingredients: content.ingredients.map((ingredient) => ({
      name: ingredient.name,
      quantity: ingredient.amount,
      ...(ingredient.unit === null ? {} : { unit: ingredient.unit }),
    })),
  };
}

function restrictionTokens(value: string): Set<string> {
  return new Set(
    normalizeIngredientKey(value).split(" ").filter(Boolean).map((word) =>
      word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word
    ),
  );
}

function recipeHasRestrictedIngredient(
  recipe: RecipeContent,
  restrictions: string[],
): string[] {
  const ingredientTokens = recipe.ingredients.map((ingredient) => ({
    tokens: new Set([
      ...restrictionTokens(ingredient.name),
      ...restrictionTokens(ingredient.ingredientKey ?? ""),
    ]),
  }));
  const conflicts = new Set<string>();
  for (const restriction of restrictions) {
    const tokens = restrictionTokens(restriction);
    if (tokens.size === 0) continue;
    const matches = ingredientTokens.some((ingredient) =>
      [...tokens].some((token) => ingredient.tokens.has(token))
    );
    if (matches) conflicts.add(restriction);
  }
  return [...conflicts].sort((left, right) => left.localeCompare(right));
}

export function validateMealRestrictions(
  meal:
    & Pick<
      PlannedMeal,
      | "headcount"
      | "guestCount"
      | "attendeeIds"
      | "guestRestrictions"
      | "portions"
    >
    & {
      dinerIds?: string[];
    },
  recipe: RecipeContent,
  baseline: RestrictionBaseline,
  requirePortions = false,
  dinerRestrictions: Record<string, DinerRestrictions> = {},
): { errors: string[]; conflicts: string[]; guestReviewRequired: boolean } {
  const errors: string[] = [];
  const conflicts = recipeHasRestrictedIngredient(recipe, [
    ...baseline.allergies,
    ...baseline.dietaryRestrictions,
    ...baseline.avoid,
  ]);
  for (const dinerId of meal.dinerIds ?? []) {
    const preferences = dinerRestrictions[dinerId];
    if (preferences) {
      conflicts.push(...recipeHasRestrictedIngredient(recipe, [
        ...preferences.allergies,
        ...preferences.dietaryRestrictions,
        ...preferences.avoid,
      ]));
    }
  }
  for (const guest of meal.guestRestrictions) {
    if (guest.status === "known") {
      conflicts.push(...recipeHasRestrictedIngredient(recipe, [
        ...guest.allergies,
        ...guest.dietaryRestrictions,
      ]));
    }
  }
  if (!baseline.confirmed) errors.push("RESTRICTIONS_UNCONFIRMED");
  if (
    !Number.isInteger(meal.headcount) || meal.headcount < 1 ||
    meal.headcount > 100
  ) {
    errors.push("INVALID_HEADCOUNT");
  }
  if (
    !Number.isInteger(meal.guestCount) || meal.guestCount < 0 ||
    meal.guestCount > meal.headcount
  ) {
    errors.push("INVALID_GUEST_COUNT");
  }
  if (
    new Set(meal.attendeeIds).size !== meal.attendeeIds.length ||
    meal.attendeeIds.length > meal.headcount
  ) {
    errors.push("INVALID_ATTENDEE_IDS");
  }
  if (meal.guestRestrictions.length !== meal.guestCount) {
    errors.push("GUEST_RESTRICTIONS_REQUIRED");
  }
  if (
    meal.portions !== null &&
    (!Number.isFinite(meal.portions) || meal.portions <= 0)
  ) {
    errors.push("INVALID_PORTIONS");
  }
  if (requirePortions && meal.portions === null) {
    errors.push("PORTIONS_REQUIRED");
  }
  if (conflicts.length > 0) errors.push("RESTRICTION_CONFLICT");
  const guestReviewRequired = meal.guestRestrictions.some((guest) =>
    guest.status === "unknown" && !guest.reviewAcknowledged
  );
  if (guestReviewRequired) errors.push("UNKNOWN_GUEST_REVIEW_REQUIRED");
  return {
    errors: [...new Set(errors)],
    conflicts: [...new Set(conflicts)],
    guestReviewRequired,
  };
}

export function aggregateGroceries(
  meals: Array<{
    id: string;
    recipe: RecipeContent;
    portions: number | null;
    groceryResponsibility?: "household" | "other" | "unresolved";
  }>,
  pantry: PantryItem[],
): GroceryItem[] {
  const normalizedPantry = normalizePantryItems(pantry);
  const groups = new Map<string, IngredientGroup>();
  const unitKeysByIngredient = new Map<string, Set<string>>();

  for (const meal of meals) {
    if (meal.portions === null) continue;
    const responsibility = meal.groceryResponsibility ?? "household";
    const scaled = scaleRecipe(meal.recipe, meal.portions);
    for (const ingredient of scaled.ingredients) {
      const ingredientKey = normalizeIngredientKey(
        ingredient.ingredientKey || ingredient.name,
      );
      if (!ingredientKey) continue;
      if (ingredient.amount === null || ingredient.unit === null) {
        const key = `${ingredientKey}\u0000unquantified\u0000${responsibility}`;
        const existing = groups.get(key);
        if (existing) existing.sourceMeals.add(meal.id);
        else {
          groups.set(key, {
            ingredientKey,
            name: ingredient.name,
            groceryResponsibility: responsibility,
            unitKey: "unquantified",
            baseUnit: null,
            dimension: "unquantified",
            amount: 0,
            pantryAmount: 0,
            pantryUnresolved: false,
            sourceMeals: new Set([meal.id]),
            needsReview: true,
          });
        }
        continue;
      }

      const quantity = toBase(ingredient.amount, ingredient.unit);
      const key =
        `${ingredientKey}\u0000${quantity.unitKey}\u0000${responsibility}`;
      const existing = groups.get(key);
      if (existing) {
        existing.amount += quantity.amount;
        existing.sourceMeals.add(meal.id);
      } else {
        groups.set(key, {
          ingredientKey,
          name: ingredient.name,
          groceryResponsibility: responsibility,
          unitKey: quantity.unitKey,
          baseUnit: quantity.baseUnit,
          dimension: quantity.dimension,
          amount: quantity.amount,
          pantryAmount: 0,
          pantryUnresolved: false,
          sourceMeals: new Set([meal.id]),
          needsReview: quantity.dimension !== "mass" &&
            quantity.dimension !== "volume" && quantity.dimension !== "count",
        });
      }
      const unitKeys = unitKeysByIngredient.get(ingredientKey) ??
        new Set<string>();
      unitKeys.add(quantity.unitKey);
      unitKeysByIngredient.set(ingredientKey, unitKeys);
    }
  }

  for (const stock of normalizedPantry) {
    const ingredientKey = normalizeIngredientKey(stock.ingredientKey);
    if (stock.amount === 0) continue;
    if (stock.amount === null || stock.unit === null) {
      const dimension = stock.unit === null
        ? null
        : toBase(1, stock.unit).dimension;
      for (const group of groups.values()) {
        if (
          group.ingredientKey === ingredientKey &&
          group.groceryResponsibility === "household" &&
          (dimension === null || group.dimension === dimension)
        ) {
          group.pantryUnresolved = true;
          group.needsReview = true;
        }
      }
      continue;
    }
    const quantity = toBase(stock.amount, stock.unit);
    const group = groups.get(
      `${ingredientKey}\u0000${quantity.unitKey}\u0000household`,
    );
    if (group) group.pantryAmount += quantity.amount;
  }

  for (const [ingredientKey, unitKeys] of unitKeysByIngredient) {
    if (unitKeys.size > 1) {
      for (const unitKey of unitKeys) {
        for (
          const responsibility of ["household", "other", "unresolved"] as const
        ) {
          const group = groups.get(
            `${ingredientKey}\u0000${unitKey}\u0000${responsibility}`,
          );
          if (group) group.needsReview = true;
        }
      }
    }
  }

  return [...groups.values()]
    .map((group) => {
      const unit = group.baseUnit;
      const neededAmount = roundQuantity(group.amount);
      const pantryAmount = roundQuantity(
        Math.min(group.pantryAmount, group.amount),
      );
      const status: GroceryItem["status"] =
        group.groceryResponsibility === "household"
          ? "ready"
          : group.groceryResponsibility === "other"
          ? "covered_elsewhere"
          : "needs_clarification";
      return {
        ingredientKey: group.ingredientKey,
        name: group.name,
        groceryResponsibility: group.groceryResponsibility,
        status,
        needed: {
          amount: group.dimension === "unquantified" ? null : neededAmount,
          unit,
        },
        pantry: {
          amount: group.dimension === "unquantified" ||
              group.groceryResponsibility !== "household" ||
              group.pantryUnresolved
            ? null
            : pantryAmount,
          unit,
        },
        toBuy: {
          amount: group.dimension === "unquantified" ||
              group.groceryResponsibility !== "household"
            ? null
            : roundQuantity(Math.max(0, group.amount - group.pantryAmount)),
          unit,
        },
        needsReview: group.needsReview,
        sourceMeals: [...group.sourceMeals].sort(),
      };
    })
    .sort((left, right) =>
      left.ingredientKey.localeCompare(right.ingredientKey) ||
      String(left.needed.unit).localeCompare(String(right.needed.unit))
    );
}

export function deterministicRecipeOrder<
  T extends {
    id: string;
    title: string;
    content: RecipeContent;
    state: string;
  },
>(recipes: T[], preferences: { avoid: string[]; prefer: string[] }): T[] {
  const avoid = new Set(preferences.avoid.map(normalizeIngredientKey));
  const prefer = new Set(preferences.prefer.map(normalizeIngredientKey));
  return recipes
    .filter((recipe) => recipe.state === "reviewed")
    .filter((recipe) =>
      !recipe.content.ingredients.some((ingredient) =>
        avoid.has(
          normalizeIngredientKey(ingredient.ingredientKey || ingredient.name),
        )
      )
    )
    .map((recipe) => ({
      recipe,
      score: recipe.content.ingredients.reduce(
        (sum, ingredient) =>
          sum +
          (prefer.has(
              normalizeIngredientKey(
                ingredient.ingredientKey || ingredient.name,
              ),
            )
            ? 1
            : 0),
        0,
      ),
    }))
    .sort((a, b) =>
      b.score - a.score || a.recipe.title.localeCompare(b.recipe.title) ||
      a.recipe.id.localeCompare(b.recipe.id)
    )
    .map(({ recipe }) => recipe);
}
