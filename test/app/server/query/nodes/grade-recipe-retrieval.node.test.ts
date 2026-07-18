import { ChatPromptTemplate } from "@langchain/core/prompts";
import { describe, expect, it } from "vitest";

import { createGradeRecipeRetrievalNode } from "../../../../../app/server/query/nodes/grade-recipe-retrieval.node";
import type { FridgeQueryStateValue } from "../../../../../app/server/query/state";

describe("grade recipe retrieval node", () => {
  it("does not erase nonempty candidates after an irrelevant corrective grade", async () => {
    const node = createGradeRecipeRetrievalNode({
      promptBundle: {
        recipeRetrievalGrade: {
          name: "recipe-retrieval-grade",
          ref: "test:latest",
          prompt: ChatPromptTemplate.fromMessages([["human", "{{recipe_retrieval_context_json}}"]]),
        },
      } as never,
      recipeRetrievalGradeModel: {
        withStructuredOutput: () => ({
          invoke: async () => ({ relevant: false, reason: "The corrected set is still broad." }),
        }),
      } as never,
    });
    const state = {
      userId: "user-1",
      fridgeId: "fridge-1",
      imageId: "image-1",
      query: "What can I make?",
      recipeSearch: { semanticQuery: "recipe using egg rice", correctiveAttempt: true },
      tournamentCandidates: [{
        id: "egg-rice",
        name: "Egg Rice",
        description: null,
        ingredients: ["egg", "rice"],
        matchedTags: [],
        minutes: 15,
        semanticScore: 0.4,
        ingredientCoverage: 1,
        missingIngredients: [],
      }],
      recipeRewriteCount: 1,
      context: {
        recipeRetrieval: {
          recipes: [{ id: "egg-rice" }],
          noMatches: false,
        },
      },
    } as unknown as FridgeQueryStateValue;

    await expect(node(state)).resolves.toEqual({
      recipeRetrievalGrade: { relevant: false, reason: "The corrected set is still broad." },
    });
  });
});
