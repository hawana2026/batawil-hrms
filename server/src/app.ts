import path from "node:path";
import express, { type Express } from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { errorHandler } from "./lib/errors.js";
import { createOriginGuard } from "./middleware/security.js";
import type { AuthDeps } from "./middleware/auth.js";
import { createPublicRouter } from "./routes/public.js";
import { createAuthRouter } from "./routes/auth.js";
import { createMetaRouter } from "./routes/meta.js";
import { createDashboardRouter } from "./routes/dashboard.js";
import { createUsersRouter } from "./routes/users.js";
import { createBranchesRouter } from "./routes/branches.js";
import { createRolesRouter } from "./routes/roles.js";
import { createAuditRouter } from "./routes/audit.js";
import { createDepartmentsRouter } from "./routes/departments.js";
import { createJobTitlesRouter } from "./routes/job-titles.js";
import { createEmployeesRouter } from "./routes/employees.js";
import { createAttendanceRouter } from "./routes/attendance.js";
import { createLeavesRouter } from "./routes/leaves.js";
import { createLeaveBalancesRouter, createLeaveTypesRouter } from "./routes/leave-types.js";
import { createSelfServiceRouter } from "./routes/self-service.js";
import { createTransfersRouter } from "./routes/transfers.js";
import { createNewHiresRouter } from "./routes/new-hires.js";
import { createAdvancesRouter } from "./routes/advances.js";
import { createPayrollRouter } from "./routes/payroll.js";
import { createApprovalsRouter } from "./routes/approvals.js";
import { createReportsRouter } from "./routes/reports.js";
import { createSettingsRouter } from "./routes/settings.js";
import { createNotificationsRouter } from "./routes/notifications.js";
import { createAttachmentsRouter } from "./routes/attachments.js";
import { createAdminDeleteRouter } from "./routes/admin-delete.js";

export interface AppOptions {
  publicDir?: string;
}

export function createApp(deps: AuthDeps, options: AppOptions = {}): Express {
  const { db, config, logger } = deps;
  const app = express();

  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          "default-src": ["'self'"],
          "base-uri": ["'self'"],
          "script-src": ["'self'"],
          "style-src": ["'self'", "'unsafe-inline'"],
          "img-src": ["'self'", "data:"],
          "font-src": ["'self'"],
          "connect-src": ["'self'"],
          "form-action": ["'self'"],
          "frame-ancestors": ["'none'"],
          "object-src": ["'none'"],
          "manifest-src": ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "same-origin" },
      referrerPolicy: { policy: "no-referrer" },
      hsts: config.isProduction,
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    next();
  });

  app.use(
    "/api/employees/import",
    express.raw({
      type: [
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/octet-stream",
        "application/zip",
      ],
      limit: "5mb",
    }),
  );
  app.use(express.json({ limit: "100kb", strict: true }));
  app.use(cookieParser());
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(createOriginGuard(config));

  app.get("/healthz", async (_req, res) => {
    try {
      await db.query("SELECT 1");
      res.setHeader("Cache-Control", "no-store");
      res.json({ status: "ok" });
    } catch (error) {
      logger.error("Health check failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(503).json({ status: "unavailable" });
    }
  });

  app.use("/api/public", createPublicRouter(deps));
  app.use("/api/auth", createAuthRouter(deps));
  app.use("/api/meta", createMetaRouter(deps));
  app.use("/api/dashboard", createDashboardRouter(deps));
  app.use("/api/users", createUsersRouter(deps));
  app.use("/api/branches", createBranchesRouter(deps));
  app.use("/api/roles", createRolesRouter(deps));
  app.use("/api/audit", createAuditRouter(deps));
  app.use("/api/departments", createDepartmentsRouter(deps));
  app.use("/api/job-titles", createJobTitlesRouter(deps));
  app.use("/api/employees", createEmployeesRouter(deps));
  app.use("/api/attendance", createAttendanceRouter(deps));
  app.use("/api/leaves", createLeavesRouter(deps));
  app.use("/api/leave-types", createLeaveTypesRouter(deps));
  app.use("/api/leave-balances", createLeaveBalancesRouter(deps));
  app.use("/api/self-service", createSelfServiceRouter(deps));
  app.use("/api/transfers", createTransfersRouter(deps));
  app.use("/api/new-hires", createNewHiresRouter(deps));
  app.use("/api/advances", createAdvancesRouter(deps));
  app.use("/api/payroll", createPayrollRouter(deps));
  app.use("/api/approvals", createApprovalsRouter(deps));
  app.use("/api/reports", createReportsRouter(deps));
  app.use("/api/settings", createSettingsRouter(deps));
  app.use("/api/notifications", createNotificationsRouter(deps));
  app.use("/api/attachments", createAttachmentsRouter(deps));
  app.use("/api/admin", createAdminDeleteRouter(deps));
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "المسار المطلوب غير موجود." } });
  });

  const publicDir = options.publicDir ?? path.resolve(process.cwd(), "public");
  app.use(
    express.static(publicDir, {
      index: false,
      fallthrough: true,
      etag: true,
      maxAge: config.isProduction ? "1h" : 0,
    }),
  );

  app.get(/^\/(?!api(?:\/|$)|healthz$).*/, (req, res, next) => {
    if (path.extname(req.path) !== "" || !req.accepts("html")) {
      next();
      return;
    }
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(publicDir, "index.html"), (error) => {
      if (error) next(error);
    });
  });

  app.use(errorHandler(logger));

  return app;
}
