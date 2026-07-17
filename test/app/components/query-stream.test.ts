import { describe, expect, it } from "vitest";

import {
  createQueryStreamParser,
  parseQueryStreamEvent,
  type QueryStreamEvent,
} from "../../../app/components/query-stream";
import { buildExpiryPlan } from "../../../app/server/query/services/expiry-plan.server";

describe("query stream parser", () => {
  it("parses split NDJSON chunks", () => {
    const events: QueryStreamEvent[] = [];
    const parser = createQueryStreamParser((event) => events.push(event));

    parser.push('{"type":"status","message":"Start"}\n{"type":"tok');
    parser.push('en","text":"Hel');
    parser.push('lo"}\n{"type":"final","answer":"Hello","intent":null,"recipes":[],"visualEvidence":[],"dietaryRestrictions":[],"dietaryPreferences":[]}\n');
    parser.close();

    expect(events).toEqual([
      { type: "status", message: "Start", node: undefined },
      { type: "token", text: "Hello" },
      { type: "final", answer: "Hello", intent: null, recipes: [], visualEvidence: [], dietaryRestrictions: [], dietaryPreferences: [] },
    ]);
  });

  it("throws on malformed stream events", () => {
    expect(() => parseQueryStreamEvent('{"type":"token"}')).toThrow(
      "Query stream event had invalid shape for token",
    );
    expect(() => parseQueryStreamEvent("not json")).toThrow(
      "Query stream event was not valid JSON",
    );
  });

  it("rejects final events with invalid dietary state", () => {
    expect(() => parseQueryStreamEvent('{"type":"final","answer":"Hello","intent":null,"recipes":[],"visualEvidence":[],"dietaryRestrictions":[{"subject":"peanuts"}],"dietaryPreferences":[]}')).toThrow(
      "Query stream event had invalid shape for final",
    );
  });

  it("accepts recipe tournament progress events", () => {
    const recipe = '{"id":"1","name":"Winner","description":null,"minutes":20,"matchedIngredients":["egg"],"missingIngredients":["bread"],"matchedTags":[],"matchBadges":[]}';

    expect(parseQueryStreamEvent('{"type":"recipe_tournament_started","candidateCount":20,"displaySlotCount":3}')).toEqual({
      type: "recipe_tournament_started",
      candidateCount: 20,
      displaySlotCount: 3,
    });
    expect(parseQueryStreamEvent(`{"type":"recipe_tournament_update","recipes":[${recipe}],"evaluatedCount":1,"totalCount":20,"droppedRecipeIds":["2"]}`)).toEqual({
      type: "recipe_tournament_update",
      recipes: [{
        id: "1",
        name: "Winner",
        description: null,
        minutes: 20,
        matchedIngredients: ["egg"],
        missingIngredients: ["bread"],
        matchedTags: [],
        matchBadges: [],
      }],
      evaluatedCount: 1,
      totalCount: 20,
      droppedRecipeIds: ["2"],
    });
    expect(parseQueryStreamEvent(`{"type":"recipe_tournament_finished","recipes":[${recipe}]}`)).toMatchObject({
      type: "recipe_tournament_finished",
      recipes: [{ id: "1" }],
    });
  });

  it("accepts inventory clarification events", () => {
    expect(parseQueryStreamEvent('{"type":"clarification","questions":[{"itemId":"item-1","field":"opened","question":"Is the chicken opened?"}]}')).toEqual({
      type: "clarification",
      questions: [{ itemId: "item-1", field: "opened", question: "Is the chicken opened?" }],
    });
  });

  it("accepts saved kitchen organization plans", () => {
    const plan = {
      id: "plan-1",
      requestId: "request-1",
      userId: "user-1",
      fridgeId: "fridge-1",
      imageId: "image-1",
      inventoryFingerprint: "fingerprint",
      priority: "placement_correction",
      status: "pending",
      summary: "Move milk from back to front.",
      moves: [{ itemId: "milk", fromZoneId: "back", toZoneId: "front", rationale: "User correction: move to the selected zone." }],
      createdAt: "2026-07-17T00:00:00.000Z",
      completedAt: null,
    };

    expect(parseQueryStreamEvent(JSON.stringify({ type: "organization_plan", plan }))).toEqual({ type: "organization_plan", plan });
  });

  it("accepts expiry plans with source and confidence evidence", () => {
    const plan = {
      items: [{ id: "milk", visibleItemId: "milk", name: "Milk", ingredientName: "milk", storageLocation: "fridge", urgency: "urgent", source: "observed_date", confidence: "medium", date: "2026-07-18", label: "Use by 2026-07-18", dateIssue: null, wasteScore: 0.8 }],
      priorityItems: [{ id: "milk", visibleItemId: "milk", name: "Milk", ingredientName: "milk", storageLocation: "fridge", urgency: "urgent", source: "observed_date", confidence: "medium", date: "2026-07-18", label: "Use by 2026-07-18", dateIssue: null, wasteScore: 0.8 }],
      expiredItems: [],
    };

    expect(parseQueryStreamEvent(JSON.stringify({ type: "expiry_plan", plan }))).toEqual({ type: "expiry_plan", plan });
  });

  it("accepts serialized expiry plans built by the query service", () => {
    const plan = buildExpiryPlan({
      scannedItems: [
        {
          id: "eggs-1",
          displayName: "Eggs",
          canonicalName: "eggs",
          category: "eggs",
          subcategory: null,
          location: { zoneType: "shelf" },
          attributes: {
            opened: null,
            expirationDate: null,
            expirationDateSource: null,
          },
        },
      ],
      householdItems: [
        {
          id: "rice-1",
          name: "Jasmine rice",
          canonicalName: "jasmine rice",
          storageLocation: "pantry",
          status: "available",
          expirationDate: "not-a-date",
        },
      ],
      now: new Date("2026-07-17T00:00:00.000Z"),
    });
    const event = parseQueryStreamEvent(JSON.stringify({
      type: "expiry_plan",
      plan,
    }));

    expect(event).toEqual({ type: "expiry_plan", plan });
  });

  it("accepts a complete grocery plan stream event", () => {
    expect(parseQueryStreamEvent(JSON.stringify({
      type: "grocery_plan",
      plan: {
        recipes: ["one", "two", "three"].map((id) => ({
          id,
          name: `Recipe ${id}`,
          description: null,
          minutes: 20,
          matchedIngredients: ["chicken"],
          missingIngredients: ["garlic"],
          matchedTags: ["dinner"],
          matchBadges: [],
        })),
        items: [{ ingredient: "garlic", aisle: "produce", recipeIds: ["one", "two", "three"], recipeNames: ["Recipe one", "Recipe two", "Recipe three"] }],
      },
    }))).toMatchObject({ type: "grocery_plan", plan: { items: [{ ingredient: "garlic", aisle: "produce" }] } });
  });

  it("accepts a complete smart pantry completion stream event", () => {
    expect(parseQueryStreamEvent(JSON.stringify({
      type: "pantry_completion",
      plan: {
        eligibleRecipeCount: 20,
        unlockedRecipeCount: 4,
        unlockedRecipes: [
          { id: "one", name: "Recipe one", suggestedIngredients: ["garlic"] },
          { id: "two", name: "Recipe two", suggestedIngredients: ["garlic"] },
        ],
        suggestions: [{
          ingredient: "garlic",
          aisle: "produce",
          recipeIds: ["one", "two"],
          recipeNames: ["Recipe one", "Recipe two"],
          supportingRecipeCount: 2,
        }],
      },
    }))).toMatchObject({ type: "pantry_completion", plan: { unlockedRecipeCount: 4 } });
  });

  it("rejects an invalid smart pantry completion plan", () => {
    expect(() => parseQueryStreamEvent('{"type":"pantry_completion","plan":{"eligibleRecipeCount":20,"unlockedRecipeCount":0,"suggestions":[]}}')).toThrow(
      "Query stream event had invalid shape for pantry_completion",
    );
  });

  it("rejects expiry plan items with non-finite scores", () => {
    expect(() => parseQueryStreamEvent('{"type":"expiry_plan","plan":{"items":[{"id":"milk","visibleItemId":"milk","name":"Milk","ingredientName":"milk","storageLocation":"fridge","urgency":"urgent","source":"observed_date","confidence":"medium","date":"2026-07-18","label":"Use by 2026-07-18","dateIssue":null,"wasteScore":1e999}],"priorityItems":[],"expiredItems":[]}}')).toThrow(
      "Query stream event had invalid shape for expiry_plan",
    );
  });

  it("accepts inventory split review events", () => {
    expect(parseQueryStreamEvent('{"type":"inventory_split_review","scopeLabel":"Top-left shelf","summary":"Visible produce in the selected area.","items":[{"name":"carrot","label":"Carrots"}]}')).toEqual({
      type: "inventory_split_review",
      scopeLabel: "Top-left shelf",
      summary: "Visible produce in the selected area.",
      items: [{ name: "carrot", label: "Carrots" }],
    });
  });

  it("accepts inventory mutation review events", () => {
    expect(parseQueryStreamEvent('{"type":"inventory_mutation_review","operation":"remove","itemName":"cheese","storageLocation":"fridge"}')).toEqual({
      type: "inventory_mutation_review",
      operation: "remove",
      itemName: "cheese",
      storageLocation: "fridge",
    });
  });

  it("accepts inventory updated events", () => {
    expect(parseQueryStreamEvent('{"type":"inventory_updated","inventory":{"id":"inventory-1","items":[]}}')).toEqual({
      type: "inventory_updated",
      inventory: {
        id: "inventory-1",
        items: [],
      },
    });
  });
});
