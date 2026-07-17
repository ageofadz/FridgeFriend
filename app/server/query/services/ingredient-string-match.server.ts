import { normalizeIngredientName } from "../../recipes/normalization";
import { isUniversalBasicIngredient } from "../../recipes/pantry-basics";

function words(value: string) {
  return normalizeIngredientName(value).split(" ").filter(Boolean);
}

function levenshteinDistance(left: string, right: string) {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  const previous = Array.from({ length: right.length + 1 }, (_entry, index) => index);
  const current = new Array<number>(right.length + 1);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + cost,
      );
    }

    for (let index = 0; index < previous.length; index += 1) {
      previous[index] = current[index] ?? 0;
    }
  }

  return previous[right.length] ?? 0;
}

function normalizedDistance(left: string, right: string) {
  return levenshteinDistance(left, right) / Math.max(left.length, right.length, 1);
}

function containsAsPhrase(longer: string, shorter: string) {
  return longer === shorter ||
    longer.startsWith(`${shorter} `) ||
    longer.endsWith(` ${shorter}`) ||
    longer.includes(` ${shorter} `);
}

function tokenOverlap(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return left.filter((word) => rightSet.has(word)).length;
}

export function ingredientNamesAreSimilar(
  leftInput: string,
  rightInput: string,
  options: { allowUniversalBasicOverlap?: boolean } = {},
) {
  const left = normalizeIngredientName(leftInput);
  const right = normalizeIngredientName(rightInput);

  if (!left || !right) return false;
  if (left === right) return true;
  if (/\d/u.test(left) || /\d/u.test(right)) return false;
  if (normalizedDistance(left, right) <= 0.25) return true;

  const leftWords = words(left);
  const rightWords = words(right);
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  const shorterWords = left.length <= right.length ? leftWords : rightWords;

  if (shorterWords.length >= 2 && containsAsPhrase(longer, shorter)) {
    return true;
  }

  if (
    shorterWords.length === 1 &&
    !isUniversalBasicIngredient(shorter) &&
    longer.endsWith(` ${shorter}`)
  ) {
    return true;
  }

  if (
    options.allowUniversalBasicOverlap === true &&
    isUniversalBasicIngredient(left) &&
    isUniversalBasicIngredient(right) &&
    tokenOverlap(leftWords, rightWords) > 0
  ) {
    return true;
  }

  return false;
}

export function preferredIngredientName(leftInput: string, rightInput: string) {
  const left = normalizeIngredientName(leftInput);
  const right = normalizeIngredientName(rightInput);

  if (!left) return right;
  if (!right) return left;
  if (left === right) return left;

  const leftWords = words(left);
  const rightWords = words(right);

  if (isUniversalBasicIngredient(left) || isUniversalBasicIngredient(right)) {
    return left.length <= right.length ? left : right;
  }

  if (containsAsPhrase(right, left) && leftWords.length <= rightWords.length) {
    return left;
  }

  if (containsAsPhrase(left, right) && rightWords.length <= leftWords.length) {
    return right;
  }

  return left.length <= right.length ? left : right;
}

export function fuzzyDeduplicateIngredientNames(
  values: string[],
  options: { allowUniversalBasicOverlap?: boolean } = {},
) {
  const deduped: string[] = [];

  for (const value of values) {
    const normalized = normalizeIngredientName(value);
    if (!normalized) continue;

    const index = deduped.findIndex((existing) =>
      ingredientNamesAreSimilar(existing, normalized, options)
    );

    if (index === -1) {
      deduped.push(normalized);
      continue;
    }

    deduped[index] = preferredIngredientName(deduped[index] ?? "", normalized);
  }

  return deduped;
}

export function fuzzyCanonicalIngredientName(
  value: string,
  canonicalNames: string[],
  options: { allowUniversalBasicOverlap?: boolean } = {},
) {
  const normalized = normalizeIngredientName(value);
  if (!normalized) return "";

  const match = canonicalNames.find((canonical) =>
    ingredientNamesAreSimilar(canonical, normalized, options)
  );

  return match ? preferredIngredientName(match, normalized) : normalized;
}
