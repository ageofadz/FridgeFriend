import { describe, expect, it } from "vitest";

import {
  extractFoodComOpenGraphImage,
  foodComRecipeUrl,
} from "./food-com-embed.server";

describe("Food.com recipe embeds", () => {
  it("builds the canonical Food.com recipe link", () => {
    expect(foodComRecipeUrl("Strawberry & Greek Yogurt", "1234")).toBe(
      "https://www.food.com/recipe/strawberry-greek-yogurt-1234",
    );
  });

  it("extracts the recipe's published OpenGraph image", () => {
    expect(extractFoodComOpenGraphImage(
      '<meta name="og:image" content="https://geniuskitchen.sndimg.com/fdc-new/img/fdc-shareGraphic.png">',
      "https://www.food.com/recipe/example-1234",
    )).toBe("https://geniuskitchen.sndimg.com/fdc-new/img/fdc-shareGraphic.png");
  });

  it("reports the exact recipe when no OpenGraph image is published", () => {
    expect(() => extractFoodComOpenGraphImage(
      "<title>No image</title>",
      "https://www.food.com/recipe/example-1234",
    )).toThrow("Food.com recipe did not publish an OpenGraph image");
  });
});
