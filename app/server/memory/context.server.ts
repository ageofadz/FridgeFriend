import {
  hasActiveSemanticMemories,
  listMemoryContext,
  listSemanticMemoriesByIds,
} from "./repository.server";
import { searchSemanticMemoryIds } from "./vector-store.server";

export async function loadMemoryContextForQuery(input: {
  userId: string;
  fridgeId: string;
  query: string;
}) {
  if (!hasActiveSemanticMemories(input)) {
    return listMemoryContext({
      userId: input.userId,
      fridgeId: input.fridgeId,
      semanticMemories: [],
    });
  }

  const semanticMemoryIds = await searchSemanticMemoryIds({
    userId: input.userId,
    fridgeId: input.fridgeId,
    query: input.query,
    limit: 5,
  });

  return listMemoryContext({
    userId: input.userId,
    fridgeId: input.fridgeId,
    semanticMemories: listSemanticMemoriesByIds(semanticMemoryIds),
  });
}
