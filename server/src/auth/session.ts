import { createHash, randomBytes } from "node:crypto";
import type { Response } from "express";
import type { AppConfig } from "../config.js";
import type { Db, Row } from "../db/index.js";
import { newId } from "../lib/ids.js";
import type { AuthSession, AuthUser, BranchAccess, RoleSummary } from "./types.js";

interface SessionAuthRow extends Row {
  session_id: string;
  stored_version: number;
  current_version: number;
  expires_at: string | Date;
  absolute_expires_at: string | Date;
  remember: boolean;
  revoked_at: string | Date | null;
  last_seen_at: string | Date;
  user_id: string;
  active: boolean;
}

interface UserPayloadRow extends Row {
  id: string;
  username: string;
  full_name: string;
  email: string | null;
  employee_id: string | null;
  must_change_password: boolean;
  active: boolean;
  all_branches: boolean;
  last_login_at: string | Date | null;
  created_at: string | Date;
  role_id: string;
  role_key: string;
  role_name: string;
  all_permissions: boolean;
  sort_order: number;
}

interface PermissionRow extends Row {
  permission_key?: string;
  key?: string;
}

interface BranchRow extends Row {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function toIso(value: string | Date | null): string | null {
  if (!value) return null;
  const date = toDate(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface CreateSessionInput {
  userId: string;
  sessionVersion: number;
  remember: boolean;
  ip: string;
  userAgent: string;
}

export interface CreatedSession {
  token: string;
  id: string;
  remember: boolean;
  expiresAt: string;
  absoluteExpiresAt: string;
}

export function sessionDurations(config: AppConfig, remember: boolean): { idleMs: number; absoluteMs: number } {
  if (remember) {
    const ms = config.session.rememberDays * 24 * 60 * 60 * 1000;
    return { idleMs: ms, absoluteMs: ms };
  }
  return {
    idleMs: config.session.idleMinutes * 60 * 1000,
    absoluteMs: config.session.absoluteHours * 60 * 60 * 1000,
  };
}

export async function createSession(db: Db, config: AppConfig, input: CreateSessionInput): Promise<CreatedSession> {
  const token = randomBytes(32).toString("base64url");
  const id = newId();
  const now = Date.now();
  const { idleMs, absoluteMs } = sessionDurations(config, input.remember);
  const expiresAt = new Date(now + idleMs);
  const absoluteExpiresAt = new Date(now + absoluteMs);
  await db.query(
    `INSERT INTO sessions
      (id, token_hash, user_id, session_version, expires_at, absolute_expires_at, remember, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      hashSessionToken(token),
      input.userId,
      input.sessionVersion,
      expiresAt.toISOString(),
      absoluteExpiresAt.toISOString(),
      input.remember,
      input.ip,
      input.userAgent,
    ],
  );
  return { token, id, remember: input.remember, expiresAt: expiresAt.toISOString(), absoluteExpiresAt: absoluteExpiresAt.toISOString() };
}

export function setSessionCookie(res: Response, config: AppConfig, token: string, remember: boolean): void {
  res.cookie(config.session.cookieName, token, {
    httpOnly: true,
    secure: config.session.secure,
    sameSite: "lax",
    path: "/",
    ...(remember ? { maxAge: config.session.rememberDays * 24 * 60 * 60 * 1000 } : {}),
  });
}

export function clearSessionCookie(res: Response, config: AppConfig): void {
  res.clearCookie(config.session.cookieName, {
    httpOnly: true,
    secure: config.session.secure,
    sameSite: "lax",
    path: "/",
  });
}

async function loadPermissions(db: Db, roleId: string, allPermissions: boolean): Promise<string[]> {
  if (allPermissions) {
    const rows = await db.query<PermissionRow>("SELECT key FROM permissions ORDER BY sort_order, key");
    return rows.rows.map((row) => row.key ?? "");
  }
  const rows = await db.query<PermissionRow>(
    "SELECT permission_key FROM role_permissions WHERE role_id = $1 ORDER BY permission_key",
    [roleId],
  );
  return rows.rows.map((row) => row.permission_key ?? "");
}

async function loadBranches(db: Db, userId: string, allBranches: boolean): Promise<BranchAccess[]> {
  const rows = allBranches
    ? await db.query<BranchRow>("SELECT id, code, name, active FROM branches ORDER BY name")
    : await db.query<BranchRow>(
        `SELECT b.id, b.code, b.name, b.active
         FROM branches b
         JOIN user_branch_access uba ON uba.branch_id = b.id
         WHERE uba.user_id = $1
         ORDER BY b.name`,
        [userId],
      );
  return rows.rows.map((row) => ({ id: row.id, code: row.code, name: row.name, active: row.active }));
}

export async function loadUserPayload(db: Db, userId: string): Promise<AuthUser | null> {
  const result = await db.query<UserPayloadRow>(
    `SELECT u.id, u.username, u.full_name, u.email, u.employee_id, u.must_change_password, u.active, u.all_branches,
            u.last_login_at, u.created_at,
            r.id AS role_id, r.key AS role_key, r.name_ar AS role_name, r.all_permissions, r.sort_order
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const [permissions, branches] = await Promise.all([
    loadPermissions(db, row.role_id, row.all_permissions),
    loadBranches(db, userId, row.all_branches),
  ]);
  const role: RoleSummary = {
    id: row.role_id,
    key: row.role_key,
    nameAr: row.role_name,
    allPermissions: row.all_permissions,
    sortOrder: row.sort_order,
  };
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    email: row.email,
    employeeId: row.employee_id,
    role,
    permissions,
    allBranches: row.all_branches,
    branches,
    mustChangePassword: row.must_change_password,
    active: row.active,
    lastLoginAt: toIso(row.last_login_at),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
  };
}

export interface AuthLookup {
  user: AuthUser;
  session: AuthSession;
}

export async function getAuthByToken(db: Db, config: AppConfig, token: string): Promise<AuthLookup | null> {
  const tokenHash = hashSessionToken(token);
  const result = await db.query<SessionAuthRow>(
    `SELECT s.id AS session_id, s.session_version AS stored_version, s.expires_at, s.absolute_expires_at,
            s.remember, s.revoked_at, s.last_seen_at,
            u.id AS user_id, u.session_version AS current_version, u.active
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) return null;

  const now = new Date();
  const expiresAt = toDate(row.expires_at);
  const absoluteExpiresAt = toDate(row.absolute_expires_at);
  const invalid =
    row.revoked_at !== null ||
    !row.active ||
    row.stored_version !== row.current_version ||
    expiresAt.getTime() <= now.getTime() ||
    absoluteExpiresAt.getTime() <= now.getTime();

  if (invalid) {
    await revokeSession(db, row.session_id);
    return null;
  }

  const lastSeen = toDate(row.last_seen_at);
  if (now.getTime() - lastSeen.getTime() > 60_000) {
    const { idleMs } = sessionDurations(config, row.remember);
    const extended = new Date(Math.min(now.getTime() + idleMs, absoluteExpiresAt.getTime()));
    await db.query(
      `UPDATE sessions
       SET last_seen_at = now(), expires_at = LEAST($1::timestamptz, absolute_expires_at)
       WHERE id = $2 AND revoked_at IS NULL`,
      [extended.toISOString(), row.session_id],
    );
  }

  const user = await loadUserPayload(db, row.user_id);
  if (!user) return null;

  return {
    user,
    session: {
      id: row.session_id,
      remember: row.remember,
      expiresAt: expiresAt.toISOString(),
      absoluteExpiresAt: absoluteExpiresAt.toISOString(),
    },
  };
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.query("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [sessionId]);
}

export async function revokeAllUserSessions(db: Db, userId: string, exceptSessionId: string | null = null): Promise<void> {
  if (exceptSessionId) {
    await db.query(
      "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2",
      [userId, exceptSessionId],
    );
    return;
  }
  await db.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
}

export async function purgeExpiredSessions(db: Db): Promise<void> {
  await db.query(
    `DELETE FROM sessions
     WHERE expires_at < now() - interval '7 days'
        OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')`,
  );
  await db.query("DELETE FROM login_attempts WHERE created_at < now() - interval '30 days'");
}
