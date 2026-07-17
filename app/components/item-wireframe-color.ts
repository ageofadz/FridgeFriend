import type { InventoryItem } from "../server/scan/schemas/inventory";

type PixelBuffer = {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
};

type LightingSample = {
  red: number;
  green: number;
  blue: number;
  lightness: number;
};

type ColorGroup = {
  weight: number;
  red: number;
  green: number;
  blue: number;
};

export type VisualColorTarget = {
  itemId: string;
  imageId: string;
  boundingBox: InventoryItem["loc"]["observations"][number]["boundingBox"];
};

const HUE_GROUP_COUNT = 18;
const SATURATION_GROUP_COUNT = 4;
const LIGHTNESS_GROUP_COUNT = 5;
const TARGET_LOCAL_LIGHTNESS = 0.62;

function rgbToHsl(red: number, green: number, blue: number) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;

  if (max === min) {
    return { hue: 0, saturation: 0, lightness };
  }

  const delta = max - min;
  const saturation = lightness > 0.5
    ? delta / (2 - max - min)
    : delta / (max + min);
  const rawHue = max === r
    ? (g - b) / delta + (g < b ? 6 : 0)
    : max === g
      ? (b - r) / delta + 2
      : (r - g) / delta + 4;

  return { hue: rawHue / 6, saturation, lightness };
}

function hslToRgb(hue: number, saturation: number, lightness: number) {
  if (saturation === 0) {
    const value = Math.round(lightness * 255);
    return { red: value, green: value, blue: value };
  }

  const hueToRgb = (p: number, q: number, t: number) => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };
  const q = lightness < 0.5
    ? lightness * (1 + saturation)
    : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;

  return {
    red: Math.round(hueToRgb(p, q, hue + 1 / 3) * 255),
    green: Math.round(hueToRgb(p, q, hue) * 255),
    blue: Math.round(hueToRgb(p, q, hue - 1 / 3) * 255),
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function colorGroupKey(red: number, green: number, blue: number) {
  const { hue, saturation, lightness } = rgbToHsl(red, green, blue);

  if (saturation < 0.12) {
    return `neutral:${Math.min(
      LIGHTNESS_GROUP_COUNT - 1,
      Math.floor(lightness * LIGHTNESS_GROUP_COUNT),
    )}`;
  }

  return [
    Math.min(HUE_GROUP_COUNT - 1, Math.floor(hue * HUE_GROUP_COUNT)),
    Math.min(SATURATION_GROUP_COUNT - 1, Math.floor(saturation * SATURATION_GROUP_COUNT)),
    Math.min(LIGHTNESS_GROUP_COUNT - 1, Math.floor(lightness * LIGHTNESS_GROUP_COUNT)),
  ].join(":");
}

function pixelWeight(red: number, green: number, blue: number, alpha: number) {
  const { saturation, lightness } = rgbToHsl(red, green, blue);
  const midtoneWeight = 1 - Math.abs(lightness - 0.5) * 2;

  return (alpha / 255) * (0.35 + saturation * 0.65) * (0.7 + midtoneWeight * 0.3);
}

function lightingSampleWeight(red: number, green: number, blue: number, alpha: number) {
  const { saturation, lightness } = rgbToHsl(red, green, blue);
  const neutralWeight = 1 - saturation;
  const lightnessWeight = 1 - Math.abs(lightness - 0.62) / 0.62;

  return (alpha / 255) * Math.max(0.05, neutralWeight) * Math.max(0.05, lightnessWeight);
}

function localLightingSample(pixelBuffer: PixelBuffer) {
  const expectedLength = pixelBuffer.width * pixelBuffer.height * 4;

  if (pixelBuffer.data.length < expectedLength) {
    throw new Error(
      `Cannot derive item wireframe lighting because pixel data length ${pixelBuffer.data.length} is smaller than expected ${expectedLength}`,
    );
  }

  let weight = 0;
  let red = 0;
  let green = 0;
  let blue = 0;

  for (let index = 0; index < expectedLength; index += 4) {
    const alpha = pixelBuffer.data[index + 3];

    if (alpha === 0) {
      continue;
    }

    const pixelRed = pixelBuffer.data[index];
    const pixelGreen = pixelBuffer.data[index + 1];
    const pixelBlue = pixelBuffer.data[index + 2];
    const pixelWeight = lightingSampleWeight(pixelRed, pixelGreen, pixelBlue, alpha);
    weight += pixelWeight;
    red += pixelRed * pixelWeight;
    green += pixelGreen * pixelWeight;
    blue += pixelBlue * pixelWeight;
  }

  if (weight <= 0) {
    throw new Error("Cannot derive item wireframe lighting because the nearby sample has no visible pixels");
  }

  red /= weight;
  green /= weight;
  blue /= weight;

  return {
    red,
    green,
    blue,
    lightness: rgbToHsl(red, green, blue).lightness,
  };
}

function normalizePixelForLighting(
  red: number,
  green: number,
  blue: number,
  lighting: LightingSample | null,
) {
  if (!lighting) {
    return { red, green, blue };
  }

  const neutral = (lighting.red + lighting.green + lighting.blue) / 3;
  const exposure = clamp(TARGET_LOCAL_LIGHTNESS / Math.max(lighting.lightness, 0.08), 0.72, 1.42);

  return {
    red: clamp(red * clamp(neutral / Math.max(lighting.red, 1), 0.62, 1.62) * exposure, 0, 255),
    green: clamp(green * clamp(neutral / Math.max(lighting.green, 1), 0.62, 1.62) * exposure, 0, 255),
    blue: clamp(blue * clamp(neutral / Math.max(lighting.blue, 1), 0.62, 1.62) * exposure, 0, 255),
  };
}

function normalizeWireframeColor(red: number, green: number, blue: number) {
  const hsl = rgbToHsl(red, green, blue);
  const lightness = Math.min(0.64, Math.max(0.28, hsl.lightness));
  const saturation = hsl.saturation < 0.08
    ? hsl.saturation
    : Math.max(0.26, hsl.saturation);
  const normalized = hslToRgb(hsl.hue, saturation, lightness);

  return (
    (normalized.red << 16) |
    (normalized.green << 8) |
    normalized.blue
  );
}

export function dominantWeightedAverageColor(
  pixelBuffer: PixelBuffer,
  nearbyPixelBuffer?: PixelBuffer,
) {
  const expectedLength = pixelBuffer.width * pixelBuffer.height * 4;

  if (pixelBuffer.data.length < expectedLength) {
    throw new Error(
      `Cannot derive item wireframe color because pixel data length ${pixelBuffer.data.length} is smaller than expected ${expectedLength}`,
    );
  }

  const groups = new Map<string, ColorGroup>();
  const lighting = nearbyPixelBuffer
    ? localLightingSample(nearbyPixelBuffer)
    : null;

  for (let index = 0; index < expectedLength; index += 4) {
    const alpha = pixelBuffer.data[index + 3];

    if (alpha === 0) {
      continue;
    }

    const { red, green, blue } = normalizePixelForLighting(
      pixelBuffer.data[index],
      pixelBuffer.data[index + 1],
      pixelBuffer.data[index + 2],
      lighting,
    );
    const weight = pixelWeight(red, green, blue, alpha);
    const key = colorGroupKey(red, green, blue);
    const group = groups.get(key) ?? { weight: 0, red: 0, green: 0, blue: 0 };
    group.weight += weight;
    group.red += red * weight;
    group.green += green * weight;
    group.blue += blue * weight;
    groups.set(key, group);
  }

  const dominantGroup = [...groups.values()]
    .sort((left, right) => right.weight - left.weight)[0];

  if (!dominantGroup || dominantGroup.weight <= 0) {
    throw new Error("Cannot derive item wireframe color because the crop has no visible pixels");
  }

  return normalizeWireframeColor(
    dominantGroup.red / dominantGroup.weight,
    dominantGroup.green / dominantGroup.weight,
    dominantGroup.blue / dominantGroup.weight,
  );
}
