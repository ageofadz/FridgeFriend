import { describe, expect, it } from "vitest";

import {
  ConversationContextSchema,
  WorkspaceActionSchema,
  focusFromWorkspaceAction,
} from "../../../app/workspace/contracts";
import { assessFreshness } from "../../../app/workspace/freshness";

describe("workspace contracts", () => {
  it("uses empty selection context by default", () => {
    expect(ConversationContextSchema.parse({})).toEqual({
      selectedItemIds: [],
      selectedZoneIds: [],
      selectedRecipeId: null,
      seededItems: [],
      seededBoundingBoxes: [],
    });
  });

  it("validates user seeded inventory item context", () => {
    expect(ConversationContextSchema.parse({
      seededItems: [
        {
          itemId: "item-1",
          imageId: "image-1",
          cropId: "image-1:item-1:0",
        },
      ],
    })).toMatchObject({
      seededItems: [
        {
          itemId: "item-1",
          imageId: "image-1",
          cropId: "image-1:item-1:0",
          userSeeded: true,
        },
      ],
    });
  });

  it("validates user seeded bounding box context", () => {
    expect(ConversationContextSchema.parse({
      seededBoundingBoxes: [
        {
          imageId: "image-1",
          cropId: "user-drawn-bbox:image-1:box-1",
          boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        },
      ],
    })).toMatchObject({
      seededBoundingBoxes: [
        {
          imageId: "image-1",
          cropId: "user-drawn-bbox:image-1:box-1",
          boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
          userSeeded: true,
        },
      ],
    });
  });

  it("maps a grounded recipe action to a candidate focus", () => {
    const action = WorkspaceActionSchema.parse({
      type: "show_recipe_coverage",
      recipeId: "recipe-1",
      availableItemIds: ["item-1"],
      missingIngredients: ["cream"],
    });

    expect(focusFromWorkspaceAction(action)).toMatchObject({
      mode: "recipe",
      itemIds: ["item-1"],
      emphasis: "candidate",
    });
  });
});

describe("freshness assessment", () => {
  it("prefers an explicit observed date over the estimated window", () => {
    expect(assessFreshness({
      category: "meat",
      expirationDate: "2026-07-25",
      expirationDateSource: "observed",
    }, new Date("2026-07-17T00:00:00.000Z"))).toMatchObject({
      source: "observed_date",
      date: "2026-07-25",
      urgency: "fresh",
    });
  });

  it("uses the current date for category estimates", () => {
    expect(assessFreshness({ category: "leftovers" }, new Date("2026-07-17T00:00:00.000Z"))).toMatchObject({
      source: "estimated",
      date: "2026-07-20",
      urgency: "use_soon",
    });
  });

  it("labels legacy recorded dates and invalid dates without presenting estimates as confirmed", () => {
    expect(assessFreshness({
      category: "dairy",
      expirationDate: "2026-07-19",
    }, new Date("2026-07-17T00:00:00.000Z"))).toMatchObject({
      source: "recorded_date",
      confidence: "medium",
      urgency: "use_soon",
    });
    expect(assessFreshness({
      category: "meat",
      expirationDate: "not-a-date",
    }, new Date("2026-07-17T00:00:00.000Z"))).toMatchObject({
      source: "estimated",
      confidence: "low",
      date: "2026-07-19",
      dateIssue: "Recorded expiry date not-a-date is invalid.",
    });
  });
});
