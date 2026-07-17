import { describe, expect, it } from "vitest";

import { dominantWeightedAverageColor } from "./item-wireframe-color";

function rgb(hex: number) {
  return {
    red: (hex >> 16) & 0xff,
    green: (hex >> 8) & 0xff,
    blue: hex & 0xff,
  };
}

describe("dominantWeightedAverageColor", () => {
  it("uses the weighted average from the dominant color group", () => {
    const color = dominantWeightedAverageColor({
      width: 4,
      height: 1,
      data: new Uint8ClampedArray([
        248, 20, 12, 255,
        236, 32, 20, 255,
        0, 180, 80, 255,
        0, 190, 88, 255,
      ]),
    });
    const result = rgb(color);

    expect(result.red).toBeGreaterThan(220);
    expect(result.green).toBeLessThan(50);
    expect(result.blue).toBeLessThan(40);
  });

  it("weights saturated pixels without ignoring neutral pixels", () => {
    const color = dominantWeightedAverageColor({
      width: 5,
      height: 1,
      data: new Uint8ClampedArray([
        240, 240, 240, 255,
        240, 240, 240, 255,
        240, 240, 240, 255,
        18, 98, 220, 255,
        24, 104, 212, 255,
      ]),
    });
    const result = rgb(color);

    expect(result.blue).toBeGreaterThan(result.red);
    expect(result.blue).toBeGreaterThan(result.green);
  });

  it("normalizes crop pixels against nearby lighting", () => {
    const color = dominantWeightedAverageColor(
      {
        width: 2,
        height: 1,
        data: new Uint8ClampedArray([
          150, 40, 140, 255,
          156, 44, 136, 255,
        ]),
      },
      {
        width: 3,
        height: 1,
        data: new Uint8ClampedArray([
          120, 120, 240, 255,
          126, 126, 236, 255,
          118, 118, 242, 255,
        ]),
      },
    );
    const result = rgb(color);

    expect(result.red).toBeGreaterThan(result.blue);
  });

  it("throws a specific error for empty visible crops", () => {
    expect(() => dominantWeightedAverageColor({
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([0, 0, 0, 0]),
    })).toThrow("Cannot derive item wireframe color because the crop has no visible pixels");
  });
});
