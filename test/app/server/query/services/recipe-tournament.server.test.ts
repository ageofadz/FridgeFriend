import { describe, expect, it } from "vitest";

import type { RankedRecipe } from "../../../../../app/server/query/services/recipe-retrieval.server";
import {
  resolveRecipeTournament,
  type RecipeTournamentEvaluation,
} from "../../../../../app/server/query/services/recipe-tournament.server";

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
  it("resolves a seeded twenty-entry bracket into three ranked recipes", () => {
    const candidates = Array.from({ length: 20 }, (_, index) => recipe(String(index + 1), 1 - index / 100));
    const result = resolveRecipeTournament(candidates, candidates.map((candidate, index) => evaluation(candidate.id, 20 - index)));

    expect(result.error).toBeNull();
    expect(result.recipes).toHaveLength(3);
    expect(result.recipes.map((candidate) => candidate.id)).toEqual(["1", "2", "3"]);
  });

  it("uses deterministic ranking evidence to break equal worker scores", () => {
    const result = resolveRecipeTournament(
      [recipe("a", 0.7), recipe("b", 0.9)],
      [evaluation("a", 8), evaluation("b", 8)],
    );

    expect(result.recipes[0]).toMatchObject({ id: "b" });
  });

  it("drops failed evaluations and resolves the bracket over the remaining candidates", () => {
    const result = resolveRecipeTournament(
      [recipe("a"), recipe("b")],
      [evaluation("a", 8), { recipeId: "b", scores: null, error: "invalid output" }],
    );

    expect(result.error).toBeNull();
    expect(result.recipes).toEqual([expect.objectContaining({ id: "a" })]);
  });

  it("still resolves a twenty-entry bracket when one evaluation fails", () => {
    const candidates = Array.from({ length: 20 }, (_, index) => recipe(String(index + 1), 1 - index / 100));
    const evaluations = candidates.map((candidate, index) =>
      candidate.id === "1"
        ? { recipeId: candidate.id, scores: null, error: "worker crashed" }
        : evaluation(candidate.id, 20 - index),
    );
    const result = resolveRecipeTournament(candidates, evaluations);

    expect(result.error).toBeNull();
    expect(result.recipes).toHaveLength(3);
    expect(result.recipes.some((candidate) => candidate.id === "1")).toBe(false);
    expect(result.recipes[0]).toMatchObject({ id: "2" });
  });

  it("ignores candidates whose evaluations never arrived", () => {
    const result = resolveRecipeTournament(
      [recipe("a"), recipe("b"), recipe("c")],
      [evaluation("b", 6), evaluation("c", 9)],
    );

    expect(result.error).toBeNull();
    expect(result.recipes.map((candidate) => candidate.id)).toEqual(["c", "b"]);
  });

  it("fails only when no candidate has a valid score", () => {
    const result = resolveRecipeTournament(
      [recipe("a"), recipe("b")],
      [
        { recipeId: "a", scores: null, error: "invalid output" },
        { recipeId: "b", scores: null, error: "timeout" },
      ],
    );

    expect(result.recipes).toEqual([]);
    expect(result.error).toBe("Recipe tournament evaluation failed because no candidate received a valid score");
  });
});
