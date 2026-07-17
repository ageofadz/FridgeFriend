import { QueryStreamEventSchema, type QueryStreamEvent } from "../workspace/query-events";

export type {
  DietaryPreference,
  DietaryRestriction,
  ExpiryPlan,
  GroceryPlan,
  GroceryPlanItem,
  InventoryClarificationQuestion,
  PantryCompletionPlan,
  PantryCompletionSuggestion,
  QueryStreamEvent,
  QueryVisualEvidence,
  RecipeCard,
} from "../workspace/query-events";
export type { OrganizationPlan } from "../server/organization/schemas";

export function parseQueryStreamEvent(line: string): QueryStreamEvent {
  let payload: unknown;

  try {
    payload = JSON.parse(line);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Query stream event was not valid JSON: ${message}`);
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as Record<string, unknown>).type !== "string"
  ) {
    throw new Error("Query stream event did not include a type");
  }

  const parsed = QueryStreamEventSchema.safeParse(payload);

  if (!parsed.success) {
    throw new Error(
      `Query stream event had invalid shape for ${(payload as Record<string, unknown>).type as string}`,
    );
  }

  return parsed.data;
}

export function createQueryStreamParser(
  onEvent: (event: QueryStreamEvent) => void,
) {
  let buffer = "";

  function flushLine(line: string) {
    if (line.trim().length === 0) {
      return;
    }

    onEvent(parseQueryStreamEvent(line));
  }

  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        flushLine(line);
      }
    },
    close() {
      flushLine(buffer);
      buffer = "";
    },
  };
}

export async function readQueryStream(
  response: Response,
  onEvent: (event: QueryStreamEvent) => void,
) {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  if (!response.body) {
    throw new Error("Query graph response did not include a stream body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createQueryStreamParser(onEvent);

  while (true) {
    const result = await reader.read();

    if (result.done) {
      break;
    }

    parser.push(decoder.decode(result.value, { stream: true }));
  }

  const remaining = decoder.decode();

  if (remaining.length > 0) {
    parser.push(remaining);
  }

  parser.close();
}
