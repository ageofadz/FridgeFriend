import path from "node:path";
import { mkdirSync } from "node:fs";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";

import { optionalEnv } from "./env.server";
import { canonicalizeInventoryPlacement } from "../components/fridge-placement";
import { Inventory as InventorySchema } from "./scan/schemas/inventory";
import {
  dietaryPreferences,
  dietaryRestrictions,
  externalInventoryItems,
  foodComRecipeIngredients,
  foodComRecipes,
  foodComRecipeTags,
  fridgeChatMessages,
  fridgeChatThreads,
  fridgeImages,
  fridgeInventories,
  kitchenOrganizationPlans,
  fridgeMemberships,
  fridges,
  goals,
  memories,
  users,
} from "./db/schema.server";

type SqliteBootstrapResult = {
  path: string;
  tables: string[];
};

export const DEFAULT_USER_ID = "default-user";
export const DEFAULT_FRIDGE_ID = "default-fridge";

export function getDatabasePath() {
  return optionalEnv("DATABASE_PATH") ?? ".data/fridgefriend.sqlite";
}

const bootstrappedDatabasePaths = new Set<string>();

export function resetSqliteBootstrapCacheForTests() {
  bootstrappedDatabasePaths.clear();
}

function ensureSchemaBootstrapped(
  db: ReturnType<typeof drizzle>,
  sqlite: Database.Database,
  databasePath: string,
) {
  const resolvedPath = path.resolve(databasePath);

  if (bootstrappedDatabasePaths.has(resolvedPath)) {
    return;
  }

  bootstrapSchema(db, sqlite, databasePath);
  bootstrappedDatabasePaths.add(resolvedPath);
}

function openSqlite() {
  const databasePath = getDatabasePath();
  const directory = path.dirname(databasePath);

  if (directory && directory !== ".") {
    mkdirSync(directory, { recursive: true });
  }

  const sqlite = new Database(databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 30000");

  return {
    databasePath,
    sqlite,
    db: drizzle(sqlite),
  };
}

export function withDatabase<T>(
  callback: (db: ReturnType<typeof drizzle>, sqlite: Database.Database) => T,
) {
  const { databasePath, sqlite, db } = openSqlite();

  try {
    ensureSchemaBootstrapped(db, sqlite, databasePath);
    return callback(db, sqlite);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SQLite operation failed for ${databasePath}: ${message}`);
  } finally {
    sqlite.close();
  }
}

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampRatio(value: number) {
  return Math.min(1, Math.max(0, value));
}

function normalizedBoxFromUnknown(value: unknown) {
  if (!isJsonRecord(value)) {
    return null;
  }

  const { x, y, width, height } = value;

  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  return { x, y, width, height };
}

function inventoryZonesById(inventory: JsonRecord) {
  const zones = inventory.zones;
  const zonesById = new Map<string, { x: number; y: number; width: number; height: number }>();

  if (!Array.isArray(zones)) {
    return zonesById;
  }

  for (const zone of zones) {
    if (!isJsonRecord(zone) || typeof zone.id !== "string") {
      continue;
    }

    const boundingBox = normalizedBoxFromUnknown(zone.boundingBox) ??
      normalizedBoxFromUnknown(zone.bbox);

    if (boundingBox) {
      zonesById.set(zone.id, boundingBox);
    }
  }

  return zonesById;
}

function depthBackRatioForObservation(
  location: JsonRecord,
  observation: JsonRecord,
  zonesById: Map<string, { x: number; y: number; width: number; height: number }>,
) {
  if (typeof location.zoneId !== "string") {
    return null;
  }

  const zoneBox = zonesById.get(location.zoneId);
  const itemBox = normalizedBoxFromUnknown(observation.boundingBox);

  if (!zoneBox || !itemBox) {
    return null;
  }

  return clampRatio((itemBox.y + itemBox.height - zoneBox.y) / zoneBox.height);
}

function addDepthBackRatiosToLocationObservations(input: {
  location: unknown;
  zonesById: Map<string, { x: number; y: number; width: number; height: number }>;
  imageId: string;
  itemIndex: number;
}) {
  if (!isJsonRecord(input.location)) {
    return {
      location: input.location,
      changed: false,
    };
  }

  const location = input.location;
  const observations = location.observations;

  if (!Array.isArray(observations)) {
    return {
      location: input.location,
      changed: false,
    };
  }

  let changed = false;
  const migratedObservations = observations.map((observation, observationIndex) => {
    if (!isJsonRecord(observation)) {
      throw new Error(`Inventory migration failed for image ${input.imageId}: items.${input.itemIndex}.loc.observations.${observationIndex} must be an object`);
    }

    const depthBackRatio = depthBackRatioForObservation(
      location,
      observation,
      input.zonesById,
    );
    const alreadyCurrent =
      !("depthPosition" in observation) &&
      observation.depthBackRatio === depthBackRatio;

    if (alreadyCurrent) {
      return observation;
    }

    changed = true;
    const { depthPosition: _depthPosition, ...rest } = observation;
    return {
      ...rest,
      depthBackRatio,
    };
  });

  if (!changed) {
    return {
      location: input.location,
      changed,
    };
  }

  return {
    location: {
      ...location,
      observations: migratedObservations,
    },
    changed,
  };
}

function addDepthBackRatiosToCurrentInventory(inventory: JsonRecord, imageId: string) {
  const items = inventory.items;
  const zonesById = inventoryZonesById(inventory);

  if (!Array.isArray(items)) {
    throw new Error(`Inventory migration failed for image ${imageId}: inventory.items must be an array`);
  }

  let changed = false;
  const migratedItems = items.map((item, itemIndex) => {
    if (!isJsonRecord(item)) {
      throw new Error(`Inventory migration failed for image ${imageId}: items.${itemIndex} must be an object`);
    }

    const migratedLocation = addDepthBackRatiosToLocationObservations({
      location: item.loc,
      zonesById,
      imageId,
      itemIndex,
    });

    if (!migratedLocation.changed) {
      return item;
    }

    changed = true;
    return {
      ...item,
      loc: migratedLocation.location,
    };
  });

  return {
    inventory: changed
      ? {
          ...inventory,
          items: migratedItems,
        }
      : inventory,
    changed,
  };
}

function migrateLegacyInventoryRows(sqlite: Database.Database, databasePath: string) {
  const rows = sqlite.prepare(
    "select image_id, inventory_json from fridge_inventories",
  ).all() as Array<{ image_id: string; inventory_json: string }>;
  const update = sqlite.prepare(
    "update fridge_inventories set inventory_json = ?, updated_at = ? where image_id = ?",
  );

  const migrate = sqlite.transaction(() => {
    for (const row of rows) {
      let inventory: unknown;

      try {
        inventory = JSON.parse(row.inventory_json);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Inventory migration failed for image ${row.image_id}: invalid JSON: ${message}`);
      }

      if (!isJsonRecord(inventory) || !Array.isArray(inventory.items)) {
        throw new Error(`Inventory migration failed for image ${row.image_id}: inventory.items must be an array`);
      }

      const items = inventory.items;
      const isLegacy = items.some(
        (item) => typeof item === "object" && item !== null && "canonicalName" in item,
      );

      if (!isLegacy) {
        const migratedCurrentInventory = addDepthBackRatiosToCurrentInventory(
          inventory,
          row.image_id,
        );

        const parsed = InventorySchema.safeParse(migratedCurrentInventory.inventory);

        if (!parsed.success) {
          throw new Error(`Inventory migration failed for image ${row.image_id}: ${parsed.error.message}`);
        }

        const placedInventory = canonicalizeInventoryPlacement(parsed.data);

        if (
          !migratedCurrentInventory.changed &&
          JSON.stringify(parsed.data) === JSON.stringify(placedInventory)
        ) {
          continue;
        }

        update.run(JSON.stringify(placedInventory), new Date().toISOString(), row.image_id);
        continue;
      }

      const zonesById = inventoryZonesById(inventory);
      const migratedInventory = {
        ...inventory,
        items: items.map((item, index) => {
          if (!isJsonRecord(item)) {
            throw new Error(`Inventory migration failed for image ${row.image_id}: items.${index} must be an object`);
          }

          const legacy = item;
          const stack = legacy.stackingHint;

          if (stack !== null && stack !== undefined && (typeof stack !== "object" || Array.isArray(stack))) {
            throw new Error(`Inventory migration failed for image ${row.image_id}: items.${index}.stackingHint must be an object or null`);
          }

          const { canonicalName, displayName, category, subcategory, quantity, packaging, stackingHint, estimatedDimensions, footprint, location, confidence, sourceDetectionIds, attributes, visualEnrichments, reviewStatus, ...rest } = legacy;
          const migratedLocation = addDepthBackRatiosToLocationObservations({
            location,
            zonesById,
            imageId: row.image_id,
            itemIndex: index,
          });

          return {
            ...rest,
            name: canonicalName,
            label: displayName,
            cat: category,
            subcat: subcategory,
            qty: quantity,
            pack: packaging,
            ...(stack && typeof stack === "object" ? {
              stack: {
                on: (stack as Record<string, unknown>).stackedOnDetectionId,
                conf: (stack as Record<string, unknown>).confidence,
                why: (stack as Record<string, unknown>).reason,
              },
            } : {}),
            loc: migratedLocation.location,
            conf: confidence,
            src: sourceDetectionIds,
            attrs: attributes,
            ...(visualEnrichments !== undefined ? { visual: visualEnrichments } : {}),
            review: reviewStatus,
          };
        }),
      };
      const parsed = InventorySchema.safeParse(migratedInventory);

      if (!parsed.success) {
        throw new Error(`Inventory migration failed for image ${row.image_id}: ${parsed.error.message}`);
      }

      const placedInventory = canonicalizeInventoryPlacement(parsed.data);

      update.run(JSON.stringify(placedInventory), new Date().toISOString(), row.image_id);
    }
  });

  try {
    migrate();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SQLite inventory migration failed for ${databasePath}: ${message}`);
  }
}

function bootstrapSchema(
  db: ReturnType<typeof drizzle>,
  sqlite: Database.Database,
  databasePath: string,
) {
  try {
    db.run(sql`
      create table if not exists ${fridgeImages} (
        id text primary key,
        data_url text not null,
        original_name text,
        storage_location text not null default 'fridge',
        base_image_id text,
        created_at text not null
      )
    `);

    const fridgeImageColumns = db.all<{ name: string }>(sql`pragma table_info(fridge_images)`);
    if (!fridgeImageColumns.some((column) => column.name === "storage_location")) {
      db.run(sql`alter table ${fridgeImages} add column storage_location text not null default 'fridge'`);
    }
    if (!fridgeImageColumns.some((column) => column.name === "base_image_id")) {
      db.run(sql`alter table ${fridgeImages} add column base_image_id text`);
    }

    db.run(sql`
      create table if not exists ${fridgeInventories} (
        image_id text primary key,
        inventory_id text not null,
        inventory_json text not null,
        created_at text not null,
        updated_at text not null,
        foreign key (image_id) references fridge_images(id) on delete cascade
      )
    `);

    db.run(sql`
      create table if not exists ${kitchenOrganizationPlans} (
        id text primary key,
        request_id text not null unique,
        user_id text not null,
        fridge_id text not null,
        image_id text not null,
        inventory_fingerprint text not null,
        status text not null,
        plan_json text not null,
        created_at text not null,
        completed_at text
      )
    `);

    db.run(sql`
      create index if not exists kitchen_organization_plans_fridge_status_idx
      on kitchen_organization_plans(fridge_id, status)
    `);

    db.run(sql`
      create table if not exists ${fridgeChatThreads} (
        id text primary key,
        user_id text not null,
        fridge_id text not null,
        image_id text,
        execution_status text not null,
        created_at text not null,
        updated_at text not null
      )
    `);

    db.run(sql`
      create index if not exists fridge_chat_threads_scope_idx
      on fridge_chat_threads(user_id, fridge_id, image_id, updated_at desc)
    `);

    db.run(sql`
      create table if not exists ${fridgeChatMessages} (
        id text primary key,
        thread_id text not null,
        role text not null,
        payload_json text not null,
        status text not null,
        created_at text not null,
        updated_at text not null,
        foreign key (thread_id) references fridge_chat_threads(id) on delete cascade
      )
    `);

    db.run(sql`
      create index if not exists fridge_chat_messages_thread_idx
      on fridge_chat_messages(thread_id, created_at)
    `);

    migrateLegacyInventoryRows(sqlite, databasePath);

    db.run(sql`
      create table if not exists ${users} (
        id text primary key,
        created_at text not null
      )
    `);

    db.run(sql`
      create table if not exists ${fridges} (
        id text primary key,
        name text not null,
        created_at text not null
      )
    `);

    db.run(sql`
      create table if not exists ${fridgeMemberships} (
        fridge_id text not null,
        user_id text not null,
        role text not null,
        primary key (fridge_id, user_id),
        foreign key (fridge_id) references fridges(id) on delete cascade,
        foreign key (user_id) references users(id) on delete cascade
      )
    `);

    db.run(sql`
      create table if not exists ${externalInventoryItems} (
        id text primary key,
        fridge_id text not null,
        name text not null,
        canonical_name text,
        storage_location text not null,
        quantity_amount real,
        quantity_unit text,
        quantity_precision text,
        status text not null,
        confidence real not null,
        source text not null,
        notes text,
        expiration_date text,
        expiration_date_source text,
        normalized_key text not null,
        last_confirmed_at text not null,
        created_at text not null,
        updated_at text not null,
        foreign key (fridge_id) references fridges(id) on delete cascade
      )
    `);

    const externalInventoryColumns = db.all<{ name: string }>(sql`pragma table_info(external_inventory_items)`);
    if (!externalInventoryColumns.some((column) => column.name === "expiration_date")) {
      db.run(sql`alter table ${externalInventoryItems} add column expiration_date text`);
    }
    if (!externalInventoryColumns.some((column) => column.name === "expiration_date_source")) {
      db.run(sql`alter table ${externalInventoryItems} add column expiration_date_source text`);
    }

    db.run(sql`
      create unique index if not exists external_inventory_items_fridge_key
      on external_inventory_items(fridge_id, normalized_key)
    `);

    db.run(sql`
      create table if not exists ${dietaryRestrictions} (
        id text primary key,
        user_id text not null,
        restriction_type text not null,
        subject text not null,
        severity text not null,
        notes text,
        source text not null,
        normalized_key text not null,
        created_at text not null,
        updated_at text not null,
        foreign key (user_id) references users(id) on delete cascade
      )
    `);

    db.run(sql`
      create unique index if not exists dietary_restrictions_user_key
      on dietary_restrictions(user_id, normalized_key)
    `);

    db.run(sql`
      create table if not exists ${dietaryPreferences} (
        id text primary key,
        user_id text not null,
        subject text not null,
        sentiment text not null,
        strength integer not null,
        notes text,
        source text not null,
        normalized_key text not null,
        created_at text not null,
        updated_at text not null,
        foreign key (user_id) references users(id) on delete cascade
      )
    `);

    db.run(sql`
      create unique index if not exists dietary_preferences_user_key
      on dietary_preferences(user_id, normalized_key)
    `);

    db.run(sql`
      create table if not exists ${goals} (
        id text primary key,
        user_id text not null,
        goal_type text not null,
        description text not null,
        target_value real,
        target_unit text,
        priority integer not null,
        active integer not null,
        source text not null,
        normalized_key text not null,
        created_at text not null,
        updated_at text not null,
        foreign key (user_id) references users(id) on delete cascade
      )
    `);

    db.run(sql`
      create unique index if not exists goals_user_key
      on goals(user_id, normalized_key)
    `);

    db.run(sql`
      create table if not exists ${memories} (
        id text primary key,
        namespace_type text not null,
        namespace_id text not null,
        category text not null,
        content text not null,
        normalized_key text not null,
        source text not null,
        confidence real not null,
        active integer not null,
        created_at text not null,
        updated_at text not null
      )
    `);

    db.run(sql`
      create unique index if not exists memories_namespace_key
      on memories(namespace_type, namespace_id, normalized_key)
    `);

    db.run(sql`
      create table if not exists ${foodComRecipes} (
        id text primary key,
        name text not null,
        description text,
        ingredients_json text not null,
        tags_json text not null,
        steps_json text not null,
        minutes integer not null,
        step_count integer not null,
        ingredient_count integer not null,
        nutrition_json text not null,
        rating_average real,
        rating_count integer,
        updated_at text not null
      )
    `);

    db.run(sql`
      create table if not exists ${foodComRecipeTags} (
        recipe_id text not null,
        tag text not null,
        primary key (recipe_id, tag),
        foreign key (recipe_id) references food_com_recipes(id) on delete cascade
      )
    `);

    db.run(sql`
      create index if not exists food_com_recipe_tags_tag_idx
      on food_com_recipe_tags(tag)
    `);

    db.run(sql`
      create table if not exists ${foodComRecipeIngredients} (
        recipe_id text not null,
        ingredient text not null,
        primary key (recipe_id, ingredient),
        foreign key (recipe_id) references food_com_recipes(id) on delete cascade
      )
    `);

    db.run(sql`
      create index if not exists food_com_recipe_ingredients_ingredient_idx
      on food_com_recipe_ingredients(ingredient)
    `);

    const now = new Date().toISOString();

    db.run(sql`
      insert into ${users} (id, created_at)
      values (${DEFAULT_USER_ID}, ${now})
      on conflict(id) do nothing
    `);

    db.run(sql`
      insert into ${fridges} (id, name, created_at)
      values (${DEFAULT_FRIDGE_ID}, 'Default Fridge', ${now})
      on conflict(id) do nothing
    `);

    db.run(sql`
      insert into ${fridgeMemberships} (fridge_id, user_id, role)
      values (${DEFAULT_FRIDGE_ID}, ${DEFAULT_USER_ID}, 'owner')
      on conflict(fridge_id, user_id) do update set role = excluded.role
    `);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SQLite schema bootstrap failed for ${databasePath}: ${message}`);
  }
}

export function bootstrapSqlite(): SqliteBootstrapResult {
  const { databasePath, sqlite, db } = openSqlite();

  try {
    bootstrapSchema(db, sqlite, databasePath);
    bootstrappedDatabasePaths.add(path.resolve(databasePath));

    const tables = db
      .all<{ name: string }>(sql`
        select name
        from sqlite_master
        where type = 'table'
          and name not like 'sqlite_%'
        order by name
      `)
      .map((row) => {
        if (!row.name) {
          throw new Error(`Unexpected SQLite table row for ${databasePath}`);
        }
        return row.name;
      });

    return {
      path: databasePath,
      tables,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SQLite bootstrap failed for ${databasePath}: ${message}`);
  } finally {
    sqlite.close();
  }
}
