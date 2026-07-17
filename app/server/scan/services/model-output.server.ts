import { BoundingBox } from "../schemas/inventory";

const GEMINI_BOX_GRID_SIZE = 1000;

type ModelBoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function formatModelValidationError(error: unknown, rootPath: string) {
  const issues =
    typeof error === "object" &&
    error !== null &&
    "issues" in error &&
    Array.isArray(error.issues)
      ? error.issues
      : [];

  if (issues.length === 0) {
    return error instanceof Error ? error.message : String(error);
  }

  return issues
    .map((issue) => {
      const pathParts = Array.isArray(issue.path) ? issue.path : [];
      const path = [rootPath, ...pathParts].join(".");
      const message =
        typeof issue.message === "string" ? issue.message : "Invalid value";
      return path ? `${path}: ${message}` : message;
    })
    .join("; ");
}

function normalizeGeminiBoxValue(value: number) {
  return value / GEMINI_BOX_GRID_SIZE;
}

function normalizeGeminiBoxAxis(start: number, extentOrEnd: number) {
  if (start + extentOrEnd <= GEMINI_BOX_GRID_SIZE) {
    return {
      start: normalizeGeminiBoxValue(start),
      size: normalizeGeminiBoxValue(extentOrEnd),
    };
  }

  if (extentOrEnd >= start) {
    return {
      start: normalizeGeminiBoxValue(start),
      size: normalizeGeminiBoxValue(extentOrEnd - start),
    };
  }

  return {
    start: normalizeGeminiBoxValue(start),
    size: normalizeGeminiBoxValue(GEMINI_BOX_GRID_SIZE - start),
  };
}

export function normalizeModelBoundingBox<TBox extends ModelBoundingBox>(
  bbox: TBox,
) {
  if (BoundingBox.safeParse(bbox).success) {
    return bbox;
  }

  const values = [
    bbox.x,
    bbox.y,
    bbox.width,
    bbox.height,
  ];
  const isGeminiGridBox = values.every(
    (value) => value >= 0 && value <= GEMINI_BOX_GRID_SIZE,
  );

  if (!isGeminiGridBox) {
    return bbox;
  }

  const horizontal = normalizeGeminiBoxAxis(bbox.x, bbox.width);
  const vertical = normalizeGeminiBoxAxis(bbox.y, bbox.height);

  return {
    x: horizontal.start,
    y: vertical.start,
    width: horizontal.size,
    height: vertical.size,
  };
}
