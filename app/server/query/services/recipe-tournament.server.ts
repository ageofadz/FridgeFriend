import type { RankedRecipe } from "./recipe-retrieval.server";

export const RECIPE_TOURNAMENT_DISPLAY_LIMIT = 3;

type RecipeTournamentScores = {
  nutrition: number;
  ingredientCoverage: number;
  difficulty: number;
  wasteReduction: number;
  preferenceMatch: number;
};

export type RecipeTournamentEvaluation = {
  recipeId: string;
  scores: RecipeTournamentScores | null;
  error: string | null;
};

type TournamentResult = {
  recipes: RankedRecipe[];
  error: string | null;
};

function compareRecipes(
  left: RankedRecipe & { tournamentScore: number },
  right: RankedRecipe & { tournamentScore: number },
) {
  return right.tournamentScore - left.tournamentScore ||
    right.score - left.score ||
    right.ingredientCoverage - left.ingredientCoverage ||
    left.id.localeCompare(right.id);
}

function score(scores: RecipeTournamentScores) {
  return scores.nutrition + scores.ingredientCoverage + scores.difficulty +
    scores.wasteReduction + scores.preferenceMatch;
}

export function rankEvaluatedRecipeTournament(
  candidates: RankedRecipe[],
  evaluations: RecipeTournamentEvaluation[],
  limit: number,
) {
  const evaluationsByRecipeId = new Map(evaluations.map((evaluation) => [evaluation.recipeId, evaluation]));

  return candidates.flatMap((candidate) => {
    const evaluation = evaluationsByRecipeId.get(candidate.id);

    if (!evaluation?.scores || evaluation.error) {
      return [];
    }

    return [{
      ...candidate,
      tournamentScore: score(evaluation.scores),
    }];
  }).sort(compareRecipes).slice(0, limit);
}

function nextPowerOfTwo(value: number) {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

export function resolveRecipeTournament(
  candidates: RankedRecipe[],
  evaluations: RecipeTournamentEvaluation[],
  limit = RECIPE_TOURNAMENT_DISPLAY_LIMIT,
): TournamentResult {
  const evaluationsByRecipeId = new Map(evaluations.map((evaluation) => [evaluation.recipeId, evaluation]));
  const scored = candidates.flatMap((candidate) => {
    const evaluation = evaluationsByRecipeId.get(candidate.id);

    if (!evaluation?.scores || evaluation.error) {
      return [];
    }

    return [{
      ...candidate,
      tournamentScore: score(evaluation.scores),
    }];
  }).sort(compareRecipes);

  if (scored.length === 0) {
    return {
      recipes: [],
      error: "Recipe tournament evaluation failed because no candidate received a valid score",
    };
  }
  const bracketSize = nextPowerOfTwo(scored.length);
  let round: Array<(typeof scored)[number] | null> = [
    ...scored,
    ...Array.from({ length: bracketSize - scored.length }, () => null),
  ];
  const eliminated: Array<(typeof scored)[number]> = [];

  while (round.length > 1) {
    const nextRound: Array<(typeof scored)[number] | null> = [];
    for (let index = 0; index < round.length; index += 2) {
      const left = round[index];
      const right = round[index + 1];
      if (!left) {
        nextRound.push(right);
      } else if (!right) {
        nextRound.push(left);
      } else if (compareRecipes(left, right) <= 0) {
        nextRound.push(left);
        eliminated.push(right);
      } else {
        nextRound.push(right);
        eliminated.push(left);
      }
    }
    round = nextRound;
  }

  const winner = round[0];
  if (!winner) {
    return { recipes: [], error: "Recipe tournament had no eligible candidates" };
  }

  const finalists = eliminated.sort(compareRecipes).slice(0, Math.max(0, limit - 1));
  return {
    recipes: [winner, ...finalists],
    error: null,
  };
}
