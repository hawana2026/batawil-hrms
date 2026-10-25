import { loadConfigForCli } from "../config.js";
import { createDb } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { createLogger } from "../logger.js";

const config = loadConfigForCli();
const logger = createLogger({ production: config.isProduction });
const db = await createDb(config.db, logger);
try {
  await runMigrations(db, config.migrationsDir, logger);
} finally {
  await db.close();
}
