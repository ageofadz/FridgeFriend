import { extractCookingMethods, normalizeRecipeTag } from "./normalization";
import type { Recipe } from "./types";

export const DEMO_CORPUS_TAXONOMY_VERSION = "1";
export const DEFAULT_DEMO_CORPUS_COUNT = 5_000;
export const DEFAULT_DEMO_CORPUS_SEED = "fridgefriend-demo-v1";

const COURSE_TAGS: Record<string, string[]> = {
  appetizer: ["appetizer", "appetizers"],
  beverage: ["beverage", "beverages"],
  bread: ["bread", "breads"],
  breakfast: ["breakfast"],
  brunch: ["brunch"],
  dessert: ["dessert", "desserts"],
  lunch: ["lunch"],
  main: ["main dish", "one dish meal"],
  salad: ["salad", "salads"],
  side: ["side dish", "side dishes"],
  snack: ["snack", "snacks"],
  soup: ["soup", "soups stews"],
};

const CUISINE_TAGS: Record<string, string[]> = {
  african: ["african"],
  american: ["american"],
  asian: ["asian"],
  british: ["british"],
  caribbean: ["caribbean"],
  chinese: ["chinese"],
  french: ["french"],
  greek: ["greek"],
  indian: ["indian"],
  italian: ["italian"],
  japanese: ["japanese"],
  korean: ["korean"],
  mexican: ["mexican"],
  middle_eastern: ["middle eastern"],
  polish: ["polish"],
  portuguese: ["portuguese"],
  spanish: ["spanish"],
  thai: ["thai"],
  vietnamese: ["vietnamese"],
};

const DIETARY_TAGS: Record<string, string[]> = {
  dairy_free: ["dairy free"],
  gluten_free: ["gluten free"],
  healthy: ["healthy"],
  low_calorie: ["low calorie"],
  low_carb: ["low carb"],
  low_fat: ["low fat"],
  vegan: ["vegan"],
  vegetarian: ["vegetarian"],
};

const INGREDIENT_FAMILIES: Record<string, RegExp> = {
  beef: /\b(beef|veal|steak)\b/u,
  legume: /\b(bean|chickpea|lentil|pea|tofu)\b/u,
  pasta_grain: /\b(pasta|rice|noodle|quinoa|couscous|barley)\b/u,
  pork: /\b(pork|bacon|ham|sausage)\b/u,
  poultry: /\b(chicken|turkey|duck)\b/u,
  seafood: /\b(fish|salmon|tuna|shrimp|prawn|crab|lobster|clam|mussel|scallop|tilapia)\b/u,
};

const TIME_BANDS = [
  { label: "under_15", maximumMinutes: 15 },
  { label: "under_30", maximumMinutes: 30 },
  { label: "under_60", maximumMinutes: 60 },
  { label: "under_180", maximumMinutes: 180 },
] as const;

const QUOTA_BY_DIMENSION = {
  course: 80,
  cuisine: 80,
  dietary: 60,
  ingredient: 120,
  method: 100,
  time: 450,
} as const;

type CoverageDimension = keyof typeof QUOTA_BY_DIMENSION;

export type DemoCorpusCoverage = Record<CoverageDimension, string[]>;

export type DemoCorpusRecipe = {
  coverage: DemoCorpusCoverage;
  recipe: Recipe;
};

export type DemoCorpusCoverageRecord = {
  available: number;
  dimension: CoverageDimension;
  label: string;
  selected: number;
  target: number;
};

export type DemoCorpusSelectionResult = {
  coverage: DemoCorpusCoverageRecord[];
  candidates: number;
  count: number;
  recipes: DemoCorpusRecipe[];
  seed: string;
  taxonomyVersion: string;
};

export type DemoCorpusSelectionOptions = {
  count?: number;
  seed?: string;
};

type Candidate = {
  coverage: DemoCorpusCoverage;
  qualityBand: number;
  recipe: Recipe;
  titleKey: string;
  tieBreaker: number;
};

type MutableCoverageRecord = DemoCorpusCoverageRecord & {
  candidates: Candidate[];
  cursor: number;
};

function stableHash(value: string) {
  let hash = 2_166_136_261;

  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }

  return hash >>> 0;
}

function validateCount(value: number) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Demo recipe corpus count must be a positive integer; received ${value}`);
  }
}

function labelsForTags(tags: string[], mapping: Record<string, string[]>) {
  const tagSet = new Set(tags.map(normalizeRecipeTag));

  return Object.entries(mapping)
    .filter(([, acceptedTags]) => acceptedTags.some((tag) => tagSet.has(tag)))
    .map(([label]) => label)
    .sort();
}

function ingredientFamilyLabels(recipe: Recipe) {
  const ingredients = recipe.ingredients.map((ingredient) => ingredient.canonicalName).join(" ");

  return Object.entries(INGREDIENT_FAMILIES)
    .filter(([, pattern]) => pattern.test(ingredients))
    .map(([label]) => label)
    .sort();
}

function timeBandLabel(minutes: number) {
  const match = TIME_BANDS.find((band) => minutes <= band.maximumMinutes);

  if (!match) {
    throw new Error(`Demo recipe corpus received a recipe outside its quality time range: ${minutes}`);
  }

  return match.label;
}

export function coverageForDemoRecipe(recipe: Recipe): DemoCorpusCoverage {
  return {
    course: labelsForTags(recipe.tags, COURSE_TAGS),
    cuisine: labelsForTags(recipe.tags, CUISINE_TAGS),
    dietary: labelsForTags(recipe.tags, DIETARY_TAGS),
    ingredient: ingredientFamilyLabels(recipe),
    method: extractCookingMethods(recipe.steps).sort(),
    time: [timeBandLabel(recipe.minutes)],
  };
}

function coverageRecords(candidates: Candidate[], count: number) {
  const records: MutableCoverageRecord[] = [];

  for (const dimension of Object.keys(QUOTA_BY_DIMENSION) as CoverageDimension[]) {
    const labels = new Set<string>();

    for (const candidate of candidates) {
      candidate.coverage[dimension].forEach((label) => labels.add(label));
    }

    for (const label of [...labels].sort()) {
      const matchingCandidates = candidates.filter((candidate) =>
        candidate.coverage[dimension].includes(label)
      );

      records.push({
        available: matchingCandidates.length,
        candidates: matchingCandidates,
        cursor: 0,
        dimension,
        label,
        selected: 0,
        target: Math.min(
          matchingCandidates.length,
          Math.max(1, Math.floor(QUOTA_BY_DIMENSION[dimension] * count / DEFAULT_DEMO_CORPUS_COUNT)),
        ),
      });
    }
  }

  return records.sort((left, right) =>
    left.available - right.available ||
    left.dimension.localeCompare(right.dimension) ||
    left.label.localeCompare(right.label)
  );
}

function candidateComparator(left: Candidate, right: Candidate) {
  return left.qualityBand - right.qualityBand ||
    left.tieBreaker - right.tieBreaker ||
    left.recipe.id.localeCompare(right.recipe.id);
}

function unmetCoverage(records: MutableCoverageRecord[]) {
  return records
    .filter((record) => record.selected < record.target)
    .map((record) => `${record.dimension}:${record.label} (${record.selected}/${record.target})`)
    .join(", ");
}

export function selectDemoRecipeCorpus(
  recipes: Recipe[],
  options: DemoCorpusSelectionOptions = {},
): DemoCorpusSelectionResult {
  const count = options.count ?? DEFAULT_DEMO_CORPUS_COUNT;
  const seed = options.seed?.trim() || DEFAULT_DEMO_CORPUS_SEED;
  validateCount(count);

  if (recipes.length < count) {
    throw new Error(`Demo recipe corpus requested ${count} recipes but only ${recipes.length} quality recipes were available`);
  }

  const candidates = recipes.map((recipe, index) => ({
    coverage: coverageForDemoRecipe(recipe),
    qualityBand: Math.floor(index / 500),
    recipe,
    titleKey: normalizeRecipeTag(recipe.name),
    tieBreaker: stableHash(`${seed}:${recipe.id}`),
  })).sort(candidateComparator);
  const records = coverageRecords(candidates, count);

  records.forEach((record) => record.candidates.sort(candidateComparator));

  const selected: Candidate[] = [];
  const selectedIds = new Set<string>();
  const selectedTitles = new Set<string>();

  function add(candidate: Candidate) {
    if (selectedIds.has(candidate.recipe.id) || selectedTitles.has(candidate.titleKey)) {
      return false;
    }

    selected.push(candidate);
    selectedIds.add(candidate.recipe.id);
    selectedTitles.add(candidate.titleKey);

    for (const record of records) {
      if (candidate.coverage[record.dimension].includes(record.label)) {
        record.selected += 1;
      }
    }

    return true;
  }

  let progressed = true;

  while (selected.length < count && progressed && unmetCoverage(records)) {
    progressed = false;

    for (const record of records) {
      if (selected.length === count || record.selected >= record.target) {
        continue;
      }

      while (record.cursor < record.candidates.length) {
        const candidate = record.candidates[record.cursor];
        record.cursor += 1;

        if (candidate && add(candidate)) {
          progressed = true;
          break;
        }
      }
    }
  }

  const unmet = unmetCoverage(records);

  if (unmet) {
    throw new Error(`Demo recipe corpus could not satisfy coverage targets: ${unmet}`);
  }

  for (const candidate of candidates) {
    if (selected.length === count) {
      break;
    }

    add(candidate);
  }

  if (selected.length !== count) {
    throw new Error(`Demo recipe corpus selected ${selected.length} unique recipe titles; requested ${count}`);
  }

  return {
    candidates: candidates.length,
    count,
    coverage: records.map(({ available, dimension, label, selected: selectedCount, target }) => ({
      available,
      dimension,
      label,
      selected: selectedCount,
      target,
    })),
    recipes: selected
      .sort((left, right) => left.recipe.name.localeCompare(right.recipe.name) || left.recipe.id.localeCompare(right.recipe.id))
      .map(({ coverage, recipe }) => ({ coverage, recipe })),
    seed,
    taxonomyVersion: DEMO_CORPUS_TAXONOMY_VERSION,
  };
}
