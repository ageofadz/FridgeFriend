import { describe, expect, it } from "vitest";

import {
  fuzzyCanonicalIngredientName,
  fuzzyDeduplicateIngredientNames,
  ingredientNamesAreSimilar,
  preferredIngredientName,
} from "../../../../../app/server/query/services/ingredient-string-match.server";

describe("ingredient string matching", () => {
  it("matches close grocery ingredient variants", () => {
    expect(ingredientNamesAreSimilar("corn tortillas", "tortillas")).toBe(true);
    expect(preferredIngredientName("corn tortillas", "tortillas")).toBe("tortilla");
  });

  it("does not treat a single leading ingredient as equivalent to a compound item", () => {
    expect(ingredientNamesAreSimilar("blackberry", "blackberry jam")).toBe(false);
  });

  it("does not merge distinct numbered placeholders by edit distance", () => {
    expect(ingredientNamesAreSimilar("specific item 0", "specific item 1")).toBe(false);
    expect(fuzzyDeduplicateIngredientNames(["specific item 0", "specific item 1"])).toEqual([
      "specific item 0",
      "specific item 1",
    ]);
  });

  it("does not let universal basics satisfy specific produce names in availability checks", () => {
    expect(ingredientNamesAreSimilar("pepper", "bell pepper")).toBe(false);
  });

  it("can merge overlapping universal basics for grocery row grouping", () => {
    expect(ingredientNamesAreSimilar("salt", "salt and pepper", { allowUniversalBasicOverlap: true })).toBe(true);
    expect(preferredIngredientName("salt", "salt and pepper")).toBe("salt");
  });

  it("does not merge produce peppers with seasoning pepper", () => {
    expect(ingredientNamesAreSimilar("pepper", "bell pepper", { allowUniversalBasicOverlap: true })).toBe(false);
    expect(ingredientNamesAreSimilar("black pepper", "bell pepper", { allowUniversalBasicOverlap: true })).toBe(false);
  });

  it("deduplicates fuzzy ingredient lists with preferred display names", () => {
    expect(fuzzyDeduplicateIngredientNames(
      ["corn tortillas", "tortillas", "salt and pepper", "salt"],
      { allowUniversalBasicOverlap: true },
    )).toEqual(["tortilla", "salt"]);
  });

  it("canonicalizes one ingredient against a fuzzy name set", () => {
    expect(fuzzyCanonicalIngredientName(
      "corn tortillas",
      ["tortilla"],
      { allowUniversalBasicOverlap: true },
    )).toBe("tortilla");
  });
});
