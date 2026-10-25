import { Router } from "express";
import { z } from "zod";
import type { Row } from "../db/index.js";
import { writeAudit } from "../lib/audit.js";
import { ApiError, conflict, forbidden, notFound, parseBody, requestIp, requestUserAgent, unauthorized } from "../lib/errors.js";
import { isoDateSchema, transferSchema } from "../lib/hr-schemas.js";
import { newId } from "../lib/ids.js";
import { canAccessBranch } from "../services/access.js";
import { cancelApproval, notifyPermissionHolders, openApproval } from "../services/approvals.js";
import { decideTransfer } from "../services/decisions.js";
import { loadEmployee, toDateOnly } from "../services/employees.js";
import { createRequireAuth, createRequirePermission, requirePasswordReady, type AuthDeps } from "../middleware/auth.js";

const listQuerySchema = z.object({
  status: z.enum(["all", "pending", "approved", "rejected", "cancelled"]).default("all"),
  employeeId: z.string().trim().max(64).default(""),
  branchId: z.string().trim().max(64).default(""),
  q: z.string().trim().max(100).default(""),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const rejectSchema = z.object({ reason: z.string().trim().min(3, "سبب الرفض مطلوب.").max(1000) });

interface TransferRow extends Row {
  id: string;
  employee_id: string;
  employee_no: string;
  employee_name: string;
  from_branch_id: string;
  from_branch_name: string;
  to_branch_id: string;
  to_branch_name: string;
  from_department_id: string | null;
  from_department_name: string | null;
  to_department_id: string | null;
  to_department_name: string | null;
  effective_date: string;
  reason: string;
  notes: string;
  status: string;
  requested_by_name: string | null;
  approved_by_name: string | null;
  approved_at: string | Date | null;
  applied_at: string | Date | null;
  decision_note: string | null;
  created_at: string | Date;
}

function presentTransfer(row: TransferRow) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeNo: row.employee_no,
    employeeName: row.employee_name,
    fromBranchId: row.from_branch_id,
    fromBranch: row.from_branch_name,
    toBranchId: row.to_branch_id,
    toBranch: row.to_branch_name,
    fromDepartmentId: row.from_department_id,
    fromDepartment: row.from_department_name,
    toDepartmentId: row.to_department_id,
    toDepartment: row.to_department_name,
    effectiveDate: row.effective_date,
    reason: row.reason,
    notes: row.notes,
    status: row.status,
    requestedBy: row.requested_by_name,
    approvedBy: row.approved_by_name,
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
    appliedAt: row.applied_at ? new Date(row.applied_at).toISOString() : null,
    decisionNote: row.decision_note,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export function createTransfersRouter(deps: AuthDeps): Router {
  const { db, logger } = deps;
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);

  const requireView = createRequirePermission("transfers.view", deps);
  const requireManage = createRequirePermission("transfers.manage", deps);
  const requireApprove = createRequirePermission("transfers.approve", deps);

  router.get("/", requireView, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const query = parseBody(listQuerySchema, req.query);
    const params: unknown[] = [];
    const where: string[] = [];
    if (!actor.allBranches) {
      const ids = actor.branches.map((branch) => branch.id);
      params.push(ids);
      where.push(`(t.from_branch_id = ANY($1::uuid[]) OR t.to_branch_id = ANY($1::uuid[]))`);
    } else {
      where.push("TRUE");
    }
    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.status !== "all") where.push(`t.status = ${add(query.status)}`);
    if (query.employeeId) where.push(`t.employee_id = ${add(query.employeeId)}::uuid`);
    if (query.branchId) {
      const p = add(query.branchId);
      where.push(`(t.from_branch_id = ${p}::uuid OR t.to_branch_id = ${p}::uuid)`);
    }
    if (query.q) {
      const p = add(`%${query.q}%`);
      where.push(`(e.full_name ILIKE ${p} OR e.employee_no ILIKE ${p})`);
    }
    const count = await db.query<Row & { total: number }>(
      `SELECT count(*)::int AS total FROM employee_transfers t JOIN employees e ON e.id = t.employee_id WHERE ${where.join(" AND ")}`,
      params,
    );
    const limit = add(query.pageSize);
    const offset = add((query.page - 1) * query.pageSize);
    const result = await db.query<TransferRow>(
      `SELECT t.id, t.employee_id, e.employee_no, e.full_name AS employee_name,
              t.from_branch_id, fb.name AS from_branch_name, t.to_branch_id, tb.name AS to_branch_name,
              t.from_department_id, fd.name AS from_department_name, t.to_department_id, td.name AS to_department_name,
              t.effective_date::text AS effective_date, t.reason, t.notes, t.status,
              ru.full_name AS requested_by_name, au.full_name AS approved_by_name, t.approved_at, t.applied_at, t.decision_note, t.created_at
       FROM employee_transfers t
       JOIN employees e ON e.id = t.employee_id
       JOIN branches fb ON fb.id = t.from_branch_id
       JOIN branches tb ON tb.id = t.to_branch_id
       LEFT JOIN departments fd ON fd.id = t.from_department_id
       LEFT JOIN departments td ON td.id = t.to_department_id
       LEFT JOIN users ru ON ru.id = t.requested_by
       LEFT JOIN users au ON au.id = t.approved_by
       WHERE ${where.join(" AND ")}
       ORDER BY t.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    res.json({
      items: result.rows.map(presentTransfer),
      total: count.rows[0]?.total ?? 0,
      page: query.page,
      pageSize: query.pageSize,
      capabilities: {
        canManage: req.auth.user.role.allPermissions || req.auth.user.permissions.includes("transfers.manage"),
        canApprove: req.auth.user.role.allPermissions || req.auth.user.permissions.includes("transfers.approve"),
      },
    });
  });

  router.post("/", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const input = parseBody(transferSchema, req.body);
    const employee = await loadEmployee(db, input.employeeId);
    if (!canAccessBranch(actor, employee.branch_id)) throw notFound("الموظف غير موجود أو خارج نطاق صلاحيتك.");
    if (employee.archived_at) throw new ApiError(400, "EMPLOYEE_ARCHIVED", "الموظف مؤرشف ولا يمكن تحويله.");
    if (input.toBranchId === employee.branch_id && (input.toDepartmentId ?? null) === (employee.department_id ?? null)) {
      throw new ApiError(400, "NO_CHANGE", "يجب اختيار فرع أو قسم مختلف عن الوضع الحالي.");
    }
    if (input.toBranchId === employee.branch_id && !input.toDepartmentId) {
      throw new ApiError(400, "INVALID_TRANSFER", "حدد القسم الجديد عند التحويل داخل نفس الفرع.");
    }
    const toBranch = await db.query<Row & { name: string; active: boolean }>("SELECT name, active FROM branches WHERE id = $1", [input.toBranchId]);
    if (!toBranch.rows[0]) throw new ApiError(400, "INVALID_BRANCH", "الفرع الجديد غير موجود.");
    if (!toBranch.rows[0].active) throw new ApiError(400, "INACTIVE_BRANCH", "لا يمكن التحويل إلى فرع معطل.");
    if (input.toDepartmentId) {
      const department = await db.query<Row & { name: string; active: boolean }>("SELECT name, active FROM departments WHERE id = $1", [input.toDepartmentId]);
      if (!department.rows[0]) throw new ApiError(400, "INVALID_DEPARTMENT", "القسم الجديد غير موجود.");
      if (!department.rows[0].active) throw new ApiError(400, "INACTIVE_DEPARTMENT", "لا يمكن التحويل إلى قسم معطل.");
    }
    const existing = await db.query<Row & { id: string; status: string }>(
      "SELECT id, status FROM employee_transfers WHERE employee_id = $1 AND (status = 'pending' OR (status = 'approved' AND applied_at IS NULL)) LIMIT 1",
      [input.employeeId],
    );
    if (existing.rows[0]) throw conflict("يوجد للموظف طلب تحويل قيد المراجعة أو معتمد لم يُطبق بعد.");
    const id = newId();
    await db.query(
      `INSERT INTO employee_transfers
        (id, employee_id, from_branch_id, to_branch_id, from_department_id, to_department_id, effective_date, reason, notes, requested_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,'pending')`,
      [
        id,
        employee.id,
        employee.branch_id,
        input.toBranchId,
        employee.department_id,
        input.toDepartmentId ?? null,
        input.effectiveDate,
        input.reason,
        input.notes,
        actor.id,
      ],
    );
    await openApproval(db, {
      entityType: "transfer",
      entityId: id,
      branchId: employee.branch_id,
      title: `تحويل وظيفي — ${employee.full_name}`,
      summary: `${employee.branch_name} → ${toBranch.rows[0].name} — اعتباراً من ${input.effectiveDate}`,
      requestedBy: actor.id,
    });
    await notifyPermissionHolders(
      db,
      "transfers.approve",
      employee.branch_id,
      "طلب تحويل وظيفي بانتظار الاعتماد",
      `${actor.fullName} طلب تحويل ${employee.full_name} إلى ${toBranch.rows[0].name}.`,
      "#/approvals",
    );
    await writeAudit(db, logger, {
      action: "transfer.requested",
      actor: { id: actor.id, username: actor.username },
      entityType: "transfer",
      entityId: id,
      branchId: employee.branch_id,
      severity: "info",
      details: {
        employee: employee.employee_no,
        employeeName: employee.full_name,
        fromBranch: employee.branch_name,
        toBranch: toBranch.rows[0].name,
        effectiveDate: input.effectiveDate,
        reason: input.reason,
      },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.status(201).json({ id });
  });

  router.post("/:id/approve", requireApprove, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const id = z.uuid("معرّف طلب غير صالح.").parse(req.params.id);
    const scope = await db.query<Row & { from_branch_id: string; to_branch_id: string }>(
      "SELECT from_branch_id, to_branch_id FROM employee_transfers WHERE id = $1",
      [id],
    );
    const transfer = scope.rows[0];
    if (!transfer || (!canAccessBranch(req.auth.user, transfer.from_branch_id) && !canAccessBranch(req.auth.user, transfer.to_branch_id))) {
      throw notFound("الطلب غير موجود أو خارج نطاق صلاحيتك.");
    }
    const reason = String((req.body as { reason?: string })?.reason ?? "");
    const outcome = await decideTransfer(db, req.auth.user, id, "approved", reason);
    await writeAudit(db, logger, {
      action: outcome.action,
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "transfer",
      entityId: id,
      branchId: outcome.branchId,
      severity: "info",
      details: outcome.details,
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  });

  router.post("/:id/reject", requireApprove, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const id = z.uuid("معرّف طلب غير صالح.").parse(req.params.id);
    const input = parseBody(rejectSchema, req.body);
    const scope = await db.query<Row & { from_branch_id: string; to_branch_id: string }>(
      "SELECT from_branch_id, to_branch_id FROM employee_transfers WHERE id = $1",
      [id],
    );
    const transfer = scope.rows[0];
    if (!transfer || (!canAccessBranch(req.auth.user, transfer.from_branch_id) && !canAccessBranch(req.auth.user, transfer.to_branch_id))) {
      throw notFound("الطلب غير موجود أو خارج نطاق صلاحيتك.");
    }
    const outcome = await decideTransfer(db, req.auth.user, id, "rejected", input.reason);
    await writeAudit(db, logger, {
      action: outcome.action,
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "transfer",
      entityId: id,
      branchId: outcome.branchId,
      severity: "warning",
      details: outcome.details,
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  });

  router.post("/:id/cancel", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const id = z.uuid("معرّف طلب غير صالح.").parse(req.params.id);
    const result = await db.query<Row & { status: string; from_branch_id: string; employee_name: string }>(
      `SELECT t.status, t.from_branch_id, e.full_name AS employee_name FROM employee_transfers t JOIN employees e ON e.id = t.employee_id WHERE t.id = $1`,
      [id],
    );
    const transfer = result.rows[0];
    if (!transfer) throw notFound("الطلب غير موجود.");
    if (!canAccessBranch(req.auth.user, transfer.from_branch_id)) throw forbidden("الطلب خارج نطاق صلاحيتك.");
    if (transfer.status !== "pending") throw conflict("يمكن إلغاء الطلبات قيد المراجعة فقط.");
    await db.query("UPDATE employee_transfers SET status='cancelled', updated_at=now() WHERE id=$1", [id]);
    await cancelApproval(db, "transfer", id);
    await writeAudit(db, logger, {
      action: "transfer.cancelled",
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "transfer",
      entityId: id,
      branchId: transfer.from_branch_id,
      severity: "info",
      details: { employee: transfer.employee_name },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  });

  return router;
}
