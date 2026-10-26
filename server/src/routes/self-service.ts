import { Router } from "express";
import { z } from "zod";
import type { Db, Row } from "../db/index.js";
import { writeAudit } from "../lib/audit.js";
import { ApiError, conflict, parseBody, requestIp, requestUserAgent, unauthorized } from "../lib/errors.js";
import { daysBetween, isoDateSchema } from "../lib/hr-schemas.js";
import { newId } from "../lib/ids.js";
import { cancelApproval, notifyPermissionHolders, openApproval } from "../services/approvals.js";
import { listEmployeeBalances, resolveLeaveType } from "../services/leave-balances.js";
import { createRequireAuth, requirePasswordReady, type AuthDeps } from "../middleware/auth.js";

const leaveRequestSchema = z
  .object({
    leaveTypeId: z.uuid("يجب اختيار نوع إجازة معتمد."),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    reason: z.string().trim().min(3, "سبب الطلب مطلوب.").max(1000),
    notes: z.string().trim().max(1000).default(""),
  })
  .refine((data) => Date.parse(`${data.endDate}T00:00:00Z`) >= Date.parse(`${data.startDate}T00:00:00Z`), {
    message: "تاريخ النهاية يجب ألا يسبق تاريخ البداية.",
    path: ["endDate"],
  });

const leaveIdSchema = z.uuid("معرّف طلب غير صالح.");

interface EmployeeRow extends Row {
  id: string;
  employee_no: string;
  full_name: string;
  phone: string;
  national_id: string | null;
  branch_id: string;
  branch_name: string;
  department_name: string | null;
  job_title: string | null;
  manager_name: string | null;
  hire_date: string;
  base_salary: string | number;
  status: string;
  archived_at: string | Date | null;
}

function numberValue(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoOrNull(value: string | Date | null): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

async function loadLinkedEmployee(db: Db, employeeId: string | null): Promise<EmployeeRow> {
  if (!employeeId) {
    throw new ApiError(403, "NO_EMPLOYEE_LINK", "حسابك غير مرتبط بملف موظف. اطلب من شؤون الموظفين ربط الحساب.");
  }
  const result = await db.query<EmployeeRow>(
    `SELECT e.id, e.employee_no, e.full_name, e.phone, e.national_id, e.branch_id, b.name AS branch_name,
            d.name AS department_name, COALESCE(jt.name, NULLIF(e.job_title, '')) AS job_title,
            m.full_name AS manager_name, e.hire_date::text AS hire_date, e.base_salary, e.status, e.archived_at
     FROM employees e
     JOIN branches b ON b.id = e.branch_id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN job_titles jt ON jt.id = e.job_title_id
     LEFT JOIN employees m ON m.id = e.manager_id
     WHERE e.id = $1`,
    [employeeId],
  );
  const employee = result.rows[0];
  if (!employee) throw new ApiError(403, "NO_EMPLOYEE_LINK", "ملف الموظف المرتبط بحسابك غير موجود.");
  return employee;
}

async function loadOwnLeave(db: Db, actorEmployeeId: string | null, leaveId: string) {
  const result = await db.query<
    Row & {
      id: string;
      employee_id: string;
      branch_id: string;
      status: string;
      leave_type: string;
      type_name: string | null;
      requires_document: boolean | null;
      start_date: string;
      end_date: string;
      days: number;
    }
  >(
    `SELECT l.id, l.employee_id, l.branch_id, l.status, l.leave_type, t.name AS type_name, t.requires_document,
            l.start_date::text AS start_date, l.end_date::text AS end_date, l.days
     FROM leave_requests l
     LEFT JOIN leave_types t ON t.id = l.leave_type_id
     WHERE l.id = $1`,
    [leaveId],
  );
  const leave = result.rows[0];
  if (!leave || !actorEmployeeId || leave.employee_id !== actorEmployeeId) {
    throw new ApiError(404, "LEAVE_NOT_FOUND", "الطلب غير موجود ضمن طلباتك.");
  }
  return leave;
}

export function createSelfServiceRouter(deps: AuthDeps): Router {
  const { db, logger } = deps;
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);

  router.get("/overview", async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const employee = await loadLinkedEmployee(db, actor.employeeId);
    const archived = Boolean(employee.archived_at);
    const year = new Date().getFullYear();
    const [balances, leaves, attendance, advances, payroll, documents, contract] = await Promise.all([
      listEmployeeBalances(db, employee.id, year, actor.id),
      db.query<Row & Record<string, unknown>>(
        `SELECT l.id, l.leave_type, t.name AS type_name, l.start_date::text AS start_date, l.end_date::text AS end_date,
                l.days, l.reason, l.status, l.decided_at, l.decision_note, du.full_name AS decided_by_name
         FROM leave_requests l
         LEFT JOIN leave_types t ON t.id = l.leave_type_id
         LEFT JOIN users du ON du.id = l.decided_by
         WHERE l.employee_id = $1
         ORDER BY l.created_at DESC
         LIMIT 12`,
        [employee.id],
      ),
      db.query<Row & Record<string, unknown>>(
        `SELECT s.work_date::text AS work_date, s.status AS submission_status,
                da.status, da.check_in::text AS check_in, da.check_out::text AS check_out,
                da.late_minutes, da.work_hours
         FROM daily_attendance da
         JOIN attendance_submissions s ON s.id = da.submission_id
         WHERE da.employee_id = $1
         ORDER BY s.work_date DESC
         LIMIT 31`,
        [employee.id],
      ),
      db.query<Row & Record<string, unknown>>(
        `SELECT a.id, a.amount, a.reason, a.request_date::text AS request_date, a.installments, a.status,
                COALESCE((
                  SELECT sum(CASE WHEN t.type = 'disbursement' THEN t.amount ELSE -t.amount END)
                  FROM advance_transactions t WHERE t.advance_id = a.id
                ), 0) AS outstanding
         FROM advance_requests a
         WHERE a.employee_id = $1
         ORDER BY a.request_date DESC
         LIMIT 8`,
        [employee.id],
      ),
      db.query<Row & Record<string, unknown>>(
        `SELECT id, year, month, base_salary, allowances, deductions, advance_deduction, review_status,
                (base_salary + allowances - deductions - advance_deduction) AS net
         FROM payroll_records
         WHERE employee_id = $1
         ORDER BY year DESC, month DESC
         LIMIT 12`,
        [employee.id],
      ),
      db.query<Row & Record<string, unknown>>(
        `SELECT id, file_name, title, document_type, expires_at::text AS expires_at, created_at
         FROM attachments
         WHERE owner_type = 'employee' AND owner_id = $1
         ORDER BY created_at DESC
         LIMIT 20`,
        [employee.id],
      ),
      db.query<Row & Record<string, unknown>>(
        `SELECT contract_no, contract_type, start_date::text AS start_date, end_date::text AS end_date, base_salary
         FROM employee_contracts
         WHERE employee_id = $1 AND status = 'active'
         ORDER BY start_date DESC LIMIT 1`,
        [employee.id],
      ),
    ]);

    res.json({
      serverTime: new Date().toISOString(),
      employee: {
        id: employee.id,
        employeeNo: employee.employee_no,
        fullName: employee.full_name,
        phone: employee.phone,
        nationalId: employee.national_id,
        branchId: employee.branch_id,
        branchName: employee.branch_name,
        departmentName: employee.department_name,
        jobTitle: employee.job_title,
        managerName: employee.manager_name,
        hireDate: employee.hire_date,
        baseSalary: numberValue(employee.base_salary),
        status: employee.status,
        archived,
      },
      contract: contract.rows[0]
        ? {
            contractNo: contract.rows[0].contract_no,
            contractType: contract.rows[0].contract_type,
            startDate: contract.rows[0].start_date,
            endDate: contract.rows[0].end_date,
            baseSalary: numberValue(contract.rows[0].base_salary as string | number),
          }
        : null,
      balances: balances.balances,
      balanceMovements: balances.movements,
      leaves: leaves.rows.map((row) => ({
        id: row.id as string,
        leaveType: row.leave_type as string,
        leaveTypeName: (row.type_name as string | null) ?? (row.leave_type as string),
        startDate: row.start_date as string,
        endDate: row.end_date as string,
        days: numberValue(row.days as number),
        reason: row.reason as string,
        status: row.status as string,
        decidedBy: (row.decided_by_name as string | null) ?? null,
        decidedAt: isoOrNull(row.decided_at as string | Date | null),
        decisionNote: (row.decision_note as string | null) ?? null,
      })),
      attendance: attendance.rows.map((row) => ({
        workDate: row.work_date as string,
        submissionStatus: row.submission_status as string,
        status: row.status as string,
        checkIn: (row.check_in as string | null) ?? null,
        checkOut: (row.check_out as string | null) ?? null,
        lateMinutes: numberValue(row.late_minutes as number),
        workHours: numberValue(row.work_hours as string | number),
      })),
      advances: advances.rows.map((row) => ({
        id: row.id as string,
        amount: numberValue(row.amount as string | number),
        outstanding: numberValue(row.outstanding as string | number),
        reason: row.reason as string,
        requestDate: row.request_date as string,
        installments: numberValue(row.installments as number),
        status: row.status as string,
      })),
      payroll: payroll.rows.map((row) => ({
        id: row.id as string,
        year: numberValue(row.year as number),
        month: numberValue(row.month as number),
        baseSalary: numberValue(row.base_salary as string | number),
        allowances: numberValue(row.allowances as string | number),
        deductions: numberValue(row.deductions as string | number),
        advanceDeduction: numberValue(row.advance_deduction as string | number),
        net: numberValue(row.net as string | number),
        reviewStatus: row.review_status as string,
      })),
      documents: documents.rows.map((row) => ({
        id: row.id as string,
        fileName: row.file_name as string,
        title: row.title as string,
        documentType: row.document_type as string,
        expiresAt: (row.expires_at as string | null) ?? null,
        createdAt: isoOrNull(row.created_at as string | Date),
      })),
      leaveTypes: (
        await db.query<Row & Record<string, unknown>>(
          `SELECT id, name, annual_entitlement, track_balance, requires_document
           FROM leave_types WHERE active = true ORDER BY sort_order, name`,
        )
      ).rows.map((row) => ({
        id: row.id as string,
        name: row.name as string,
        annualEntitlement: numberValue(row.annual_entitlement as string | number),
        trackBalance: Boolean(row.track_balance),
        requiresDocument: Boolean(row.requires_document),
      })),
      capabilities: {
        canRequestLeave: !archived && employee.status === "active",
      },
    });
  });

  router.post("/leaves", async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const employee = await loadLinkedEmployee(db, actor.employeeId);
    if (employee.archived_at || employee.status !== "active") {
      throw new ApiError(400, "EMPLOYEE_INACTIVE", "لا يمكن تقديم طلب لموظف غير نشط.");
    }
    const input = parseBody(leaveRequestSchema, req.body);
    const days = daysBetween(input.startDate, input.endDate);
    if (days < 1 || days > 366) throw new ApiError(400, "INVALID_RANGE", "مدة الطلب يجب أن تكون بين يوم و366 يوماً.");
    const overlap = await db.query<Row & { id: string }>(
      `SELECT id FROM leave_requests
       WHERE employee_id = $1 AND status IN ('draft', 'pending', 'approved')
         AND start_date <= $3::date AND end_date >= $2::date LIMIT 1`,
      [employee.id, input.startDate, input.endDate],
    );
    if (overlap.rows[0]) throw conflict("يوجد طلب إجازة أو إذن متداخل لنفس الموظف.");
    const type = await resolveLeaveType(db, input.leaveTypeId, undefined);
    if (!type.active) throw new ApiError(400, "LEAVE_TYPE_INACTIVE", "نوع الإجازة معطّل ولا يمكن اختياره.");
    const id = newId();
    await db.query(
      `INSERT INTO leave_requests
        (id, employee_id, branch_id, leave_type, leave_type_id, start_date, end_date, days, reason, notes, status, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10,'draft',$11)`,
      [id, employee.id, employee.branch_id, type.code, type.id, input.startDate, input.endDate, days, input.reason, input.notes, actor.id],
    );
    await writeAudit(db, logger, {
      action: "leave.created",
      actor: { id: actor.id, username: actor.username },
      entityType: "leave",
      entityId: id,
      branchId: employee.branch_id,
      severity: "info",
      details: { employee: employee.full_name, type: type.name, startDate: input.startDate, endDate: input.endDate, days, selfService: true },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.status(201).json({ id, requiresDocument: type.requires_document, days });
  });

  router.post("/leaves/:id/submit", async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const id = z.uuid("معرّف طلب غير صالح.").parse(req.params.id);
    const leave = await loadOwnLeave(db, actor.employeeId, id);
    if (leave.status !== "draft" && leave.status !== "rejected") throw conflict("لا يمكن إرسال طلب في هذه الحالة.");
    if (leave.requires_document) {
      const attachments = await db.query<Row & { total: number }>(
        "SELECT count(*)::int AS total FROM attachments WHERE owner_type = 'leave' AND owner_id = $1",
        [id],
      );
      if ((attachments.rows[0]?.total ?? 0) < 1) {
        throw new ApiError(400, "DOCUMENT_REQUIRED", "هذا النوع يتطلب إرفاق مستند قبل الإرسال للاعتماد.");
      }
    }
    await db.query("UPDATE leave_requests SET status='pending', updated_at=now() WHERE id=$1", [id]);
    await openApproval(db, {
      entityType: "leave",
      entityId: id,
      branchId: leave.branch_id,
      title: `${leave.type_name ?? leave.leave_type} — ${actor.fullName}`,
      summary: `${leave.start_date} إلى ${leave.end_date} (${leave.days} يوم)`,
      requestedBy: actor.id,
    });
    await notifyPermissionHolders(
      db,
      "leaves.approve",
      leave.branch_id,
      "طلب إجازة بانتظار الاعتماد",
      `${actor.fullName} أرسل طلب ${leave.type_name ?? leave.leave_type} من بوابة الخدمة الذاتية.`,
      "#/approvals",
    );
    await writeAudit(db, logger, {
      action: "leave.submitted",
      actor: { id: actor.id, username: actor.username },
      entityType: "leave",
      entityId: id,
      branchId: leave.branch_id,
      severity: "info",
      details: { employee: actor.fullName, days: leave.days, selfService: true },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  });

  router.post("/leaves/:id/cancel", async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const id = leaveIdSchema.parse(req.params.id);
    const leave = await loadOwnLeave(db, actor.employeeId, id);
    if (leave.status === "approved" || leave.status === "cancelled") throw conflict("لا يمكن إلغاء طلب في هذه الحالة.");
    await db.query("UPDATE leave_requests SET status='cancelled', updated_at=now() WHERE id=$1", [id]);
    await cancelApproval(db, "leave", id);
    await writeAudit(db, logger, {
      action: "leave.cancelled",
      actor: { id: actor.id, username: actor.username },
      entityType: "leave",
      entityId: id,
      branchId: leave.branch_id,
      severity: "info",
      details: { employee: actor.fullName, selfService: true },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  });

  return router;
}
