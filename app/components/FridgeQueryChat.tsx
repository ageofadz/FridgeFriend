import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  readQueryStream,
  type InventoryClarificationQuestion,
  type ExpiryPlan,
  type DietaryPreference,
  type DietaryRestriction,
  type GoalMemory,
  type GroceryPlan,
  type GroceryPlanItem,
  type PantryCompletionPlan,
  type PantryCompletionSuggestion,
  type OrganizationPlan,
  type RecipeCard,
  type QueryStreamEvent,
  type QueryVisualEvidence,
} from "./query-stream";
import type { Inventory } from "../server/scan/schemas/inventory";
import type {
  AgentActivityEvent,
  ConversationContext,
  ConversationContextSeededItem,
  WorkspaceAction,
} from "../workspace/contracts";
import { inventorySeedCropId } from "../workspace/contracts";
import type { PersistedChat, PersistedChatMessage } from "../chat/contracts";

type FridgeQueryChatProps = {
  initialChat: PersistedChat;
  userId?: string;
  fridgeId: string;
  imageId: string | null;
  dietaryRestrictions: DietaryRestriction[];
  dietaryPreferences: DietaryPreference[];
  conversationContext: ConversationContext;
  draftRequest: { id: string; text: string } | null;
  seededItems: ConversationContextSeededItem[];
  seededItemLabels: Record<string, string>;
  inventory: Inventory;
  onRemoveSeededItem(cropId: string): void;
  onClearSeededItems(): void;
  onWorkspaceAction(action: WorkspaceAction): void;
  onAgentEvent(event: AgentActivityEvent): void;
  onQueryStarted(): void;
  onRecipeIngredientHover?(ingredients: string[] | null): void;
  onGroceryPlan(plan: GroceryPlan): void;
  onAddPantryCompletionItems(items: PantryCompletionSuggestion[]): void;
  onOpenGroceryList(): void;
  onInventoryUpdated(inventory: Inventory): void;
  onOrganizationPlanCompleted(inventory: Inventory): void;
  onOrganizationPlanRejected(): void;
  onDietaryProfileChange(profile: {
    dietaryRestrictions: DietaryRestriction[];
    dietaryPreferences: DietaryPreference[];
    activeGoals: GoalMemory[];
  }): void;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  statusLines?: string[];
  streaming?: boolean;
  recipes?: RecipeCard[];
  recipeTournament?: RecipeTournamentState;
  expiryPlan?: ExpiryPlan;
  groceryPlan?: GroceryPlan;
  groceryPlanPending?: boolean;
  groceryPlanStage?: "selecting_recipes" | "building_list";
  groceryPlanError?: string;
  pantryCompletionPlan?: PantryCompletionPlan;
  pantryCompletionPending?: boolean;
  pantryCompletionStage?: "analyzing_recipes" | "assigning_aisles";
  pantryCompletionError?: string;
  pantryCompletionClarification?: string;
  organizationPlan?: OrganizationPlan;
  visualEvidence?: QueryVisualEvidence[];
  seededItems?: ConversationContextSeededItem[];
  memoryUpdateMessage?: string;
};

export function withoutQueryFailureState(message: ChatMessage): ChatMessage {
  return {
    ...message,
    statusLines: undefined,
    streaming: false,
    groceryPlanPending: false,
    groceryPlanStage: undefined,
    pantryCompletionPending: false,
    pantryCompletionStage: undefined,
  };
}

type RecipeTournamentState = {
  status: "running" | "finished";
  candidateCount: number;
  displaySlotCount: number;
  evaluatedCount: number;
  totalCount: number;
  recipes: RecipeCard[];
  exitingRecipes: RecipeCard[];
};

type InventorySplitReview = {
  scopeLabel: string;
  summary: string;
  items: Array<{ label: string; name: string }>;
};

type InventoryMutationReview = {
  operation: "consume" | "remove";
  itemName: string;
  storageLocation: string;
};

type MarkdownBlock =
  | {
    type: "paragraph";
    lines: string[];
  }
  | {
    type: "heading";
    level: number;
    text: string;
  }
  | {
    type: "unordered-list";
    items: string[];
  }
  | {
    type: "ordered-list";
    items: string[];
  }
  | {
    type: "code";
    code: string;
  };

const RECIPE_TOURNAMENT_DISPLAY_LIMIT = 3;
const LOADING_FOOD_EMOJIS = ["🌽", "🥚", "🍌", "🥩", "🧃", "🍞", "🍒", "🍓", "🥦", "🥬", "🍤", "🥜"] as const;
export const CHATBOX_EXAMPLE_PROMPTS = [
  "List the visible drinks in the door...",
  "How much is left in this selected container...",
  "What should I use before it goes bad...",
  "Find quick dinners I can cook from what I have...",
  "Show more recipe options like those...",
  "Build a grocery list for three meals this week...",
  "What pantry staples would unlock more recipes...",
  "How long is opened yogurt safe to keep...",
  "Which shelf has room for a tall bottle...",
  "Make a plan to reorganize the fridge...",
  "Move the yogurt to the door bin in the inventory...",
  "Remember that I avoid peanuts and prefer spicy food...",
] as const;

function chatMessageFromPersisted(message: PersistedChatMessage): ChatMessage {
  const text = message.payload.text;

  if (typeof text !== "string") {
    throw new Error(`Persisted chat message ${message.id} has no text`);
  }

  return {
    ...message.payload,
    id: message.id,
    role: message.role,
    text,
    streaming: message.status === "running",
  } as ChatMessage;
}

function messagesFromChat(chat: PersistedChat) {
  return chat.messages.map(chatMessageFromPersisted);
}

function chatScopeKey(userId: string, fridgeId: string, imageId: string | null) {
  return JSON.stringify([userId, fridgeId, imageId]);
}

function persistedChatScopeKey(chat: PersistedChat) {
  return chatScopeKey(chat.userId, chat.fridgeId, chat.imageId);
}

function createAssistantMessage(
  text: string,
  options: Pick<ChatMessage, "statusLines" | "streaming"> = {},
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    text,
    ...options,
  };
}

function createUserMessage(
  text: string,
  seededItems: ConversationContextSeededItem[],
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    text,
    seededItems: seededItems.map((item) => ({ ...item })),
  };
}

function hasVisibleAssistantContent(message: ChatMessage) {
  return (
    message.text.length > 0 ||
    (message.statusLines?.length ?? 0) > 0 ||
    (message.recipes?.length ?? 0) > 0 ||
    message.recipeTournament !== undefined ||
    message.expiryPlan !== undefined ||
    message.groceryPlan !== undefined ||
    message.groceryPlanPending === true ||
    message.groceryPlanError !== undefined ||
    message.pantryCompletionPlan !== undefined ||
    message.pantryCompletionPending === true ||
    message.pantryCompletionError !== undefined ||
    message.pantryCompletionClarification !== undefined ||
    message.organizationPlan !== undefined ||
    (message.visualEvidence?.length ?? 0) > 0
  );
}

export function hasAssistantResponseContent(message: ChatMessage) {
  return (
    message.text.length > 0 ||
    (message.recipes?.length ?? 0) > 0 ||
    message.recipeTournament !== undefined ||
    message.expiryPlan !== undefined ||
    message.groceryPlan !== undefined ||
    message.groceryPlanError !== undefined ||
    message.pantryCompletionPlan !== undefined ||
    message.pantryCompletionError !== undefined ||
    message.pantryCompletionClarification !== undefined ||
    message.organizationPlan !== undefined ||
    (message.visualEvidence?.length ?? 0) > 0
  );
}

export function withoutHitlLoadingState(message: ChatMessage): ChatMessage {
  return {
    ...message,
    text: "",
    statusLines: undefined,
    streaming: false,
  };
}

export function finalAssistantMessageText(
  currentText: string,
  event: Extract<QueryStreamEvent, { type: "final" }>,
) {
  const structuredError = event.groceryPlanError ?? event.pantryCompletionError;

  if (structuredError && event.answer.trim() === structuredError.trim()) {
    return currentText;
  }

  return event.answer;
}

function normalizedDietarySubject(subject: string) {
  return subject
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

function hasDietaryPreference(
  dietaryRestrictions: DietaryRestriction[],
  dietaryPreferences: DietaryPreference[],
  subject: string,
) {
  return dietaryRestrictions.some((restriction) =>
    normalizedDietarySubject(restriction.subject).includes(subject)
  ) || dietaryPreferences.some((preference) =>
    (preference.sentiment === "like" || preference.sentiment === "prefer") &&
    normalizedDietarySubject(preference.subject).includes(subject)
  );
}

function hasDietaryAllergy(dietaryRestrictions: DietaryRestriction[], subjects: string[]) {
  return dietaryRestrictions.some((restriction) =>
    restriction.restrictionType === "allergy" &&
    normalizedDietarySubject(restriction.subject).some((subject) => subjects.includes(subject))
  );
}

export function loadingFoodEmojis(
  dietaryRestrictions: DietaryRestriction[],
  dietaryPreferences: DietaryPreference[],
) {
  const vegetarian = hasDietaryPreference(dietaryRestrictions, dietaryPreferences, "vegetarian");
  const vegan = hasDietaryPreference(dietaryRestrictions, dietaryPreferences, "vegan");
  const peanutAllergy = hasDietaryAllergy(dietaryRestrictions, ["peanut", "peanuts"]);
  const shellfishAllergy = hasDietaryAllergy(dietaryRestrictions, ["shellfish"]);

  return LOADING_FOOD_EMOJIS.filter((emoji) =>
    !(emoji === "🥩" && (vegetarian || vegan)) &&
    !(emoji === "🍤" && (vegetarian || vegan || shellfishAllergy)) &&
    !(emoji === "🥚" && vegan) &&
    !(emoji === "🥜" && peanutAllergy)
  );
}

export function FoodLoadingIndicator({
  foods,
  label = "Loading...",
}: {
  foods: readonly string[];
  label?: string;
}) {
  const activeIndexRef = useRef(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [outgoingIndex, setOutgoingIndex] = useState<number | null>(null);
  const [transitionId, setTransitionId] = useState(0);

  useEffect(() => {
    activeIndexRef.current = 0;
    setActiveIndex(0);
    setOutgoingIndex(null);
    setTransitionId(0);

    const intervalId = window.setInterval(() => {
      const outgoing = activeIndexRef.current % foods.length;
      const next = (outgoing + 1) % foods.length;
      activeIndexRef.current = next;
      setOutgoingIndex(outgoing);
      setActiveIndex(next);
      setTransitionId((current) => current + 1);
    }, 500);

    return () => window.clearInterval(intervalId);
  }, [foods]);

  return (
    <div aria-live="polite" className="ff-chat-food-loading" role="status">
      <span className="ff-chat-food-loading__label">{label}</span>
      <span aria-hidden="true" className="ff-chat-food-loading__emoji">
        {outgoingIndex === null ? null : (
          <span className="ff-chat-food-loading__food ff-chat-food-loading__food--outgoing" key={`outgoing-${transitionId}`}>
            {foods[outgoingIndex % foods.length]!}
          </span>
        )}
        <span className="ff-chat-food-loading__food ff-chat-food-loading__food--incoming" key={`incoming-${transitionId}`}>
          {foods[activeIndex % foods.length]!}
        </span>
      </span>
    </div>
  );
}

function formatNodeStatus(node: string | undefined, message: string) {
  return "Working...";
}

function formatToolStatus(event: Extract<QueryStreamEvent, { type: "tool" }>) {
  return "Working...";
}

function stableRecipeSlots(
  previousRecipes: RecipeCard[],
  incomingRecipes: RecipeCard[],
) {
  const incomingById = new Map(incomingRecipes.map((recipe) => [recipe.id, recipe]));
  const stableRecipes = previousRecipes.map((recipe) =>
    incomingById.get(recipe.id) ?? recipe
  );
  const stableRecipeIds = new Set(stableRecipes.map((recipe) => recipe.id));
  const newRecipes = incomingRecipes.filter((recipe) => !stableRecipeIds.has(recipe.id));

  return [...stableRecipes, ...newRecipes].slice(0, RECIPE_TOURNAMENT_DISPLAY_LIMIT);
}

function recipeUrl(recipe: RecipeCard) {
  const slug = recipe.name
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `https://www.food.com/recipe/${slug}-${encodeURIComponent(recipe.id)}`;
}

function recipeImageUrl(recipe: RecipeCard) {
  const params = new URLSearchParams({ name: recipe.name, id: recipe.id });
  return `/api/recipe-image?${params.toString()}`;
}

function RecipeCardLink({
  recipe,
  exiting = false,
  onRecipeIngredientHover,
}: {
  recipe: RecipeCard;
  exiting?: boolean;
  onRecipeIngredientHover?: (ingredients: string[] | null) => void;
}) {
  const className = ["ff-recipe-card", exiting ? "ff-recipe-card-exiting" : "ff-recipe-card-entering"].join(" ");

  return (
    <a
      className={className}
      href={recipeUrl(recipe)}
      rel="noreferrer"
      target="_blank"
      data-recipe-card-id={recipe.id}
      onMouseEnter={() => onRecipeIngredientHover?.(recipe.matchedIngredients)}
      onMouseLeave={() => onRecipeIngredientHover?.(null)}
      onFocus={() => onRecipeIngredientHover?.(recipe.matchedIngredients)}
      onBlur={() => onRecipeIngredientHover?.(null)}
    >
      <img
        alt=""
        className="ff-recipe-card-image"
        src={recipeImageUrl(recipe)}
      />
      <span className="ff-recipe-card-content">
        <span className="ff-recipe-card-title">{recipe.name}</span>
        {recipe.description ? (
          <span className="ff-recipe-card-description">{recipe.description}</span>
        ) : null}
        <span className="ff-recipe-card-meta">{recipe.minutes} min</span>
        <span className="ff-recipe-card-ingredients">
          <strong>You have:</strong> {recipe.matchedIngredients.join(", ")}
        </span>
        {recipe.missingIngredients.length > 0 ? (
          <span className="ff-recipe-card-ingredients">
            <strong>Still needed:</strong> {recipe.missingIngredients.join(", ")}
          </span>
        ) : null}
        {recipe.usesSoonIngredients && recipe.usesSoonIngredients.length > 0 ? (
          <span className="ff-recipe-card-ingredients ff-recipe-card-priority-items">
            <strong>Uses soon:</strong> {recipe.usesSoonIngredients.join(", ")}
          </span>
        ) : null}
      </span>
    </a>
  );
}

function ExpiryPlanSummary({ plan }: { plan: ExpiryPlan }) {
  return (
    <section className="ff-expiry-plan" aria-label="Expiry plan">
      {plan.priorityItems.length > 0 ? (
        <>
          <h3>Use soon</h3>
          <ul>
            {plan.priorityItems.map((item) => (
              <li key={item.id}>
                <strong>{item.name}</strong>: {item.label} ({item.confidence} confidence)
              </li>
            ))}
          </ul>
        </>
      ) : <p>No items are currently due soon based on the recorded and estimated dates.</p>}
      {plan.expiredItems.length > 0 ? (
        <p className="ff-expiry-plan-expired">Past date: {plan.expiredItems.map((item) => item.name).join(", ")}. Verify safety before using these items.</p>
      ) : null}
    </section>
  );
}

function RecipeCardSkeleton() {
  return (
    <div className="ff-recipe-card ff-recipe-card-skeleton" aria-hidden="true">
      <span className="ff-recipe-card-image ff-recipe-card-skeleton-image ff-recipe-skeleton-block" />
      <span className="ff-recipe-card-content">
        <span className="ff-recipe-skeleton-line ff-recipe-skeleton-line-title" />
        <span className="ff-recipe-skeleton-pill" />
        <span className="ff-recipe-skeleton-line ff-recipe-skeleton-line-short" />
        <span className="ff-recipe-skeleton-line" />
        <span className="ff-recipe-skeleton-badges">
          <span className="ff-recipe-skeleton-pill" />
          <span className="ff-recipe-skeleton-pill ff-recipe-skeleton-pill-short" />
        </span>
        <span className="ff-recipe-skeleton-line ff-recipe-skeleton-line-ingredient" />
        <span className="ff-recipe-skeleton-line ff-recipe-skeleton-line-ingredient" />
        <span className="ff-recipe-skeleton-line ff-recipe-skeleton-line-short" />
      </span>
    </div>
  );
}

function RecipeCards({
  recipes,
  onMore,
  onRecipeIngredientHover,
}: {
  recipes: RecipeCard[];
  onMore: () => void;
  onRecipeIngredientHover?: (ingredients: string[] | null) => void;
}) {
  if (recipes.length === 0) {
    return null;
  }

  return (
    <div className="ff-recipe-cards" aria-label="Recipe suggestions">
      {recipes.map((recipe) => (
        <RecipeCardLink key={recipe.id} onRecipeIngredientHover={onRecipeIngredientHover} recipe={recipe} />
      ))}
      <button className="ff-recipe-more" onClick={onMore} type="button">More recipes</button>
    </div>
  );
}

function RecipeTournament({
  tournament,
  onMore,
  onRecipeIngredientHover,
}: {
  tournament: RecipeTournamentState;
  onMore: () => void;
  onRecipeIngredientHover?: (ingredients: string[] | null) => void;
}) {
  const slotCount = Math.min(RECIPE_TOURNAMENT_DISPLAY_LIMIT, tournament.displaySlotCount);
  const visibleRecipes = tournament.recipes.slice(0, slotCount);
  const visibleRecipeIds = new Set(visibleRecipes.map((recipe) => recipe.id));
  const visibleExitingRecipes = tournament.exitingRecipes
    .filter((recipe) => !visibleRecipeIds.has(recipe.id))
    .slice(0, Math.max(0, slotCount - visibleRecipes.length));
  const skeletonCount = tournament.status === "running"
    ? Math.max(0, slotCount - visibleRecipes.length - visibleExitingRecipes.length)
    : 0;

  return (
    <div className="ff-recipe-tournament" aria-label="Recipe tournament">
      <div className="ff-recipe-cards" aria-label="Recipe suggestions">
        {visibleRecipes.map((recipe) => (
          <RecipeCardLink key={recipe.id} onRecipeIngredientHover={onRecipeIngredientHover} recipe={recipe} />
        ))}
        {visibleExitingRecipes.map((recipe) => (
          <RecipeCardLink exiting key={`${recipe.id}-exiting`} onRecipeIngredientHover={onRecipeIngredientHover} recipe={recipe} />
        ))}
        {Array.from({ length: skeletonCount }, (_, index) => <RecipeCardSkeleton key={`skeleton-${index}`} />)}
        {tournament.status === "finished" && tournament.recipes.length > 0 ? (
          <button className="ff-recipe-more" onClick={onMore} type="button">More recipes</button>
        ) : null}
      </div>
    </div>
  );
}

const GROCERY_AISLE_LABELS: Record<GroceryPlanItem["aisle"], string> = {
  produce: "Produce",
  meat_seafood: "Meat & Seafood",
  dairy_eggs: "Dairy & Eggs",
  bakery: "Bakery",
  dry_goods: "Dry Goods",
  canned_goods: "Canned Goods",
  frozen: "Frozen",
  condiments_spices: "Condiments & Spices",
  beverages: "Beverages",
  other: "Other",
};

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

export function groceryPlanCsv(plan: GroceryPlan, completedIngredients: Set<string>) {
  const rows = [
    ["Aisle", "Ingredient", "Recipes", "Completed"],
    ...plan.items.map((item) => [
      GROCERY_AISLE_LABELS[item.aisle],
      item.ingredient,
      item.recipeNames.join("; "),
      completedIngredients.has(item.ingredient) ? "true" : "false",
    ]),
  ];

  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function downloadGroceryPlanCsv(plan: GroceryPlan, completedIngredients: Set<string>) {
  const date = new Date().toISOString().slice(0, 10);
  const blob = new Blob([groceryPlanCsv(plan, completedIngredients)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `fridgefriend-shopping-list-${date}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function GroceryPlanLoading({ stage }: { stage: "selecting_recipes" | "building_list" }) {
  return (
    <section className="ff-grocery-plan ff-grocery-plan--loading" aria-label="Building grocery plan" aria-live="polite">
      <header className="ff-grocery-plan-heading">
        <div>
          <h3>Building your grocery plan</h3>
          <p>{stage === "selecting_recipes" ? "Selecting meals from your inventory." : "Grouping missing ingredients by aisle."}</p>
        </div>
      </header>
      <div className="ff-recipe-cards" aria-hidden="true">
        {Array.from({ length: 3 }, (_, index) => <RecipeCardSkeleton key={index} />)}
      </div>
      <p className="ff-grocery-plan-pending">Your aisle list will appear when the plan is complete.</p>
    </section>
  );
}

function PantryCompletionLoading({ stage }: { stage: "analyzing_recipes" | "assigning_aisles" }) {
  return (
    <section className="ff-pantry-completion ff-grocery-plan--loading" aria-label="Building smart pantry completion" aria-live="polite">
      <header className="ff-grocery-plan-heading">
        <div>
          <h3>Building smart pantry completion</h3>
          <p>{stage === "analyzing_recipes" ? "Finding high-leverage pantry staples." : "Grouping pantry staples by aisle."}</p>
        </div>
      </header>
      <p className="ff-grocery-plan-pending">Your recipe-unlock suggestions will appear when the plan is complete.</p>
    </section>
  );
}

function PantryCompletionArtifact({
  plan,
  onAdd,
}: {
  plan: PantryCompletionPlan;
  onAdd(items: PantryCompletionSuggestion[]): void;
}) {
  const [addedIngredients, setAddedIngredients] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setAddedIngredients(new Set());
  }, [plan]);

  function add(items: PantryCompletionSuggestion[]) {
    const next = items.filter((item) => !addedIngredients.has(item.ingredient));
    if (next.length === 0) return;
    onAdd(next);
    setAddedIngredients((current) => new Set([...current, ...next.map((item) => item.ingredient)]));
  }

  return (
    <section className="ff-pantry-completion" aria-label="Smart Pantry Completion">
      <header className="ff-grocery-plan-heading">
        <div>
          <h3>Smart Pantry Completion</h3>
          <p>Together, these staples unlock {plan.unlockedRecipeCount} of {plan.eligibleRecipeCount} relevant recipes.</p>
        </div>
        <button disabled={addedIngredients.size === plan.suggestions.length} onClick={() => add(plan.suggestions)} type="button">Add all</button>
      </header>
      <ul className="ff-pantry-completion-list">
        {plan.suggestions.map((suggestion) => {
          const added = addedIngredients.has(suggestion.ingredient);
          return (
            <li key={suggestion.ingredient}>
              <div>
                <strong>{suggestion.ingredient}</strong>
                <span>{GROCERY_AISLE_LABELS[suggestion.aisle]} · supports {suggestion.supportingRecipeCount} unlocked {suggestion.supportingRecipeCount === 1 ? "recipe" : "recipes"}</span>
                <small>{suggestion.recipeNames.join(", ")}</small>
              </div>
              <button disabled={added} onClick={() => add([suggestion])} type="button">{added ? "Added" : "Add"}</button>
            </li>
          );
        })}
      </ul>
      <div>
        <h4>Unlocked recipes</h4>
        <ul className="ff-pantry-completion-list">
          {plan.unlockedRecipes.map((recipe) => (
            <li key={recipe.id}>
              <div>
                <strong>{recipe.name}</strong>
                <small>{recipe.suggestedIngredients.join(", ")}</small>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function GroceryPlanArtifact({
  plan,
  onRecipeIngredientHover,
  onPlanChange,
  compact = false,
  onOpenFullList,
}: {
  plan: GroceryPlan;
  onRecipeIngredientHover?: (ingredients: string[] | null) => void;
  onPlanChange?(plan: GroceryPlan): void;
  compact?: boolean;
  onOpenFullList?(): void;
}) {
  const [page, setPage] = useState(0);
  const [completedIngredients, setCompletedIngredients] = useState<Set<string>>(() => new Set());
  const pageCount = Math.ceil(plan.recipes.length / 3);
  const visibleRecipes = plan.recipes.slice(page * 3, page * 3 + 3);
  const displayedItems = compact ? plan.items.slice(0, 6) : plan.items;
  const groupedItems = displayedItems.reduce<Record<GroceryPlanItem["aisle"], GroceryPlanItem[]>>((groups, item) => {
    groups[item.aisle].push(item);
    return groups;
  }, {
    produce: [], meat_seafood: [], dairy_eggs: [], bakery: [], dry_goods: [], canned_goods: [], frozen: [], condiments_spices: [], beverages: [], other: [],
  });

  useEffect(() => {
    setPage(0);
    setCompletedIngredients(new Set());
  }, [plan]);

  function updateItem(index: number, update: Partial<GroceryPlanItem>) {
    onPlanChange?.({
      ...plan,
      items: plan.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...update } : item),
    });
  }

  function removeItem(index: number) {
    onPlanChange?.({ ...plan, items: plan.items.filter((_, itemIndex) => itemIndex !== index) });
  }

  function addItem() {
    onPlanChange?.({
      ...plan,
      items: [...plan.items, { ingredient: "", aisle: "other", recipeIds: [], recipeNames: [] }],
    });
  }

  return (
    <section className="ff-grocery-plan" aria-label="Grocery plan">
      {plan.recipes.length > 0 ? (
        <>
          <header className="ff-grocery-plan-heading">
            <div>
              <h3>Planned meals</h3>
              <p>{plan.recipes.length} meals selected from your recorded inventory.</p>
            </div>
            {pageCount > 1 ? (
              <nav className="ff-grocery-plan-pages" aria-label="Planned meal pages">
                <button aria-label="Previous planned meals" disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))} type="button">Previous</button>
                <span aria-live="polite">Page {page + 1} of {pageCount}</span>
                <button aria-label="Next planned meals" disabled={page === pageCount - 1} onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))} type="button">Next</button>
              </nav>
            ) : null}
          </header>
          <div className="ff-recipe-cards" aria-label="Planned meal recipes">
            {visibleRecipes.map((recipe) => <RecipeCardLink key={recipe.id} onRecipeIngredientHover={onRecipeIngredientHover} recipe={recipe} />)}
          </div>
        </>
      ) : null}
      <section className="ff-grocery-list" aria-label="Shopping list">
        <header className="ff-grocery-list-heading">
          <div>
            <h4>Shopping list</h4>
            <p>{plan.items.length === 0 ? "Your Grocery List is blank." : compact && plan.items.length > displayedItems.length ? `Showing ${displayedItems.length} of ${plan.items.length} ingredients.` : `${plan.items.length} ingredients grouped by aisle.`}</p>
          </div>
          {compact ? <button onClick={onOpenFullList} type="button">Open Grocery List</button> : <button onClick={() => downloadGroceryPlanCsv(plan, completedIngredients)} type="button">Download CSV</button>}
        </header>
        {Object.entries(groupedItems).flatMap(([aisle, items]) => items.length === 0 ? [] : [
          <section className="ff-grocery-aisle" key={aisle}>
            <h5>{GROCERY_AISLE_LABELS[aisle as GroceryPlanItem["aisle"]]}</h5>
            <ul>
              {items.map((item) => {
                const itemIndex = plan.items.indexOf(item);
                return (
                <li key={`${item.ingredient}-${itemIndex}`}>
                  <label>
                    <input
                      checked={completedIngredients.has(item.ingredient)}
                      onChange={() => setCompletedIngredients((current) => {
                        const next = new Set(current);
                        if (next.has(item.ingredient)) next.delete(item.ingredient);
                        else next.add(item.ingredient);
                        return next;
                      })}
                      type="checkbox"
                    />
                    {onPlanChange && !compact ? (
                      <input aria-label="Grocery item" onChange={(event) => updateItem(itemIndex, { ingredient: event.currentTarget.value })} value={item.ingredient} />
                    ) : <span>{item.ingredient}</span>}
                  </label>
                  {onPlanChange && !compact ? (
                    <span className="ff-grocery-item-controls">
                      <select aria-label="Grocery aisle" onChange={(event) => updateItem(itemIndex, { aisle: event.currentTarget.value as GroceryPlanItem["aisle"] })} value={item.aisle}>
                        {Object.entries(GROCERY_AISLE_LABELS).map(([aisle, label]) => <option key={aisle} value={aisle}>{label}</option>)}
                      </select>
                      <button onClick={() => removeItem(itemIndex)} type="button">Remove</button>
                    </span>
                  ) : null}
                  {item.recipeNames.length > 0 ? <small>For {item.recipeNames.join(", ")}</small> : null}
                </li>
                );
              })}
            </ul>
          </section>,
        ])}
        {onPlanChange && !compact ? <button className="ff-grocery-add-item" onClick={addItem} type="button">Add item</button> : null}
      </section>
    </section>
  );
}

function readableFallback(value: string) {
  return titleCaseLabel(value
    .replace(/[_-]+/gu, " ")
    .trim());
}

function titleCaseLabel(value: string) {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase());
}

function replaceKnownNames(text: string, names: Map<string, string>) {
  let result = text;

  for (const [id, label] of names) {
    result = result.replaceAll(id, label);
  }

  return result;
}

export function organizationPlanArtifactCopy(plan: OrganizationPlan) {
  const isCorrection = plan.priority === "placement_correction";
  return {
    ariaLabel: isCorrection ? "Inventory correction" : "Kitchen organization plan",
    title: isCorrection ? "Inventory correction" : "Organization plan",
    applyLabel: isCorrection ? "Apply correction" : "Apply changes",
    rejectLabel: isCorrection ? "Keep current placement" : "Reject changes",
  };
}

function OrganizationPlanArtifact({
  inventory,
  plan,
  onCompleted,
  onRejected,
}: {
  inventory: Inventory;
  plan: OrganizationPlan;
  onCompleted(inventory: Inventory): void;
  onRejected(): void;
}) {
  const [state, setState] = useState<"ready" | "submitting" | "completed" | "error">("ready");
  const [error, setError] = useState<string | null>(null);
  const itemById = useMemo(() => new Map(inventory.items.map((item) => [item.id, item])), [inventory.items]);
  const zoneById = useMemo(() => new Map(inventory.zones.map((zone) => [zone.id, zone])), [inventory.zones]);
  const readableNames = useMemo(() => new Map([
    ...inventory.items.map((item) => [item.id, titleCaseLabel(item.label)] as const),
    ...inventory.zones.map((zone) => [zone.id, zone.label || readableFallback(zone.id)] as const),
  ]), [inventory.items, inventory.zones]);
  const completed = state === "completed" || plan.status === "completed";
  const copy = organizationPlanArtifactCopy(plan);

  async function complete() {
    if (state === "submitting" || state === "completed" || plan.status !== "pending") return;
    setState("submitting");
    setError(null);
    try {
      const response = await fetch("/api/kitchen-org-plan/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.id }),
      });
      const payload = await response.json() as { inventory?: Inventory; error?: string };
      if (!response.ok || !payload.inventory) throw new Error(payload.error ?? "Kitchen organization plan completion did not return updated inventory");
      onCompleted(payload.inventory);
      setState("completed");
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
      setError(message);
      setState("error");
    }
  }

  return (
    <section className="ff-grocery-plan" aria-label={copy.ariaLabel}>
      <header className="ff-grocery-plan-heading"><div><h3>{copy.title}</h3><p>{replaceKnownNames(plan.summary, readableNames)}</p></div></header>
      <div className="ff-visual-evidence" aria-label="Moved items">
        {plan.moves.map((move) => {
          const item = itemById.get(move.itemId);
          const observation = item?.loc.observations[0];

          if (!item || !observation) {
            return null;
          }

          const cropId = inventorySeedCropId({
            imageId: observation.imageId,
            itemId: item.id,
            observationIndex: 0,
          });

          return (
            <figure className="ff-visual-evidence-item" key={move.itemId}>
              <img alt={`Focused view of ${titleCaseLabel(item.label)}`} src={`/api/inventory-crop?cropId=${encodeURIComponent(cropId)}`} />
              <figcaption>{titleCaseLabel(item.label)}</figcaption>
            </figure>
          );
        })}
      </div>
      <ol>{plan.moves.map((move) => {
        const item = itemById.get(move.itemId);
        const itemLabel = item ? titleCaseLabel(item.label) : readableFallback(move.itemId);
        const fromLabel = zoneById.get(move.fromZoneId)?.label || readableFallback(move.fromZoneId);
        const toLabel = zoneById.get(move.toZoneId)?.label || readableFallback(move.toZoneId);
        const rationale = replaceKnownNames(move.rationale, readableNames);

        return <li key={move.itemId}><strong>{itemLabel}</strong>: move from {fromLabel} to {toLabel}. {rationale}</li>;
      })}</ol>
      {!completed ? (
        <div className="ff-organization-actions">
          <button className="ff-label-button" disabled={state === "submitting"} onClick={() => void complete()} type="button">{state === "submitting" ? "Applying..." : copy.applyLabel}</button>
          <button className="ff-label-button" disabled={state === "submitting"} onClick={onRejected} type="button">{copy.rejectLabel}</button>
        </div>
      ) : null}
    </section>
  );
}

function VisualEvidence({ evidence }: { evidence: QueryVisualEvidence[] }) {
  if (evidence.length === 0) {
    return null;
  }

  return (
    <div className="ff-visual-evidence" aria-label="Images used for this answer">
      {evidence.map((image) => (
        <figure className="ff-visual-evidence-item" key={`${image.itemId}-${image.cropId}`}>
          <img alt={`Focused view of ${image.displayName}`} src={`/api/inventory-crop?cropId=${encodeURIComponent(image.cropId)}`} />
          <figcaption>{image.displayName}</figcaption>
        </figure>
      ))}
    </div>
  );
}

function SeededItemChips({
  items,
  labels,
  removable = false,
  onRemove,
}: {
  items: ConversationContextSeededItem[];
  labels: Record<string, string>;
  removable?: boolean;
  onRemove?: (cropId: string) => void;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="ff-seeded-items" aria-label="Seeded item context">
      {items.map((item) => {
        const label = labels[item.cropId] ?? item.itemId;
        const src = `/api/inventory-crop?cropId=${encodeURIComponent(item.cropId)}`;

        return (
          <span className="ff-seeded-item" key={item.cropId}>
            <img alt="" src={src} />
            <span>{label}</span>
            {removable ? (
              <button aria-label={`Remove ${label}`} onClick={() => onRemove?.(item.cropId)} type="button">×</button>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

function renderInlineMarkdown(text: string) {
  const nodes: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    const key = `${match.index}-${token}`;

    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function parseMarkdownBlocks(markdown: string) {
  const blocks: MarkdownBlock[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let codeLines: string[] | null = null;

  function flushParagraph() {
    if (paragraph.length > 0) {
      blocks.push({
        type: "paragraph",
        lines: paragraph,
      });
      paragraph = [];
    }
  }

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (codeLines) {
        blocks.push({
          type: "code",
          code: codeLines.join("\n"),
        });
        codeLines = null;
      } else {
        flushParagraph();
        codeLines = [];
      }
      continue;
    }

    if (codeLines) {
      codeLines.push(line);
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: "heading",
        level: heading[1].length,
        text: heading[2],
      });
      continue;
    }

    const unorderedItems: string[] = [];
    const orderedItems: string[] = [];
    const unordered = /^\s*[-*]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+\.\s+(.+)$/.exec(line);

    if (unordered) {
      flushParagraph();
      unorderedItems.push(unordered[1]);
      blocks.push({
        type: "unordered-list",
        items: unorderedItems,
      });
      continue;
    }

    if (ordered) {
      flushParagraph();
      orderedItems.push(ordered[1]);
      blocks.push({
        type: "ordered-list",
        items: orderedItems,
      });
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();

  if (codeLines) {
    blocks.push({
      type: "code",
      code: codeLines.join("\n"),
    });
  }

  return blocks.reduce<MarkdownBlock[]>((mergedBlocks, block) => {
    const previous = mergedBlocks[mergedBlocks.length - 1];

    if (
      previous?.type === "unordered-list" &&
      block.type === "unordered-list"
    ) {
      previous.items.push(...block.items);
      return mergedBlocks;
    }

    if (previous?.type === "ordered-list" && block.type === "ordered-list") {
      previous.items.push(...block.items);
      return mergedBlocks;
    }

    mergedBlocks.push(block);
    return mergedBlocks;
  }, []);
}

function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="ff-markdown">
      {parseMarkdownBlocks(text).map((block, index) => {
        if (block.type === "heading") {
          if (block.level === 1) {
            return (
              <h3 key={index}>{renderInlineMarkdown(block.text)}</h3>
            );
          }

          if (block.level === 2) {
            return (
              <h4 key={index}>{renderInlineMarkdown(block.text)}</h4>
            );
          }

          return (
            <h5 key={index}>{renderInlineMarkdown(block.text)}</h5>
          );
        }

        if (block.type === "unordered-list") {
          return (
            <ul key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
              ))}
            </ul>
          );
        }

        if (block.type === "ordered-list") {
          return (
            <ol key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
              ))}
            </ol>
          );
        }

        if (block.type === "code") {
          return (
            <pre key={index}>
              <code>{block.code}</code>
            </pre>
          );
        }

        return (
          <p key={index}>
            {renderInlineMarkdown(block.lines.join("\n"))}
          </p>
        );
      })}
    </div>
  );
}

export function FridgeQueryChat({
  initialChat,
  userId = "default-user",
  fridgeId,
  imageId,
  dietaryRestrictions,
  dietaryPreferences,
  conversationContext,
  draftRequest,
  seededItems,
  seededItemLabels,
  inventory,
  onRemoveSeededItem,
  onClearSeededItems,
  onWorkspaceAction,
  onAgentEvent,
  onQueryStarted,
  onRecipeIngredientHover,
  onGroceryPlan,
  onAddPantryCompletionItems,
  onOpenGroceryList,
  onInventoryUpdated,
  onOrganizationPlanCompleted,
  onOrganizationPlanRejected,
  onDietaryProfileChange,
}: FridgeQueryChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => messagesFromChat(initialChat));
  const [input, setInput] = useState("");
  const [dietaryProfile, setDietaryProfile] = useState(() => ({
    dietaryRestrictions,
    dietaryPreferences,
  }));
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const placeholderIndexRef = useRef(0);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const [previousPlaceholderIndex, setPreviousPlaceholderIndex] = useState<number | null>(null);
  const [status, setStatus] = useState<"ready" | "submitted" | "error">(
    "ready",
  );
  const [error, setError] = useState<string | null>(null);
  const [clarification, setClarification] = useState<InventoryClarificationQuestion[] | null>(null);
  const [clarificationAnswers, setClarificationAnswers] = useState<Record<string, string>>({});
  const [splitReview, setSplitReview] = useState<InventorySplitReview | null>(null);
  const [mutationReview, setMutationReview] = useState<InventoryMutationReview | null>(null);
  const [threadId, setThreadId] = useState(initialChat.id);
  const [executionStatus, setExecutionStatus] = useState(initialChat.executionStatus);
  const [loadedChatScopeKey, setLoadedChatScopeKey] = useState(() => persistedChatScopeKey(initialChat));
  const isPending = status === "submitted";
  const foodLoadingEmojis = useMemo(
    () => loadingFoodEmojis(dietaryProfile.dietaryRestrictions, dietaryProfile.dietaryPreferences),
    [dietaryProfile],
  );
  const expectedChatScopeKey = useMemo(
    () => chatScopeKey(userId, fridgeId, imageId),
    [fridgeId, imageId, userId],
  );

  useEffect(() => {
    setDietaryProfile({ dietaryRestrictions, dietaryPreferences });
  }, [dietaryPreferences, dietaryRestrictions]);

  useEffect(() => {
    placeholderIndexRef.current = placeholderIndex;
  }, [placeholderIndex]);

  useEffect(() => {
    if (input.length > 0) {
      return;
    }

    const interval = window.setInterval(() => {
      const currentIndex = placeholderIndexRef.current;
      const nextIndex = (currentIndex + 1) % CHATBOX_EXAMPLE_PROMPTS.length;

      setPreviousPlaceholderIndex(currentIndex);
      placeholderIndexRef.current = nextIndex;
      setPlaceholderIndex(nextIndex);
    }, 3000);

    return () => window.clearInterval(interval);
  }, [input]);

  useEffect(() => {
    if (previousPlaceholderIndex === null) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setPreviousPlaceholderIndex(null);
    }, 600);

    return () => window.clearTimeout(timeout);
  }, [placeholderIndex, previousPlaceholderIndex]);

  useEffect(() => {
    const nextChatScopeKey = persistedChatScopeKey(initialChat);

    if (nextChatScopeKey !== expectedChatScopeKey) {
      return;
    }

    if (nextChatScopeKey === loadedChatScopeKey) {
      return;
    }

    setMessages(messagesFromChat(initialChat));
    setThreadId(initialChat.id);
    setExecutionStatus(initialChat.executionStatus);
    setLoadedChatScopeKey(nextChatScopeKey);
    setStatus("ready");
    setError(null);
    setClarification(null);
    setClarificationAnswers({});
    setSplitReview(null);
    setMutationReview(null);
  }, [expectedChatScopeKey, initialChat, loadedChatScopeKey]);

  useEffect(() => {
    if (loadedChatScopeKey === expectedChatScopeKey) {
      return;
    }

    const abortController = new AbortController();

    async function loadScopedChat() {
      try {
        const params = new URLSearchParams({ userId, fridgeId });
        if (imageId !== null) {
          params.set("imageId", imageId);
        }
        const response = await fetch(`/api/chats?${params.toString()}`, {
          signal: abortController.signal,
        });
        const payload = await response.json() as { chat?: PersistedChat; error?: string };

        if (!response.ok || !payload.chat) {
          throw new Error(payload.error ?? "Loading the scoped chat did not return a chat thread");
        }

        setMessages(messagesFromChat(payload.chat));
        setThreadId(payload.chat.id);
        setExecutionStatus(payload.chat.executionStatus);
        setLoadedChatScopeKey(persistedChatScopeKey(payload.chat));
        setStatus("ready");
        setError(null);
        setClarification(null);
        setClarificationAnswers({});
        setSplitReview(null);
        setMutationReview(null);
      } catch (caughtError) {
        if (caughtError instanceof DOMException && caughtError.name === "AbortError") {
          return;
        }

        const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
        setError(`Loading chat failed: ${message}`);
        setStatus("error");
      }
    }

    void loadScopedChat();

    return () => abortController.abort();
  }, [expectedChatScopeKey, fridgeId, imageId, loadedChatScopeKey, userId]);

  useEffect(() => {
    if (draftRequest) {
      setInput(draftRequest.text);
    }
  }, [draftRequest]);

  useLayoutEffect(() => {
    const field = inputRef.current;

    if (!field) {
      return;
    }

    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [input]);

  useLayoutEffect(() => {
    const messagesElement = messagesRef.current;

    if (!messagesElement) {
      return;
    }

    messagesElement.scrollTop = messagesElement.scrollHeight;
  }, [messages, error]);

  function updateAssistantMessage(
    messageId: string,
    update: (message: ChatMessage) => ChatMessage,
  ) {
    setMessages((currentMessages) =>
      currentMessages.map((message) =>
        message.id === messageId ? update(message) : message
      )
    );
  }

  function setCurrentStep(message: ChatMessage, line: string): ChatMessage {
    return {
      ...message,
      statusLines: [line],
    };
  }

  function releaseChatInput() {
    setStatus((currentStatus) => currentStatus === "submitted" ? "ready" : currentStatus);
  }

  function handleQueryFailure(messageId: string, caughtError: unknown) {
    const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
    console.error("Query graph request failed", message);
    setError(null);
    updateAssistantMessage(messageId, withoutQueryFailureState);
    setStatus("ready");
    setExecutionStatus("idle");
  }

  function handleStreamEvent(messageId: string, event: QueryStreamEvent) {
    if (event.type === "status") {
      updateAssistantMessage(messageId, (message) =>
        message.groceryPlanPending || message.groceryPlan || message.groceryPlanError || message.pantryCompletionPending || message.pantryCompletionPlan || message.pantryCompletionError || message.pantryCompletionClarification
          ? message
          : setCurrentStep(message, formatNodeStatus(event.node, event.message))
      );
      return;
    }

    if (event.type === "tool") {
      updateAssistantMessage(messageId, (message) =>
        message.groceryPlanPending || message.groceryPlan || message.groceryPlanError || message.pantryCompletionPending || message.pantryCompletionPlan || message.pantryCompletionError || message.pantryCompletionClarification
          ? message
          : setCurrentStep(message, formatToolStatus(event))
      );
      return;
    }

    if (event.type === "recipe_tournament_started") {
      updateAssistantMessage(messageId, (message) => ({
        ...message,
        text: "",
        statusLines: undefined,
        recipeTournament: {
          status: "running",
          candidateCount: event.candidateCount,
          displaySlotCount: event.displaySlotCount,
          evaluatedCount: 0,
          totalCount: event.candidateCount,
          recipes: [],
          exitingRecipes: [],
        },
      }));
      return;
    }

    if (event.type === "expiry_plan") {
      updateAssistantMessage(messageId, (message) => ({
        ...message,
        expiryPlan: event.plan,
        statusLines: undefined,
      }));
      return;
    }

    if (event.type === "grocery_plan_progress") {
      updateAssistantMessage(messageId, (message) => ({
        ...message,
        text: "",
        statusLines: undefined,
        recipes: undefined,
        recipeTournament: undefined,
        groceryPlan: undefined,
        groceryPlanError: undefined,
        groceryPlanPending: true,
        groceryPlanStage: event.stage,
      }));
      return;
    }

    if (event.type === "grocery_plan") {
      onGroceryPlan(event.plan);
      updateAssistantMessage(messageId, (message) => ({
        ...message,
        text: "",
        statusLines: undefined,
        recipes: undefined,
        recipeTournament: undefined,
        groceryPlan: event.plan,
        groceryPlanError: undefined,
        groceryPlanPending: false,
        groceryPlanStage: undefined,
      }));
      return;
    }

    if (event.type === "grocery_plan_error") {
      updateAssistantMessage(messageId, (message) => ({
        ...message,
        statusLines: undefined,
        recipeTournament: undefined,
        groceryPlan: undefined,
        groceryPlanError: event.error,
        groceryPlanPending: false,
        groceryPlanStage: undefined,
      }));
      return;
    }

    if (event.type === "pantry_completion_progress") {
      updateAssistantMessage(messageId, (message) => ({
        ...message,
        text: "",
        statusLines: undefined,
        recipes: undefined,
        recipeTournament: undefined,
        pantryCompletionPlan: undefined,
        pantryCompletionError: undefined,
        pantryCompletionClarification: undefined,
        pantryCompletionPending: true,
        pantryCompletionStage: event.stage,
      }));
      return;
    }

    if (event.type === "pantry_completion") {
      updateAssistantMessage(messageId, (message) => ({
        ...message,
        text: "",
        statusLines: undefined,
        recipes: undefined,
        recipeTournament: undefined,
        pantryCompletionPlan: event.plan,
        pantryCompletionError: undefined,
        pantryCompletionClarification: undefined,
        pantryCompletionPending: false,
        pantryCompletionStage: undefined,
      }));
      return;
    }

    if (event.type === "pantry_completion_error") {
      updateAssistantMessage(messageId, (message) => ({
        ...message,
        statusLines: undefined,
        recipeTournament: undefined,
        pantryCompletionPlan: undefined,
        pantryCompletionError: event.error,
        pantryCompletionClarification: undefined,
        pantryCompletionPending: false,
        pantryCompletionStage: undefined,
      }));
      return;
    }

    if (event.type === "pantry_completion_clarification") {
      updateAssistantMessage(messageId, (message) => ({
        ...message,
        text: event.message,
        statusLines: undefined,
        recipes: undefined,
        recipeTournament: undefined,
        pantryCompletionPlan: undefined,
        pantryCompletionError: undefined,
        pantryCompletionClarification: event.message,
        pantryCompletionPending: false,
        pantryCompletionStage: undefined,
      }));
      return;
    }

    if (event.type === "organization_plan") {
      updateAssistantMessage(messageId, (message) => ({
        ...message,
        text: "",
        statusLines: undefined,
        organizationPlan: event.plan,
      }));
      return;
    }

    if (event.type === "recipe_tournament_update") {
      updateAssistantMessage(messageId, (message) => {
        const previousTournament = message.recipeTournament;
        const recipes = stableRecipeSlots(previousTournament?.recipes ?? [], event.recipes);

        return {
          ...message,
          text: "",
          statusLines: undefined,
          recipeTournament: {
            status: "running",
            candidateCount: previousTournament?.candidateCount ?? event.totalCount,
            displaySlotCount: previousTournament?.displaySlotCount ?? Math.min(RECIPE_TOURNAMENT_DISPLAY_LIMIT, event.totalCount),
            evaluatedCount: event.evaluatedCount,
            totalCount: event.totalCount,
            recipes,
            exitingRecipes: [],
          },
        };
      });
      return;
    }

    if (event.type === "recipe_tournament_finished") {
      updateAssistantMessage(messageId, (message) => ({
        ...message,
        text: "",
        statusLines: undefined,
        recipes: undefined,
        recipeTournament: {
          status: "finished",
          candidateCount: message.recipeTournament?.candidateCount ?? event.recipes.length,
          displaySlotCount: event.recipes.length,
          evaluatedCount: message.recipeTournament?.totalCount ?? event.recipes.length,
          totalCount: message.recipeTournament?.totalCount ?? event.recipes.length,
          recipes: event.recipes.slice(0, RECIPE_TOURNAMENT_DISPLAY_LIMIT),
          exitingRecipes: [],
        },
      }));
      return;
    }

    if (event.type === "workspace_action") {
      onWorkspaceAction(event.action);
      return;
    }

    if (event.type === "agent_event") {
      onAgentEvent(event.event);
      return;
    }

    if (event.type === "clarification") {
      setExecutionStatus("interrupted");
      setClarification(event.questions);
      setClarificationAnswers({});
      releaseChatInput();
      updateAssistantMessage(messageId, withoutHitlLoadingState);
      return;
    }

    if (event.type === "inventory_split_review") {
      setExecutionStatus("interrupted");
      setSplitReview({ scopeLabel: event.scopeLabel, summary: event.summary, items: event.items });
      releaseChatInput();
      updateAssistantMessage(messageId, withoutHitlLoadingState);
      return;
    }

    if (event.type === "inventory_mutation_review") {
      setExecutionStatus("interrupted");
      setMutationReview({ operation: event.operation, itemName: event.itemName, storageLocation: event.storageLocation });
      releaseChatInput();
      updateAssistantMessage(messageId, withoutHitlLoadingState);
      return;
    }

    if (event.type === "inventory_updated") {
      onInventoryUpdated(event.inventory as Inventory);
      return;
    }

    if (event.type === "memory_update") {
      const nextDietaryProfile = {
        dietaryRestrictions: event.dietaryRestrictions,
        dietaryPreferences: event.dietaryPreferences,
        activeGoals: event.activeGoals,
      };

      setDietaryProfile(nextDietaryProfile);
      onDietaryProfileChange(nextDietaryProfile);
      if (event.status === "verified") {
        updateAssistantMessage(messageId, (message) => ({
          ...message,
          memoryUpdateMessage: event.message,
        }));
      }
      return;
    }

    if (event.type === "token") {
      updateAssistantMessage(messageId, (message) => ({
        ...message,
        text: `${message.text}${event.text}`,
        statusLines: undefined,
      }));
      return;
    }

    if (event.type === "final") {
      setExecutionStatus("idle");
      releaseChatInput();
      const nextDietaryProfile = {
        dietaryRestrictions: event.dietaryRestrictions,
        dietaryPreferences: event.dietaryPreferences,
        activeGoals: event.activeGoals,
      };

      setDietaryProfile(nextDietaryProfile);
      onDietaryProfileChange(nextDietaryProfile);
      if (event.groceryPlan) {
        onGroceryPlan(event.groceryPlan);
      }
      updateAssistantMessage(messageId, (message) => ({
        ...message,
        text: [
          finalAssistantMessageText(message.text, event),
          message.memoryUpdateMessage,
        ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join("\n\n"),
        statusLines: undefined,
        streaming: false,
        recipes: event.groceryPlan || event.groceryPlanError || event.pantryCompletionPlan || event.pantryCompletionError || event.pantryCompletionClarification ? undefined : message.recipeTournament ? undefined : event.recipes,
        recipeTournament: event.groceryPlan || event.groceryPlanError || event.pantryCompletionPlan || event.pantryCompletionError || event.pantryCompletionClarification ? undefined : message.recipeTournament && event.recipes.length > 0
          ? {
            ...message.recipeTournament,
            status: "finished",
            displaySlotCount: event.recipes.length,
            recipes: event.recipes.slice(0, RECIPE_TOURNAMENT_DISPLAY_LIMIT),
            exitingRecipes: [],
          }
          : message.recipeTournament,
        visualEvidence: event.visualEvidence,
        expiryPlan: event.expiryPlan ?? message.expiryPlan,
        groceryPlan: event.groceryPlan ?? message.groceryPlan,
        groceryPlanError: event.groceryPlanError ?? message.groceryPlanError,
        groceryPlanPending: false,
        groceryPlanStage: undefined,
        pantryCompletionPlan: event.pantryCompletionPlan ?? message.pantryCompletionPlan,
        pantryCompletionError: event.pantryCompletionError ?? message.pantryCompletionError,
        pantryCompletionClarification: event.pantryCompletionClarification ?? message.pantryCompletionClarification,
        pantryCompletionPending: false,
        pantryCompletionStage: undefined,
        organizationPlan: event.organizationPlan ?? message.organizationPlan,
      }));
      return;
    }

    handleQueryFailure(messageId, event.error);
  }

  async function submitQuery(query: string, options: { recipeContinuation?: boolean } = {}) {
    if (query.length === 0 || isPending) {
      return;
    }

    const assistantMessage = createAssistantMessage("", {
      statusLines: ["Sending message..."],
      streaming: true,
    });
    const userMessage = createUserMessage(query, seededItems);

    setMessages((currentMessages) => [
      ...currentMessages,
      userMessage,
      assistantMessage,
    ]);
    const submittedContext = {
      ...conversationContext,
      seededItems,
    };
    setInput("");
    setError(null);
    setStatus("submitted");
    setExecutionStatus("running");
    onQueryStarted();
    onClearSeededItems();

    try {
      const response = await fetch("/api/query", {
        method: "POST",
        headers: {
          Accept: "application/x-ndjson",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          userId,
          fridgeId,
          imageId,
          query,
          threadId,
          requestId: crypto.randomUUID(),
          recipeContinuation: options.recipeContinuation === true,
          conversationContext: submittedContext,
          userMessageId: userMessage.id,
          assistantMessageId: assistantMessage.id,
        }),
      });
      await readQueryStream(response, (streamEvent) =>
        handleStreamEvent(assistantMessage.id, streamEvent)
      );
      setStatus("ready");
      setExecutionStatus("idle");
    } catch (caughtError) {
      handleQueryFailure(assistantMessage.id, caughtError);
    }
  }

  async function resumeClarification(skipAll = false) {
    if (!clarification || isPending) return;

    const assistantMessage = createAssistantMessage("", {
      statusLines: ["Updating inventory details..."],
      streaming: true,
    });
    const userMessageText = skipAll ? "Skip inventory clarification" : "Confirm inventory clarification";
    const userMessage = createUserMessage(userMessageText, []);
    const answers: Record<string, string> = {};
    const skipped: string[] = [];
    for (const question of clarification) {
      const key = `${question.itemId}:${question.field}`;
      const answer = clarificationAnswers[key]?.trim();
      if (!skipAll && answer) {
        answers[key] = answer;
      } else {
        skipped.push(key);
      }
    }

    setMessages((currentMessages) => [
      ...currentMessages,
      userMessage,
      assistantMessage,
    ]);
    setClarification(null);
    setClarificationAnswers({});
    setError(null);
    setStatus("submitted");
    setExecutionStatus("running");

    try {
      const response = await fetch("/api/query", {
        method: "POST",
        headers: {
          Accept: "application/x-ndjson",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "resume", userId, fridgeId, imageId, threadId, resume: { answers, skipped }, userMessageId: userMessage.id, assistantMessageId: assistantMessage.id, userMessageText }),
      });
      await readQueryStream(response, (streamEvent) => handleStreamEvent(assistantMessage.id, streamEvent));
      setStatus("ready");
      setExecutionStatus("idle");
    } catch (caughtError) {
      handleQueryFailure(assistantMessage.id, caughtError);
    }
  }

  async function resumeSplitReview(approved: boolean) {
    if (!splitReview || isPending) return;
    const assistantMessage = createAssistantMessage("", {
      statusLines: [approved ? "Updating inventory..." : "Keeping the existing inventory..."],
      streaming: true,
    });
    const userMessageText = approved ? "Apply proposed inventory split" : "Keep current inventory";
    const userMessage = createUserMessage(userMessageText, []);
    setMessages((currentMessages) => [
      ...currentMessages,
      userMessage,
      assistantMessage,
    ]);
    setSplitReview(null);
    setError(null);
    setStatus("submitted");
    setExecutionStatus("running");

    try {
      const response = await fetch("/api/query", {
        method: "POST",
        headers: { Accept: "application/x-ndjson", "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resume", userId, fridgeId, imageId, threadId, resume: { answers: {}, skipped: [], splitReview: { approved } }, userMessageId: userMessage.id, assistantMessageId: assistantMessage.id, userMessageText }),
      });
      await readQueryStream(response, (streamEvent) => handleStreamEvent(assistantMessage.id, streamEvent));
      setStatus("ready");
      setExecutionStatus("idle");
    } catch (caughtError) {
      handleQueryFailure(assistantMessage.id, caughtError);
    }
  }

  async function resumeMutationReview(approved: boolean) {
    if (!mutationReview || isPending) return;
    const actionLabel = mutationReview.operation === "consume" ? "mark as consumed" : "remove";
    const assistantMessage = createAssistantMessage("", {
      statusLines: [approved ? "Updating inventory..." : "Keeping the existing inventory..."],
      streaming: true,
    });
    const userMessageText = approved ? `Approve inventory ${actionLabel}` : "Keep current inventory";
    const userMessage = createUserMessage(userMessageText, []);
    setMessages((currentMessages) => [
      ...currentMessages,
      userMessage,
      assistantMessage,
    ]);
    setMutationReview(null);
    setError(null);
    setStatus("submitted");
    setExecutionStatus("running");

    try {
      const response = await fetch("/api/query", {
        method: "POST",
        headers: { Accept: "application/x-ndjson", "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resume", userId, fridgeId, imageId, threadId, resume: { answers: {}, skipped: [], inventoryMutationReview: { approved } }, userMessageId: userMessage.id, assistantMessageId: assistantMessage.id, userMessageText }),
      });
      await readQueryStream(response, (streamEvent) => handleStreamEvent(assistantMessage.id, streamEvent));
      setStatus("ready");
      setExecutionStatus("idle");
    } catch (caughtError) {
      handleQueryFailure(assistantMessage.id, caughtError);
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitQuery(input.trim());
  }

  function handleFieldKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey) {
      return;
    }

    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  async function continueExecution() {
    if (isPending || executionStatus === "idle") {
      return;
    }

    const assistantMessage = [...messages].reverse().find((message) => message.role === "assistant");

    if (!assistantMessage) {
      setError("This chat has no assistant response to continue");
      return;
    }

    setError(null);
    setStatus("submitted");
    setExecutionStatus("running");
    updateAssistantMessage(assistantMessage.id, (message) => ({
      ...message,
      statusLines: ["Resuming response..."],
      streaming: true,
    }));

    try {
      const response = await fetch("/api/query", {
        method: "POST",
        headers: { Accept: "application/x-ndjson", "Content-Type": "application/json" },
        body: JSON.stringify({ action: "continue", userId, fridgeId, imageId, threadId }),
      });
      await readQueryStream(response, (streamEvent) => handleStreamEvent(assistantMessage.id, streamEvent));
      setStatus("ready");
      setExecutionStatus("idle");
    } catch (caughtError) {
      handleQueryFailure(assistantMessage.id, caughtError);
    }
  }

  async function handleClearChat() {
    if (isPending) {
      return;
    }

    try {
      const response = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear", userId, fridgeId, imageId }),
      });
      const payload = await response.json() as { chat?: PersistedChat; error?: string };

      if (!response.ok || !payload.chat) {
        throw new Error(payload.error ?? "Clearing chat did not return a new chat thread");
      }

      setMessages(messagesFromChat(payload.chat));
      setInput("");
      setError(null);
      setStatus("ready");
      setExecutionStatus(payload.chat.executionStatus);
      setClarification(null);
      setClarificationAnswers({});
      setSplitReview(null);
      setMutationReview(null);
      setThreadId(payload.chat.id);
      onClearSeededItems();
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
      setError(`Clearing chat failed: ${message}`);
    }
  }

  return (
    <section className="ff-chat-panel" aria-label="Fridge query chat">
      <div className="ff-chat-toolbar">
        {executionStatus !== "idle" && !clarification && !splitReview && !mutationReview ? (
          <button
            className="ff-chat-clear"
            disabled={isPending}
            onClick={() => void continueExecution()}
            type="button"
          >
            Resume response
          </button>
        ) : null}
        <button
          className="ff-chat-clear"
          disabled={isPending}
          onClick={() => void handleClearChat()}
          type="button"
        >
          Clear chat
        </button>
      </div>
      <div className="ff-chat-messages" aria-live="polite" ref={messagesRef}>
        <div className="ff-chat-message-list">
          {messages.map((message) => {
            if (
              message.role === "assistant" &&
              !hasVisibleAssistantContent(message)
            ) {
              return null;
            }

            return (
              <div
                className={`ff-chat-message ff-chat-message--${message.role}`}
                key={message.id}
              >
                {message.role === "assistant" ? (
                  <>
                    {message.streaming && message.statusLines && message.statusLines.length > 0 && !hasAssistantResponseContent(message) ? (
                      <FoodLoadingIndicator foods={foodLoadingEmojis} />
                    ) : null}
                    {message.text.length > 0 ? (
                      <MarkdownMessage text={message.text} />
                    ) : null}
                    {message.groceryPlanPending ? <GroceryPlanLoading stage={message.groceryPlanStage ?? "selecting_recipes"} /> : null}
                    {message.groceryPlan ? <GroceryPlanArtifact compact onOpenFullList={onOpenGroceryList} onRecipeIngredientHover={onRecipeIngredientHover} plan={message.groceryPlan} /> : null}
                    {message.pantryCompletionPending ? <PantryCompletionLoading stage={message.pantryCompletionStage ?? "analyzing_recipes"} /> : null}
                    {message.pantryCompletionPlan ? <PantryCompletionArtifact onAdd={onAddPantryCompletionItems} plan={message.pantryCompletionPlan} /> : null}
                    {message.organizationPlan ? <OrganizationPlanArtifact inventory={inventory} onCompleted={onOrganizationPlanCompleted} onRejected={onOrganizationPlanRejected} plan={message.organizationPlan} /> : null}
                    {message.recipeTournament && !message.groceryPlanPending && !message.groceryPlan && !message.groceryPlanError && !message.pantryCompletionPending && !message.pantryCompletionPlan && !message.pantryCompletionError && !message.pantryCompletionClarification ? (
                      <RecipeTournament onRecipeIngredientHover={onRecipeIngredientHover} tournament={message.recipeTournament} onMore={() => void submitQuery("Show more recipes.", { recipeContinuation: true })} />
                    ) : null}
                    {message.expiryPlan ? <ExpiryPlanSummary plan={message.expiryPlan} /> : null}
                    {message.recipes && !message.groceryPlanPending && !message.groceryPlan && !message.groceryPlanError && !message.pantryCompletionPending && !message.pantryCompletionPlan && !message.pantryCompletionError && !message.pantryCompletionClarification ? <RecipeCards onRecipeIngredientHover={onRecipeIngredientHover} recipes={message.recipes} onMore={() => void submitQuery("Show more recipes.", { recipeContinuation: true })} /> : null}
                    {message.visualEvidence ? <VisualEvidence evidence={message.visualEvidence} /> : null}
                  </>
                ) : (
                  <>
                    {message.seededItems ? (
                      <SeededItemChips
                        items={message.seededItems}
                        labels={seededItemLabels}
                      />
                    ) : null}
                    <p>{message.text}</p>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {clarification ? (
        <div className="ff-chat-clarification" aria-label="Inventory clarification">
          {clarification.map((question) => {
            const key = `${question.itemId}:${question.field}`;
            return (
              <label key={key}>
                <span>{question.question}</span>
                <input
                  disabled={isPending}
                  onChange={(event) => setClarificationAnswers((current) => ({ ...current, [key]: event.currentTarget.value }))}
                  value={clarificationAnswers[key] ?? ""}
                />
              </label>
            );
          })}
          <div>
            <button disabled={isPending} onClick={() => void resumeClarification()} type="button">Continue</button>
            <button disabled={isPending} onClick={() => void resumeClarification(true)} type="button">Skip</button>
          </div>
        </div>
      ) : null}
      {splitReview ? (
        <div className="ff-chat-clarification" aria-label="Review inventory split">
          <p>Update inventory for {splitReview.scopeLabel}?</p>
          <p>{splitReview.summary}</p>
          <ul>{splitReview.items.map((item) => <li key={item.name}>{item.label}</li>)}</ul>
          <div>
            <button disabled={isPending} onClick={() => void resumeSplitReview(true)} type="button">Yes, update inventory</button>
            <button disabled={isPending} onClick={() => void resumeSplitReview(false)} type="button">No, keep it as is</button>
          </div>
        </div>
      ) : null}
      {mutationReview ? (
        <div className="ff-chat-clarification" aria-label="Review inventory mutation">
          <p>{mutationReview.operation === "consume" ? "Mark this item as consumed?" : "Remove this item from inventory?"}</p>
          <p>{mutationReview.itemName} in {mutationReview.storageLocation}</p>
          <div>
            <button disabled={isPending} onClick={() => void resumeMutationReview(true)} type="button">{mutationReview.operation === "consume" ? "Yes, mark consumed" : "Yes, remove it"}</button>
            <button disabled={isPending} onClick={() => void resumeMutationReview(false)} type="button">No, keep it</button>
          </div>
        </div>
      ) : null}
      <form className="ff-chat-form" onSubmit={handleSubmit}>
        <SeededItemChips
          items={seededItems}
          labels={seededItemLabels}
          onRemove={onRemoveSeededItem}
          removable
        />
        <div className="ff-chat-field-shell">
          <textarea
            aria-label="Ask FridgeFriend"
            className="ff-chat-field"
            onKeyDown={handleFieldKeyDown}
            onChange={(event) => setInput(event.currentTarget.value)}
            placeholder={CHATBOX_EXAMPLE_PROMPTS[placeholderIndex]}
            ref={inputRef}
            rows={2}
            value={input}
          />
          {input.length === 0 ? (
            <div className="ff-chat-placeholder" aria-hidden="true">
              {previousPlaceholderIndex !== null ? (
                <span className="ff-chat-placeholder__text ff-chat-placeholder__text--previous" key={`previous-${previousPlaceholderIndex}`}>
                  {CHATBOX_EXAMPLE_PROMPTS[previousPlaceholderIndex]}
                </span>
              ) : null}
              <span
                className={`ff-chat-placeholder__text ff-chat-placeholder__text--current${previousPlaceholderIndex === null ? "" : " ff-chat-placeholder__text--incoming"}`}
                key={`current-${placeholderIndex}`}
              >
                {CHATBOX_EXAMPLE_PROMPTS[placeholderIndex]}
              </span>
            </div>
          ) : null}
        </div>
        <button aria-label="Send" className="ff-chat-submit" disabled={isPending || clarification !== null || splitReview !== null || mutationReview !== null} type="submit">
          ↑
        </button>
      </form>
    </section>
  );
}
