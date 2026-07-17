import { describe, expect, it } from "vitest";

import { resolveFoodComTags } from "./recipe-tag-resolution.server";

describe("resolveFoodComTags", () => {
  it("maps affordable language to the indexed inexpensive tag", () => {
    expect(resolveFoodComTags(["affordable budget recipes"], ["inexpensive", "quick"])).toEqual([
      "inexpensive",
    ]);
  });

  it("only returns terms in the Food.com catalog", () => {
    expect(resolveFoodComTags(["fantasy cuisine"], ["inexpensive"])).toEqual([]);
  });
});
