import assert from "node:assert/strict";
import {
  applyRecipeVersion,
  MAX_RECIPE_CONTENT_JSON_BYTES,
  type RecipeContent,
  recipeContentFromMealie,
} from "./domain.ts";

function recipe(overrides: Partial<RecipeContent> = {}): RecipeContent {
  return {
    title: "Synthetic stew",
    servings: 4,
    ingredients: [{ name: "Crème brûlée", amount: 1, unit: "cup" }],
    instructions: ["Cook the synthetic ingredients."],
    ...overrides,
  };
}

function normalize(value: RecipeContent): RecipeContent {
  return applyRecipeVersion(value, value);
}

Deno.test("shared recipe normalization enforces the existing field boundaries", () => {
  const valid = normalize(recipe({
    servings: 500,
    ingredients: [{ name: "x".repeat(500), amount: 1, unit: "u".repeat(64) }],
    instructions: ["x".repeat(5000)],
  }));
  assert.equal(valid.servings, 500);
  assert.equal(valid.ingredients[0].unit?.length, 64);
  assert.equal(valid.ingredients[0].id, "ingredient-1");

  assert.throws(() => normalize(recipe({ servings: 501 })), /servings/);
  assert.throws(() =>
    normalize(recipe({
      ingredients: [{ name: "ingredient", amount: 1, unit: "u".repeat(65) }],
    })), /units/);
  assert.throws(() =>
    normalize(recipe({
      ingredients: [{ name: "x".repeat(501), amount: 1, unit: null }],
    })), /Ingredient names/);
  assert.throws(() =>
    normalize(recipe({
      instructions: ["x".repeat(5001)],
    })), /instruction/);
  assert.throws(() =>
    normalize(recipe({
      instructions: Array.from({ length: 501 }, () => "step"),
    })), /1–500 steps/);
  assert.throws(() => normalize(recipe({ title: "x".repeat(201) })), /title/);
});

Deno.test("normalized ingredient identities stay within limits at both import boundaries", () => {
  const ligatureName = "\ufb03".repeat(200);
  assert.equal(ligatureName.length, 200);
  assert.equal(ligatureName.normalize("NFKC").length, 600);

  assert.throws(() =>
    normalize(recipe({
      ingredients: [{ name: ligatureName, amount: 1, unit: null }],
    })), /Ingredient identities/);

  assert.throws(() =>
    recipeContentFromMealie({
      slug: "synthetic-ligature-recipe",
      name: "Synthetic ligature recipe",
      recipeServings: 4,
      recipeIngredient: [{
        quantity: 1,
        note: ligatureName,
        unit: null,
        food: { name: ligatureName },
      }],
      recipeInstructions: [{ text: "Prepare the synthetic recipe." }],
    }, true), /Ingredient identities/);
});

Deno.test("escaped and multibyte recipe text stays under the actual storage envelopes", () => {
  const escapedPattern = ["é", '"', "\\"].join("");
  const escapedMultibyteStep = `${escapedPattern.repeat(1666)}xy`;
  assert.equal(escapedMultibyteStep.length, 5000);
  const content = normalize(recipe({
    servings: 500,
    ingredients: [{ name: "Crème brûlée", amount: 1, unit: "cup" }],
    instructions: Array.from({ length: 99 }, () => escapedMultibyteStep),
  }));
  const contentBytes =
    new TextEncoder().encode(JSON.stringify(content)).byteLength;
  assert.ok(contentBytes <= MAX_RECIPE_CONTENT_JSON_BYTES);

  const operationId = "a".repeat(32);
  const capturedAt = "2026-11-09T12:34:56.789Z";
  const createEnvelope = {
    operationId,
    mealieId: "synthetic-mealie-recipe-" + "m".repeat(128),
    sourceKind: "manual",
    sourceUrl: null,
    content,
    capturedAt,
  };
  const versionEnvelope = {
    operationId,
    expectedRevision: 499,
    mealieId: "synthetic-mealie-recipe-" + "m".repeat(128),
    content,
  };
  const captureBytes =
    new TextEncoder().encode(JSON.stringify(createEnvelope)).byteLength;
  const versionBytes =
    new TextEncoder().encode(JSON.stringify(versionEnvelope)).byteLength;
  assert.ok(
    captureBytes < 1_048_576,
    `capture envelope is ${captureBytes} bytes`,
  );
  assert.ok(
    versionBytes < 1_048_576,
    `version envelope is ${versionBytes} bytes`,
  );
  assert.equal(content.ingredients[0].id, "ingredient-1");
  assert.equal(content.ingredients[0].ingredientKey, "crème brûlée");

  assert.throws(() =>
    normalize(recipe({
      instructions: Array.from({ length: 100 }, () => escapedMultibyteStep),
    })), /1,000,000-byte/);
  assert.throws(() =>
    normalize(recipe({
      instructions: Array.from({ length: 300 }, () => "x".repeat(4000)),
    })), /1,000,000-byte/);
});
