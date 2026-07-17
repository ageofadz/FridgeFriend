export function normalizeFoodText(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function singularFoodToken(token: string) {
  if (token.length > 4 && token.endsWith("ies")) {
    return `${token.slice(0, -3)}y`;
  }

  if (
    token.length > 3 &&
    token.endsWith("s") &&
    !token.endsWith("ss") &&
    !token.endsWith("us") &&
    !token.endsWith("is")
  ) {
    return token.slice(0, -1);
  }

  return token;
}

export function normalizedFoodTokens(value: string) {
  return normalizeFoodText(value)
    .split(" ")
    .map(singularFoodToken)
    .filter(Boolean);
}

function tokenSetIncludesAll(container: Set<string>, tokens: string[]) {
  return tokens.length > 0 && tokens.every((token) => container.has(token));
}

export function foodTextMatches(itemValue: string, targetValue: string) {
  const itemText = normalizeFoodText(itemValue);
  const targetText = normalizeFoodText(targetValue);

  if (itemText === targetText) {
    return true;
  }

  const itemTokens = normalizedFoodTokens(itemText);
  const targetTokens = normalizedFoodTokens(targetText);
  const itemTokenSet = new Set(itemTokens);
  const targetTokenSet = new Set(targetTokens);

  return tokenSetIncludesAll(itemTokenSet, targetTokens) ||
    tokenSetIncludesAll(targetTokenSet, itemTokens);
}
