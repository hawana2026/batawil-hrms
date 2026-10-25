import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Db, Row } from "./index.js";
import type { Logger } from "../logger.js";

interface MigrationRow extends Row {
  version: string;
}

const MIGRATION_LOCK_ID = 872_014_331;

export async function runMigrations(db: Db, migrationsDir: string, logger: Logger): Promise<string[]> {
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  if (files.length === 0) throw new Error(`لم يتم العثور على ملفات ترحيل في: ${migrationsDir}`);

  const applied: string[] = [];

  await db.transaction(async (tx) => {
    if (db.driver === "postgres") {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
    }
    await tx.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const existing = await tx.query<MigrationRow>("SELECT version FROM schema_migrations");
    const done = new Set(existing.rows.map((row) => row.version));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      if (!sql.trim()) continue;
      await tx.execute(sql);
      await tx.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      applied.push(file);
    }
  });

  if (applied.length === 0) {
    logger.info("Database schema is up to date");
  } else {
    logger.info("Applied database migrations", { files: applied });
  }
  return applied;
}
