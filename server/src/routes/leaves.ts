import { Router, type Request } from "express";
import { z } from "zod";
import type { Row } from "../db/index.js";
import { writeAudit } from "../lib/audit.js";
import { ApiError, conflict, forbidden, notFound, parseBody, requestIp, requestUserAgent, unauthorized } from "../lib/errors.js";
import { isoDateSchema, leaveSchema } from "../lib/hr-schemas.js";
import { newId } from "../lib/ids.js";
import { branchScopeSql, canAccessBranch } from "../services/access.js";
import { cancelApproval, notifyPermissionHolders, openApproval } from "../services/approvals.js";
import { decideLeave } from "../services/decisions.js";
import { loadEmployee } from "../services/employees.js";
import { createRequireAuth, createRequirePermission, requirePasswordReady, type AuthDeps } from "../middleware/auth.js";

const listQuerySchema = z.object({
  status: z.enum(["all", "draft", "pending", "approved", "rejected", "cancelled"]).default("all"),
  type: z.enum(["all", "annual", "sick", "unpaid", "emergency", "permission", "other"]).default("all"),
  employeeId: z.string().trim().max(64).default(""),
  branchId: z.string().trim().max(64).default(""),
  from: z.union([z.literal(""), isoDateSchema]).default(""),
  to: z.union([z.literal(""), isoDateSchema]).default(""),
  q: z.string().trim().max(100).default(""),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

interface LeaveRow extends Row {
  id: string;
  employee_id: string;
  employee_no: string;
  employee_name: string;
  branch_id: string;
  branch_name: string;
  leave_type: string;
  start_date: string;
  end_date: string;
  days: number;
  reason: string;
  notes: string;
  status: string;
  requested_by_name: string | null;
  decided_by_name: string | null;
  decided_at: string | Date | null;
  decision_note: string | null;
  attachments_count: number;
  created_at: string | Date;
  updated_at: string | Date;
}

function presentLeave(row: LeaveRow) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeNo: row.employee_no,
    employeeName: row.employee_name,
    branchId: row.branch_id,
    branchName: row.branch_name,
    leaveType: row.leave_type,
    startDate: row.start_date,
    endDate: row.end_date,
    days: row.days,
    reason: row.reason,
    notes: row.notes,
    status: row.status,
    requestedBy: row.requested_by_name,
    decidedBy: row.decided_by_name,
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    decisionNote: row.decision_note,
    attachmentsCount: row.attachments_count,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function daysBetween(startDate: string, endDate: string): number {
  return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000) + 1;
}

async function logDecision(req: Request, deps: AuthDeps, outcome: Awaited<ReturnType<typeof decideLeave>>, extra: Record<string, unknown> = {}) {
  if (!req.auth) return;
  await writeAudit(deps.db, deps.logger, {
    action: outcome.action,
    actor: { id: req.auth.user.id, username: req.auth.user.username },
    entityType: "leave",
    entityId: outcome.entityId,
    branchId: outcome.branchId,
    severity: outcome.action.endsWith("rejected") ? "warning" : "info",
    details: { ...outcome.details, ...extra },
    ip: requestIp(req),
    userAgent: requestUserAgent(req),
  });
}

export function createLeavesRouter(deps: AuthDeps): Router {
  const { db, logger } = deps;
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);

  const requireView = createRequirePermission("leaves.view", deps);
  const requireManage = createRequirePermission("leaves.manage", deps);
  const requireApprove = createRequirePermission("leaves.approve", deps);

  router.get("/", requireView, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const query = parseBody(listQuerySchema, req.query);
    const scope = branchScopeSql(req.auth.user, "l", 1);
    const params: unknown[] = [...scope.params];
    const where: string[] = [scope.sql];
    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.status !== "all") where.push(`l.status = ${add(query.status)}`);
    if (query.type !== "all") where.push(`l.leave_type = ${add(query.type)}`);
    if (query.employeeId) where.push(`l.employee_id = ${add(query.employeeId)}::uuid`);
    if (query.branchId) where.push(`l.branch_id = ${add(query.branchId)}::uuid`);
    if (query.from) where.push(`l.end_date >= ${add(query.from)}::date`);
    if (query.to) where.push(`l.start_date <= ${add(query.to)}::date`);
    if (query.q) {
      const p = add(`%${query.q}%`);
      where.push(`(e.full_name ILIKE ${p} OR e.employee_no ILIKE ${p})`);
    }
    const count = await db.query<Row & { total: number }>(
      `SELECT count(*)::int AS total FROM leave_requests l JOIN employees e ON e.id = l.employee_id WHERE ${where.join(" AND ")}`,
      params,
    );
    const limit = add(query.pageSize);
    const offset = add((query.page - 1) * query.pageSize);
    const result = await db.query<LeaveRow>(
      `SELECT l.id, l.employee_id, e.employee_no, e.full_name AS employee_name, l.branch_id, b.name AS branch_name,
              l.leave_type, l.start_date::text AS start_date, l.end_date::text AS end_date, l.days, l.reason, l.notes, l.status,
              ru.full_name AS requested_by_name, du.full_name AS decided_by_name, l.decided_at, l.decision_note,
              (SELECT count(*)::int FROM attachments a WHERE a.owner_type = 'leave' AND a.owner_id = l.id) AS attachments_count,
              l.created_at, l.updated_at
       FROM leave_requests l
       JOIN employees e ON e.id = l.employee_id
       JOIN branches b ON b.id = l.branch_id
       LEFT JOIN users ru ON ru.id = l.requested_by
       LEFT JOIN users du ON du.id = l.decided_by
       WHERE ${where.join(" AND ")}
       ORDER BY l.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    const statusCounts = await db.query<Row & { status: string; total: number }>(
      `SELECT l.status, count(*)::int AS total FROM leave_requests l WHERE ${scope.sql} GROUP BY l.status`,
      scope.params,
    );
    res.json({
      items: result.rows.map(presentLeave),
      total: count.rows[0]?.total ?? 0,
      page: query.page,
      pageSize: query.pageSize,
      counts: Object.fromEntries(statusCounts.rows.map((row) => [row.status, row.total])),
      capabilities: {
        canManage: req.auth.user.permissions.includes("leaves.manage") || req.auth.user.role.allPermissions,
        canApprove: req.auth.user.permissions.includes("leaves.approve") || req.auth.user.role.allPermissions,
      },
    });
  });

  router.post("/", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const input = parseBody(leaveSchema, req.body);
    const employee = await loadEmployee(db, input.employeeId);
    if (!canAccessBranch(actor, employee.branch_id)) throw notFound("الموظف غير موجود أو خارج نطاق صلاحيتك.");
    if (employee.archived_at) throw new ApiError(400, "EMPLOYEE_ARCHIVED", "الموظف مؤرشف ولا يمكن إنشاء طلب له.");
    const days = daysBetween(input.startDate, input.endDate);
    if (days < 1 || days > 366) throw new ApiError(400, "INVALID_RANGE", "مدة الطلب يجب أن تكون بين يوم و366 يوماً.");
    const overlap = await db.query<Row & { id: string }>(
      `SELECT id FROM leave_requests
       WHERE employee_id = $1 AND status IN ('draft', 'pending', 'approved')
         AND start_date <= $3::date AND end_date >= $2::date LIMIT 1`,
      [input.employeeId, input.startDate, input.endDate],
    );
    if (overlap.rows[0]) throw conflict("يوجد طلب إجازة أو إذن متداخل لنفس الموظف.");
    const id = newId();
    await db.query(
      `INSERT INTO leave_requests
        (id, employee_id, branch_id, leave_type, start_date, end_date, days, reason, notes, status, requested_by)
       VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8,$9,'draft',$10)`,
      [id, input.employeeId, employee.branch_id, input.leaveType, input.startDate, input.endDate, days, input.reason, input.notes, actor.id],
    );
    await writeAudit(db, logger, {
      action: "leave.created",
      actor: { id: actor.id, username: actor.username },
      entityType: "leave",
      entityId: id,
      branchId: employee.branch_id,
      severity: "info",
      details: { employee: employee.full_name, type: input.leaveType, startDate: input.startDate, endDate: input.endDate, days },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.status(201).json({ id });
  });

  router.patch("/:id", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const id = z.uuid("معرّف طلب غير صالح.").parse(req.params.id);
    const input = parseBody(leaveSchema, req.body);
    const current = await db.query<Row & { status: string; branch_id: string; employee_id: string; requested_by: string | null }>(
      "SELECT status, branch_id, employee_id, requested_by FROM leave_requests WHERE id = $1",
      [id],
    );
    const leave = current.rows[0];
    if (!leave) throw notFound("الطلب غير موجود.");
    if (!canAccessBranch(req.auth.user, leave.branch_id)) throw notFound("الطلب غير موجود أو خارج نطاق صلاحيتك.");
    if (leave.status !== "draft" && leave.status !== "rejected") throw conflict("لا يمكن تعديل طلب في هذه الحالة.");
    if (leave.employee_id !== input.employeeId) throw new ApiError(400, "INVALID_EMPLOYEE", "لا يمكن تغيير موظف الطلب.");
    const employee = await loadEmployee(db, input.employeeId);
    if (employee.branch_id !== leave.branch_id) throw new ApiError(400, "INVALID_EMPLOYEE", "لا يمكن نقل الطلب إلى فرع آخر.");
    const days = daysBetween(input.startDate, input.endDate);
    const overlap = await db.query<Row & { id: string }>(
      `SELECT id FROM leave_requests
       WHERE employee_id = $1 AND id <> $2 AND status IN ('draft', 'pending', 'approved')
         AND start_date <= $4::date AND end_date >= $3::date LIMIT 1`,
      [input.employeeId, id, input.startDate, input.endDate],
    );
    if (overlap.rows[0]) throw conflict("يوجد طلب إجازة أو إذن متداخل لنفس الموظف.");
    await db.query(
      `UPDATE leave_requests SET leave_type=$2, start_date=$3::date, end_date=$4::date, days=$5, reason=$6, notes=$7, updated_at=now() WHERE id=$1`,
      [id, input.leaveType, input.startDate, input.endDate, days, input.reason, input.notes],
    );
    await writeAudit(db, logger, {
      action: "leave.updated",
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "leave",
      entityId: id,
      branchId: leave.branch_id,
      severity: "info",
      details: { type: input.leaveType, startDate: input.startDate, endDate: input.endDate, days },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  });

  router.post("/:id/submit", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const id = z.uuid("معرّف طلب غير صالح.").parse(req.params.id);
    const result = await db.query<Row & { status: string; branch_id: string; employee_name: string; leave_type: string; start_date: string; end_date: string; days: number }>(
      `SELECT l.status, l.branch_id, e.full_name AS employee_name, l.leave_type,
              l.start_date::text AS start_date, l.end_date::text AS end_date, l.days
       FROM leave_requests l JOIN employees e ON e.id = l.employee_id WHERE l.id = $1`,
      [id],
    );
    const leave = result.rows[0];
    if (!leave) throw notFound("الطلب غير موجود.");
    if (!canAccessBranch(actor, leave.branch_id)) throw notFound("الطلب غير موجود أو خارج نطاق صلاحيتك.");
    if (leave.status !== "draft" && leave.status !== "rejected") throw conflict("لا يمكن إرسال طلب في هذه الحالة.");
    await db.query("UPDATE leave_requests SET status='pending', updated_at=now() WHERE id=$1", [id]);
    await openApproval(db, {
      entityType: "leave",
      entityId: id,
      branchId: leave.branch_id,
      title: `${leave.leave_type === "permission" ? "إذن" : "إجازة"} — ${leave.employee_name}`,
      summary: `${leave.start_date} إلى ${leave.end_date} (${leave.days} يوم)`,
      requestedBy: actor.id,
    });
    await notifyPermissionHolders(
      db,
      "leaves.approve",
      leave.branch_id,
      "طلب إجازة بانتظار الاعتماد",
      `${actor.fullName} أرسل طلب ${leave.leave_type === "permission" ? "إذن" : "إجازة"} للموظف ${leave.employee_name}.`,
      "#/approvals",
    );
    await writeAudit(db, logger, {
      action: "leave.submitted",
      actor: { id: actor.id, username: actor.username },
      entityType: "leave",
      entityId: id,
      branchId: leave.branch_id,
      severity: "info",
      details: { employee: leave.employee_name, days: leave.days },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  });

  router.post("/:id/approve", requireApprove, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const id = z.uuid("معرّف طلب غير صالح.").parse(req.params.id);
    const body = req.body as { reason?: string };
    const scopeCheck = await db.query<Row & { branch_id: string }>("SELECT branch_id FROM leave_requests WHERE id = $1", [id]);
    if (!scopeCheck.rows[0] || !canAccessBranch(req.auth.user, scopeCheck.rows[0].branch_id)) {
      throw notFound("الطلب غير موجود أو خارج نطاق صلاحيتك.");
    }
    const outcome = await decideLeave(db, req.auth.user, id, "approved", String(body?.reason ?? ""));
    await logDecision(req, deps, outcome);
    res.json({ ok: true });
  });

  router.post("/:id/reject", requireApprove, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const id = z.uuid("معرّف طلب غير صالح.").parse(req.params.id);
    const body = req.body as { reason?: string };
    const scopeCheck = await db.query<Row & { branch_id: string }>("SELECT branch_id FROM leave_requests WHERE id = $1", [id]);
    if (!scopeCheck.rows[0] || !canAccessBranch(req.auth.user, scopeCheck.rows[0].branch_id)) {
      throw notFound("الطلب غير موجود أو خارج نطاق صلاحيتك.");
    }
    const outcome = await decideLeave(db, req.auth.user, id, "rejected", String(body?.reason ?? ""));
    await logDecision(req, deps, outcome);
    res.json({ ok: true });
  });

  router.post("/:id/cancel", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const id = z.uuid("معرّف طلب غير صالح.").parse(req.params.id);
    const result = await db.query<Row & { status: string; branch_id: string; employee_name: string }>(
      `SELECT l.status, l.branch_id, e.full_name AS employee_name FROM leave_requests l JOIN employees e ON e.id = l.employee_id WHERE l.id = $1`,
      [id],
    );
    const leave = result.rows[0];
    if (!leave) throw notFound("الطلب غير موجود.");
    if (!canAccessBranch(req.auth.user, leave.branch_id)) throw forbidden("الطلب خارج نطاق صلاحيتك.");
    if (leave.status === "approved" || leave.status === "cancelled") throw conflict("لا يمكن إلغاء طلب في هذه الحالة.");
    await db.query("UPDATE leave_requests SET status='cancelled', updated_at=now() WHERE id=$1", [id]);
    await cancelApproval(db, "leave", id);
    await writeAudit(db, logger, {
      action: "leave.cancelled",
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "leave",
      entityId: id,
      branchId: leave.branch_id,
      severity: "info",
      details: { employee: leave.employee_name },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  });

  return router;
}
