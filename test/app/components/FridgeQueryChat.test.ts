import { describe, expect, it } from "vitest";

import { CHATBOX_EXAMPLE_PROMPTS, finalAssistantMessageText, groceryPlanCsv, hasAssistantResponseContent, loadingFoodEmojis, organizationPlanArtifactCopy, withoutHitlLoadingState, withoutQueryFailureState } from "../../../app/components/FridgeQueryChat";

describe("chatbox example prompts", () => {
  it("keeps the suggestion set in the requested range with ellipsis endings", () => {
    expect(CHATBOX_EXAMPLE_PROMPTS.length).toBeGreaterThanOrEqual(8);
    expect(CHATBOX_EXAMPLE_PROMPTS.length).toBeLessThanOrEqual(15);
    expect(new Set(CHATBOX_EXAMPLE_PROMPTS).size).toBe(CHATBOX_EXAMPLE_PROMPTS.length);
    expect(CHATBOX_EXAMPLE_PROMPTS.every((prompt) => prompt.endsWith("..."))).toBe(true);
  });
});

describe("grocery plan CSV", () => {
  it("exports aisle, ingredient, recipe references, and completion state with RFC 4180 escaping", () => {
    const csv = groceryPlanCsv({
      recipes: ["one", "two", "three"].map((id) => ({
        id,
        name: `Recipe ${id}`,
        description: null,
        minutes: 20,
        matchedIngredients: [],
        missingIngredients: [],
        matchedTags: [],
        matchBadges: [],
      })),
      items: [{
        ingredient: "chef's \"special\" sauce",
        aisle: "condiments_spices",
        recipeIds: ["one"],
        recipeNames: ["Recipe one, deluxe"],
      }],
    }, new Set(["chef's \"special\" sauce"]));

    expect(csv).toBe(
      '"Aisle","Ingredient","Recipes","Completed"\r\n"Condiments & Spices","chef\'s ""special"" sauce","Recipe one, deluxe","true"\r\n',
    );
  });
});

describe("chat loading foods", () => {
  it("keeps the requested sequence for unrestricted users", () => {
    expect(loadingFoodEmojis([], [])).toEqual(["🌽", "🥚", "🍌", "🥩", "🧃", "🍞", "🍒", "🍓", "🥦", "🥬", "🍤", "🥜"]);
  });

  it("filters vegetarian, vegan, and allergy foods from durable dietary state", () => {
    const restriction = (subject: string, restrictionType: "allergy" | "other" = "other") => ({
      id: `${restrictionType}-${subject}`,
      userId: "user-1",
      restrictionType,
      subject,
      severity: "strict_avoid" as const,
      notes: null,
      source: "user_explicit",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    });

    expect(loadingFoodEmojis([restriction("vegetarian")], [])).not.toContain("🥩");
    expect(loadingFoodEmojis([restriction("vegetarian")], [])).not.toContain("🍤");
    expect(loadingFoodEmojis([restriction("vegan"), restriction("peanuts", "allergy"), restriction("shellfish", "allergy")], [])).toEqual(["🌽", "🍌", "🧃", "🍞", "🍒", "🍓", "🥦", "🥬"]);
  });

  it("recognizes positive dietary preferences without treating avoidances as diets", () => {
    const preference = (sentiment: "like" | "avoid") => ({
      id: sentiment,
      userId: "user-1",
      subject: "vegan",
      sentiment,
      strength: 5,
      notes: null,
      source: "user_explicit",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    });

    expect(loadingFoodEmojis([], [preference("like")])).not.toContain("🥚");
    expect(loadingFoodEmojis([], [preference("avoid")])).toContain("🥚");
  });
});

describe("chat loading visibility", () => {
  it("treats streamed text as response content so the food loader can unmount", () => {
    expect(hasAssistantResponseContent({
      id: "assistant-1",
      role: "assistant",
      text: "Use the spinach first.",
      statusLines: ["respond: Generating response."],
      streaming: true,
    })).toBe(true);
  });

  it("does not treat status-only messages as response content", () => {
    expect(hasAssistantResponseContent({
      id: "assistant-1",
      role: "assistant",
      text: "",
      statusLines: ["load_context: Loading query context."],
      streaming: true,
    })).toBe(false);
  });

  it("treats a pantry completion clarification as actionable assistant content", () => {
    expect(hasAssistantResponseContent({
      id: "assistant-1",
      role: "assistant",
      text: "",
      pantryCompletionClarification: "Try broadening the recipe category or adding more pantry items.",
      streaming: false,
    })).toBe(true);
  });

  it("removes the status-only loading state when a HITL prompt appears", () => {
    const message = withoutHitlLoadingState({
      id: "assistant-1",
      role: "assistant",
      text: "",
      statusLines: ["persist_memory: Requesting inventory update review."],
      streaming: true,
    });

    expect(message).toEqual({
      id: "assistant-1",
      role: "assistant",
      text: "",
      statusLines: undefined,
      streaming: false,
    });
    expect(hasAssistantResponseContent(message)).toBe(false);
  });

  it("clears query loading state without turning an internal failure into chat content", () => {
    const message = withoutQueryFailureState({
      id: "assistant-1",
      role: "assistant",
      text: "",
      statusLines: ["respond: Generating response."],
      streaming: true,
      groceryPlanPending: true,
      groceryPlanStage: "building_list",
      pantryCompletionPending: true,
      pantryCompletionStage: "assigning_aisles",
    });

    expect(message).toMatchObject({
      text: "",
      statusLines: undefined,
      streaming: false,
      groceryPlanPending: false,
      groceryPlanStage: undefined,
      pantryCompletionPending: false,
      pantryCompletionStage: undefined,
    });
    expect(hasAssistantResponseContent(message)).toBe(false);
  });
});

describe("final assistant message text", () => {
  it("keeps the assistant answer when a grocery plan is attached", () => {
    const recipe = (id: string) => ({
      id,
      name: `Recipe ${id}`,
      description: null,
      minutes: 20,
      matchedIngredients: [],
      missingIngredients: [],
      matchedTags: [],
      matchBadges: [],
    });

    expect(finalAssistantMessageText("", {
      type: "final",
      answer: "I made a grocery plan from the selected meals.",
      intent: "shopping",
      recipes: [],
      groceryPlan: {
        recipes: [recipe("one"), recipe("two"), recipe("three")],
        items: [{
          ingredient: "garlic",
          aisle: "produce",
          recipeIds: ["one"],
          recipeNames: ["Recipe one"],
        }],
      },
      visualEvidence: [],
      dietaryRestrictions: [],
      dietaryPreferences: [],
      activeGoals: [],
    })).toBe("I made a grocery plan from the selected meals.");
  });
});

describe("organization artifact copy", () => {
  it("uses correction-specific labels for placement correction plans", () => {
    expect(organizationPlanArtifactCopy({
      id: "plan-1",
      requestId: "request-1",
      userId: "user-1",
      fridgeId: "fridge-1",
      imageId: "image-1",
      inventoryFingerprint: "fingerprint",
      priority: "placement_correction",
      status: "pending",
      summary: "Move yogurt from Top shelf to Middle shelf.",
      moves: [{ itemId: "item-1", fromZoneId: "top", toZoneId: "middle", rationale: "User correction: move down." }],
      createdAt: "2026-07-17T00:00:00.000Z",
      completedAt: null,
    })).toEqual({
      ariaLabel: "Inventory correction",
      title: "Inventory correction",
      applyLabel: "Apply correction",
      rejectLabel: "Keep current placement",
    });
  });
});
