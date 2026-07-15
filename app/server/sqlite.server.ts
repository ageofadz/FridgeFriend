import path from "node:path";
import { mkdirSync } from "node:fs";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";

import { optionalEnv } from "./env.server";
import { appFoundation, fridgeImages } from "./db/schema.server";

export type SqliteBootstrapResult = {
  path: string;
  tables: string[];
};

export function getDatabasePath() {
  return optionalEnv("DATABASE_PATH") ?? ".data/fridgefriend.sqlite";
}

function openSqlite() {
  const databasePath = getDatabasePath();
  const directory = path.dirname(databasePath);

  if (directory && directory !== ".") {
    mkdirSync(directory, { recursive: true });
  }

  const sqlite = new Database(databasePath);
  sqlite.pragma("journal_mode = WAL");

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
    bootstrapSchema(db, databasePath);
    return callback(db, sqlite);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SQLite operation failed for ${databasePath}: ${message}`);
  } finally {
    sqlite.close();
  }
}

function bootstrapSchema(db: ReturnType<typeof drizzle>, databasePath: string) {
  try {
    db.run(sql`
      create table if not exists ${appFoundation} (
        key text primary key,
        value text not null,
        updated_at text not null
      )
    `);

    db.run(sql`
      create table if not exists ${fridgeImages} (
        id text primary key,
        data_url text not null,
        original_name text,
        created_at text not null
      )
    `);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SQLite schema bootstrap failed for ${databasePath}: ${message}`);
  }
}

export function bootstrapSqlite(): SqliteBootstrapResult {
  const { databasePath, sqlite, db } = openSqlite();

  try {
    bootstrapSchema(db, databasePath);

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
