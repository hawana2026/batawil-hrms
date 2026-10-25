import path from "node:path";
import { loadConfig, loadEnvFileIfPresent } from "./config.js";
import { createLogger } from "./logger.js";
import { createDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { purgeExpiredSessions } from "./auth/session.js";
import { createApp } from "./app.js";

async function main(): Promise<void> {
  loadEnvFileIfPresent();
  const config = loadConfig();
  const logger = createLogger({ production: config.isProduction });

  const db = await createDb(config.db, logger);
  await runMigrations(db, config.migrationsDir, logger);

  const app = createApp({ db, config, logger }, { publicDir: path.resolve(process.cwd(), "public") });
  const server = app.listen(config.port, () => {
    logger.info("BATAWIL HRMS server listening", {
      port: config.port,
      origin: config.publicOrigin,
      env: config.nodeEnv,
      driver: config.db.driver,
    });
  });

  const userCount = await db.query<{ total: number }>("SELECT count(*)::int AS total FROM users");
  if ((userCount.rows[0]?.total ?? 0) === 0) {
    logger.warn("No users exist yet. Run 'npm run setup' to create the initial administrator.");
  }

  const maintenance = setInterval(() => {
    purgeExpiredSessions(db).catch((error: unknown) => {
      logger.error("Session maintenance failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }, 60 * 60 * 1000);
  maintenance.unref();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutdown requested", { signal });
    const force = setTimeout(() => {
      logger.error("Forced shutdown after timeout");
      process.exit(1);
    }, 10_000);
    force.unref();
    server.close(() => {
      db.close()
        .then(() => {
          logger.info("Shutdown complete");
          process.exit(0);
        })
        .catch((error: unknown) => {
          logger.error("Failed to close database", { error: error instanceof Error ? error.message : String(error) });
          process.exit(1);
        });
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  process.stderr.write(`[fatal] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
