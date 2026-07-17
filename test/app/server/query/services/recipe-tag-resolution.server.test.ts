import { describe, expect, it } from "vitest";

import { resolveFoodComTags } from "../../../../../app/server/query/services/recipe-tag-resolution.server";

describe("resolveFoodComTags", () => {
  it("maps affordable language to the indexed inexpensive tag", () => {
    expect(resolveFoodComTags(["affordable budget recipes"], ["inexpensive", "quick"])).toEqual([
      "inexpensive",
    ]);
  });

  it("only returns terms in the Food.com catalog", () => {
    expect(resolveFoodComTags(["fantasy cuisine"], ["inexpensive"])).toEqual([]);
  });

  it("does not resolve a near-miss into a catalog tag", () => {
    expect(resolveFoodComTags(["vegetarain meals"], ["vegetarian", "vegan"])).toEqual([]);
  });

  it("maps dinner wording onto the Food.com main dish tag", () => {
    expect(resolveFoodComTags(
      ["What few pantry ingredients should I buy to unlock the most dinners?"],
      ["main dish", "dinner party", "inexpensive"],
    )).toEqual(["main dish"]);
  });
});
