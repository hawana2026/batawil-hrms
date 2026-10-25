import { mkdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";

const { Pool } = pg;

export type Row = Record<string, unknown>;

export interface QueryResult<T extends Row = Row> {
  rows: T[];
  rowCount: number;
}

export interface DbClient {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  execute(sql: string): Promise<void>;
}

export interface Db extends DbClient {
  readonly driver: "pglite" | "postgres";
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function pgSslConfig(mode: AppConfig["db"]["ssl"]): false | { rejectUnauthorized: boolean } {
  if (mode === "disable") return false;
  return { rejectUnauthorized: mode === "require" };
}

export async function createDb(config: AppConfig["db"], logger: Logger): Promise<Db> {
  if (config.driver === "pglite") {
    if (config.pgliteDir !== ":memory:") {
      await mkdir(config.pgliteDir, { recursive: true });
    }
    const embedded = config.pgliteDir === ":memory:" ? new PGlite() : new PGlite(config.pgliteDir);
    await embedded.waitReady;
    logger.info("Embedded PostgreSQL (PGlite) ready", { mode: config.pgliteDir === ":memory:" ? "memory" : config.pgliteDir });

    const wrapped: Db = {
      driver: "pglite",
      async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
        const result = await embedded.query<T>(sql, params);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      },
      async execute(sql: string): Promise<void> {
        await embedded.exec(sql);
      },
      async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
        return embedded.transaction(async (tx) => {
          return fn({
            async query<U extends Row = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<U>> {
              const result = await tx.query<U>(sql, params);
              return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
            },
            async execute(sql: string): Promise<void> {
              await tx.exec(sql);
            },
          });
        });
      },
      async close() {
        await embedded.close();
      },
    };
    return wrapped;
  }

  if (!config.databaseUrl) throw new Error("DATABASE_URL is required for the postgres driver");
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: pgSslConfig(config.ssl),
    options: config.schema ? `-c search_path=${config.schema}` : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 20_000,
    application_name: "batawil-hrms",
  });
  pool.on("error", (error) => logger.error("Unexpected PostgreSQL pool error", { error: error.message }));
  await pool.query("SELECT 1");
  logger.info("PostgreSQL connection pool ready");

  const clientWrapper = (client: pg.Pool | pg.PoolClient): DbClient => ({
    async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
      const result = await client.query(sql, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
    },
    async execute(sql: string): Promise<void> {
      await client.query(sql);
    },
  });

  return {
    driver: "postgres",
    query: clientWrapper(pool).query,
    execute: clientWrapper(pool).execute,
    async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(clientWrapper(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          logger.error("Failed to roll back transaction", {
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          });
        }
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
