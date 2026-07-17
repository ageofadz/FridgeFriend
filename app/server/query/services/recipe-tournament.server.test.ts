import { describe, expect, it } from "vitest";

import type { RankedRecipe } from "./recipe-retrieval.server";
import {
  resolveRecipeTournament,
  type RecipeTournamentEvaluation,
} from "./recipe-tournament.server";

function recipe(id: string, score = 0.5): RankedRecipe {
  return {
    id,
    name: `Recipe ${id}`,
    description: null,
    minutes: 20,
    calories: 400,
    proteinDailyValue: 20,
    ingredients: ["chicken"],
    matchedIngredients: ["chicken"],
    missingIngredients: [],
    matchedTags: ["dinner"],
    matchBadges: [],
    ingredientCoverage: 1,
    expiringCoverage: 0,
    wasteReductionScore: 0,
    usesSoonIngredients: [],
    semanticScore: score,
    tagScore: 0,
    preferenceScore: 0,
    ratingScore: 0,
    eligibilityBand: "strict",
    score,
  };
}

function evaluation(recipeId: string, value: number): RecipeTournamentEvaluation {
  return {
    recipeId,
    scores: {
      nutrition: value,
      ingredientCoverage: value,
      difficulty: value,
      wasteReduction: value,
      preferenceMatch: value,
    },
    error: null,
  };
}

describe("recipe tournament", () => {
  it("resolves a seeded twenty-entry bracket into a champion and two finalists", () => {
    const candidates = Array.from({ length: 20 }, (_, index) => recipe(String(index + 1), 1 - index / 100));
    const result = resolveRecipeTournament(candidates, candidates.map((candidate, index) => evaluation(candidate.id, 20 - index)));

    expect(result.error).toBeNull();
    expect(result.recipes).toHaveLength(3);
    expect(result.recipes[0]).toMatchObject({ id: "1", tournamentPlacement: "winner" });
    expect(result.recipes.slice(1).every((candidate) => candidate.tournamentPlacement === "finalist")).toBe(true);
  });

  it("uses deterministic ranking evidence to break equal worker scores", () => {
    const result = resolveRecipeTournament(
      [recipe("a", 0.7), recipe("b", 0.9)],
      [evaluation("a", 8), evaluation("b", 8)],
    );

    expect(result.recipes[0]).toMatchObject({ id: "b", tournamentPlacement: "winner" });
  });

  it("returns a specific failure instead of selecting a deterministic fallback", () => {
    const result = resolveRecipeTournament(
      [recipe("a"), recipe("b")],
      [evaluation("a", 8), { recipeId: "b", scores: null, error: "invalid output" }],
    );

    expect(result.recipes).toEqual([]);
    expect(result.error).toBe("Recipe tournament evaluation failed for b: invalid output");
  });
});
