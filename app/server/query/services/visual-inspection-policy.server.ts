import type { QueryIntent } from "../schemas/query";

type FocusedVisualInspectionPlan = {
  enabled: boolean;
  itemIds?: string[];
};

const visibleStatePattern = /\b(expir(?:e|es|ed|ation)|best by|use by|sell by|date|label|open(?:ed)?|seal(?:ed)?|unsealed|leak(?:ing)?|damag(?:e|ed)|broken|mold|mould|spoiled|spoilt|rotten|bad|fresh(?:ness)?|safe to eat|contaminated)\b/i;
const itemMeasurePattern = /\b(how many|how much|count|number of|quantity|amount|left|remaining|full|empty|fill(?:ed)?|fill level)\b/i;

export function planFocusedVisualInspection(input: {
  query: string;
  intent: QueryIntent | null;
  itemIds: string[];
}): FocusedVisualInspectionPlan {
  if (input.intent === "space" || input.intent === "recipe") {
    return { enabled: false };
  }

  const query = input.query.normalize("NFKD");
  const itemIds = input.itemIds.length > 0 ? input.itemIds : undefined;

  if (visibleStatePattern.test(query)) {
    return itemIds ? { enabled: true, itemIds } : { enabled: true };
  }

  if (itemIds && itemMeasurePattern.test(query)) {
    return { enabled: true, itemIds };
  }

  return { enabled: false };
}
