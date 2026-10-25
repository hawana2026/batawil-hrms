import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db, Row } from "../db/index.js";
import { hasPermission, type AuthUser } from "../auth/types.js";
import { writeAudit } from "../lib/audit.js";
import { addDataSheet, createWorkbook, sendWorkbook, type CellValue } from "../lib/xlsx.js";
import { ApiError, conflict, forbidden, notFound, parseBody, requestIp, requestUserAgent, unauthorized } from "../lib/errors.js";
import { isoDateSchema, monthlySaveSchema, monthlySubmitSchema, rejectSchema, saveDailySchema, submitReasonSchema } from "../lib/hr-schemas.js";
import { newId } from "../lib/ids.js";
import { branchScopeSql, canAccessBranch } from "../services/access.js";
import {
  closeApproval,
  notifyPermissionHolders,
  notifyUser,
  openApproval,
} from "../services/approvals.js";
import { assertBranchUsable, toDateOnly, today, type EmployeeRow } from "../services/employees.js";
import { getSettings, isWeekend, minutesFromTime, monthRange } from "../services/settings.js";
import { createRequireAuth, createRequirePermission, requirePasswordReady, type AuthDeps } from "../middleware/auth.js";

const dailyQuerySchema = z.object({
  branchId: z.uuid("يجب اختيار فرع صالح."),
  date: isoDateSchema,
});

const monthlyQuerySchema = z.object({
  branchId: z.uuid("يجب اختيار فرع صالح."),
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  departmentId: z.string().trim().max(64).default(""),
});

const followUpQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()),
  month: z.coerce.number().int().min(1).max(12).default(new Date().getMonth() + 1),
  late: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
});

const ATTENDANCE_LABELS: Record<string, string> = {
  present: "حاضر",
  absent: "غائب",
  leave: "إجازة",
  permission: "إذن",
  mission: "مهمة",
  weekly_rest: "راحة أسبوعية",
  late: "تأخير",
  excused_absence: "غياب بعذر",
  draft: "مسودة",
  submitted: "مرسل للاعتماد",
  approved: "معتمد",
  rejected: "معاد",
};

const MONTHLY_SYMBOLS: Record<string, string> = {
  present: "ح",
  absent: "غ",
  leave: "إ",
  permission: "ذ",
  mission: "م",
  weekly_rest: "ر",
  late: "ت",
  excused_absence: "ع",
};

const correctDailyRowSchema = z.object({
  status: z.enum(["present", "absent", "leave", "permission", "mission", "weekly_rest", "late", "excused_absence"]).optional(),
  checkIn: z.union([z.literal(""), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)]).optional(),
  checkOut: z.union([z.literal(""), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)]).optional(),
  lateMinutes: z.coerce.number().int().min(0).max(1440).optional(),
  workHours: z.coerce.number().min(0).max(24).optional(),
  reason: z.string().trim().max(300).optional(),
  notes: z.string().trim().max(500).optional(),
  correctionReason: z.string().trim().min(3, "سبب التصحيح مطلوب.").max(500),
});

interface SubmissionRow extends Row {
  id: string;
  branch_id: string;
  branch_name: string;
  work_date: string | Date;
  status: string;
  notes: string;
  prepared_by: string | null;
  prepared_name: string | null;
  submitted_by: string | null;
  submitted_name: string | null;
  submitted_at: string | Date | null;
  approved_by: string | null;
  approved_name: string | null;
  approved_at: string | Date | null;
  rejection_reason: string | null;
  last_corrected_by: string | null;
  last_corrected_name: string | null;
  last_corrected_at: string | Date | null;
  correction_count: number;
  created_at: string | Date;
  updated_at: string | Date;
}

interface SavedRow extends Row {
  id: string;
  employee_id: string | null;
  manual_name: string | null;
  status: string;
  check_in: string | null;
  check_out: string | null;
  late_minutes: number;
  work_hours: string | number;
  reason: string;
  notes: string;
  employee_no: string | null;
  employee_name: string | null;
  department_id: string | null;
  department_name: string | null;
}

interface BranchEmployeeRow extends Row {
  id: string;
  employee_no: string;
  full_name: string;
  department_id: string | null;
  department_name: string | null;
}

interface MonthlyRow extends Row {
  id: string;
  status: string;
  notes: string;
  missing_days_confirmed: boolean;
  prepared_by: string | null;
  prepared_name: string | null;
  submitted_by: string | null;
  submitted_name: string | null;
  submitted_at: string | Date | null;
  approved_by: string | null;
  approved_name: string | null;
  approved_at: string | Date | null;
  rejection_reason: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function iso(value: string | Date | null): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

function timeText(value: string | null): string {
  return value ? value.slice(0, 5) : "";
}

function computeWorkHours(checkIn: string | null, checkOut: string | null, provided: number): number {
  if (provided > 0) return Math.round(provided * 100) / 100;
  if (!checkIn || !checkOut) return 0;
  let minutes = minutesFromTime(checkOut) - minutesFromTime(checkIn);
  if (minutes < 0) minutes += 24 * 60;
  return Math.round((minutes / 60) * 100) / 100;
}

async function computeMonthlyMissingDays(
  db: Db,
  branchId: string,
  year: number,
  month: number,
  monthlyId: string | null,
): Promise<number> {
  const range = monthRange(year, month);
  const target = `${year}-${String(month).padStart(2, "0")}`;
  const current = today().slice(0, 7);
  const lastDay = target > current ? 0 : target === current ? Number(today().slice(8, 10)) : range.days;
  if (lastDay === 0) return 0;
  const settings = await getSettings(db);
  const [employees, daily, leaves, overrides] = await Promise.all([
    db.query<Row & { id: string; hire_date: string; end_date: string | null }>(
      `SELECT e.id, e.hire_date::text AS hire_date,
              COALESCE(e.termination_date, e.archived_at::date)::text AS end_date
       FROM employees e
       WHERE e.branch_id = $1 AND e.hire_date <= $3::date
         AND COALESCE(e.termination_date, e.archived_at::date, '9999-12-31'::date) >= $2::date`,
      [branchId, range.start, range.end],
    ),
    db.query<Row & { employee_id: string; day: number }>(
      `SELECT dd.employee_id, EXTRACT(DAY FROM s.work_date)::int AS day
       FROM attendance_submissions s JOIN daily_attendance dd ON dd.submission_id = s.id
       WHERE s.branch_id = $1 AND s.work_date BETWEEN $2::date AND $3::date
         AND s.status IN ('submitted','approved') AND dd.employee_id IS NOT NULL`,
      [branchId, range.start, range.end],
    ),
    db.query<Row & { employee_id: string; start_date: string; end_date: string }>(
      `SELECT employee_id, start_date::text AS start_date, end_date::text AS end_date
       FROM leave_requests
       WHERE branch_id = $1 AND status = 'approved' AND start_date <= $3::date AND end_date >= $2::date`,
      [branchId, range.start, range.end],
    ),
    monthlyId
      ? db.query<Row & { employee_id: string; day: number }>(
          "SELECT employee_id, day FROM monthly_attendance_overrides WHERE monthly_id = $1",
          [monthlyId],
        )
      : Promise.resolve({ rows: [] as Array<Row & { employee_id: string; day: number }> }),
  ]);
  const covered = new Set<string>();
  for (const row of daily.rows) covered.add(`${row.employee_id}:${row.day}`);
  for (const row of overrides.rows) covered.add(`${row.employee_id}:${row.day}`);
  for (const leave of leaves.rows) {
    const start = leave.start_date <= range.start ? 1 : Number(leave.start_date.slice(8, 10));
    const end = leave.end_date >= range.end ? range.days : Number(leave.end_date.slice(8, 10));
    for (let day = start; day <= end; day += 1) covered.add(`${leave.employee_id}:${day}`);
  }
  let missing = 0;
  for (const employee of employees.rows) {
    for (let day = 1; day <= lastDay; day += 1) {
      const date = `${target}-${String(day).padStart(2, "0")}`;
      if (isWeekend(date, settings.attendance.weekendDays)) continue;
      if (date < employee.hire_date) continue;
      if (employee.end_date && date > employee.end_date) continue;
      if (!covered.has(`${employee.id}:${day}`)) missing += 1;
    }
  }
  return missing;
}

async function loadSubmission(db: Db, branchId: string, workDate: string): Promise<SubmissionRow | null> {
  const result = await db.query<SubmissionRow>(
    `SELECT s.id, s.branch_id, b.name AS branch_name, s.work_date, s.status, s.notes,
            s.prepared_by, pu.full_name AS prepared_name,
            s.submitted_by, su.full_name AS submitted_name, s.submitted_at,
            s.approved_by, au.full_name AS approved_name, s.approved_at,
            s.rejection_reason,
            s.last_corrected_by, cu.full_name AS last_corrected_name, s.last_corrected_at, s.correction_count,
            s.created_at, s.updated_at
     FROM attendance_submissions s
     JOIN branches b ON b.id = s.branch_id
     LEFT JOIN users pu ON pu.id = s.prepared_by
     LEFT JOIN users su ON su.id = s.submitted_by
     LEFT JOIN users au ON au.id = s.approved_by
     LEFT JOIN users cu ON cu.id = s.last_corrected_by
     WHERE s.branch_id = $1 AND s.work_date = $2::date`,
    [branchId, workDate],
  );
  return result.rows[0] ?? null;
}

async function loadSubmissionById(db: Db, id: string): Promise<SubmissionRow> {
  const result = await db.query<SubmissionRow>(
    `SELECT s.id, s.branch_id, b.name AS branch_name, s.work_date, s.status, s.notes,
            s.prepared_by, pu.full_name AS prepared_name,
            s.submitted_by, su.full_name AS submitted_name, s.submitted_at,
            s.approved_by, au.full_name AS approved_name, s.approved_at,
            s.rejection_reason,
            s.last_corrected_by, cu.full_name AS last_corrected_name, s.last_corrected_at, s.correction_count,
            s.created_at, s.updated_at
     FROM attendance_submissions s
     JOIN branches b ON b.id = s.branch_id
     LEFT JOIN users pu ON pu.id = s.prepared_by
     LEFT JOIN users su ON su.id = s.submitted_by
     LEFT JOIN users au ON au.id = s.approved_by
     LEFT JOIN users cu ON cu.id = s.last_corrected_by
     WHERE s.id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw notFound("كشف التحضير غير موجود.");
  return row;
}

function submissionCapabilities(actor: AuthUser, submission: SubmissionRow | null) {
  const status = submission?.status ?? "draft";
  return {
    canManage: hasPermission(actor, "attendance.manage") && (status === "draft" || status === "rejected"),
    canSubmit: hasPermission(actor, "attendance.submit") && (status === "draft" || status === "rejected"),
    canApprove: hasPermission(actor, "attendance.approve") && status === "submitted",
    canCorrect: hasPermission(actor, "attendance.correct") && status === "approved",
  };
}

function submissionJson(submission: SubmissionRow | null, branchId: string, branchName: string, workDate: string) {
  if (!submission) {
    return {
      id: null,
      branchId,
      branchName,
      workDate,
      status: "draft",
      notes: "",
      preparedBy: null,
      submittedBy: null,
      submittedAt: null,
      approvedBy: null,
      approvedAt: null,
      rejectionReason: null,
      lastCorrectedBy: null,
      lastCorrectedAt: null,
      correctionCount: 0,
      createdAt: null,
      updatedAt: null,
    };
  }
  return {
    id: submission.id,
    branchId: submission.branch_id,
    branchName: submission.branch_name,
    workDate: toDateOnly(submission.work_date),
    status: submission.status,
    notes: submission.notes,
    preparedBy: submission.prepared_name,
    submittedBy: submission.submitted_name,
    submittedAt: iso(submission.submitted_at),
    approvedBy: submission.approved_name,
    approvedAt: iso(submission.approved_at),
    rejectionReason: submission.rejection_reason,
    lastCorrectedBy: submission.last_corrected_name,
    lastCorrectedAt: iso(submission.last_corrected_at),
    correctionCount: submission.correction_count,
    createdAt: iso(submission.created_at),
    updatedAt: iso(submission.updated_at),
  };
}

export function createAttendanceRouter(deps: AuthDeps): Router {
  const { db, logger } = deps;
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);

  const requireView = createRequirePermission("attendance.view", deps);
  const requireManage = createRequirePermission("attendance.manage", deps);
  const requireSubmit = createRequirePermission("attendance.submit", deps);
  const requireApprove = createRequirePermission("attendance.approve", deps);
  const requireCorrect = createRequirePermission("attendance.correct", deps);

  router.get("/daily", requireView, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const query = parseBody(dailyQuerySchema, req.query);
    if (!canAccessBranch(actor, query.branchId)) throw forbidden("الفرع خارج نطاق صلاحيتك.");
    const branchResult = await db.query<Row & { name: string; code: string; active: boolean }>(
      "SELECT name, code, active FROM branches WHERE id = $1",
      [query.branchId],
    );
    const branch = branchResult.rows[0];
    if (!branch) throw notFound("الفرع غير موجود.");
    const settings = await getSettings(db);
    const submission = await loadSubmission(db, query.branchId, query.date);

    const [employeesResult, rowsResult, leavesResult] = await Promise.all([
      db.query<BranchEmployeeRow>(
        `SELECT e.id, e.employee_no, e.full_name, e.department_id, d.name AS department_name
         FROM employees e LEFT JOIN departments d ON d.id = e.department_id
         WHERE e.branch_id = $1 AND e.archived_at IS NULL AND e.status IN ('active', 'leave')
         ORDER BY e.full_name`,
        [query.branchId],
      ),
      submission
        ? db.query<SavedRow>(
            `SELECT d.id, d.employee_id, d.manual_name, d.status, d.check_in::text AS check_in, d.check_out::text AS check_out,
                    d.late_minutes, d.work_hours, d.reason, d.notes,
                    e.employee_no, e.full_name AS employee_name, e.department_id, dep.name AS department_name
             FROM daily_attendance d
             LEFT JOIN employees e ON e.id = d.employee_id
             LEFT JOIN departments dep ON dep.id = e.department_id
             WHERE d.submission_id = $1
             ORDER BY e.full_name NULLS LAST, d.manual_name`,
            [submission.id],
          )
        : Promise.resolve({ rows: [] as SavedRow[] }),
      db.query<Row & { employee_id: string; leave_type: string }>(
        `SELECT employee_id, leave_type FROM leave_requests
         WHERE branch_id = $1 AND status = 'approved' AND start_date <= $2::date AND end_date >= $2::date`,
        [query.branchId, query.date],
      ),
    ]);

    const savedByEmployee = new Map<string, SavedRow>();
    const manualRows: SavedRow[] = [];
    for (const row of rowsResult.rows) {
      if (row.employee_id) savedByEmployee.set(row.employee_id, row);
      else manualRows.push(row);
    }
    const leaveByEmployee = new Map(leavesResult.rows.map((row) => [row.employee_id, row.leave_type]));

    const toRow = (saved: SavedRow | undefined, employee?: BranchEmployeeRow) => {
      const leaveType = employee?.id ? leaveByEmployee.get(employee.id) : undefined;
      const leaveStatus = leaveType === "permission" ? "permission" : leaveType ? "leave" : null;
      return {
        id: saved?.id ?? null,
        employeeId: saved?.employee_id ?? employee?.id ?? null,
        manualName: saved?.manual_name ?? null,
        employeeNo: saved?.employee_no ?? employee?.employee_no ?? "",
        fullName: saved?.employee_name ?? employee?.full_name ?? saved?.manual_name ?? "",
        departmentId: saved?.department_id ?? employee?.department_id ?? null,
        departmentName: saved?.department_name ?? employee?.department_name ?? null,
        status: saved?.status ?? leaveStatus ?? "present",
        checkIn: timeText(saved?.check_in ?? null),
        checkOut: timeText(saved?.check_out ?? null),
        lateMinutes: saved?.late_minutes ?? 0,
        workHours: saved ? Number(saved.work_hours) : 0,
        reason: saved?.reason ?? (leaveStatus ? (leaveStatus === "permission" ? "إذن معتمد" : "إجازة معتمدة") : ""),
        notes: saved?.notes ?? "",
        recorded: Boolean(saved) || Boolean(leaveStatus),
        temporary: false,
      };
    };

    const rows = employeesResult.rows.map((employee) => toRow(savedByEmployee.get(employee.id), employee));
    const savedEmployeeIds = new Set(employeesResult.rows.map((employee) => employee.id));
    for (const [employeeId, saved] of savedByEmployee) {
      if (!savedEmployeeIds.has(employeeId)) rows.push(toRow(saved));
    }
    for (const manual of manualRows) {
      rows.push({ ...toRow(manual), temporary: true });
    }

    const counts = {
      total: rows.filter((row) => !row.temporary).length,
      recorded: rows.filter((row) => !row.temporary && row.recorded).length,
      unrecorded: rows.filter((row) => !row.temporary && !row.recorded).length,
      present: rows.filter((row) => row.status === "present").length,
      absent: rows.filter((row) => row.status === "absent").length,
      leave: rows.filter((row) => row.status === "leave").length,
      permission: rows.filter((row) => row.status === "permission").length,
      mission: rows.filter((row) => row.status === "mission").length,
      weeklyRest: rows.filter((row) => row.status === "weekly_rest").length,
      late: rows.filter((row) => row.status === "late").length,
      excusedAbsence: rows.filter((row) => row.status === "excused_absence").length,
      manual: manualRows.length,
    };

    res.json({
      branch: { id: query.branchId, name: branch.name, code: branch.code, active: branch.active },
      date: query.date,
      today: today(),
      settings: settings.attendance,
      submission: submissionJson(submission, query.branchId, branch.name, query.date),
      rows,
      counts,
      capabilities: submissionCapabilities(actor, submission),
      departments: await db.query<Row & { id: string; name: string }>("SELECT id, name FROM departments WHERE active = true ORDER BY name").then((result) => result.rows.map((row) => ({ id: row.id, name: row.name }))),
    });
  });

  router.get("/daily/export.xlsx", requireView, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const query = parseBody(dailyQuerySchema, req.query);
    if (!canAccessBranch(actor, query.branchId)) throw forbidden("الفرع خارج نطاق صلاحيتك.");
    const branchResult = await db.query<Row & { name: string; code: string }>("SELECT name, code FROM branches WHERE id = $1", [query.branchId]);
    const branch = branchResult.rows[0];
    if (!branch) throw notFound("الفرع غير موجود.");
    const submission = await loadSubmission(db, query.branchId, query.date);
    const employees = await db.query<BranchEmployeeRow>(
      `SELECT e.id, e.employee_no, e.full_name, e.department_id, d.name AS department_name
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.branch_id = $1 AND e.archived_at IS NULL AND e.status IN ('active', 'leave')
       ORDER BY e.full_name`,
      [query.branchId],
    );
    const saved = submission
      ? await db.query<SavedRow>(
          `SELECT d.id, d.employee_id, d.manual_name, d.status, d.check_in::text AS check_in, d.check_out::text AS check_out,
                  d.late_minutes, d.work_hours, d.reason, d.notes,
                  e.employee_no, e.full_name AS employee_name, e.department_id, dep.name AS department_name
           FROM daily_attendance d
           LEFT JOIN employees e ON e.id = d.employee_id
           LEFT JOIN departments dep ON dep.id = e.department_id
           WHERE d.submission_id = $1
           ORDER BY e.full_name NULLS LAST, d.manual_name`,
          [submission.id],
        )
      : { rows: [] as SavedRow[] };
    const leaves = await db.query<Row & { employee_id: string; leave_type: string }>(
      `SELECT employee_id, leave_type FROM leave_requests
       WHERE branch_id = $1 AND status = 'approved' AND start_date <= $2::date AND end_date >= $2::date`,
      [query.branchId, query.date],
    );
    const leaveByEmployee = new Map(leaves.rows.map((row) => [row.employee_id, row.leave_type]));
    const savedByEmployee = new Map(saved.rows.filter((row) => row.employee_id).map((row) => [row.employee_id as string, row]));
    const rows: CellValue[][] = employees.rows.map((employee) => {
      const row = savedByEmployee.get(employee.id);
      const leaveType = leaveByEmployee.get(employee.id);
      const leaveStatus = leaveType === "permission" ? "permission" : leaveType ? "leave" : null;
      return [
        employee.employee_no,
        employee.full_name,
        employee.department_name ?? "",
        row ? ATTENDANCE_LABELS[row.status] ?? row.status : leaveStatus ? ATTENDANCE_LABELS[leaveStatus] : "غير مسجل",
        row?.check_in ?? "",
        row?.check_out ?? "",
        row?.late_minutes ?? "",
        row ? Number(row.work_hours) : "",
        row?.reason ?? (leaveStatus ? (leaveStatus === "permission" ? "إذن معتمد" : "إجازة معتمدة") : ""),
        row?.notes ?? "",
      ];
    });
    for (const row of saved.rows) {
      if (row.employee_id) continue;
      rows.push([
        "",
        row.manual_name ?? "",
        row.department_name ?? "",
        ATTENDANCE_LABELS[row.status] ?? row.status,
        row.check_in ?? "",
        row.check_out ?? "",
        row.late_minutes,
        Number(row.work_hours),
        row.reason,
        row.notes,
      ]);
    }
    const workbook = createWorkbook();
    addDataSheet(
      workbook,
      "التحضير اليومي",
      ["الرقم الوظيفي", "الاسم", "القسم", "الحالة", "الحضور", "الانصراف", "تأخير (دقيقة)", "ساعات العمل", "السبب", "ملاحظات"],
      rows,
      {
        title: `التحضير اليومي — ${branch.name}`,
        subtitle: `التاريخ: ${query.date} · كود الفرع: ${branch.code} · حالة الكشف: ${ATTENDANCE_LABELS[submission?.status ?? ""] ?? submission?.status ?? "مسودة"}`,
        landscape: true,
      },
    );
    await writeAudit(db, logger, {
      action: "attendance.daily_exported",
      actor: { id: actor.id, username: actor.username },
      entityType: "attendance_submission",
      entityId: submission?.id ?? undefined,
      branchId: query.branchId,
      severity: "info",
      details: { date: query.date, rows: rows.length, format: "xlsx" },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    await sendWorkbook(res, workbook, `attendance-daily-${query.date}`);
  });

  router.post("/daily/save", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const input = parseBody(
      dailyQuerySchema.extend({ rows: saveDailySchema.shape.rows, notes: saveDailySchema.shape.notes }),
      req.body,
    );
    if (!canAccessBranch(actor, input.branchId)) throw forbidden("الفرع خارج نطاق صلاحيتك.");
    await assertBranchUsable(db, actor, input.branchId);
    if (input.date > today()) throw new ApiError(400, "FUTURE_DATE", "لا يمكن تسجيل تحضير بتاريخ مستقبلي.");
    const settings = await getSettings(db);

    const existing = await loadSubmission(db, input.branchId, input.date);
    if (existing && (existing.status === "submitted" || existing.status === "approved")) {
      throw conflict(
        existing.status === "approved"
          ? "الكشف معتمد؛ استخدم التصحيح المصرح به في سجل الحضور."
          : "الكشف مرسل للاعتماد ولا يمكن تعديله قبل إعادته.",
      );
    }

    const employeeIds = [...new Set(input.rows.map((row) => row.employeeId).filter(Boolean) as string[])];
    const employees = employeeIds.length
      ? await db.query<Row & { id: string; full_name: string }>(
          "SELECT id, full_name FROM employees WHERE id = ANY($1::uuid[]) AND branch_id = $2 AND archived_at IS NULL",
          [employeeIds, input.branchId],
        )
      : { rows: [] as Array<Row & { id: string; full_name: string }> };
    if (employees.rows.length !== employeeIds.length) {
      throw new ApiError(400, "INVALID_EMPLOYEES", "بعض الموظفين المحددين لا ينتمون إلى هذا الفرع أو مؤرشفون.");
    }
    const nameById = new Map(employees.rows.map((row) => [row.id, row.full_name]));
    const manualNames = new Set<string>();
    for (const row of input.rows) {
      if (row.manualName) {
        const key = row.manualName.trim().toLowerCase();
        if (manualNames.has(key)) throw new ApiError(400, "DUPLICATE_MANUAL", `الاسم المؤقت "${row.manualName}" مكرر في الكشف.`);
        manualNames.add(key);
      }
    }

    const submissionId = existing?.id ?? newId();
    const preparedRows = input.rows.map((row) => {
      const checkIn = row.checkIn ?? null;
      const checkOut = row.checkOut ?? null;
      let lateMinutes = row.lateMinutes;
      if (lateMinutes === 0 && checkIn && (row.status === "present" || row.status === "late")) {
        const diff = minutesFromTime(checkIn) - (minutesFromTime(settings.attendance.workStart) + settings.attendance.lateGraceMinutes);
        if (diff > 0) lateMinutes = Math.min(diff, 1440);
      }
      return {
        row,
        checkIn,
        checkOut,
        lateMinutes,
        status: row.status === "present" && lateMinutes > 0 ? "late" : row.status,
        workHours: computeWorkHours(checkIn, checkOut, row.workHours),
        employeeName: row.employeeId ? (nameById.get(row.employeeId) ?? "") : (row.manualName ?? ""),
      };
    });

    await db.transaction(async (tx) => {
      if (existing) {
        await tx.query("UPDATE attendance_submissions SET notes = $2, prepared_by = COALESCE(prepared_by, $3), updated_at = now() WHERE id = $1", [
          submissionId,
          input.notes,
          actor.id,
        ]);
        await tx.query("DELETE FROM daily_attendance WHERE submission_id = $1", [submissionId]);
      } else {
        await tx.query(
          `INSERT INTO attendance_submissions (id, branch_id, work_date, status, notes, prepared_by)
           VALUES ($1, $2, $3::date, 'draft', $4, $5)`,
          [submissionId, input.branchId, input.date, input.notes, actor.id],
        );
      }
      for (const prepared of preparedRows) {
        await tx.query(
          `INSERT INTO daily_attendance
            (id, submission_id, employee_id, manual_name, status, check_in, check_out, late_minutes, work_hours, reason, notes, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6::time,$7::time,$8,$9,$10,$11,$12,$12)`,
          [
            newId(),
            submissionId,
            prepared.row.employeeId || null,
            prepared.row.employeeId ? null : prepared.row.manualName,
            prepared.status,
            prepared.checkIn,
            prepared.checkOut,
            prepared.lateMinutes,
            prepared.workHours,
            prepared.row.reason,
            prepared.row.notes,
            actor.id,
          ],
        );
      }
    });

    await writeAudit(db, logger, {
      action: "attendance.saved",
      actor: { id: actor.id, username: actor.username },
      entityType: "attendance_submission",
      entityId: submissionId,
      branchId: input.branchId,
      severity: "info",
      details: { date: input.date, rows: preparedRows.length, manualRows: manualNames.size, status: existing?.status ?? "draft" },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });

    const saved = await loadSubmission(db, input.branchId, input.date);
    res.json({ ok: true, submission: submissionJson(saved, input.branchId, saved?.branch_name ?? "", input.date) });
  });

  router.post("/daily/:id/submit", requireSubmit, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const submission = await loadSubmissionById(db, z.uuid("معرّف كشف غير صالح.").parse(req.params.id));
    if (!canAccessBranch(actor, submission.branch_id)) throw notFound("الكشف غير موجود أو خارج نطاق صلاحيتك.");
    if (submission.status !== "draft" && submission.status !== "rejected") {
      throw conflict("لا يمكن إرسال كشف بهذه الحالة.");
    }
    parseBody(submitReasonSchema, req.body ?? {});
    const stats = await db.query<Row & { total: number }>("SELECT count(*)::int AS total FROM daily_attendance WHERE submission_id = $1", [submission.id]);
    if ((stats.rows[0]?.total ?? 0) === 0) throw new ApiError(400, "EMPTY_SHEET", "أضف صفوف التحضير قبل الإرسال.");

    await db.query(
      `UPDATE attendance_submissions
       SET status = 'submitted', submitted_by = $2, submitted_at = now(), rejection_reason = NULL, updated_at = now()
       WHERE id = $1`,
      [submission.id, actor.id],
    );
    const workDate = toDateOnly(submission.work_date) ?? "";
    await openApproval(db, {
      entityType: "attendance_day",
      entityId: submission.id,
      branchId: submission.branch_id,
      title: `تحضير يومي — ${submission.branch_name} — ${workDate}`,
      summary: `عدد الصفوف: ${stats.rows[0]?.total ?? 0}`,
      requestedBy: actor.id,
    });
    await notifyPermissionHolders(
      db,
      "attendance.approve",
      submission.branch_id,
      "كشف تحضير بانتظار الاعتماد",
      `أرسل ${actor.fullName} كشف ${submission.branch_name} بتاريخ ${workDate}.`,
      `#/attendance/daily?branch=${submission.branch_id}&date=${workDate}`,
    );
    await writeAudit(db, logger, {
      action: "attendance.submitted",
      actor: { id: actor.id, username: actor.username },
      entityType: "attendance_submission",
      entityId: submission.id,
      branchId: submission.branch_id,
      severity: "info",
      details: { date: workDate, branch: submission.branch_name },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  });

  const decideDaily = async (req: Request, res: Response, decision: "approved" | "rejected") => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const submission = await loadSubmissionById(db, z.uuid("معرّف كشف غير صالح.").parse(req.params.id));
    if (!canAccessBranch(actor, submission.branch_id)) throw notFound("الكشف غير موجود أو خارج نطاق صلاحيتك.");
    if (submission.status !== "submitted") throw conflict("لا يمكن اعتماد أو رفض كشف غير مرسل.");
    const input = decision === "rejected" ? parseBody(rejectSchema, req.body) : { reason: String(req.body?.reason ?? "").trim() };
    const workDate = toDateOnly(submission.work_date) ?? "";

    await db.query(
      `UPDATE attendance_submissions
       SET status = $2, approved_by = $3, approved_at = now(), rejection_reason = $4, updated_at = now()
       WHERE id = $1`,
      [submission.id, decision, actor.id, decision === "rejected" ? input.reason : null],
    );
    await closeApproval(db, "attendance_day", submission.id, decision, actor.id, input.reason || null);
    await notifyUser(
      db,
      submission.submitted_by,
      decision === "approved" ? "اعتماد كشف التحضير" : "إعادة كشف التحضير",
      decision === "approved"
        ? `اعتُمد كشف ${submission.branch_name} بتاريخ ${workDate}.`
        : `أُعيد كشف ${submission.branch_name} بتاريخ ${workDate}. السبب: ${input.reason}`,
      `#/attendance/daily?branch=${submission.branch_id}&date=${workDate}`,
    );
    await writeAudit(db, logger, {
      action: decision === "approved" ? "attendance.approved" : "attendance.rejected",
      actor: { id: actor.id, username: actor.username },
      entityType: "attendance_submission",
      entityId: submission.id,
      branchId: submission.branch_id,
      severity: decision === "rejected" ? "warning" : "info",
      details: { date: workDate, reason: decision === "rejected" ? input.reason : undefined },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  };

  router.post("/daily/:id/approve", requireApprove, (req, res) => decideDaily(req, res, "approved"));
  router.post("/daily/:id/reject", requireApprove, (req, res) => decideDaily(req, res, "rejected"));

  router.patch("/daily/:id/rows/:rowId", requireCorrect, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const submissionId = z.uuid("معرّف كشف غير صالح.").parse(req.params.id);
    const rowId = z.uuid("معرّف صف غير صالح.").parse(req.params.rowId);
    const input = parseBody(correctDailyRowSchema, req.body);
    const submission = await loadSubmissionById(db, submissionId);
    if (!canAccessBranch(actor, submission.branch_id)) throw notFound("الكشف غير موجود أو خارج نطاق صلاحيتك.");
    if (submission.status !== "approved") throw conflict("التصحيح متاح فقط على الكشوف المعتمدة.");
    const currentResult = await db.query<SavedRow>("SELECT * FROM daily_attendance WHERE id = $1 AND submission_id = $2", [rowId, submissionId]);
    const current = currentResult.rows[0];
    if (!current) throw notFound("الصف غير موجود.");
    const settings = await getSettings(db);
    const checkIn = input.checkIn !== undefined ? (input.checkIn || null) : timeText(current.check_in) || null;
    const checkOut = input.checkOut !== undefined ? (input.checkOut || null) : timeText(current.check_out) || null;
    let lateMinutes = input.lateMinutes ?? current.late_minutes;
    let status = input.status ?? current.status;
    if (input.lateMinutes === undefined && checkIn && (status === "present" || status === "late")) {
      const diff = minutesFromTime(checkIn) - (minutesFromTime(settings.attendance.workStart) + settings.attendance.lateGraceMinutes);
      lateMinutes = diff > 0 ? Math.min(diff, 1440) : 0;
    }
    if (status === "present" && lateMinutes > 0) status = "late";
    const workHours = input.workHours !== undefined ? computeWorkHours(checkIn, checkOut, input.workHours) : computeWorkHours(checkIn, checkOut, Number(current.work_hours));
    const reason = input.reason !== undefined ? input.reason : current.reason;
    const notes = input.notes !== undefined ? input.notes : current.notes;

    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE daily_attendance
         SET status=$2, check_in=$3::time, check_out=$4::time, late_minutes=$5, work_hours=$6, reason=$7, notes=$8, updated_by=$9, updated_at=now()
         WHERE id=$1`,
        [rowId, status, checkIn, checkOut, lateMinutes, workHours, reason, notes, actor.id],
      );
      await tx.query(
        `UPDATE attendance_submissions
         SET last_corrected_by = $2, last_corrected_at = now(), correction_count = correction_count + 1, updated_at = now()
         WHERE id = $1`,
        [submissionId, actor.id],
      );
    });
    const workDate = toDateOnly(submission.work_date) ?? "";
    await writeAudit(db, logger, {
      action: "attendance.corrected",
      actor: { id: actor.id, username: actor.username },
      entityType: "attendance_submission",
      entityId: submissionId,
      branchId: submission.branch_id,
      severity: "warning",
      details: {
        date: workDate,
        rowId,
        employee: current.employee_name ?? current.manual_name ?? "",
        reason: input.correctionReason,
        changes: {
          status: { from: current.status, to: status },
          checkIn: { from: timeText(current.check_in), to: checkIn ?? "" },
          checkOut: { from: timeText(current.check_out), to: checkOut ?? "" },
          lateMinutes: { from: current.late_minutes, to: lateMinutes },
        },
      },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  });

  router.get("/monthly", requireView, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const query = parseBody(monthlyQuerySchema, req.query);
    if (!canAccessBranch(actor, query.branchId)) throw forbidden("الفرع خارج نطاق صلاحيتك.");
    const branchResult = await db.query<Row & { name: string; code: string }>("SELECT name, code FROM branches WHERE id = $1", [query.branchId]);
    const branch = branchResult.rows[0];
    if (!branch) throw notFound("الفرع غير موجود.");
    const settings = await getSettings(db);
    const range = monthRange(query.year, query.month);
    const monthlyResult = await db.query<MonthlyRow>(
      `SELECT m.id, m.status, m.notes, m.missing_days_confirmed,
              m.prepared_by, pu.full_name AS prepared_name,
              m.submitted_by, su.full_name AS submitted_name, m.submitted_at,
              m.approved_by, au.full_name AS approved_name, m.approved_at,
              m.rejection_reason, m.created_at, m.updated_at
       FROM monthly_attendance m
       LEFT JOIN users pu ON pu.id = m.prepared_by
       LEFT JOIN users su ON su.id = m.submitted_by
       LEFT JOIN users au ON au.id = m.approved_by
       WHERE m.branch_id = $1 AND m.year = $2 AND m.month = $3`,
      [query.branchId, query.year, query.month],
    );
    const monthly = monthlyResult.rows[0] ?? null;
    const overridesResult = monthly
      ? await db.query<Row & { employee_id: string; day: number; status: string; note: string }>(
          "SELECT employee_id, day, status, note FROM monthly_attendance_overrides WHERE monthly_id = $1",
          [monthly.id],
        )
      : { rows: [] as Array<Row & { employee_id: string; day: number; status: string; note: string }> };
    const overrideMap = new Map(overridesResult.rows.map((row) => [`${row.employee_id}:${row.day}`, row]));

    const employees = await db.query<EmployeeRow>(
      `SELECT e.id, e.employee_no, e.full_name, e.phone, e.national_id,
              e.branch_id, $2::text AS branch_name, ''::text AS branch_code,
              e.department_id, d.name AS department_name, e.job_title,
              e.hire_date, e.base_salary, e.status, e.notes,
              e.termination_date, e.termination_reason, e.archived_at, e.archive_reason,
              e.created_at, e.updated_at
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.hire_date <= $3::date
         AND COALESCE(e.termination_date, e.archived_at::date, '9999-12-31'::date) >= $4::date
         AND (e.branch_id = $1
           OR EXISTS (
             SELECT 1 FROM attendance_submissions s
             JOIN daily_attendance dd ON dd.submission_id = s.id
             WHERE s.branch_id = $1 AND dd.employee_id = e.id AND s.work_date BETWEEN $4::date AND $3::date
           ))
         ${query.departmentId ? "AND e.department_id = $5::uuid" : ""}
       ORDER BY e.full_name`,
      query.departmentId
        ? [query.branchId, branch.name, range.end, range.start, query.departmentId]
        : [query.branchId, branch.name, range.end, range.start],
    );

    const dailyRows = await db.query<Row & { employee_id: string | null; manual_name: string | null; day: number; status: string }>(
      `SELECT dd.employee_id, dd.manual_name, EXTRACT(DAY FROM s.work_date)::int AS day, dd.status
       FROM attendance_submissions s
       JOIN daily_attendance dd ON dd.submission_id = s.id
       WHERE s.branch_id = $1 AND s.work_date BETWEEN $2::date AND $3::date
         AND s.status IN ('submitted', 'approved')`,
      [query.branchId, range.start, range.end],
    );
    const leaves = await db.query<Row & { employee_id: string; start_date: string; end_date: string }>(
      `SELECT employee_id, start_date::text AS start_date, end_date::text AS end_date
       FROM leave_requests
       WHERE branch_id = $1 AND status = 'approved' AND start_date <= $3::date AND end_date >= $2::date`,
      [query.branchId, range.start, range.end],
    );

    interface MonthlyEmployee {
      key: string;
      id: string | null;
      employeeNo: string;
      fullName: string;
      departmentId: string | null;
      departmentName: string | null;
      hireDate: string | null;
      endDate: string | null;
      temporary: boolean;
    }

    const employeeMap = new Map<string, MonthlyEmployee>();
    for (const employee of employees.rows) {
      employeeMap.set(employee.id, {
        key: employee.id,
        id: employee.id,
        employeeNo: employee.employee_no,
        fullName: employee.full_name,
        departmentId: employee.department_id,
        departmentName: employee.department_name,
        hireDate: toDateOnly(employee.hire_date),
        endDate: toDateOnly(employee.termination_date) ?? toDateOnly(employee.archived_at),
        temporary: false,
      });
    }

    const dailyMap = new Map<string, Map<number, string>>();
    for (const row of dailyRows.rows) {
      if (row.employee_id) {
        if (!employeeMap.has(row.employee_id)) {
          employeeMap.set(row.employee_id, {
            key: row.employee_id,
            id: row.employee_id,
            employeeNo: "",
            fullName: "",
            departmentId: null,
            departmentName: null,
            hireDate: range.start,
            endDate: null,
            temporary: false,
          });
        }
        const map = dailyMap.get(row.employee_id) ?? new Map<number, string>();
        map.set(row.day, row.status);
        dailyMap.set(row.employee_id, map);
      } else if (row.manual_name && !query.departmentId) {
        const key = `manual:${row.manual_name.trim().toLowerCase()}`;
        if (!employeeMap.has(key)) {
          employeeMap.set(key, {
            key,
            id: null,
            employeeNo: "—",
            fullName: row.manual_name,
            departmentId: null,
            departmentName: null,
            hireDate: range.start,
            endDate: null,
            temporary: true,
          });
        }
        const map = dailyMap.get(key) ?? new Map<number, string>();
        map.set(row.day, row.status);
        dailyMap.set(key, map);
      }
    }
    const leaveMap = new Map<string, Map<number, string>>();
    for (const leave of leaves.rows) {
      const startDay = leave.start_date <= range.start ? 1 : Number(leave.start_date.slice(8, 10));
      const endDay = leave.end_date >= range.end ? range.days : Number(leave.end_date.slice(8, 10));
      for (let day = startDay; day <= endDay; day += 1) {
        const map = leaveMap.get(leave.employee_id) ?? new Map<number, string>();
        map.set(day, "leave");
        leaveMap.set(leave.employee_id, map);
      }
    }

    let totalMissing = 0;
    const missingCells: Array<{ employeeId: string; day: number }> = [];
    const rows = [...employeeMap.values()]
      .filter((employee) => !employee.id || employee.fullName !== "")
      .map((employee) => {
        const totals = { present: 0, absent: 0, leave: 0, permission: 0, mission: 0, weeklyRest: 0, late: 0, excusedAbsence: 0, unrecorded: 0, workdays: 0 };
        const days = Array.from({ length: range.days }, (_, index) => {
          const day = index + 1;
          const date = `${query.year}-${String(query.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const active = (!employee.hireDate || date >= employee.hireDate) && (!employee.endDate || date <= employee.endDate);
          if (!active) return { day, status: null, source: "inactive", note: "" };
          const override = employee.id ? overrideMap.get(`${employee.id}:${day}`) : undefined;
          const dailyStatus = dailyMap.get(employee.key)?.get(day);
          const leave = employee.id ? leaveMap.get(employee.id)?.get(day) : undefined;
          let status: string | null = null;
          let source = "none";
          if (override) {
            status = override.status;
            source = "override";
          } else if (dailyStatus) {
            status = dailyStatus;
            source = "daily";
          } else if (leave) {
            status = leave;
            source = "leave";
          } else if (isWeekend(date, settings.attendance.weekendDays)) {
            status = "weekly_rest";
            source = "weekend";
          }
          const isWorkday = !isWeekend(date, settings.attendance.weekendDays);
          if (isWorkday) totals.workdays += 1;
          if (status === "present") totals.present += 1;
          else if (status === "absent") totals.absent += 1;
          else if (status === "leave") totals.leave += 1;
          else if (status === "permission") totals.permission += 1;
          else if (status === "mission") totals.mission += 1;
          else if (status === "weekly_rest") totals.weeklyRest += 1;
          else if (status === "late") totals.late += 1;
          else if (status === "excused_absence") totals.excusedAbsence += 1;
          else if (isWorkday) {
            totals.unrecorded += 1;
            totalMissing += 1;
            if (missingCells.length < 500 && employee.id) missingCells.push({ employeeId: employee.id, day });
          }
          return { day, status, source, note: override?.note ?? "" };
        });
        return {
          employeeId: employee.id,
          employeeNo: employee.employeeNo,
          fullName: employee.fullName,
          departmentId: employee.departmentId,
          departmentName: employee.departmentName,
          temporary: employee.temporary,
          days,
          totals,
        };
      })
      .sort((a, b) => (a.employeeNo === "—" ? 1 : b.employeeNo === "—" ? -1 : a.employeeNo.localeCompare(b.employeeNo)));

    const monthlyCapabilities = {
      canManage:
        hasPermission(actor, "attendance.manage") &&
        (!monthly || (monthly.status !== "submitted" && monthly.status !== "approved")),
      canSubmit:
        hasPermission(actor, "attendance.submit") &&
        (!monthly || (monthly.status !== "submitted" && monthly.status !== "approved")),
      canApprove: hasPermission(actor, "attendance.approve") && monthly?.status === "submitted",
      canCorrect: hasPermission(actor, "attendance.correct") && monthly?.status === "approved",
    };

    res.json({
      branch: { id: query.branchId, name: branch.name, code: branch.code },
      year: query.year,
      month: query.month,
      days: range.days,
      settings: settings.attendance,
      monthly: monthly
        ? {
            id: monthly.id,
            status: monthly.status,
            notes: monthly.notes,
            missingDaysConfirmed: monthly.missing_days_confirmed,
            preparedBy: monthly.prepared_name,
            submittedBy: monthly.submitted_name,
            submittedAt: iso(monthly.submitted_at),
            approvedBy: monthly.approved_name,
            approvedAt: iso(monthly.approved_at),
            rejectionReason: monthly.rejection_reason,
            createdAt: iso(monthly.created_at),
            updatedAt: iso(monthly.updated_at),
          }
        : {
            id: null,
            status: "draft",
            notes: "",
            missingDaysConfirmed: false,
            preparedBy: null,
            submittedBy: null,
            submittedAt: null,
            approvedBy: null,
            approvedAt: null,
            rejectionReason: null,
            createdAt: null,
            updatedAt: null,
          },
      rows,
      missingDays: totalMissing,
      missingCells,
      overrides: overridesResult.rows.map((row) => ({ employeeId: row.employee_id, day: row.day, status: row.status, note: row.note })),
      capabilities: monthlyCapabilities,
    });
  });

  router.get("/monthly/export.xlsx", requireView, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const query = parseBody(monthlyQuerySchema, req.query);
    if (!canAccessBranch(actor, query.branchId)) throw forbidden("الفرع خارج نطاق صلاحيتك.");
    const branchResult = await db.query<Row & { name: string; code: string }>("SELECT name, code FROM branches WHERE id = $1", [query.branchId]);
    const branch = branchResult.rows[0];
    if (!branch) throw notFound("الفرع غير موجود.");
    const settings = await getSettings(db);
    const range = monthRange(query.year, query.month);
    const monthlyResult = await db.query<MonthlyRow>(
      "SELECT id, status, notes, missing_days_confirmed FROM monthly_attendance WHERE branch_id = $1 AND year = $2 AND month = $3",
      [query.branchId, query.year, query.month],
    );
    const monthly = monthlyResult.rows[0] ?? null;
    const overrides = monthly
      ? await db.query<Row & { employee_id: string; day: number; status: string }>(
          "SELECT employee_id, day, status FROM monthly_attendance_overrides WHERE monthly_id = $1",
          [monthly.id],
        )
      : { rows: [] as Array<Row & { employee_id: string; day: number; status: string }> };
    const overrideMap = new Map(overrides.rows.map((row) => [`${row.employee_id}:${row.day}`, row.status]));
    const employees = await db.query<EmployeeRow>(
      `SELECT e.id, e.employee_no, e.full_name, e.phone, e.national_id,
              e.branch_id, $2::text AS branch_name, ''::text AS branch_code,
              e.department_id, d.name AS department_name, e.job_title,
              e.hire_date, e.base_salary, e.status, e.notes,
              e.termination_date, e.termination_reason, e.archived_at, e.archive_reason,
              e.created_at, e.updated_at
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.hire_date <= $3::date
         AND COALESCE(e.termination_date, e.archived_at::date, '9999-12-31'::date) >= $4::date
         AND (e.branch_id = $1
           OR EXISTS (
             SELECT 1 FROM attendance_submissions s
             JOIN daily_attendance dd ON dd.submission_id = s.id
             WHERE s.branch_id = $1 AND dd.employee_id = e.id AND s.work_date BETWEEN $4::date AND $3::date
           ))
         ${query.departmentId ? "AND e.department_id = $5::uuid" : ""}
       ORDER BY e.full_name`,
      query.departmentId
        ? [query.branchId, branch.name, range.end, range.start, query.departmentId]
        : [query.branchId, branch.name, range.end, range.start],
    );
    const dailyRows = await db.query<Row & { employee_id: string | null; manual_name: string | null; day: number; status: string }>(
      `SELECT dd.employee_id, dd.manual_name, EXTRACT(DAY FROM s.work_date)::int AS day, dd.status
       FROM attendance_submissions s
       JOIN daily_attendance dd ON dd.submission_id = s.id
       WHERE s.branch_id = $1 AND s.work_date BETWEEN $2::date AND $3::date
         AND s.status IN ('submitted', 'approved')`,
      [query.branchId, range.start, range.end],
    );
    const dailyMap = new Map<string, Map<number, string>>();
    const names = new Map<string, { employeeNo: string; fullName: string; department: string }>();
    for (const employee of employees.rows) {
      names.set(employee.id, { employeeNo: employee.employee_no, fullName: employee.full_name, department: employee.department_name ?? "" });
    }
    for (const row of dailyRows.rows) {
      const key = row.employee_id ?? (row.manual_name ? `manual:${row.manual_name.trim().toLowerCase()}` : null);
      if (!key) continue;
      if (!names.has(key)) {
        names.set(key, { employeeNo: row.employee_id ? "" : "—", fullName: row.manual_name ?? "", department: "" });
      }
      const map = dailyMap.get(key) ?? new Map<number, string>();
      map.set(row.day, row.status);
      dailyMap.set(key, map);
    }
    const leaveRows = await db.query<Row & { employee_id: string; start_date: string; end_date: string }>(
      `SELECT employee_id, start_date::text AS start_date, end_date::text AS end_date
       FROM leave_requests WHERE branch_id = $1 AND status = 'approved' AND start_date <= $3::date AND end_date >= $2::date`,
      [query.branchId, range.start, range.end],
    );
    const leaveMap = new Map<string, Set<number>>();
    for (const leave of leaveRows.rows) {
      const startDay = leave.start_date <= range.start ? 1 : Number(leave.start_date.slice(8, 10));
      const endDay = leave.end_date >= range.end ? range.days : Number(leave.end_date.slice(8, 10));
      const set = leaveMap.get(leave.employee_id) ?? new Set<number>();
      for (let day = startDay; day <= endDay; day += 1) set.add(day);
      leaveMap.set(leave.employee_id, set);
    }
    const headers = ["الرقم الوظيفي", "الاسم", "القسم", ...Array.from({ length: range.days }, (_, index) => String(index + 1)), "ح", "غ", "إ", "ذ", "م", "ر", "ت", "ع", "أيام العمل", "غير مسجل"];
    const excelRows: CellValue[][] = [];
    for (const [key, employee] of names) {
      const cells: CellValue[] = [];
      const totals: Record<string, number> = { present: 0, absent: 0, leave: 0, permission: 0, mission: 0, weekly_rest: 0, late: 0, excused_absence: 0 };
      let workdays = 0;
      let missing = 0;
      let activeDays = 0;
      for (let day = 1; day <= range.days; day += 1) {
        const date = `${query.year}-${String(query.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const override = overrideMap.get(`${key}:${day}`);
        const daily = dailyMap.get(key)?.get(day);
        const isLeave = leaveMap.get(key)?.has(day);
        let status: string | null = override ?? daily ?? (isLeave ? "leave" : null);
        if (!status && isWeekend(date, settings.attendance.weekendDays)) status = "weekly_rest";
        if (isWeekend(date, settings.attendance.weekendDays)) {
          cells.push(status && status !== "weekly_rest" ? MONTHLY_SYMBOLS[status] ?? "" : "ر");
        } else {
          workdays += 1;
          if (status) {
            activeDays += 1;
            cells.push(MONTHLY_SYMBOLS[status] ?? "");
            totals[status] = (totals[status] ?? 0) + 1;
          } else {
            missing += 1;
            cells.push("");
          }
        }
      }
      excelRows.push([
        employee.employeeNo,
        employee.fullName,
        employee.department,
        ...cells,
        totals.present,
        totals.absent,
        totals.leave,
        totals.permission,
        totals.mission,
        totals.weekly_rest,
        totals.late,
        totals.excused_absence,
        workdays,
        missing,
      ]);
    }
    const workbook = createWorkbook();
    addDataSheet(workbook, "التحضير الشهري", headers, excelRows, {
      title: `التحضير الشهري — ${branch.name}`,
      subtitle: `الشهر: ${String(query.month).padStart(2, "0")}/${query.year} · أيام الشهر: ${range.days} · حالة الكشف: ${ATTENDANCE_LABELS[monthly?.status ?? ""] ?? monthly?.status ?? "غير منشأ"}`,
      landscape: true,
    });
    await writeAudit(db, logger, {
      action: "attendance.monthly_exported",
      actor: { id: actor.id, username: actor.username },
      entityType: "monthly_attendance",
      entityId: monthly?.id ?? undefined,
      branchId: query.branchId,
      severity: "info",
      details: { year: query.year, month: query.month, rows: excelRows.length, format: "xlsx" },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    await sendWorkbook(res, workbook, `attendance-monthly-${query.year}-${String(query.month).padStart(2, "0")}`);
  });

  router.post("/monthly/save", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const input = parseBody(
      monthlyQuerySchema.extend({ notes: monthlySaveSchema.shape.notes, overrides: monthlySaveSchema.shape.overrides }),
      req.body,
    );
    if (!canAccessBranch(actor, input.branchId)) throw forbidden("الفرع خارج نطاق صلاحيتك.");
    await assertBranchUsable(db, actor, input.branchId);
    const range = monthRange(input.year, input.month);
    if (input.overrides.some((override) => override.day > range.days)) {
      throw new ApiError(400, "INVALID_DAY", "يوجد يوم خارج نطاق الشهر المحدد.");
    }
    const employeeIds = [...new Set(input.overrides.map((override) => override.employeeId))];
    if (employeeIds.length) {
      const valid = await db.query<Row & { id: string }>(
        "SELECT id FROM employees WHERE id = ANY($1::uuid[]) AND branch_id = $2 AND archived_at IS NULL",
        [employeeIds, input.branchId],
      );
      if (valid.rows.length !== employeeIds.length) throw new ApiError(400, "INVALID_EMPLOYEES", "يوجد موظف غير صالح في التعديلات.");
    }
    const existing = await db.query<Row & { id: string; status: string }>(
      "SELECT id, status FROM monthly_attendance WHERE branch_id = $1 AND year = $2 AND month = $3",
      [input.branchId, input.year, input.month],
    );
    const current = existing.rows[0];
    if (current && (current.status === "submitted" || current.status === "approved")) {
      throw conflict("سجل الشهر مرسل أو معتمد ولا يمكن تعديله.");
    }
    const monthlyId = current?.id ?? newId();
    await db.transaction(async (tx) => {
      if (current) {
        await tx.query(
          "UPDATE monthly_attendance SET notes = $2, missing_days_confirmed = false, prepared_by = COALESCE(prepared_by, $3), updated_at = now() WHERE id = $1",
          [monthlyId, input.notes, actor.id],
        );
        await tx.query("DELETE FROM monthly_attendance_overrides WHERE monthly_id = $1", [monthlyId]);
      } else {
        await tx.query(
          `INSERT INTO monthly_attendance (id, branch_id, year, month, status, notes, prepared_by)
           VALUES ($1, $2, $3, $4, 'draft', $5, $6)`,
          [monthlyId, input.branchId, input.year, input.month, input.notes, actor.id],
        );
      }
      for (const override of input.overrides) {
        await tx.query(
          `INSERT INTO monthly_attendance_overrides (id, monthly_id, employee_id, day, status, note, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [newId(), monthlyId, override.employeeId, override.day, override.status, override.note, actor.id],
        );
      }
    });
    await writeAudit(db, logger, {
      action: "attendance.monthly_saved",
      actor: { id: actor.id, username: actor.username },
      entityType: "attendance_month",
      entityId: monthlyId,
      branchId: input.branchId,
      severity: "info",
      details: { year: input.year, month: input.month, overrides: input.overrides.length, notes: input.notes },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true, id: monthlyId });
  });

  router.post("/monthly/:id/submit", requireSubmit, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const monthlyId = z.uuid("معرّف سجل غير صالح.").parse(req.params.id);
    const input = parseBody(monthlySubmitSchema, req.body ?? {});
    const result = await db.query<MonthlyRow & { branch_id: string; year: number; month: number }>(
      "SELECT *, (SELECT name FROM branches WHERE id = branch_id) AS branch_name FROM monthly_attendance WHERE id = $1",
      [monthlyId],
    );
    const monthly = result.rows[0];
    if (!monthly) throw notFound("سجل الشهر غير موجود.");
    if (!canAccessBranch(actor, monthly.branch_id)) throw notFound("السجل غير موجود أو خارج نطاق صلاحيتك.");
    if (monthly.status !== "draft" && monthly.status !== "rejected") throw conflict("لا يمكن إرسال سجل بهذه الحالة.");
    const missingDays = await computeMonthlyMissingDays(db, monthly.branch_id, monthly.year, monthly.month, monthlyId);
    if (missingDays > 0 && !input.missingDaysConfirmed) {
      throw new ApiError(
        409,
        "MISSING_DAYS_CONFIRMATION",
        `يوجد ${missingDays} يوم عمل غير مسجل. راجع الأيام غير المسجلة ثم أكد المتابعة قبل إرسال الشهر.`,
        { missingDays },
      );
    }
    await db.query(
      `UPDATE monthly_attendance
       SET status = 'submitted', missing_days_confirmed = $2, submitted_by = $3, submitted_at = now(), rejection_reason = NULL, updated_at = now()
       WHERE id = $1`,
      [monthlyId, input.missingDaysConfirmed, actor.id],
    );
    await openApproval(db, {
      entityType: "attendance_month",
      entityId: monthlyId,
      branchId: monthly.branch_id,
      title: `تحضير شهري — ${monthly.branch_name} — ${monthly.year}/${String(monthly.month).padStart(2, "0")}`,
      summary: input.note,
      requestedBy: actor.id,
    });
    await notifyPermissionHolders(
      db,
      "attendance.approve",
      monthly.branch_id,
      "تحضير شهري بانتظار الاعتماد",
      `أرسل ${actor.fullName} تحضير ${monthly.branch_name} لشهر ${monthly.month}/${monthly.year}.`,
      `#/attendance/monthly?branch=${monthly.branch_id}&year=${monthly.year}&month=${monthly.month}`,
    );
    await writeAudit(db, logger, {
      action: "attendance.monthly_submitted",
      actor: { id: actor.id, username: actor.username },
      entityType: "attendance_month",
      entityId: monthlyId,
      branchId: monthly.branch_id,
      severity: "info",
      details: { year: monthly.year, month: monthly.month, missingDaysConfirmed: input.missingDaysConfirmed, note: input.note },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  });

  const decideMonthly = async (req: Request, res: Response, decision: "approved" | "rejected") => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const monthlyId = z.uuid("معرّف سجل غير صالح.").parse(req.params.id);
    const result = await db.query<MonthlyRow & { branch_id: string; year: number; month: number; branch_name: string }>(
      "SELECT *, (SELECT name FROM branches WHERE id = branch_id) AS branch_name FROM monthly_attendance WHERE id = $1",
      [monthlyId],
    );
    const monthly = result.rows[0];
    if (!monthly) throw notFound("سجل الشهر غير موجود.");
    if (!canAccessBranch(actor, monthly.branch_id)) throw notFound("السجل غير موجود أو خارج نطاق صلاحيتك.");
    if (monthly.status !== "submitted") throw conflict("لا يمكن اعتماد أو رفض سجل غير مرسل.");
    const input = decision === "rejected" ? parseBody(rejectSchema, req.body) : { reason: String(req.body?.reason ?? "").trim() };
    await db.query(
      `UPDATE monthly_attendance SET status = $2, approved_by = $3, approved_at = now(), rejection_reason = $4, updated_at = now() WHERE id = $1`,
      [monthlyId, decision, actor.id, decision === "rejected" ? input.reason : null],
    );
    await closeApproval(db, "attendance_month", monthlyId, decision, actor.id, input.reason || null);
    await notifyUser(
      db,
      monthly.submitted_by,
      decision === "approved" ? "اعتماد التحضير الشهري" : "إعادة التحضير الشهري",
      decision === "approved"
        ? `اعتُمد تحضير ${monthly.branch_name} لشهر ${monthly.month}/${monthly.year}.`
        : `أُعيد تحضير ${monthly.branch_name} لشهر ${monthly.month}/${monthly.year}. السبب: ${input.reason}`,
      `#/attendance/monthly?branch=${monthly.branch_id}&year=${monthly.year}&month=${monthly.month}`,
    );
    await writeAudit(db, logger, {
      action: decision === "approved" ? "attendance.monthly_approved" : "attendance.monthly_rejected",
      actor: { id: actor.id, username: actor.username },
      entityType: "attendance_month",
      entityId: monthlyId,
      branchId: monthly.branch_id,
      severity: decision === "rejected" ? "warning" : "info",
      details: { year: monthly.year, month: monthly.month, reason: decision === "rejected" ? input.reason : undefined },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  };

  router.post("/monthly/:id/approve", requireApprove, (req, res) => decideMonthly(req, res, "approved"));
  router.post("/monthly/:id/reject", requireApprove, (req, res) => decideMonthly(req, res, "rejected"));

  router.get("/follow-up", requireView, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const query = parseBody(followUpQuerySchema, req.query);
    const settings = await getSettings(db);
    const range = monthRange(query.year, query.month);
    const scope: { sql: string; params: unknown[] } = actor.allBranches
      ? { sql: "TRUE", params: [] }
      : { sql: "b.id = ANY($1::uuid[])", params: [actor.branches.map((branch) => branch.id)] };
    const branches = await db.query<Row & { id: string; name: string; code: string; active: boolean }>(
      `SELECT b.id, b.name, b.code, b.active FROM branches b WHERE ${scope.sql} ORDER BY b.active DESC, b.name`,
      scope.params,
    );
    const branchIds = branches.rows.map((row) => row.id);
    if (branchIds.length === 0) {
      res.json({ year: query.year, month: query.month, rows: [], totals: { branches: 0, missingDays: 0, lateBranches: 0 } });
      return;
    }
    const [submissions, monthlyRecords, employeeCounts] = await Promise.all([
      db.query<Row & { branch_id: string; work_date: string; status: string; submitted_at: string | Date | null; submitter: string | null; notes: string }>(
        `SELECT s.branch_id, s.work_date::text AS work_date, s.status, s.submitted_at, u.full_name AS submitter, s.notes
         FROM attendance_submissions s LEFT JOIN users u ON u.id = s.submitted_by
         WHERE s.branch_id = ANY($1::uuid[]) AND s.work_date BETWEEN $2::date AND $3::date`,
        [branchIds, range.start, range.end],
      ),
      db.query<Row & { branch_id: string; status: string; notes: string; submitted_at: string | Date | null; approved_at: string | Date | null }>(
        "SELECT branch_id, status, notes, submitted_at, approved_at FROM monthly_attendance WHERE branch_id = ANY($1::uuid[]) AND year = $2 AND month = $3",
        [branchIds, query.year, query.month],
      ),
      db.query<Row & { branch_id: string; total: number }>(
        "SELECT branch_id, count(*)::int AS total FROM employees WHERE branch_id = ANY($1::uuid[]) AND archived_at IS NULL AND status IN ('active','leave') GROUP BY branch_id",
        [branchIds],
      ),
    ]);
    const monthIsCurrent = query.year === new Date().getFullYear() && query.month === new Date().getMonth() + 1;
    const monthIsFuture = `${query.year}-${String(query.month).padStart(2, "0")}` > today().slice(0, 7);
    const lastWorkday = monthIsCurrent ? Number(today().slice(8, 10)) : monthIsFuture ? 0 : range.days;
    const activeEmployeeCount = new Map(employeeCounts.rows.map((row) => [row.branch_id, row.total]));
    const monthlyByBranch = new Map(monthlyRecords.rows.map((row) => [row.branch_id, row]));

    let totalMissing = 0;
    const rows = branches.rows.map((branch) => {
      const branchSubmissions = submissions.rows.filter((row) => row.branch_id === branch.id);
      const approved = branchSubmissions.filter((row) => row.status === "approved");
      const submitted = branchSubmissions.filter((row) => row.status === "submitted");
      const rejected = branchSubmissions.filter((row) => row.status === "rejected");
      const drafts = branchSubmissions.filter((row) => row.status === "draft");
      let expectedWorkdays = 0;
      for (let day = 1; day <= lastWorkday; day += 1) {
        const date = `${query.year}-${String(query.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        if (!isWeekend(date, settings.attendance.weekendDays)) expectedWorkdays += 1;
      }
      const coveredDays = new Set([...approved, ...submitted].map((row) => row.work_date)).size;
      const missingDays = Math.max(0, expectedWorkdays - coveredDays);
      totalMissing += missingDays;
      const monthly = monthlyByBranch.get(branch.id);
      const lastSubmission = [...branchSubmissions]
        .filter((row) => row.submitted_at)
        .sort((a, b) => new Date(b.submitted_at as string).getTime() - new Date(a.submitted_at as string).getTime())[0];
      let status = "not_started";
      if (monthly?.status === "approved") status = "approved";
      else if (monthly?.status === "submitted") status = "submitted";
      else if (monthly?.status === "rejected" || rejected.length > 0) status = "returned";
      else if (drafts.length > 0 || submitted.length > 0 || approved.length > 0) {
        status = missingDays === 0 && expectedWorkdays > 0 ? "complete_unsubmitted" : "in_progress";
      } else if (expectedWorkdays > 0) status = "not_started";
      const todayRow = branchSubmissions.find((row) => row.work_date === today());
      return {
        branchId: branch.id,
        branchName: branch.name,
        branchCode: branch.code,
        branchActive: branch.active,
        employees: activeEmployeeCount.get(branch.id) ?? 0,
        expectedWorkdays,
        coveredDays,
        missingDays,
        draftDays: drafts.length,
        submittedDays: submitted.length,
        approvedDays: approved.length,
        rejectedDays: rejected.length,
        lastSubmissionAt: lastSubmission?.submitted_at ? new Date(lastSubmission.submitted_at).toISOString() : null,
        lastSubmitter: lastSubmission?.submitter ?? null,
        notes: monthly?.notes || lastSubmission?.notes || "",
        monthlyStatus: monthly?.status ?? null,
        todayStatus: todayRow?.status ?? null,
        status,
        late: missingDays > 0 && monthly?.status !== "approved",
      };
    });
    const filtered = query.late ? rows.filter((row) => row.late) : rows;
    res.json({
      year: query.year,
      month: query.month,
      rows: filtered,
      totals: {
        branches: filtered.length,
        missingDays: totalMissing,
        lateBranches: rows.filter((row) => row.late).length,
      },
    });
  });

  return router;
}
