import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const appFoundation = sqliteTable("app_foundation", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const fridgeImages = sqliteTable("fridge_images", {
  id: text("id").primaryKey(),
  dataUrl: text("data_url").notNull(),
  originalName: text("original_name"),
  createdAt: text("created_at").notNull(),
});
