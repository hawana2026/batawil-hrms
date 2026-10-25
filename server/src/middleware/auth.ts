import type { RequestHandler } from "express";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { Logger } from "../logger.js";
import { clearSessionCookie, getAuthByToken } from "../auth/session.js";
import { hasAnyPermission, hasPermission } from "../auth/types.js";
import { writeAudit } from "../lib/audit.js";
import { ApiError, forbidden, requestIp, requestUserAgent, unauthorized } from "../lib/errors.js";

export interface AuthDeps {
  db: Db;
  config: AppConfig;
  logger: Logger;
}

export function createRequireAuth({ db, config }: AuthDeps): RequestHandler {
  return async (req, res, next) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[config.session.cookieName];
    if (!token) throw unauthorized();
    const auth = await getAuthByToken(db, config, token);
    if (!auth) {
      clearSessionCookie(res, config);
      throw unauthorized("انتهت الجلسة أو تم إلغاؤها. سجّل الدخول من جديد.");
    }
    req.auth = auth;
    next();
  };
}

export const requirePasswordReady: RequestHandler = (req, _res, next) => {
  if (!req.auth) throw unauthorized();
  if (req.auth.user.mustChangePassword) {
    throw new ApiError(403, "PASSWORD_CHANGE_REQUIRED", "يجب تغيير كلمة المرور المؤقتة قبل استخدام النظام.");
  }
  next();
};

export function createRequirePermission(permission: string, { db, logger }: AuthDeps): RequestHandler {
  return async (req, _res, next) => {
    if (!req.auth) throw unauthorized();
    if (hasPermission(req.auth.user, permission)) {
      next();
      return;
    }
    await writeAudit(db, logger, {
      action: "security.permission_denied",
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "permission",
      entityId: permission,
      severity: "warning",
      details: { permission, method: req.method, path: req.originalUrl },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    throw forbidden();
  };
}

export function createRequireAnyPermission(permissions: string[], { db, logger }: AuthDeps): RequestHandler {
  return async (req, _res, next) => {
    if (!req.auth) throw unauthorized();
    if (hasAnyPermission(req.auth.user, permissions)) {
      next();
      return;
    }
    await writeAudit(db, logger, {
      action: "security.permission_denied",
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "permission",
      entityId: permissions.join(","),
      severity: "warning",
      details: { permissions, method: req.method, path: req.originalUrl },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    throw forbidden();
  };
}
