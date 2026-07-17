import { describe, expect, it } from "vitest";

import {
  createQueryStreamParser,
  parseQueryStreamEvent,
  type QueryStreamEvent,
} from "./query-stream";
import { buildExpiryPlan } from "../server/query/services/expiry-plan.server";

describe("query stream parser", () => {
  it("parses split NDJSON chunks", () => {
    const events: QueryStreamEvent[] = [];
    const parser = createQueryStreamParser((event) => events.push(event));

    parser.push('{"type":"status","message":"Start"}\n{"type":"tok');
    parser.push('en","text":"Hel');
    parser.push('lo"}\n{"type":"final","answer":"Hello","intent":null,"recipes":[],"visualEvidence":[]}\n');
    parser.close();

    expect(events).toEqual([
      { type: "status", message: "Start", node: undefined },
      { type: "token", text: "Hello" },
      { type: "final", answer: "Hello", intent: null, recipes: [], visualEvidence: [], workspaceActions: [], agentEvents: [] },
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

  it("accepts recipe tournament placement on streamed cards", () => {
    const event = parseQueryStreamEvent('{"type":"final","answer":"Hello","intent":"recipe","recipes":[{"id":"1","name":"Winner","description":null,"minutes":20,"matchedIngredients":[],"missingIngredients":[],"matchedTags":[],"matchBadges":[],"tournamentPlacement":"winner"}],"visualEvidence":[]}');

    expect(event).toMatchObject({
      type: "final",
      recipes: [{ id: "1", tournamentPlacement: "winner" }],
    });
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

  it("rejects expiry plan items with non-finite scores", () => {
    expect(() => parseQueryStreamEvent('{"type":"expiry_plan","plan":{"items":[{"id":"milk","visibleItemId":"milk","name":"Milk","ingredientName":"milk","storageLocation":"fridge","urgency":"urgent","source":"observed_date","confidence":"medium","date":"2026-07-18","label":"Use by 2026-07-18","dateIssue":null,"wasteScore":1e999}],"priorityItems":[],"expiredItems":[]}}')).toThrow(
      "Query stream event had invalid shape for expiry_plan",
    );
  });

  it("accepts inventory split review events", () => {
    expect(parseQueryStreamEvent('{"type":"inventory_split_review","zoneId":"drawer-1","summary":"Visible produce in the drawer.","items":[{"name":"carrot","label":"Carrots"}]}')).toEqual({
      type: "inventory_split_review",
      zoneId: "drawer-1",
      summary: "Visible produce in the drawer.",
      items: [{ name: "carrot", label: "Carrots" }],
    });
  });
});
