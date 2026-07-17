import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  readQueryStream,
  type InventoryClarificationQuestion,
  type ExpiryPlan,
  type RecipeCard,
  type QueryStreamEvent,
  type QueryVisualEvidence,
} from "./query-stream";
import type {
  AgentActivityEvent,
  ConversationContext,
  ConversationContextSeededItem,
  WorkspaceAction,
} from "../workspace/contracts";

type FridgeQueryChatProps = {
  userId?: string;
  fridgeId: string;
  imageId: string | null;
  conversationContext: ConversationContext;
  draftRequest: { id: string; text: string } | null;
  seededItems: ConversationContextSeededItem[];
  seededItemLabels: Record<string, string>;
  onRemoveSeededItem(cropId: string): void;
  onClearSeededItems(): void;
  onWorkspaceAction(action: WorkspaceAction): void;
  onAgentEvent(event: AgentActivityEvent): void;
  onQueryStarted(): void;
  onRecipeIngredientHover?(ingredients: string[] | null): void;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  statusLines?: string[];
  streaming?: boolean;
  recipes?: RecipeCard[];
  recipeTournament?: RecipeTournamentState;
  expiryPlan?: ExpiryPlan;
  visualEvidence?: QueryVisualEvidence[];
  seededItems?: ConversationContextSeededItem[];
};

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
  zoneId: string;
  summary: string;
  items: Array<{ label: string; name: string }>;
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

const initialMessages: ChatMessage[] = [
  {
    id: "fridge-query-initial-message",
    role: "assistant",
    text: "What would you like to know about your fridge? I can look for recipes you can make from these items, suggest ingredients, and more.",
  },
];

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
    (message.visualEvidence?.length ?? 0) > 0
  );
}

function formatNodeStatus(node: string | undefined, message: string) {
  return node ? `${node}: ${message}` : message;
}

function formatToolStatus(event: Extract<QueryStreamEvent, { type: "tool" }>) {
  return `${event.name}: ${event.message}`;
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
  const className = [
    "ff-recipe-card",
    recipe.tournamentPlacement === "winner" ? "ff-recipe-card-winner" : "",
    exiting ? "ff-recipe-card-exiting" : "ff-recipe-card-entering",
  ].filter(Boolean).join(" ");

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
        {recipe.tournamentPlacement === "winner" ? <span className="ff-recipe-card-winner-label">Tournament winner</span> : null}
        {recipe.tournamentPlacement === "finalist" ? <span className="ff-recipe-card-finalist-label">Tournament finalist</span> : null}
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
  exitingRecipes = [],
}: {
  recipes: RecipeCard[];
  onMore: () => void;
  onRecipeIngredientHover?: (ingredients: string[] | null) => void;
  exitingRecipes?: RecipeCard[];
}) {
  if (recipes.length === 0) {
    return null;
  }

  return (
    <div className="ff-recipe-cards" aria-label="Recipe suggestions">
      {recipes.map((recipe) => (
        <RecipeCardLink key={recipe.id} onRecipeIngredientHover={onRecipeIngredientHover} recipe={recipe} />
      ))}
      {exitingRecipes.map((recipe) => (
        <RecipeCardLink exiting key={`${recipe.id}-exiting`} onRecipeIngredientHover={onRecipeIngredientHover} recipe={recipe} />
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

function VisualEvidence({ evidence }: { evidence: QueryVisualEvidence[] }) {
  if (evidence.length === 0) {
    return null;
  }

  return (
    <div className="ff-visual-evidence" aria-label="Images used for this answer">
      {evidence.map((image) => (
        <figure className="ff-visual-evidence-item" key={`${image.itemId}-${image.dataUrl}`}>
          <img alt={`Focused view of ${image.displayName}`} src={image.dataUrl} />
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
  userId = "default-user",
  fridgeId,
  imageId,
  conversationContext,
  draftRequest,
  seededItems,
  seededItemLabels,
  onRemoveSeededItem,
  onClearSeededItems,
  onWorkspaceAction,
  onAgentEvent,
  onQueryStarted,
  onRecipeIngredientHover,
}: FridgeQueryChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"ready" | "submitted" | "error">(
    "ready",
  );
  const [error, setError] = useState<string | null>(null);
  const [clarification, setClarification] = useState<InventoryClarificationQuestion[] | null>(null);
  const [clarificationAnswers, setClarificationAnswers] = useState<Record<string, string>>({});
  const [splitReview, setSplitReview] = useState<InventorySplitReview | null>(null);
  const [threadId] = useState(() => crypto.randomUUID());
  const isPending = status === "submitted";

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

  function handleStreamEvent(messageId: string, event: QueryStreamEvent) {
    if (event.type === "status") {
      updateAssistantMessage(messageId, (message) =>
        setCurrentStep(message, formatNodeStatus(event.node, event.message))
      );
      return;
    }

    if (event.type === "tool") {
      updateAssistantMessage(messageId, (message) =>
        setCurrentStep(message, formatToolStatus(event))
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
      setClarification(event.questions);
      setClarificationAnswers({});
      updateAssistantMessage(messageId, (message) => ({
        ...message,
        text: event.questions.map((question) => question.question).join("\n\n"),
        statusLines: undefined,
        streaming: false,
      }));
      return;
    }

    if (event.type === "inventory_split_review") {
      setSplitReview({ zoneId: event.zoneId, summary: event.summary, items: event.items });
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
      updateAssistantMessage(messageId, (message) => ({
        ...message,
        text: event.recipes.length > 0 ? "" : event.answer,
        statusLines: undefined,
        streaming: false,
        recipes: message.recipeTournament ? undefined : event.recipes,
        recipeTournament: message.recipeTournament && event.recipes.length > 0
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
      }));
      return;
    }

    throw new Error(event.error);
  }

  async function submitQuery(query: string) {
    if (query.length === 0 || isPending) {
      return;
    }

    const assistantMessage = createAssistantMessage("", {
      statusLines: ["Sending message..."],
      streaming: true,
    });

    setMessages((currentMessages) => [
      ...currentMessages,
      createUserMessage(query, seededItems),
      assistantMessage,
    ]);
    const submittedContext = {
      ...conversationContext,
      seededItems,
    };
    setInput("");
    setError(null);
    setStatus("submitted");
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
          conversationContext: submittedContext,
        }),
      });
      await readQueryStream(response, (streamEvent) =>
        handleStreamEvent(assistantMessage.id, streamEvent)
      );
      setStatus("ready");
    } catch (caughtError) {
      const messageText =
        caughtError instanceof Error ? caughtError.message : String(caughtError);

      setError(messageText);
      updateAssistantMessage(assistantMessage.id, (message) => ({
        ...message,
        text: `Query graph error: ${messageText}`,
        statusLines: undefined,
        streaming: false,
      }));
      setStatus("error");
    }
  }

  async function resumeClarification(skipAll = false) {
    if (!clarification || isPending) return;

    const assistantMessage = createAssistantMessage("", {
      statusLines: ["Updating inventory details..."],
      streaming: true,
    });
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
      createUserMessage(skipAll ? "Skip inventory clarification" : "Confirm inventory clarification", []),
      assistantMessage,
    ]);
    setClarification(null);
    setClarificationAnswers({});
    setError(null);
    setStatus("submitted");

    try {
      const response = await fetch("/api/query", {
        method: "POST",
        headers: {
          Accept: "application/x-ndjson",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "resume", threadId, resume: { answers, skipped } }),
      });
      await readQueryStream(response, (streamEvent) => handleStreamEvent(assistantMessage.id, streamEvent));
      setStatus("ready");
    } catch (caughtError) {
      const messageText = caughtError instanceof Error ? caughtError.message : String(caughtError);
      setError(messageText);
      updateAssistantMessage(assistantMessage.id, (message) => ({
        ...message,
        text: `Query graph error: ${messageText}`,
        statusLines: undefined,
        streaming: false,
      }));
      setStatus("error");
    }
  }

  async function resumeSplitReview(approved: boolean) {
    if (!splitReview || isPending) return;
    const assistantMessage = createAssistantMessage("", {
      statusLines: [approved ? "Updating drawer inventory..." : "Keeping the existing drawer inventory..."],
      streaming: true,
    });
    setMessages((currentMessages) => [
      ...currentMessages,
      createUserMessage(approved ? "Apply drawer inventory split" : "Keep current drawer inventory", []),
      assistantMessage,
    ]);
    setSplitReview(null);
    setError(null);
    setStatus("submitted");

    try {
      const response = await fetch("/api/query", {
        method: "POST",
        headers: { Accept: "application/x-ndjson", "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resume", threadId, resume: { answers: {}, skipped: [], splitReview: { approved } } }),
      });
      await readQueryStream(response, (streamEvent) => handleStreamEvent(assistantMessage.id, streamEvent));
      setStatus("ready");
    } catch (caughtError) {
      const messageText = caughtError instanceof Error ? caughtError.message : String(caughtError);
      setError(messageText);
      updateAssistantMessage(assistantMessage.id, (message) => ({ ...message, text: `Query graph error: ${messageText}`, statusLines: undefined, streaming: false }));
      setStatus("error");
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

  return (
    <section className="ff-chat-panel" aria-label="Fridge query chat">
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
                    {message.statusLines && message.statusLines.length > 0 ? (
                      <div className="ff-chat-progress">
                        {message.statusLines.map((line, index) => (
                          <p key={`${line}-${index}`}>{line}</p>
                        ))}
                      </div>
                    ) : null}
                    {message.text.length > 0 ? (
                      <MarkdownMessage text={message.text} />
                    ) : null}
                    {message.recipeTournament ? (
                      <RecipeTournament onRecipeIngredientHover={onRecipeIngredientHover} tournament={message.recipeTournament} onMore={() => void submitQuery("Show more recipes.")} />
                    ) : null}
                    {message.expiryPlan ? <ExpiryPlanSummary plan={message.expiryPlan} /> : null}
                    {message.recipes ? <RecipeCards onRecipeIngredientHover={onRecipeIngredientHover} recipes={message.recipes} onMore={() => void submitQuery("Show more recipes.")} /> : null}
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
          {error ? <p className="ff-chat-error">{error}</p> : null}
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
        <div className="ff-chat-clarification" aria-label="Review drawer inventory split">
          <p>{splitReview.summary}</p>
          <ul>{splitReview.items.map((item) => <li key={item.name}>{item.label}</li>)}</ul>
          <div>
            <button disabled={isPending} onClick={() => void resumeSplitReview(true)} type="button">Yes, update inventory</button>
            <button disabled={isPending} onClick={() => void resumeSplitReview(false)} type="button">No, keep it as is</button>
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
        <textarea
          aria-label="Ask FridgeFriend"
          className="ff-chat-field"
          disabled={isPending || clarification !== null || splitReview !== null}
          onKeyDown={handleFieldKeyDown}
          onChange={(event) => setInput(event.currentTarget.value)}
          placeholder="Ask about this fridge..."
          ref={inputRef}
          rows={2}
          value={input}
        />
        <button aria-label="Send" className="ff-chat-submit" disabled={isPending || clarification !== null || splitReview !== null} type="submit">
          ↑
        </button>
      </form>
    </section>
  );
}
