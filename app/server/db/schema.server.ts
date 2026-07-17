import { primaryKey, real, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const fridgeImages = sqliteTable("fridge_images", {
  id: text("id").primaryKey(),
  dataUrl: text("data_url").notNull(),
  originalName: text("original_name"),
  storageLocation: text("storage_location").notNull(),
  baseImageId: text("base_image_id"),
  createdAt: text("created_at").notNull(),
});

export const fridgeInventories = sqliteTable("fridge_inventories", {
  imageId: text("image_id").primaryKey(),
  inventoryId: text("inventory_id").notNull(),
  inventoryJson: text("inventory_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const kitchenOrganizationPlans = sqliteTable("kitchen_organization_plans", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull(),
  userId: text("user_id").notNull(),
  fridgeId: text("fridge_id").notNull(),
  imageId: text("image_id").notNull(),
  inventoryFingerprint: text("inventory_fingerprint").notNull(),
  status: text("status").notNull(),
  planJson: text("plan_json").notNull(),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
});

export const fridgeChatThreads = sqliteTable("fridge_chat_threads", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  fridgeId: text("fridge_id").notNull(),
  imageId: text("image_id"),
  executionStatus: text("execution_status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const fridgeChatMessages = sqliteTable("fridge_chat_messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  role: text("role").notNull(),
  payloadJson: text("payload_json").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
});

export const fridges = sqliteTable("fridges", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
});

export const fridgeMemberships = sqliteTable(
  "fridge_memberships",
  {
    fridgeId: text("fridge_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.fridgeId, table.userId],
    }),
  ],
);

export const externalInventoryItems = sqliteTable("external_inventory_items", {
  id: text("id").primaryKey(),
  fridgeId: text("fridge_id").notNull(),
  name: text("name").notNull(),
  canonicalName: text("canonical_name"),
  storageLocation: text("storage_location").notNull(),
  quantityAmount: real("quantity_amount"),
  quantityUnit: text("quantity_unit"),
  quantityPrecision: text("quantity_precision"),
  status: text("status").notNull(),
  confidence: real("confidence").notNull(),
  source: text("source").notNull(),
  notes: text("notes"),
  expirationDate: text("expiration_date"),
  expirationDateSource: text("expiration_date_source"),
  normalizedKey: text("normalized_key").notNull(),
  lastConfirmedAt: text("last_confirmed_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const dietaryRestrictions = sqliteTable("dietary_restrictions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  restrictionType: text("restriction_type").notNull(),
  subject: text("subject").notNull(),
  severity: text("severity").notNull(),
  notes: text("notes"),
  source: text("source").notNull(),
  normalizedKey: text("normalized_key").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const dietaryPreferences = sqliteTable("dietary_preferences", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  subject: text("subject").notNull(),
  sentiment: text("sentiment").notNull(),
  strength: integer("strength").notNull(),
  notes: text("notes"),
  source: text("source").notNull(),
  normalizedKey: text("normalized_key").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const goals = sqliteTable("goals", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  goalType: text("goal_type").notNull(),
  description: text("description").notNull(),
  targetValue: real("target_value"),
  targetUnit: text("target_unit"),
  priority: integer("priority").notNull(),
  active: integer("active").notNull(),
  source: text("source").notNull(),
  normalizedKey: text("normalized_key").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  namespaceType: text("namespace_type").notNull(),
  namespaceId: text("namespace_id").notNull(),
  category: text("category").notNull(),
  content: text("content").notNull(),
  normalizedKey: text("normalized_key").notNull(),
  source: text("source").notNull(),
  confidence: real("confidence").notNull(),
  active: integer("active").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const foodComRecipes = sqliteTable("food_com_recipes", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  ingredientsJson: text("ingredients_json").notNull(),
  tagsJson: text("tags_json").notNull(),
  stepsJson: text("steps_json").notNull(),
  minutes: integer("minutes").notNull(),
  stepCount: integer("step_count").notNull(),
  ingredientCount: integer("ingredient_count").notNull(),
  nutritionJson: text("nutrition_json").notNull(),
  ratingAverage: real("rating_average"),
  ratingCount: integer("rating_count"),
  updatedAt: text("updated_at").notNull(),
});

export const foodComRecipeTags = sqliteTable(
  "food_com_recipe_tags",
  {
    recipeId: text("recipe_id").notNull(),
    tag: text("tag").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.recipeId, table.tag] }),
  ],
);

export const foodComRecipeIngredients = sqliteTable(
  "food_com_recipe_ingredients",
  {
    recipeId: text("recipe_id").notNull(),
    ingredient: text("ingredient").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.recipeId, table.ingredient] }),
  ],
);
