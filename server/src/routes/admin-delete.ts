import { Router, type Request } from "express";
import { z } from "zod";
import type { DbClient, Row } from "../db/index.js";
import { writeAudit } from "../lib/audit.js";
import { conflict, forbidden, notFound, parseBody, requestIp, requestUserAgent, unauthorized } from "../lib/errors.js";
import { canAccessBranch } from "../services/access.js";
import {
  createRequireAuth,
  createRequirePermission,
  requirePasswordReady,
  type AuthDeps,
} from "../middleware/auth.js";
import type { AuthUser } from "../auth/types.js";

const paramsSchema = z.object({
  entity: z.enum([
    "leave",
    "advance",
    "transfer",
    "new_hire",
    "daily_submission",
    "monthly_sheet",
    "employee",
    "department",
    "branch",
    "payroll_record",
    "user",
  ]),
  id: z.uuid("معرّف السجل غير صالح."),
});

type Severity = "info" | "warning" | "critical";

interface AuditContext {
  ip: string;
  userAgent: string;
}

async function removeAttachments(tx: DbClient, ownerType: string, ownerId: string): Promise<void> {
  await tx.query("DELETE FROM attachments WHERE owner_type = $1 AND owner_id = $2", [ownerType, ownerId]);
}

async function removeApproval(tx: DbClient, entityType: string, entityId: string): Promise<void> {
  await tx.query("DELETE FROM approval_requests WHERE entity_type = $1 AND entity_id = $2", [entityType, entityId]);
}

function requireBranch(actor: AuthUser, branchId: string): void {
  if (!canAccessBranch(actor, branchId)) throw notFound("السجل غير موجود أو خارج نطاق صلاحيتك.");
}

async function logDeletion(
  deps: AuthDeps,
  req: Request,
  actor: AuthUser,
  context: AuditContext,
  action: string,
  entityType: string,
  entityId: string,
  branchId: string | null,
  severity: Severity,
  details: Record<string, unknown>,
): Promise<void> {
  await writeAudit(deps.db, deps.logger, {
    action,
    actor: { id: actor.id, username: actor.username },
    entityType,
    entityId,
    branchId,
    severity,
    details,
    ip: context.ip,
    userAgent: context.userAgent,
  });
}

export function createAdminDeleteRouter(deps: AuthDeps): Router {
  const { db } = deps;
  const router = Router();
  const requireDelete = createRequirePermission("records.delete", deps);

  router.use(createRequireAuth(deps), requirePasswordReady);

  router.delete("/records/:entity/:id", requireDelete, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const { entity, id } = parseBody(paramsSchema, req.params);
    const context: AuditContext = { ip: requestIp(req), userAgent: requestUserAgent(req) };

    if (entity === "leave") {
      const row = (
        await db.query<
          Row & {
            branch_id: string;
            status: string;
            leave_type: string;
            start_date: string;
            end_date: string;
            full_name: string;
            employee_no: string;
          }
        >(
          `SELECT l.branch_id, l.status, l.leave_type, l.start_date::text AS start_date, l.end_date::text AS end_date,
                  e.full_name, e.employee_no
           FROM leave_requests l JOIN employees e ON e.id = l.employee_id
           WHERE l.id = $1`,
          [id],
        )
      ).rows[0];
      if (!row) throw notFound("طلب الإجازة غير موجود.");
      requireBranch(actor, row.branch_id);
      await db.transaction(async (tx) => {
        await removeAttachments(tx, "leave", id);
        await removeApproval(tx, "leave", id);
        await tx.query("DELETE FROM leave_requests WHERE id = $1", [id]);
      });
      await logDeletion(deps, req, actor, context, "leave.deleted", "leave", id, row.branch_id, row.status === "approved" ? "critical" : "warning", {
        employeeNo: row.employee_no,
        employeeName: row.full_name,
        leaveType: row.leave_type,
        startDate: row.start_date,
        endDate: row.end_date,
        status: row.status,
      });
      res.json({ ok: true });
      return;
    }

    if (entity === "advance") {
      const row = (
        await db.query<
          Row & {
            branch_id: string;
            status: string;
            amount: string;
            request_date: string;
            full_name: string;
            employee_no: string;
            movements: number;
          }
        >(
          `SELECT a.branch_id, a.status, a.amount::text AS amount, a.request_date::text AS request_date,
                  e.full_name, e.employee_no,
                  (SELECT count(*)::int FROM advance_transactions t WHERE t.advance_id = a.id) AS movements
           FROM advance_requests a JOIN employees e ON e.id = a.employee_id
           WHERE a.id = $1`,
          [id],
        )
      ).rows[0];
      if (!row) throw notFound("طلب السلفة غير موجود.");
      requireBranch(actor, row.branch_id);
      if (row.movements > 0) {
        throw conflict("لا يمكن حذف سلفة لها حركات صرف أو استقطاع. احذف حركاتها أولًا أو استخدم الإلغاء.");
      }
      await db.transaction(async (tx) => {
        await removeAttachments(tx, "advance", id);
        await removeApproval(tx, "advance", id);
        await tx.query("DELETE FROM advance_requests WHERE id = $1", [id]);
      });
      await logDeletion(deps, req, actor, context, "advance.deleted", "advance", id, row.branch_id, "critical", {
        employeeNo: row.employee_no,
        employeeName: row.full_name,
        amount: row.amount,
        requestDate: row.request_date,
        status: row.status,
      });
      res.json({ ok: true });
      return;
    }

    if (entity === "transfer") {
      const row = (
        await db.query<
          Row & {
            from_branch_id: string;
            to_branch_id: string;
            status: string;
            effective_date: string;
            full_name: string;
            employee_no: string;
          }
        >(
          `SELECT t.from_branch_id, t.to_branch_id, t.status, t.effective_date::text AS effective_date,
                  e.full_name, e.employee_no
           FROM employee_transfers t JOIN employees e ON e.id = t.employee_id
           WHERE t.id = $1`,
          [id],
        )
      ).rows[0];
      if (!row) throw notFound("طلب التحويل غير موجود.");
      requireBranch(actor, row.from_branch_id);
      await db.transaction(async (tx) => {
        await removeAttachments(tx, "transfer", id);
        await removeApproval(tx, "transfer", id);
        await tx.query("DELETE FROM employee_transfers WHERE id = $1", [id]);
      });
      await logDeletion(deps, req, actor, context, "transfer.deleted", "transfer", id, row.from_branch_id, "warning", {
        employeeNo: row.employee_no,
        employeeName: row.full_name,
        effectiveDate: row.effective_date,
        status: row.status,
        toBranchId: row.to_branch_id,
      });
      res.json({ ok: true });
      return;
    }

    if (entity === "new_hire") {
      const row = (
        await db.query<Row & { branch_id: string; status: string; full_name: string; phone: string; start_date: string }>(
          `SELECT branch_id, status, full_name, phone, start_date::text AS start_date
           FROM new_employee_requests WHERE id = $1`,
          [id],
        )
      ).rows[0];
      if (!row) throw notFound("طلب الموظف الجديد غير موجود.");
      requireBranch(actor, row.branch_id);
      await db.transaction(async (tx) => {
        await removeAttachments(tx, "new_hire", id);
        await removeApproval(tx, "new_hire", id);
        await tx.query("DELETE FROM new_employee_requests WHERE id = $1", [id]);
      });
      await logDeletion(deps, req, actor, context, "new_hire.deleted", "new_hire", id, row.branch_id, "warning", {
        fullName: row.full_name,
        phone: row.phone,
        startDate: row.start_date,
        status: row.status,
      });
      res.json({ ok: true });
      return;
    }

    if (entity === "daily_submission") {
      const row = (
        await db.query<Row & { branch_id: string; work_date: string; status: string; rows_count: number }>(
          `SELECT s.branch_id, s.work_date::text AS work_date, s.status,
                  (SELECT count(*)::int FROM daily_attendance d WHERE d.submission_id = s.id) AS rows_count
           FROM attendance_submissions s WHERE s.id = $1`,
          [id],
        )
      ).rows[0];
      if (!row) throw notFound("كشف التحضير اليومي غير موجود.");
      requireBranch(actor, row.branch_id);
      await db.transaction(async (tx) => {
        await removeApproval(tx, "attendance_day", id);
        await tx.query("DELETE FROM attendance_submissions WHERE id = $1", [id]);
      });
      await logDeletion(
        deps,
        req,
        actor,
        context,
        "attendance_daily.deleted",
        "attendance_submission",
        id,
        row.branch_id,
        row.status === "approved" ? "critical" : "warning",
        { workDate: row.work_date, status: row.status, attendanceRows: row.rows_count },
      );
      res.json({ ok: true });
      return;
    }

    if (entity === "monthly_sheet") {
      const row = (
        await db.query<Row & { branch_id: string; year: number; month: number; status: string }>(
          `SELECT branch_id, year, month, status FROM monthly_attendance WHERE id = $1`,
          [id],
        )
      ).rows[0];
      if (!row) throw notFound("كشف التحضير الشهري غير موجود.");
      requireBranch(actor, row.branch_id);
      await db.transaction(async (tx) => {
        await removeApproval(tx, "attendance_month", id);
        await tx.query("DELETE FROM monthly_attendance WHERE id = $1", [id]);
      });
      await logDeletion(
        deps,
        req,
        actor,
        context,
        "attendance_monthly.deleted",
        "monthly_attendance",
        id,
        row.branch_id,
        row.status === "approved" ? "critical" : "warning",
        { year: row.year, month: row.month, status: row.status },
      );
      res.json({ ok: true });
      return;
    }

    if (entity === "employee") {
      const row = (
        await db.query<Row & { branch_id: string; employee_no: string; full_name: string; status: string; archived_at: string | null }>(
          `SELECT branch_id, employee_no, full_name, status, archived_at FROM employees WHERE id = $1`,
          [id],
        )
      ).rows[0];
      if (!row) throw notFound("الموظف غير موجود.");
      requireBranch(actor, row.branch_id);
      const dependencies = (
        await db.query<
          Row & {
            attendance: number;
            overrides: number;
            leaves: number;
            advances: number;
            transfers: number;
            new_hires: number;
            payroll: number;
          }
        >(
          `SELECT (SELECT count(*)::int FROM daily_attendance WHERE employee_id = $1) AS attendance,
                  (SELECT count(*)::int FROM monthly_attendance_overrides WHERE employee_id = $1) AS overrides,
                  (SELECT count(*)::int FROM leave_requests WHERE employee_id = $1) AS leaves,
                  (SELECT count(*)::int FROM advance_requests WHERE employee_id = $1) AS advances,
                  (SELECT count(*)::int FROM employee_transfers WHERE employee_id = $1) AS transfers,
                  (SELECT count(*)::int FROM new_employee_requests WHERE employee_id = $1) AS new_hires,
                  (SELECT count(*)::int FROM payroll_records WHERE employee_id = $1) AS payroll`,
          [id],
        )
      ).rows[0];
      const total = dependencies
        ? Object.values(dependencies).reduce<number>((sum, value) => sum + Number(value ?? 0), 0)
        : 0;
      if (total > 0) {
        throw conflict("لا يمكن حذف الموظف لوجود سجلات مرتبطة به. استخدم الأرشفة للحفاظ على السجلات.", dependencies);
      }
      await db.transaction(async (tx) => {
        await removeAttachments(tx, "employee", id);
        await tx.query("DELETE FROM employees WHERE id = $1", [id]);
      });
      await logDeletion(deps, req, actor, context, "employee.deleted", "employee", id, row.branch_id, "critical", {
        employeeNo: row.employee_no,
        fullName: row.full_name,
        status: row.status,
        archived: Boolean(row.archived_at),
      });
      res.json({ ok: true });
      return;
    }

    if (entity === "department") {
      const row = (await db.query<Row & { name: string }>("SELECT name FROM departments WHERE id = $1", [id])).rows[0];
      if (!row) throw notFound("القسم غير موجود.");
      const dependencies = (
        await db.query<Row & { employees: number; transfers: number; new_hires: number }>(
          `SELECT (SELECT count(*)::int FROM employees WHERE department_id = $1) AS employees,
                  (SELECT count(*)::int FROM employee_transfers WHERE from_department_id = $1 OR to_department_id = $1) AS transfers,
                  (SELECT count(*)::int FROM new_employee_requests WHERE department_id = $1) AS new_hires`,
          [id],
        )
      ).rows[0];
      const total = dependencies
        ? Object.values(dependencies).reduce<number>((sum, value) => sum + Number(value ?? 0), 0)
        : 0;
      if (total > 0) throw conflict("لا يمكن حذف القسم لوجود موظفين أو طلبات مرتبطة به.", dependencies);
      await db.query("DELETE FROM departments WHERE id = $1", [id]);
      await logDeletion(deps, req, actor, context, "department.deleted", "department", id, null, "warning", { name: row.name });
      res.json({ ok: true });
      return;
    }

    if (entity === "branch") {
      if (!actor.role.allPermissions) throw forbidden("حذف الفروع متاح لمدير النظام فقط.");
      const row = (await db.query<Row & { code: string; name: string }>("SELECT code, name FROM branches WHERE id = $1", [id])).rows[0];
      if (!row) throw notFound("الفرع غير موجود.");
      const dependencies = (
        await db.query<
          Row & {
            employees: number;
            users: number;
            submissions: number;
            monthly: number;
            leaves: number;
            advances: number;
            transfers: number;
            new_hires: number;
            payroll: number;
            audit: number;
          }
        >(
          `SELECT (SELECT count(*)::int FROM employees WHERE branch_id = $1) AS employees,
                  (SELECT count(*)::int FROM user_branch_access WHERE branch_id = $1) AS users,
                  (SELECT count(*)::int FROM attendance_submissions WHERE branch_id = $1) AS submissions,
                  (SELECT count(*)::int FROM monthly_attendance WHERE branch_id = $1) AS monthly,
                  (SELECT count(*)::int FROM leave_requests WHERE branch_id = $1) AS leaves,
                  (SELECT count(*)::int FROM advance_requests WHERE branch_id = $1) AS advances,
                  (SELECT count(*)::int FROM employee_transfers WHERE from_branch_id = $1 OR to_branch_id = $1) AS transfers,
                  (SELECT count(*)::int FROM new_employee_requests WHERE branch_id = $1) AS new_hires,
                  (SELECT count(*)::int FROM payroll_records WHERE branch_id = $1) AS payroll,
                  (SELECT count(*)::int FROM audit_logs WHERE branch_id = $1) AS audit`,
          [id],
        )
      ).rows[0];
      const total = dependencies
        ? Object.values(dependencies).reduce<number>((sum, value) => sum + Number(value ?? 0), 0)
        : 0;
      if (total > 0) throw conflict("لا يمكن حذف الفرع لوجود سجلات أو مستخدمين مرتبطين به. عطّله بدل الحذف.", dependencies);
      await db.query("DELETE FROM branches WHERE id = $1", [id]);
      await logDeletion(deps, req, actor, context, "branch.deleted", "branch", id, null, "critical", {
        code: row.code,
        name: row.name,
      });
      res.json({ ok: true });
      return;
    }

    if (entity === "payroll_record") {
      const row = (
        await db.query<Row & { branch_id: string; employee_id: string; year: number; month: number; review_status: string; full_name: string }>(
          `SELECT p.branch_id, p.employee_id, p.year, p.month, p.review_status, e.full_name
           FROM payroll_records p JOIN employees e ON e.id = p.employee_id
           WHERE p.id = $1`,
          [id],
        )
      ).rows[0];
      if (!row) throw notFound("سجل الراتب غير موجود.");
      requireBranch(actor, row.branch_id);
      await db.query("DELETE FROM payroll_records WHERE id = $1", [id]);
      await logDeletion(deps, req, actor, context, "payroll.deleted", "payroll_record", id, row.branch_id, "critical", {
        employeeId: row.employee_id,
        employeeName: row.full_name,
        year: row.year,
        month: row.month,
        reviewStatus: row.review_status,
      });
      res.json({ ok: true });
      return;
    }

    // entity === "user": soft delete keeps audit trails intact.
    if (!actor.role.allPermissions) throw forbidden("حذف حسابات المستخدمين متاح لمدير النظام فقط.");
    const row = (
      await db.query<Row & { username: string; full_name: string; active: boolean; role_key: string; deleted_at: string | null }>(
        `SELECT u.username, u.full_name, u.active, u.deleted_at, r.key AS role_key
         FROM users u JOIN roles r ON r.id = u.role_id
         WHERE u.id = $1`,
        [id],
      )
    ).rows[0];
    if (!row) throw notFound("المستخدم غير موجود.");
    if (id === actor.id) throw conflict("لا يمكن حذف حسابك الحالي.");
    if (row.deleted_at) throw conflict("الحساب محذوف مسبقًا.");
    if (row.role_key === "admin") {
      const admins = await db.query<Row & { count: number }>(
        `SELECT count(*)::int AS count FROM users u JOIN roles r ON r.id = u.role_id
         WHERE r.key = 'admin' AND u.active = true AND u.deleted_at IS NULL AND u.id <> $1`,
        [id],
      );
      if ((admins.rows[0]?.count ?? 0) === 0) throw conflict("لا يمكن حذف آخر حساب مدير نظام نشط.");
    }
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE users
         SET active = false, deleted_at = now(), username = $2, full_name = 'مستخدم محذوف', email = NULL,
             password_hash = '!deleted', must_change_password = true,
             session_version = session_version + 1, updated_at = now()
         WHERE id = $1`,
        [id, `deleted.${id.slice(0, 8)}`],
      );
      await tx.query("DELETE FROM sessions WHERE user_id = $1", [id]);
      await tx.query("DELETE FROM user_branch_access WHERE user_id = $1", [id]);
    });
    await logDeletion(deps, req, actor, context, "user.deleted", "user", id, null, "critical", {
      username: row.username,
      fullName: row.full_name,
      role: row.role_key,
    });
    res.json({ ok: true });
  });

  return router;
}
