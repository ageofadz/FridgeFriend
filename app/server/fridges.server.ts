import { asc, eq } from "drizzle-orm";

import { fridgeMemberships, fridges } from "./db/schema.server";
import { withDatabase } from "./sqlite.server";

export type FridgeSummary = {
  id: string;
  name: string;
  createdAt: string;
};

export function listFridgesForUser(userId: string): FridgeSummary[] {
  if (!userId.trim()) {
    throw new Error("Cannot list fridges without a user id");
  }

  return withDatabase((db) => db
    .select({
      id: fridges.id,
      name: fridges.name,
      createdAt: fridges.createdAt,
    })
    .from(fridgeMemberships)
    .innerJoin(fridges, eq(fridgeMemberships.fridgeId, fridges.id))
    .where(eq(fridgeMemberships.userId, userId))
    .orderBy(asc(fridges.createdAt))
    .all());
}
