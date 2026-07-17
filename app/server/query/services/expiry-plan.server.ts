import { assessFreshness, type FreshnessAssessment } from "../../../workspace/freshness";
import { generalRecipeIngredientName } from "../../recipes/inventory-generalization";
import { normalizeIngredientName } from "../../recipes/normalization";

export type ExpiryPlanItem = FreshnessAssessment & {
  id: string;
  visibleItemId: string | null;
  name: string;
  ingredientName: string;
  storageLocation: string;
  wasteScore: number;
};

export type ExpiryPlan = {
  items: ExpiryPlanItem[];
  priorityItems: ExpiryPlanItem[];
  expiredItems: ExpiryPlanItem[];
};

type ScannedItem = {
  id: string;
  displayName: string;
  canonicalName: string;
  category: string;
  subcategory: string | null;
  location: { zoneType: string | null };
  attributes: {
    opened: boolean | null;
    expirationDate: string | null;
    expirationDateSource?: "user" | "observed" | null;
  };
};

type HouseholdItem = {
  id: string;
  name: string;
  canonicalName?: string | null;
  storageLocation: string;
  status?: string;
  expirationDate?: string | null;
  expirationDateSource?: "user" | "observed" | null;
};

function storageLocationForScannedItem(item: ScannedItem) {
  if (item.location.zoneType === "freezer") return "freezer";
  if (item.location.zoneType === "pantry") return "pantry";
  return "fridge";
}

function urgencyWeight(assessment: FreshnessAssessment) {
  if (assessment.urgency === "urgent") return 1;
  if (assessment.urgency === "use_soon") return 0.65;
  if (assessment.urgency === "fresh") return 0.15;
  return 0;
}

function confidenceWeight(confidence: FreshnessAssessment["confidence"]) {
  if (confidence === "high") return 1;
  if (confidence === "medium") return 0.8;
  return 0.55;
}

function wasteScoreFor(assessment: FreshnessAssessment) {
  const score = urgencyWeight(assessment) * confidenceWeight(assessment.confidence);

  if (!Number.isFinite(score)) {
    throw new Error(`Cannot build expiry plan because waste score for ${assessment.date} is not finite`);
  }

  return score;
}

function itemKey(name: string, storageLocation: string) {
  return `${normalizeIngredientName(name)}:${storageLocation}`;
}

function asExpiryPlanItem(input: {
  id: string;
  visibleItemId: string | null;
  name: string;
  ingredientName: string;
  category: string;
  storageLocation: string;
  opened: boolean | null;
  expirationDate: string | null;
  expirationDateSource?: "user" | "observed" | null;
  now: Date;
}): ExpiryPlanItem {
  const assessment = assessFreshness({
    category: input.category,
    storageLocation: input.storageLocation,
    opened: input.opened,
    expirationDate: input.expirationDate,
    expirationDateSource: input.expirationDateSource ?? null,
  }, input.now);

  return {
    ...assessment,
    dateIssue: assessment.dateIssue ?? null,
    id: input.id,
    visibleItemId: input.visibleItemId,
    name: input.name,
    ingredientName: normalizeIngredientName(input.ingredientName),
    storageLocation: input.storageLocation,
    wasteScore: wasteScoreFor(assessment),
  };
}

function priorityOrder(left: ExpiryPlanItem, right: ExpiryPlanItem) {
  return right.wasteScore - left.wasteScore || left.date.localeCompare(right.date) || left.name.localeCompare(right.name);
}

export function buildExpiryPlan(input: {
  scannedItems: ScannedItem[];
  householdItems: HouseholdItem[];
  now?: Date;
}): ExpiryPlan {
  const now = input.now ?? new Date();
  const scanned = input.scannedItems.map((item) => {
    const storageLocation = storageLocationForScannedItem(item);
    return asExpiryPlanItem({
      id: item.id,
      visibleItemId: item.id,
      name: item.displayName,
      ingredientName: item.subcategory ?? generalRecipeIngredientName(item.canonicalName || item.displayName) ?? item.canonicalName ?? item.displayName,
      category: item.category,
      storageLocation,
      opened: item.attributes.opened,
      expirationDate: item.attributes.expirationDate,
      expirationDateSource: item.attributes.expirationDateSource,
      now,
    });
  });
  const scannedKeys = new Set(scanned.map((item) => itemKey(item.ingredientName || item.name, item.storageLocation)));
  const household = input.householdItems
    .filter((item) => item.status === undefined || item.status === "available" || item.status === "possibly_available")
    .filter((item) => !scannedKeys.has(itemKey(item.canonicalName || item.name, item.storageLocation)))
    .map((item) => asExpiryPlanItem({
      id: `household:${item.id}`,
      visibleItemId: null,
      name: item.name,
      ingredientName: item.canonicalName || item.name,
      category: "other",
      storageLocation: item.storageLocation,
      opened: null,
      expirationDate: item.expirationDate ?? null,
      expirationDateSource: item.expirationDateSource,
      now,
    }));
  const items = [...scanned, ...household].sort(priorityOrder);

  return {
    items,
    priorityItems: items.filter((item) => item.urgency === "urgent" || item.urgency === "use_soon").sort(priorityOrder),
    expiredItems: items.filter((item) => item.urgency === "expired").sort((left, right) => left.date.localeCompare(right.date) || left.name.localeCompare(right.name)),
  };
}
