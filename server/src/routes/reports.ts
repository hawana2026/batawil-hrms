import { Router } from "express";
import { z } from "zod";
import type { Db, Row } from "../db/index.js";
import type { AuthUser } from "../auth/types.js";
import { writeAudit } from "../lib/audit.js";
import { ApiError, forbidden, notFound, parseBody, requestIp, requestUserAgent, unauthorized } from "../lib/errors.js";
import { addDataSheet, createWorkbook, sendWorkbook } from "../lib/xlsx.js";
import { isoDateSchema } from "../lib/hr-schemas.js";
import { branchScopeSql, canAccessBranch } from "../services/access.js";
import { loadEmployee, today } from "../services/employees.js";
import { getSettings, isWeekend, monthRange } from "../services/settings.js";
import { createRequireAuth, createRequirePermission, requirePasswordReady, type AuthDeps } from "../middleware/auth.js";

const reportQuerySchema = z.object({
  branchId: z.string().trim().max(64).default(""),
  departmentId: z.string().trim().max(64).default(""),
  employeeId: z.string().trim().max(64).default(""),
  date: z.union([z.literal(""), isoDateSchema]).optional(),
  from: z.union([z.literal(""), isoDateSchema]).optional(),
  to: z.union([z.literal(""), isoDateSchema]).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});

type ReportQuery = z.infer<typeof reportQuerySchema>;

const REPORT_TITLES: Record<string, string> = {
  "daily-absent": "تقرير الغياب اليومي",
  "monthly-absent": "تقرير الغياب الشهري",
  "most-absent": "الأكثر غياباً",
  lateness: "تقرير التأخير",
  workdays: "أيام العمل الفعلية",
  "employee-detail": "كشف حضور موظف",
  "branch-comparison": "مقارنة الفروع",
};

interface ReportColumn {
  key: string;
  label: string;
}

interface ReportPayload {
  type: string;
  title: string;
  subtitle: string;
  periodLabel: string;
  branchLabel: string;
  generatedAt: string;
  company: { name: string; printFooter: string; currency: string };
  columns: ReportColumn[];
  rows: Array<Record<string, string | number>>;
  summary: Array<{ label: string; value: string | number }>;
}

const STATUS_LABELS: Record<string, string> = {
  present: "حاضر",
  absent: "غائب",
  leave: "إجازة",
  permission: "إذن",
  mission: "مهمة",
  weekly_rest: "راحة أسبوعية",
  late: "تأخير",
  excused_absence: "غياب بعذر",
};

const MONTHLY_STATUS_LABELS: Record<string, string> = {
  draft: "مسودة",
  submitted: "مرسل",
  approved: "معتمد",
  rejected: "معاد",
};

function resolveRange(query: ReportQuery): { from: string; to: string; label: string } {
  if (query.date) return { from: query.date, to: query.date, label: query.date };
  if (query.from || query.to) {
    const from = query.from || query.to || today();
    const to = query.to || query.from || today();
    if (from > to) throw new ApiError(400, "INVALID_RANGE", "تاريخ البداية يجب ألا يسبق النهاية.");
    return { from, to, label: `${from} → ${to}` };
  }
  const now = new Date();
  const year = query.year ?? now.getFullYear();
  const month = query.month ?? now.getMonth() + 1;
  const range = monthRange(year, month);
  return { from: range.start, to: range.end, label: `${String(month).padStart(2, "0")}/${year}` };
}

async function branchLabelFor(db: Db, actor: AuthUser, input: ReportQuery): Promise<string> {
  if (input.branchId) {
    const result = await db.query<Row & { name: string }>("SELECT name FROM branches WHERE id = $1", [input.branchId]);
    return result.rows[0]?.name ?? "";
  }
  if (actor.allBranches) return "كل الفروع المتاحة";
  return actor.branches.map((branch) => branch.name).join("، ");
}

function departmentFilter(alias: string, params: unknown[], input: ReportQuery): string {
  if (!input.departmentId) return "";
  params.push(input.departmentId);
  return `${alias}.department_id = $${params.length}::uuid`;
}

function explicitBranchFilter(alias: string, params: unknown[], input: ReportQuery): string {
  if (!input.branchId) return "";
  params.push(input.branchId);
  return `${alias}.branch_id = $${params.length}::uuid`;
}

async function assertReportScope(deps: AuthDeps, actor: AuthUser, input: ReportQuery): Promise<void> {
  if (input.branchId && !canAccessBranch(actor, input.branchId)) throw forbidden("الفرع خارج نطاق صلاحيتك.");
  if (input.departmentId) {
    const department = await deps.db.query<Row & { id: string }>("SELECT id FROM departments WHERE id = $1", [input.departmentId]);
    if (!department.rows[0]) throw new ApiError(400, "INVALID_DEPARTMENT", "القسم غير موجود.");
  }
  if (input.employeeId) {
    const employee = await loadEmployee(deps.db, input.employeeId);
    if (!canAccessBranch(actor, employee.branch_id)) throw notFound("الموظف خارج نطاق صلاحيتك.");
  }
}

async function buildReport(deps: AuthDeps, actor: AuthUser, type: string, input: ReportQuery): Promise<ReportPayload> {
  const settings = await getSettings(deps.db);
  const range = resolveRange(input);
  const branchLabel = await branchLabelFor(deps.db, actor, input);
  const base = {
    type,
    title: REPORT_TITLES[type] ?? "تقرير",
    periodLabel: range.label,
    branchLabel,
    generatedAt: new Date().toISOString(),
    company: settings.company,
  };

  if (type === "daily-absent") {
    const params: unknown[] = [range.from];
    const scope = branchScopeSql(actor, "s", 2);
    params.push(...scope.params);
    const filters = [scope.sql, "s.work_date = $1::date", "s.status IN ('submitted','approved')", "da.status IN ('absent','excused_absence')"];
    const extraBranch = explicitBranchFilter("s", params, input);
    if (extraBranch) filters.push(extraBranch);
    const extraDepartment = departmentFilter("e", params, input);
    if (extraDepartment) filters.push(extraDepartment);
    const result = await deps.db.query<Row & { employee_no: string; employee_name: string; branch_name: string; department_name: string | null; status: string; reason: string; notes: string }>(
      `SELECT e.employee_no, e.full_name AS employee_name, b.name AS branch_name, d.name AS department_name, da.status, da.reason, da.notes
       FROM attendance_submissions s
       JOIN daily_attendance da ON da.submission_id = s.id
       JOIN employees e ON e.id = da.employee_id
       JOIN branches b ON b.id = s.branch_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE ${filters.join(" AND ")}
       ORDER BY b.name, e.full_name`,
      params,
    );
    return {
      ...base,
      subtitle: `الغياب المسجل في ${range.label}`,
      columns: [
        { key: "employeeNo", label: "الرقم الوظيفي" },
        { key: "employeeName", label: "الموظف" },
        { key: "branchName", label: "الفرع" },
        { key: "departmentName", label: "القسم" },
        { key: "status", label: "الحالة" },
        { key: "reason", label: "السبب" },
        { key: "notes", label: "ملاحظات" },
      ],
      rows: result.rows.map((row) => ({
        employeeNo: row.employee_no,
        employeeName: row.employee_name,
        branchName: row.branch_name,
        departmentName: row.department_name ?? "",
        status: STATUS_LABELS[row.status] ?? row.status,
        reason: row.reason,
        notes: row.notes,
      })),
      summary: [
        { label: "عدد حالات الغياب", value: result.rows.length },
        { label: "الفترة", value: range.label },
      ],
    };
  }

  if (type === "monthly-absent" || type === "most-absent") {
    const params: unknown[] = [range.from, range.to];
    const scope = branchScopeSql(actor, "s", 3);
    params.push(...scope.params);
    const filters = [scope.sql, "s.status IN ('submitted','approved')", "s.work_date BETWEEN $1::date AND $2::date"];
    const extraBranch = explicitBranchFilter("s", params, input);
    if (extraBranch) filters.push(extraBranch);
    const extraDepartment = departmentFilter("e", params, input);
    if (extraDepartment) filters.push(extraDepartment);
    const result = await deps.db.query<
      Row & { id: string; employee_no: string; employee_name: string; branch_name: string; department_name: string | null; absent_days: number; excused_days: number; leave_days: number }
    >(
      `SELECT e.id, e.employee_no, e.full_name AS employee_name, b.name AS branch_name, d.name AS department_name,
              count(*) FILTER (WHERE da.status = 'absent')::int AS absent_days,
              count(*) FILTER (WHERE da.status = 'excused_absence')::int AS excused_days,
              count(*) FILTER (WHERE da.status = 'leave')::int AS leave_days
       FROM attendance_submissions s
       JOIN daily_attendance da ON da.submission_id = s.id
       JOIN employees e ON e.id = da.employee_id
       JOIN branches b ON b.id = s.branch_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE ${filters.join(" AND ")}
       GROUP BY e.id, e.employee_no, e.full_name, b.name, d.name
       HAVING count(*) FILTER (WHERE da.status IN ('absent','excused_absence')) > 0
       ORDER BY absent_days DESC, excused_days DESC, e.full_name
       ${type === "most-absent" ? "LIMIT 100" : ""}`,
      params,
    );
    return {
      ...base,
      subtitle: type === "most-absent" ? "الموظفون الأكثر غياباً خلال الفترة (حتى 100 موظف)" : "ملخص الغياب حسب الموظف",
      columns: [
        { key: "employeeNo", label: "الرقم الوظيفي" },
        { key: "employeeName", label: "الموظف" },
        { key: "branchName", label: "الفرع" },
        { key: "departmentName", label: "القسم" },
        { key: "absentDays", label: "أيام الغياب" },
        { key: "excusedDays", label: "غياب بعذر" },
        { key: "leaveDays", label: "أيام الإجازة" },
      ],
      rows: result.rows.map((row) => ({
        employeeNo: row.employee_no,
        employeeName: row.employee_name,
        branchName: row.branch_name,
        departmentName: row.department_name ?? "",
        absentDays: row.absent_days,
        excusedDays: row.excused_days,
        leaveDays: row.leave_days,
      })),
      summary: [
        { label: "عدد الموظفين", value: result.rows.length },
        { label: "إجمالي أيام الغياب", value: result.rows.reduce((sum, row) => sum + row.absent_days, 0) },
        { label: "الفترة", value: range.label },
      ],
    };
  }

  if (type === "lateness") {
    const params: unknown[] = [range.from, range.to];
    const scope = branchScopeSql(actor, "s", 3);
    params.push(...scope.params);
    const filters = [scope.sql, "s.status IN ('submitted','approved')", "s.work_date BETWEEN $1::date AND $2::date", "(da.late_minutes > 0 OR da.status = 'late')"];
    const extraBranch = explicitBranchFilter("s", params, input);
    if (extraBranch) filters.push(extraBranch);
    const extraDepartment = departmentFilter("e", params, input);
    if (extraDepartment) filters.push(extraDepartment);
    const result = await deps.db.query<
      Row & { employee_no: string; employee_name: string; branch_name: string; department_name: string | null; work_date: string; check_in: string | null; check_out: string | null; late_minutes: number }
    >(
      `SELECT e.employee_no, e.full_name AS employee_name, b.name AS branch_name, d.name AS department_name,
              s.work_date::text AS work_date, da.check_in::text AS check_in, da.check_out::text AS check_out, da.late_minutes
       FROM attendance_submissions s
       JOIN daily_attendance da ON da.submission_id = s.id
       JOIN employees e ON e.id = da.employee_id
       JOIN branches b ON b.id = s.branch_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE ${filters.join(" AND ")}
       ORDER BY s.work_date DESC, da.late_minutes DESC, e.full_name
       LIMIT 2000`,
      params,
    );
    const totalMinutes = result.rows.reduce((sum, row) => sum + Number(row.late_minutes), 0);
    return {
      ...base,
      subtitle: "سجلات التأخير المسجلة في التحضير اليومي",
      columns: [
        { key: "workDate", label: "التاريخ" },
        { key: "employeeNo", label: "الرقم الوظيفي" },
        { key: "employeeName", label: "الموظف" },
        { key: "branchName", label: "الفرع" },
        { key: "departmentName", label: "القسم" },
        { key: "checkIn", label: "الحضور" },
        { key: "checkOut", label: "الانصراف" },
        { key: "lateMinutes", label: "دقائق التأخير" },
      ],
      rows: result.rows.map((row) => ({
        workDate: row.work_date,
        employeeNo: row.employee_no,
        employeeName: row.employee_name,
        branchName: row.branch_name,
        departmentName: row.department_name ?? "",
        checkIn: (row.check_in ?? "").slice(0, 5),
        checkOut: (row.check_out ?? "").slice(0, 5),
        lateMinutes: row.late_minutes,
      })),
      summary: [
        { label: "عدد حالات التأخير", value: result.rows.length },
        { label: "إجمالي دقائق التأخير", value: totalMinutes },
        { label: "الفترة", value: range.label },
      ],
    };
  }

  if (type === "workdays") {
    const params: unknown[] = [range.from, range.to];
    const scopeEmployees = branchScopeSql(actor, "e", 3);
    params.push(...scopeEmployees.params);
    const filters = [
      "e.hire_date <= $2::date",
      "COALESCE(e.termination_date, e.archived_at::date, '9999-12-31'::date) >= $1::date",
      scopeEmployees.sql,
    ];
    const extraBranch = explicitBranchFilter("e", params, input);
    if (extraBranch) filters.push(extraBranch);
    const extraDepartment = departmentFilter("e", params, input);
    if (extraDepartment) filters.push(extraDepartment);
    const result = await deps.db.query<
      Row & { employee_no: string; employee_name: string; branch_name: string; department_name: string | null; present_days: number; late_days: number; absent_days: number; leave_days: number; permission_days: number; mission_days: number }
    >(
      `SELECT e.employee_no, e.full_name AS employee_name, b.name AS branch_name, d.name AS department_name,
              COALESCE(att.present_days, 0)::int AS present_days, COALESCE(att.late_days, 0)::int AS late_days,
              COALESCE(att.absent_days, 0)::int AS absent_days, COALESCE(att.leave_days, 0)::int AS leave_days,
              COALESCE(att.permission_days, 0)::int AS permission_days, COALESCE(att.mission_days, 0)::int AS mission_days
       FROM employees e
       JOIN branches b ON b.id = e.branch_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE da.status = 'present') AS present_days,
                count(*) FILTER (WHERE da.status = 'late') AS late_days,
                count(*) FILTER (WHERE da.status = 'absent') AS absent_days,
                count(*) FILTER (WHERE da.status = 'leave') AS leave_days,
                count(*) FILTER (WHERE da.status = 'permission') AS permission_days,
                count(*) FILTER (WHERE da.status = 'mission') AS mission_days
         FROM attendance_submissions s JOIN daily_attendance da ON da.submission_id = s.id
         WHERE s.branch_id = e.branch_id AND da.employee_id = e.id AND s.status IN ('submitted','approved')
           AND s.work_date BETWEEN $1::date AND $2::date
       ) att ON true
       WHERE ${filters.join(" AND ")}
       ORDER BY b.name, e.full_name`,
      params,
    );
    return {
      ...base,
      subtitle: "أيام الحضور الفعلية والمشمولة في التحضير المعتمد أو المرسل",
      columns: [
        { key: "employeeNo", label: "الرقم الوظيفي" },
        { key: "employeeName", label: "الموظف" },
        { key: "branchName", label: "الفرع" },
        { key: "departmentName", label: "القسم" },
        { key: "presentDays", label: "أيام الحضور" },
        { key: "lateDays", label: "أيام التأخير" },
        { key: "missionDays", label: "أيام المهام" },
        { key: "leaveDays", label: "أيام الإجازة" },
        { key: "permissionDays", label: "أيام الأذونات" },
        { key: "absentDays", label: "أيام الغياب" },
      ],
      rows: result.rows.map((row) => ({
        employeeNo: row.employee_no,
        employeeName: row.employee_name,
        branchName: row.branch_name,
        departmentName: row.department_name ?? "",
        presentDays: row.present_days,
        lateDays: row.late_days,
        missionDays: row.mission_days,
        leaveDays: row.leave_days,
        permissionDays: row.permission_days,
        absentDays: row.absent_days,
      })),
      summary: [
        { label: "عدد الموظفين", value: result.rows.length },
        { label: "الفترة", value: range.label },
        { label: "الأيام المتوقعة (حسب إعداد نهاية الأسبوع)", value: countWorkdays(range.from, range.to, settings.attendance.weekendDays) },
      ],
    };
  }

  if (type === "employee-detail") {
    if (!input.employeeId) throw new ApiError(400, "EMPLOYEE_REQUIRED", "يجب اختيار موظف لعرض كشف الحضور.");
    const employee = await loadEmployee(deps.db, input.employeeId);
    if (!canAccessBranch(actor, employee.branch_id)) throw notFound("الموظف خارج نطاق صلاحيتك.");
    const params: unknown[] = [employee.id, range.from, range.to];
    let branchConstraint = "";
    if (!actor.allBranches) {
      params.push(actor.branches.map((branch) => branch.id));
      branchConstraint = `AND s.branch_id = ANY($${params.length}::uuid[])`;
    }
    const result = await deps.db.query<
      Row & { work_date: string; branch_name: string; status: string; check_in: string | null; check_out: string | null; late_minutes: number; work_hours: string | number; reason: string; notes: string; sheet_status: string }
    >(
      `SELECT s.work_date::text AS work_date, b.name AS branch_name, da.status, da.check_in::text AS check_in, da.check_out::text AS check_out,
              da.late_minutes, da.work_hours, da.reason, da.notes, s.status AS sheet_status
       FROM attendance_submissions s
       JOIN daily_attendance da ON da.submission_id = s.id
       JOIN branches b ON b.id = s.branch_id
       WHERE da.employee_id = $1 AND s.work_date BETWEEN $2::date AND $3::date AND s.status IN ('submitted','approved') ${branchConstraint}
       ORDER BY s.work_date ASC`,
      params,
    );
    const counts = result.rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      return acc;
    }, {});
    return {
      ...base,
      title: `كشف حضور — ${employee.full_name}`,
      subtitle: `${employee.employee_no} — ${employee.job_title || "بدون مسمى"} — ${employee.branch_name}`,
      branchLabel: employee.branch_name,
      columns: [
        { key: "workDate", label: "التاريخ" },
        { key: "branchName", label: "الفرع" },
        { key: "status", label: "الحالة" },
        { key: "checkIn", label: "الحضور" },
        { key: "checkOut", label: "الانصراف" },
        { key: "lateMinutes", label: "تأخير (د)" },
        { key: "workHours", label: "ساعات العمل" },
        { key: "reason", label: "السبب" },
        { key: "notes", label: "ملاحظات" },
      ],
      rows: result.rows.map((row) => ({
        workDate: row.work_date,
        branchName: row.branch_name,
        status: STATUS_LABELS[row.status] ?? row.status,
        checkIn: (row.check_in ?? "").slice(0, 5),
        checkOut: (row.check_out ?? "").slice(0, 5),
        lateMinutes: row.late_minutes,
        workHours: Number(row.work_hours),
        reason: row.reason,
        notes: row.notes,
      })),
      summary: [
        { label: "أيام الحضور", value: counts.present ?? 0 },
        { label: "أيام التأخير", value: counts.late ?? 0 },
        { label: "أيام الغياب", value: counts.absent ?? 0 },
        { label: "أيام الإجازة", value: counts.leave ?? 0 },
        { label: "الفترة", value: range.label },
      ],
    };
  }

  if (type === "branch-comparison") {
    const scoped = await deps.db.query<Row & { id: string; name: string; code: string; active: boolean }>(
      `SELECT id, name, code, active FROM branches ${input.branchId ? "WHERE id = $1" : ""} ORDER BY name`,
      input.branchId ? [input.branchId] : [],
    );
    const branches = scoped.rows.filter((branch) => canAccessBranch(actor, branch.id));
    if (branches.length === 0) {
      return {
        ...base,
        subtitle: "لا توجد فروع ضمن نطاق صلاحيتك",
        columns: [{ key: "branchName", label: "الفرع" }],
        rows: [],
        summary: [],
      };
    }
    const monthly = await deps.db.query<Row & { branch_id: string; status: string }>(
      `SELECT branch_id, status FROM monthly_attendance WHERE year = $1 AND month = $2 AND branch_id = ANY($3::uuid[])`,
      [Number(range.from.slice(0, 4)), Number(range.from.slice(5, 7)), branches.map((branch) => branch.id)],
    );
    const monthlyStatus = new Map(monthly.rows.map((row) => [row.branch_id, row.status]));
    const rows: Array<Record<string, string | number>> = [];
    for (const branch of branches) {
      const stats = await deps.db.query<
        Row & { employees: number; absent_days: number; late_days: number; leave_days: number; present_days: number; recorded_days: number; submitted_days: number }
      >(
        `SELECT
           (SELECT count(*)::int FROM employees e WHERE e.branch_id = $1 AND e.archived_at IS NULL AND e.status IN ('active','leave')) AS employees,
           COALESCE(sum(CASE WHEN da.status = 'absent' THEN 1 ELSE 0 END), 0)::int AS absent_days,
           COALESCE(sum(CASE WHEN da.status = 'late' THEN 1 ELSE 0 END), 0)::int AS late_days,
           COALESCE(sum(CASE WHEN da.status = 'leave' THEN 1 ELSE 0 END), 0)::int AS leave_days,
           COALESCE(sum(CASE WHEN da.status = 'present' THEN 1 ELSE 0 END), 0)::int AS present_days,
           count(da.id)::int AS recorded_days,
           count(DISTINCT s.work_date)::int AS submitted_days
         FROM attendance_submissions s
         LEFT JOIN daily_attendance da ON da.submission_id = s.id
         WHERE s.branch_id = $1 AND s.status IN ('submitted','approved') AND s.work_date BETWEEN $2::date AND $3::date`,
        [branch.id, range.from, range.to],
      );
      const stat = stats.rows[0];
      const expected = countWorkdays(range.from, range.to, settings.attendance.weekendDays);
      const coverage = expected > 0 ? Math.round(((stat?.submitted_days ?? 0) / expected) * 100) : 0;
      const status = monthlyStatus.get(branch.id);
      rows.push({
        branchName: branch.name,
        branchCode: branch.code,
        branchActive: branch.active ? "نشط" : "معطل",
        employees: stat?.employees ?? 0,
        submittedDays: stat?.submitted_days ?? 0,
        expectedDays: expected,
        coverage: `${Math.min(100, coverage)}%`,
        presentDays: stat?.present_days ?? 0,
        absentDays: stat?.absent_days ?? 0,
        lateDays: stat?.late_days ?? 0,
        leaveDays: stat?.leave_days ?? 0,
        monthlyStatus: status ? (MONTHLY_STATUS_LABELS[status] ?? status) : "لم يُرسل",
      });
    }
    return {
      ...base,
      subtitle: "مقارنة التغطية والحضور بين الفروع",
      columns: [
        { key: "branchName", label: "الفرع" },
        { key: "branchCode", label: "الكود" },
        { key: "branchActive", label: "الحالة" },
        { key: "employees", label: "الموظفون" },
        { key: "submittedDays", label: "أيام مرسلة" },
        { key: "expectedDays", label: "أيام متوقعة" },
        { key: "coverage", label: "التغطية" },
        { key: "presentDays", label: "حضور" },
        { key: "absentDays", label: "غياب" },
        { key: "lateDays", label: "تأخير" },
        { key: "leaveDays", label: "إجازة" },
        { key: "monthlyStatus", label: "التحضير الشهري" },
      ],
      rows,
      summary: [
        { label: "عدد الفروع", value: rows.length },
        { label: "الفترة", value: range.label },
      ],
    };
  }

  throw notFound("نوع التقرير غير معروف.");
}

function countWorkdays(from: string, to: string, weekendDays: number[]): number {
  let count = 0;
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let time = start.getTime(); time <= end.getTime(); time += 86_400_000) {
    const date = new Date(time).toISOString().slice(0, 10);
    if (!isWeekend(date, weekendDays)) count += 1;
  }
  return count;
}

export function createReportsRouter(deps: AuthDeps): Router {
  const { db, logger } = deps;
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);
  const requireView = createRequirePermission("reports.view", deps);
  const requireExport = createRequirePermission("reports.export", deps);

  router.get("/:type/export.xlsx", requireExport, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const type = String(req.params.type);
    if (!REPORT_TITLES[type]) throw notFound("نوع التقرير غير معروف.");
    const input = parseBody(reportQuerySchema, req.query);
    await assertReportScope(deps, req.auth.user, input);
    const report = await buildReport(deps, req.auth.user, type, input);
    const workbook = createWorkbook();
    addDataSheet(
      workbook,
      report.title.slice(0, 31),
      report.columns.map((column) => column.label),
      report.rows.map((row) => report.columns.map((column) => row[column.key] ?? "")),
      {
        title: `${report.company.name} — ${report.title}`,
        subtitle: `${report.branchLabel} — ${report.periodLabel} — تاريخ الطباعة: ${report.generatedAt.slice(0, 10)}`,
        landscape: report.columns.length > 7,
      },
    );
    await writeAudit(db, logger, {
      action: "report.exported",
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "report",
      entityId: type,
      branchId: input.branchId || null,
      severity: "info",
      details: { type, filters: input, rows: report.rows.length, format: "xlsx" },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    await sendWorkbook(res, workbook, `report-${type}`);
  });

  router.get("/:type", requireView, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const type = String(req.params.type);
    if (!REPORT_TITLES[type]) throw notFound("نوع التقرير غير معروف.");
    const input = parseBody(reportQuerySchema, req.query);
    await assertReportScope(deps, req.auth.user, input);
    const report = await buildReport(deps, req.auth.user, type, input);
    await writeAudit(db, logger, {
      action: "report.viewed",
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "report",
      entityId: type,
      branchId: input.branchId || null,
      severity: "info",
      details: { type, filters: input, rows: report.rows.length },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json(report);
  });

  return router;
}
