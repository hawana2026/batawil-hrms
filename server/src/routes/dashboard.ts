import { Router } from "express";
import type { Row } from "../db/index.js";
import { hasPermission } from "../auth/types.js";
import { unauthorized } from "../lib/errors.js";
import { auditScopeSql, userScopeSql } from "../services/access.js";
import { createRequireAuth, requirePasswordReady, type AuthDeps } from "../middleware/auth.js";

interface CountRow extends Row {
  total: number;
  active?: number;
  locked?: number;
  must_change?: number;
}

interface ActivityRow extends Row {
  action: string;
  actor_username: string;
  severity: string;
  created_at: string | Date;
  branch_name: string | null;
}

interface BranchActivityRow extends Row {
  name: string;
  code: string;
  active: boolean;
}

function toIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function createDashboardRouter(deps: AuthDeps): Router {
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);

  router.get("/", async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;

    const canViewUsers = hasPermission(actor, "users.view");
    const canViewBranches = hasPermission(actor, "branches.view");
    const canViewAudit = hasPermission(actor, "audit.view");

    let users: CountRow | null = null;
    if (canViewUsers) {
      const scope = userScopeSql(actor, "u", 1);
      const result = await deps.db.query<CountRow>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE u.active)::int AS active,
                count(*) FILTER (WHERE u.locked_until IS NOT NULL AND u.locked_until > now())::int AS locked,
                count(*) FILTER (WHERE u.must_change_password AND u.active)::int AS must_change
         FROM users u WHERE u.deleted_at IS NULL AND ${scope.sql}`,
        scope.params,
      );
      users = result.rows[0] ?? { total: 0, active: 0, locked: 0, must_change: 0 };
    }

    let branches: { total: number; active: number } | null = null;
    if (canViewBranches) {
      const result = actor.allBranches
        ? await deps.db.query<Row & { total: number; active: number }>(
            "SELECT count(*)::int AS total, count(*) FILTER (WHERE active)::int AS active FROM branches",
          )
        : await deps.db.query<Row & { total: number; active: number }>(
            "SELECT count(*)::int AS total, count(*) FILTER (WHERE active)::int AS active FROM branches WHERE id = ANY($1::uuid[])",
            [actor.branches.map((branch) => branch.id)],
          );
      branches = result.rows[0] ?? { total: 0, active: 0 };
    }

    let audit: { last24h: number; criticalWeek: number } | null = null;
    let recentActivity: Array<{
      action: string;
      actorUsername: string;
      severity: string;
      branchName: string | null;
      createdAt: string;
    }> = [];
    if (canViewAudit) {
      const scope = auditScopeSql(actor, "a", 1);
      const [stats, activity] = await Promise.all([
        deps.db.query<Row & { last24h: number; critical_week: number }>(
          `SELECT count(*) FILTER (WHERE a.created_at > now() - interval '24 hours')::int AS last24h,
                  count(*) FILTER (WHERE a.severity = 'critical' AND a.created_at > now() - interval '7 days')::int AS critical_week
           FROM audit_logs a WHERE ${scope.sql}`,
          scope.params,
        ),
        deps.db.query<ActivityRow>(
          `SELECT a.action, a.actor_username, a.severity, a.created_at, b.name AS branch_name
           FROM audit_logs a LEFT JOIN branches b ON b.id = a.branch_id
           WHERE ${scope.sql}
           ORDER BY a.created_at DESC, a.id DESC
           LIMIT 8`,
          scope.params,
        ),
      ]);
      audit = {
        last24h: stats.rows[0]?.last24h ?? 0,
        criticalWeek: stats.rows[0]?.critical_week ?? 0,
      };
      recentActivity = activity.rows.map((row) => ({
        action: row.action,
        actorUsername: row.actor_username,
        severity: row.severity,
        branchName: row.branch_name,
        createdAt: toIso(row.created_at),
      }));
    }

    let branchList: Array<{ name: string; code: string; active: boolean }> = [];
    if (canViewBranches) {
      const result = actor.allBranches
        ? await deps.db.query<BranchActivityRow>("SELECT name, code, active FROM branches ORDER BY active DESC, name")
        : await deps.db.query<BranchActivityRow>(
            "SELECT name, code, active FROM branches WHERE id = ANY($1::uuid[]) ORDER BY active DESC, name",
            [actor.branches.map((branch) => branch.id)],
          );
      branchList = result.rows.map((row) => ({ name: row.name, code: row.code, active: row.active }));
    }

    res.json({
      serverTime: new Date().toISOString(),
      account: {
        fullName: actor.fullName,
        username: actor.username,
        roleName: actor.role.nameAr,
        allBranches: actor.allBranches,
        branches: actor.branches,
        lastLoginAt: actor.lastLoginAt,
      },
      users,
      branches,
      audit,
      recentActivity,
      branchList,
      capabilities: { canViewUsers, canViewBranches, canViewAudit },
    });
  });

  return router;
}
