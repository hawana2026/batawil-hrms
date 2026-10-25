import { Router } from "express";
import { z } from "zod";
import type { Row } from "../db/index.js";
import { writeAudit } from "../lib/audit.js";
import { parseBody, requestIp, requestUserAgent, unauthorized } from "../lib/errors.js";
import { auditScopeSql } from "../services/access.js";
import { createRequireAuth, createRequirePermission, requirePasswordReady, type AuthDeps } from "../middleware/auth.js";

const auditQuerySchema = z.object({
  q: z.string().trim().max(100).default(""),
  action: z.string().trim().max(100).default(""),
  severity: z.enum(["all", "info", "warning", "critical"]).default("all"),
  from: z.string().trim().max(10).default(""),
  to: z.string().trim().max(10).default(""),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function validateDate(value: string): string | null {
  if (!value) return null;
  if (!datePattern.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return value;
}

interface AuditRow extends Row {
  id: string | number;
  actor_username: string;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  branch_id: string | null;
  branch_name: string | null;
  severity: string;
  details: unknown;
  ip: string;
  created_at: string | Date;
}

function parseDetails(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function toIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function createAuditRouter(deps: AuthDeps): Router {
  const { db, logger } = deps;
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);
  const requireView = createRequirePermission("audit.view", deps);

  router.get("/", requireView, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const query = parseBody(auditQuerySchema, req.query);
    const params: unknown[] = [];
    const where: string[] = [];

    const scope = auditScopeSql(actor, "a", 1);
    params.push(...scope.params);
    where.push(scope.sql);

    const addParam = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (query.q) {
      const p = addParam(`%${query.q}%`);
      where.push(`(a.actor_username ILIKE ${p} OR a.action ILIKE ${p} OR a.entity_id ILIKE ${p})`);
    }
    if (query.action) {
      const p = addParam(query.action);
      where.push(`a.action = ${p}`);
    }
    if (query.severity !== "all") {
      const p = addParam(query.severity);
      where.push(`a.severity = ${p}`);
    }
    const from = validateDate(query.from);
    if (from) {
      const p = addParam(from);
      where.push(`a.created_at >= ${p}::date`);
    }
    const to = validateDate(query.to);
    if (to) {
      const p = addParam(to);
      where.push(`a.created_at < (${p}::date + interval '1 day')`);
    }

    const countResult = await db.query<Row & { total: number }>(
      `SELECT count(*)::int AS total FROM audit_logs a WHERE ${where.join(" AND ")}`,
      params,
    );
    const offset = (query.page - 1) * query.pageSize;
    const limitParam = addParam(query.pageSize);
    const offsetParam = addParam(offset);

    const rowsResult = await db.query<AuditRow>(
      `SELECT a.id, a.actor_username, a.actor_user_id, a.action, a.entity_type, a.entity_id,
              a.branch_id, b.name AS branch_name, a.severity, a.details, a.ip, a.created_at
       FROM audit_logs a
       LEFT JOIN branches b ON b.id = a.branch_id
       WHERE ${where.join(" AND ")}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    );

    res.json({
      items: rowsResult.rows.map((row) => ({
        id: String(row.id),
        actorUsername: row.actor_username,
        actorUserId: row.actor_user_id,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        branchId: row.branch_id,
        branchName: row.branch_name,
        severity: row.severity,
        details: parseDetails(row.details),
        ip: row.ip,
        createdAt: toIso(row.created_at),
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: countResult.rows[0]?.total ?? 0,
    });
  });

  return router;
}
