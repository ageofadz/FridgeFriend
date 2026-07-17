import {
  normalizeIngredientName,
  normalizeRecipeTag,
} from "../../recipes/normalization";
import type {
  RecipeSearchFacet,
  RecipeSearchInterpretation,
  RecipeSearchPlan,
  RecipeSearchRequest,
} from "../schemas/query";
import type { AvailableRecipeIngredient } from "./recipe-retrieval.server";

const INITIAL_VECTOR_CANDIDATE_LIMIT = 50;
const CORRECTIVE_VECTOR_CANDIDATE_LIMIT = 120;
const MAX_VECTOR_QUERY_INGREDIENTS = 8;

function normalizedPhrase(value: string) {
  return normalizeRecipeTag(value);
}

function phraseOccurs(query: string, phrase: string) {
  const normalizedQuery = normalizedPhrase(query);
  const normalizedPhraseValue = normalizedPhrase(phrase);
  if (!normalizedPhraseValue) return false;
  return new RegExp(`(^|\\s)${normalizedPhraseValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`, "u")
    .test(normalizedQuery);
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function userTermsAreGrounded(query: string, values: string[], label: string) {
  const unsupported = unique(values).filter((value) => !phraseOccurs(query, value));
  return unsupported.length === 0
    ? null
    : `Recipe search interpretation included ${label} not present in the user request: ${unsupported.join(", ")}`;
}

function numericConstraintIsGrounded(query: string, value: number | null, label: string) {
  if (value === null || query.includes(String(value))) return null;
  return `Recipe search interpretation included ${label} ${value}, which was not present in the user request`;
}

function hasExplicitRequirement(query: string) {
  return /\b(must|only|strictly|required|require)\b/iu.test(query);
}

export function validateRecipeSearchInterpretation(input: {
  query: string;
  interpretation: RecipeSearchInterpretation;
}) {
  const facetError = userTermsAreGrounded(
    input.query,
    input.interpretation.facets.map((facet) => facet.text),
    "facets",
  );
  const termErrors = [
    facetError,
    userTermsAreGrounded(input.query, input.interpretation.excludedIngredients, "excluded ingredients"),
    userTermsAreGrounded(input.query, input.interpretation.dietaryRestrictions, "dietary restrictions"),
    userTermsAreGrounded(input.query, input.interpretation.preferredIngredients, "preferred ingredients"),
    userTermsAreGrounded(input.query, input.interpretation.requiredTags, "required tags"),
    userTermsAreGrounded(input.query, input.interpretation.preferredTags, "preferred tags"),
    userTermsAreGrounded(input.query, input.interpretation.excludedTags, "excluded tags"),
    numericConstraintIsGrounded(input.query, input.interpretation.maxMinutes, "maximum cooking time"),
    numericConstraintIsGrounded(input.query, input.interpretation.maxCalories, "maximum calories"),
    numericConstraintIsGrounded(input.query, input.interpretation.minProteinDailyValue, "minimum protein"),
  ].filter((error): error is string => error !== null);

  return termErrors.length === 0 ? null : termErrors.join("; ");
}

function orderedInventoryTerms(ingredients: AvailableRecipeIngredient[]) {
  return [...ingredients]
    .map((ingredient) => ({
      name: normalizeIngredientName(ingredient.name),
      wasteScore: ingredient.wasteScore ?? 0,
    }))
    .filter((ingredient) => ingredient.name.length > 0)
    .sort((left, right) => right.wasteScore - left.wasteScore || left.name.localeCompare(right.name))
    .map((ingredient) => ingredient.name)
    .filter((name, index, values) => values.indexOf(name) === index)
    .slice(0, MAX_VECTOR_QUERY_INGREDIENTS);
}

function compileVectorQuery(input: {
  facets: RecipeSearchFacet[];
  userTags: string[];
  memoryTags: string[];
  inventoryIngredients: string[];
  includeInventory: boolean;
}) {
  const intentTerms = unique([
    ...input.facets.map((facet) => normalizedPhrase(facet.text)),
    ...input.userTags.map(normalizedPhrase),
    ...input.memoryTags.map(normalizedPhrase),
  ]);
  const base = unique(["recipe", ...intentTerms]);

  if (!input.includeInventory || input.inventoryIngredients.length === 0) {
    return base.join(" ");
  }

  return [...base, "using", ...input.inventoryIngredients].join(" ");
}

export function buildRecipeSearchPlan(input: {
  facets: RecipeSearchFacet[];
  userTags: string[];
  memoryTags: string[];
  availableIngredients: AvailableRecipeIngredient[];
}) {
  return {
    userFacets: input.facets,
    userTags: unique(input.userTags.map(normalizedPhrase)),
    memoryTags: unique(input.memoryTags.map(normalizedPhrase)),
    inventoryIngredients: orderedInventoryTerms(input.availableIngredients),
  } satisfies RecipeSearchPlan;
}

export function compileRecipeSearch(input: {
  plan: RecipeSearchPlan;
  specific: boolean;
}): Pick<RecipeSearchRequest, "semanticQuery" | "semanticQueryWithoutInventory" | "vectorCandidateLimit" | "correctiveAttempt" | "intent"> {
  const semanticQueryWithoutInventory = compileVectorQuery({
    facets: input.plan.userFacets,
    userTags: input.plan.userTags,
    memoryTags: input.plan.memoryTags,
    inventoryIngredients: input.plan.inventoryIngredients,
    includeInventory: false,
  });
  const semanticQuery = compileVectorQuery({
    facets: input.plan.userFacets,
    userTags: input.plan.userTags,
    memoryTags: input.plan.memoryTags,
    inventoryIngredients: input.plan.inventoryIngredients,
    includeInventory: true,
  });

  return {
    semanticQuery,
    semanticQueryWithoutInventory,
    vectorCandidateLimit: INITIAL_VECTOR_CANDIDATE_LIMIT,
    correctiveAttempt: false,
    intent: { specific: input.specific, relatedSemanticQuery: null },
  };
}

export function compileCorrectiveRecipeSearch(search: RecipeSearchRequest): RecipeSearchRequest {
  return {
    ...search,
    semanticQuery: search.intent?.specific
      ? search.semanticQueryWithoutInventory
      : search.semanticQuery,
    vectorCandidateLimit: CORRECTIVE_VECTOR_CANDIDATE_LIMIT,
    correctiveAttempt: true,
  };
}

export function recipeSearchPlanSummary(plan: RecipeSearchPlan) {
  return {
    userFacetCount: plan.userFacets.length,
    userTagCount: plan.userTags.length,
    memoryTagCount: plan.memoryTags.length,
    inventoryIngredientCount: plan.inventoryIngredients.length,
  };
}
