import { Router } from "express";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Db, Row } from "../db/index.js";
import type { Logger } from "../logger.js";
import {
  createSession,
  loadUserPayload,
  revokeAllUserSessions,
  revokeSession,
  setSessionCookie,
  clearSessionCookie,
  type CreatedSession,
} from "../auth/session.js";
import {
  hashPassword,
  validatePasswordStrength,
  verifyAgainstDummyHash,
  verifyPassword,
} from "../auth/password.js";
import { writeAudit } from "../lib/audit.js";
import { ApiError, parseBody, requestIp, requestUserAgent, unauthorized } from "../lib/errors.js";
import { passwordSchema, usernameSchema } from "../lib/schemas.js";
import { createRequireAuth, type AuthDeps } from "../middleware/auth.js";

const loginSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  remember: z.boolean().optional().default(false),
});

const changePasswordSchema = z.object({
  currentPassword: passwordSchema,
  newPassword: passwordSchema,
});

interface LoginUserRow extends Row {
  id: string;
  username: string;
  password_hash: string;
  active: boolean;
  failed_attempts: number;
  locked_until: string | Date | null;
  session_version: number;
}

interface PasswordStateRow extends Row {
  password_hash: string;
  session_version: number;
}

function toDate(value: string | Date | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function recordAttempt(db: Db, username: string, ip: string, success: boolean): Promise<void> {
  await db.query("INSERT INTO login_attempts (username, ip, success) VALUES ($1, $2, $3)", [
    username.slice(0, 64),
    ip,
    success,
  ]);
}

function sessionPayload(created: CreatedSession) {
  return {
    remember: created.remember,
    expiresAt: created.expiresAt,
    absoluteExpiresAt: created.absoluteExpiresAt,
  };
}

export function createAuthRouter(deps: AuthDeps): Router {
  const { db, config, logger } = deps;
  const router = Router();
  const requireAuth = createRequireAuth(deps);

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.post("/login", async (req, res) => {
    const input = parseBody(loginSchema, req.body);
    const ip = requestIp(req);
    const userAgent = requestUserAgent(req);
    const windowMinutes = config.security.ipWindowMinutes;

    const ipFailures = await db.query<Row & { count: number }>(
      "SELECT count(*)::int AS count FROM login_attempts WHERE ip = $1 AND success = false AND created_at > now() - make_interval(mins => $2)",
      [ip, windowMinutes],
    );
    if ((ipFailures.rows[0]?.count ?? 0) >= config.security.maxIpFailures) {
      throw new ApiError(429, "RATE_LIMITED", "محاولات دخول كثيرة من هذا الجهاز. أعد المحاولة لاحقاً.");
    }

    const result = await db.query<LoginUserRow>(
      `SELECT u.id, u.username, u.password_hash, u.active, u.failed_attempts, u.locked_until, u.session_version
       FROM users u WHERE lower(u.username) = $1`,
      [input.username],
    );
    const user = result.rows[0];

    if (!user) {
      await verifyAgainstDummyHash(input.password);
      await recordAttempt(db, input.username, ip, false);
      await writeAudit(db, logger, {
        action: "auth.login_failed",
        actor: { id: null, username: input.username },
        severity: "warning",
        details: { reason: "unknown_user" },
        ip,
        userAgent,
      });
      throw new ApiError(401, "INVALID_CREDENTIALS", "اسم المستخدم أو كلمة المرور غير صحيحة.");
    }

    const lockedUntil = toDate(user.locked_until);
    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      await recordAttempt(db, input.username, ip, false);
      await writeAudit(db, logger, {
        action: "auth.login_blocked",
        actor: { id: null, username: input.username },
        entityType: "user",
        entityId: user.id,
        severity: "warning",
        details: { reason: "account_locked" },
        ip,
        userAgent,
      });
      const minutes = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 60_000));
      throw new ApiError(429, "ACCOUNT_LOCKED", `تم إيقاف محاولات الدخول مؤقتاً لحماية الحساب. أعد المحاولة بعد ${minutes} دقيقة.`, {
        retryAfterMinutes: minutes,
      });
    }

    if (lockedUntil && lockedUntil.getTime() <= Date.now()) {
      await db.query("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1", [user.id]);
      user.failed_attempts = 0;
    }

    const passwordValid = await verifyPassword(input.password, user.password_hash);
    if (!passwordValid) {
      const updated = await db.query<Row & { failed_attempts: number; locked_until: string | Date | null }>(
        `UPDATE users
         SET failed_attempts = failed_attempts + 1,
             locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END,
             updated_at = now()
         WHERE id = $1
         RETURNING failed_attempts, locked_until`,
        [user.id, config.security.maxLoginAttempts, config.security.lockMinutes],
      );
      const attempts = updated.rows[0]?.failed_attempts ?? 1;
      const newLock = toDate(updated.rows[0]?.locked_until ?? null);
      const isLocked = newLock !== null && newLock.getTime() > Date.now();
      await recordAttempt(db, input.username, ip, false);
      await writeAudit(db, logger, {
        action: isLocked ? "auth.account_locked" : "auth.login_failed",
        actor: { id: null, username: input.username },
        entityType: "user",
        entityId: user.id,
        severity: isLocked ? "critical" : "warning",
        details: {
          reason: "invalid_password",
          attempts,
          ...(isLocked ? { lockMinutes: config.security.lockMinutes } : {}),
        },
        ip,
        userAgent,
      });
      if (isLocked) {
        throw new ApiError(429, "ACCOUNT_LOCKED", `تم إيقاف محاولات الدخول مؤقتاً لحماية الحساب. أعد المحاولة بعد ${config.security.lockMinutes} دقيقة.`, {
          retryAfterMinutes: config.security.lockMinutes,
        });
      }
      throw new ApiError(401, "INVALID_CREDENTIALS", "اسم المستخدم أو كلمة المرور غير صحيحة.");
    }

    if (!user.active) {
      await writeAudit(db, logger, {
        action: "auth.login_failed",
        actor: { id: null, username: input.username },
        entityType: "user",
        entityId: user.id,
        severity: "warning",
        details: { reason: "account_disabled" },
        ip,
        userAgent,
      });
      throw new ApiError(403, "ACCOUNT_DISABLED", "الحساب معطل. يرجى مراجعة مدير النظام.");
    }

    await db.query(
      "UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = now(), updated_at = now() WHERE id = $1",
      [user.id],
    );
    await recordAttempt(db, input.username, ip, true);

    const created = await createSession(db, config, {
      userId: user.id,
      sessionVersion: user.session_version,
      remember: input.remember,
      ip,
      userAgent,
    });
    setSessionCookie(res, config, created.token, created.remember);

    const payload = await loadUserPayload(db, user.id);
    if (!payload) throw new ApiError(500, "INTERNAL_ERROR", "تعذر تحميل بيانات الحساب.");

    await writeAudit(db, logger, {
      action: "auth.login",
      actor: { id: user.id, username: user.username },
      entityType: "session",
      entityId: created.id,
      details: { remember: created.remember },
      ip,
      userAgent,
    });

    res.json({ user: payload, session: sessionPayload(created) });
  });

  router.get("/session", requireAuth, (req, res) => {
    if (!req.auth) throw unauthorized();
    res.json({ user: req.auth.user, session: req.auth.session });
  });

  router.post("/change-password", requireAuth, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const input = parseBody(changePasswordSchema, req.body);
    const current = await db.query<PasswordStateRow>(
      "SELECT password_hash, session_version FROM users WHERE id = $1 AND active = true",
      [req.auth.user.id],
    );
    const row = current.rows[0];
    if (!row) throw unauthorized();

    const validCurrent = await verifyPassword(input.currentPassword, row.password_hash);
    if (!validCurrent) {
      await writeAudit(db, logger, {
        action: "auth.password_change_failed",
        actor: { id: req.auth.user.id, username: req.auth.user.username },
        severity: "warning",
        details: { reason: "invalid_current_password" },
        ip: requestIp(req),
        userAgent: requestUserAgent(req),
      });
      throw new ApiError(400, "INVALID_CURRENT_PASSWORD", "كلمة المرور الحالية غير صحيحة.");
    }

    const policy = validatePasswordStrength(input.newPassword, req.auth.user.username);
    if (!policy.ok) throw new ApiError(400, "WEAK_PASSWORD", policy.message ?? "كلمة المرور غير مقبولة.");
    if (input.newPassword === input.currentPassword) {
      throw new ApiError(400, "PASSWORD_REUSED", "لا يمكن استخدام كلمة المرور الحالية مرة أخرى.");
    }

    const newHash = await hashPassword(input.newPassword);
    const updated = await db.query<Row & { session_version: number }>(
      `UPDATE users
       SET password_hash = $2, must_change_password = false, password_changed_at = now(),
           session_version = session_version + 1, updated_at = now()
       WHERE id = $1
       RETURNING session_version`,
      [req.auth.user.id, newHash],
    );
    const newVersion = updated.rows[0]?.session_version;
    if (!newVersion) throw new ApiError(500, "INTERNAL_ERROR", "تعذر تحديث كلمة المرور.");

    await revokeAllUserSessions(db, req.auth.user.id);
    const created = await createSession(db, config, {
      userId: req.auth.user.id,
      sessionVersion: newVersion,
      remember: req.auth.session.remember,
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    setSessionCookie(res, config, created.token, created.remember);

    const payload = await loadUserPayload(db, req.auth.user.id);
    if (!payload) throw new ApiError(500, "INTERNAL_ERROR", "تعذر تحميل بيانات الحساب.");

    await writeAudit(db, logger, {
      action: "auth.password_changed",
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "user",
      entityId: req.auth.user.id,
      details: { sessionsRevoked: true },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });

    res.json({ user: payload, session: sessionPayload(created) });
  });

  router.post("/logout", requireAuth, async (req, res) => {
    if (!req.auth) throw unauthorized();
    await revokeSession(db, req.auth.session.id);
    clearSessionCookie(res, config);
    await writeAudit(db, logger, {
      action: "auth.logout",
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "session",
      entityId: req.auth.session.id,
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.status(204).end();
  });

  router.post("/logout-all", requireAuth, async (req, res) => {
    if (!req.auth) throw unauthorized();
    await revokeAllUserSessions(db, req.auth.user.id);
    await db.query("UPDATE users SET session_version = session_version + 1, updated_at = now() WHERE id = $1", [
      req.auth.user.id,
    ]);
    clearSessionCookie(res, config);
    await writeAudit(db, logger, {
      action: "auth.logout_all",
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "user",
      entityId: req.auth.user.id,
      severity: "warning",
      details: { sessionsRevoked: "all" },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.status(204).end();
  });

  return router;
}
