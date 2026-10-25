import { Router } from "express";
import { z } from "zod";
import type { Row } from "../db/index.js";
import { hasPermission } from "../auth/types.js";
import { writeAudit } from "../lib/audit.js";
import { ApiError, conflict, forbidden, notFound, parseBody, requestIp, requestUserAgent, unauthorized } from "../lib/errors.js";
import { payrollGenerateSchema, payrollUpdateSchema } from "../lib/hr-schemas.js";
import { branchScopeSql, canAccessBranch } from "../services/access.js";
import { newId } from "../lib/ids.js";
import { monthRange } from "../services/settings.js";
import { createRequireAuth, createRequirePermission, requirePasswordReady, type AuthDeps } from "../middleware/auth.js";

const roundMoney = (value: number): number => Math.round(value * 100) / 100;

const listQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  branchId: z.string().trim().max(64).default(""),
  reviewStatus: z.enum(["all", "draft", "reviewed", "approved"]).default("all"),
  q: z.string().trim().max(100).default(""),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

interface PayrollRow extends Row {
  id: string;
  employee_id: string;
  employee_no: string;
  employee_name: string;
  job_title: string;
  branch_id: string;
  branch_name: string;
  department_name: string | null;
  year: number;
  month: number;
  base_salary: string | number;
  allowances: string | number;
  deductions: string | number;
  advance_deduction: string | number;
  advance_outstanding: string | number;
  present_days: number;
  absent_days: number;
  leave_days: number;
  late_count: number;
  notes: string;
  review_status: string;
  generated_by_name: string | null;
  generated_at: string | Date;
  updated_at: string | Date;
}

function presentRecord(row: PayrollRow) {
  const base = Number(row.base_salary);
  const allowances = Number(row.allowances);
  const deductions = Number(row.deductions);
  const advanceDeduction = Number(row.advance_deduction);
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeNo: row.employee_no,
    employeeName: row.employee_name,
    jobTitle: row.job_title,
    branchId: row.branch_id,
    branchName: row.branch_name,
    departmentName: row.department_name,
    year: row.year,
    month: row.month,
    baseSalary: base,
    allowances,
    deductions,
    advanceDeduction,
    advanceOutstanding: Number(row.advance_outstanding),
    net: Math.round((base + allowances - deductions - advanceDeduction) * 100) / 100,
    presentDays: row.present_days,
    absentDays: row.absent_days,
    leaveDays: row.leave_days,
    lateCount: row.late_count,
    notes: row.notes,
    reviewStatus: row.review_status,
    generatedBy: row.generated_by_name,
    generatedAt: new Date(row.generated_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function createPayrollRouter(deps: AuthDeps): Router {
  const { db, logger } = deps;
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);

  const requireView = createRequirePermission("payroll.view", deps);
  const requireManage = createRequirePermission("payroll.manage", deps);

  router.get("/", requireView, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const query = parseBody(listQuerySchema, req.query);
    const scope = branchScopeSql(req.auth.user, "p", 1);
    const params: unknown[] = [...scope.params];
    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [scope.sql, `p.year = ${add(query.year)}`, `p.month = ${add(query.month)}`];
    if (query.branchId) where.push(`p.branch_id = ${add(query.branchId)}::uuid`);
    if (query.reviewStatus !== "all") where.push(`p.review_status = ${add(query.reviewStatus)}`);
    if (query.q) {
      const p = add(`%${query.q}%`);
      where.push(`(e.full_name ILIKE ${p} OR e.employee_no ILIKE ${p})`);
    }
    const count = await db.query<Row & { total: number }>(
      `SELECT count(*)::int AS total FROM payroll_records p JOIN employees e ON e.id = p.employee_id WHERE ${where.join(" AND ")}`,
      params,
    );
    const totals = await db.query<Row & { base: string | number; allowances: string | number; deductions: string | number; advance: string | number; outstanding: string | number }>(
      `SELECT COALESCE(sum(p.base_salary),0) AS base, COALESCE(sum(p.allowances),0) AS allowances,
              COALESCE(sum(p.deductions),0) AS deductions, COALESCE(sum(p.advance_deduction),0) AS advance,
              COALESCE(sum(p.advance_outstanding),0) AS outstanding
       FROM payroll_records p JOIN employees e ON e.id = p.employee_id WHERE ${where.join(" AND ")}`,
      params,
    );
    const limit = add(query.pageSize);
    const offset = add((query.page - 1) * query.pageSize);
    const rows = await db.query<PayrollRow>(
      `SELECT p.id, p.employee_id, e.employee_no, e.full_name AS employee_name, e.job_title,
              p.branch_id, b.name AS branch_name, d.name AS department_name,
              p.year, p.month, p.base_salary, p.allowances, p.deductions, p.advance_deduction, p.advance_outstanding,
              p.present_days, p.absent_days, p.leave_days, p.late_count, p.notes, p.review_status,
              gu.full_name AS generated_by_name, p.generated_at, p.updated_at
       FROM payroll_records p
       JOIN employees e ON e.id = p.employee_id
       JOIN branches b ON b.id = p.branch_id
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN users gu ON gu.id = p.generated_by
       WHERE ${where.join(" AND ")}
       ORDER BY e.full_name ASC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    res.json({
      items: rows.rows.map(presentRecord),
      total: count.rows[0]?.total ?? 0,
      page: query.page,
      pageSize: query.pageSize,
      year: query.year,
      month: query.month,
      totals: {
        base: Number(totals.rows[0]?.base ?? 0),
        allowances: Number(totals.rows[0]?.allowances ?? 0),
        deductions: Number(totals.rows[0]?.deductions ?? 0),
        advanceDeduction: Number(totals.rows[0]?.advance ?? 0),
        advanceOutstanding: Number(totals.rows[0]?.outstanding ?? 0),
        net: Math.round(
          (Number(totals.rows[0]?.base ?? 0) + Number(totals.rows[0]?.allowances ?? 0) - Number(totals.rows[0]?.deductions ?? 0) - Number(totals.rows[0]?.advance ?? 0)) * 100,
        ) / 100,
      },
      capabilities: {
        canManage: hasPermission(req.auth.user, "payroll.manage"),
        canViewAdvances: hasPermission(req.auth.user, "advances.view"),
      },
    });
  });

  router.post("/generate", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const input = parseBody(payrollGenerateSchema, req.body);
    if (input.branchId && !canAccessBranch(actor, input.branchId)) throw forbidden("الفرع خارج نطاق صلاحيتك.");
    const range = monthRange(input.year, input.month);
    const params: unknown[] = [range.start, range.end];
    const scope = branchScopeSql(actor, "e", 3);
    params.push(...scope.params);
    let branchFilter = "";
    if (input.branchId) {
      params.push(input.branchId);
      branchFilter = `AND e.branch_id = $${params.length}::uuid`;
    }
    const employees = await db.query<
      Row & {
        id: string;
        branch_id: string;
        base_salary: string | number;
        present_days: number;
        absent_days: number;
        leave_days: number;
        late_count: number;
        advance_outstanding: string | number;
      }
    >(
      `SELECT e.id, e.branch_id, e.base_salary,
              COALESCE(att.present_days, 0)::int AS present_days,
              COALESCE(att.absent_days, 0)::int AS absent_days,
              COALESCE(att.leave_days, 0)::int AS leave_days,
              COALESCE(att.late_count, 0)::int AS late_count,
              COALESCE(adv.outstanding, 0) AS advance_outstanding
       FROM employees e
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE d.status IN ('present','late','mission')) AS present_days,
                count(*) FILTER (WHERE d.status = 'absent') AS absent_days,
                count(*) FILTER (WHERE d.status IN ('leave','permission')) AS leave_days,
                count(*) FILTER (WHERE d.status = 'late') AS late_count
         FROM attendance_submissions s
         JOIN daily_attendance d ON d.submission_id = s.id
         WHERE s.branch_id = e.branch_id AND d.employee_id = e.id
           AND s.work_date BETWEEN $1::date AND $2::date AND s.status IN ('submitted','approved')
       ) att ON true
       LEFT JOIN LATERAL (
         SELECT sum(a.amount - COALESCE((SELECT sum(t.amount) FROM advance_transactions t WHERE t.advance_id = a.id AND t.type='deduction'),0)) AS outstanding
         FROM advance_requests a
         WHERE a.employee_id = e.id AND a.status IN ('approved','disbursed')
       ) adv ON true
       WHERE e.hire_date <= $2::date
         AND COALESCE(e.termination_date, e.archived_at::date, '9999-12-31'::date) >= $1::date
         AND ${scope.sql} ${branchFilter}
       ORDER BY e.full_name`,
      params,
    );
    if (employees.rows.length === 0) throw new ApiError(400, "NO_EMPLOYEES", "لا يوجد موظفون مؤهلون للفترة المحددة.");

    let created = 0;
    let updated = 0;
    await db.transaction(async (tx) => {
      for (const employee of employees.rows) {
        const refresh = await tx.query(
          `UPDATE payroll_records
           SET base_salary=$4, advance_outstanding=$5, present_days=$6, absent_days=$7, leave_days=$8, late_count=$9, updated_at=now()
           WHERE employee_id=$1 AND year=$2 AND month=$3 AND review_status <> 'approved'`,
          [
            employee.id,
            input.year,
            input.month,
            Number(employee.base_salary),
            Number(employee.advance_outstanding),
            employee.present_days,
            employee.absent_days,
            employee.leave_days,
            employee.late_count,
          ],
        );
        if (refresh.rowCount > 0) {
          updated += refresh.rowCount;
          continue;
        }
        const result = await tx.query(
          `INSERT INTO payroll_records
            (id, employee_id, branch_id, year, month, base_salary, allowances, deductions, advance_deduction, advance_outstanding,
             present_days, absent_days, leave_days, late_count, notes, review_status, generated_by)
           VALUES ($1,$2,$3,$4,$5,$6,0,0,0,$7,$8,$9,$10,$11,'','draft',$12)
           ON CONFLICT (employee_id, year, month) DO NOTHING`,
          [
            newId(),
            employee.id,
            employee.branch_id,
            input.year,
            input.month,
            Number(employee.base_salary),
            Number(employee.advance_outstanding),
            employee.present_days,
            employee.absent_days,
            employee.leave_days,
            employee.late_count,
            actor.id,
          ],
        );
        created += result.rowCount;
      }
    });
    const skipped = employees.rows.length - created - updated;
    await writeAudit(db, logger, {
      action: "payroll.generated",
      actor: { id: actor.id, username: actor.username },
      entityType: "payroll",
      branchId: input.branchId,
      severity: "info",
      details: { year: input.year, month: input.month, candidates: employees.rows.length, created, updated, skipped },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true, created, updated, skipped });
  });

  router.patch("/:id", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const id = z.uuid("معرّف سجل غير صالح.").parse(req.params.id);
    const input = parseBody(payrollUpdateSchema, req.body);
    const current = await db.query<PayrollRow & { advance_outstanding: string | number; notes: string; review_status: string }>(
      "SELECT * FROM payroll_records WHERE id = $1",
      [id],
    );
    const record = current.rows[0];
    if (!record) throw notFound("سجل الراتب غير موجود.");
    if (!canAccessBranch(actor, record.branch_id)) throw notFound("السجل غير موجود أو خارج نطاق صلاحيتك.");
    if (record.review_status === "approved") {
      throw conflict("سجل الراتب معتمد ومقفل؛ لا يمكن تعديل بياناته بعد الاعتماد.");
    }
    if (input.advanceDeduction !== undefined && input.advanceDeduction > Number(record.advance_outstanding) + 0.001) {
      throw new ApiError(400, "EXCEEDS_OUTSTANDING", "الاستقطاع يتجاوز رصيد السلفة المتبقي المسجل.");
    }
    const fields: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      params.push(value);
      fields.push(`${column} = $${params.length}`);
    };
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (input.allowances !== undefined && input.allowances !== Number(record.allowances)) {
      changes.allowances = { from: Number(record.allowances), to: input.allowances };
      set("allowances", input.allowances);
    }
    if (input.deductions !== undefined && input.deductions !== Number(record.deductions)) {
      changes.deductions = { from: Number(record.deductions), to: input.deductions };
      set("deductions", input.deductions);
    }
    if (input.advanceDeduction !== undefined && input.advanceDeduction !== Number(record.advance_deduction)) {
      changes.advanceDeduction = { from: Number(record.advance_deduction), to: input.advanceDeduction };
      set("advance_deduction", input.advanceDeduction);
    }
    if (input.notes !== undefined && input.notes !== record.notes) {
      changes.notes = { from: record.notes, to: input.notes };
      set("notes", input.notes);
    }
    if (input.reviewStatus !== undefined && input.reviewStatus !== record.review_status) {
      changes.reviewStatus = { from: record.review_status, to: input.reviewStatus };
      set("review_status", input.reviewStatus);
    }
    if (fields.length === 0) throw conflict("لا توجد تغييرات لحفظها.");
    const approving = input.reviewStatus === "approved" && record.review_status !== "approved";
    const deduction = roundMoney(input.advanceDeduction ?? Number(record.advance_deduction));
    let advancePosted = 0;
    params.push(id, actor.id);
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE payroll_records SET ${fields.join(", ")}, updated_by = $${params.length}, updated_at = now() WHERE id = $${params.length - 1}`,
        params,
      );
      if (!approving || deduction <= 0) return;
      const advances = await tx.query<Row & { id: string; amount: string | number; deducted: string | number }>(
        `SELECT a.id, a.amount,
                COALESCE((SELECT sum(t.amount) FROM advance_transactions t WHERE t.advance_id = a.id AND t.type = 'deduction'), 0) AS deducted
         FROM advance_requests a
         WHERE a.employee_id = $1 AND a.status = 'disbursed'
         ORDER BY a.created_at, a.id
         FOR UPDATE`,
        [record.employee_id],
      );
      const outstanding = advances.rows.reduce(
        (total, advance) => total + Math.max(0, roundMoney(Number(advance.amount) - Number(advance.deducted))),
        0,
      );
      if (deduction > outstanding + 0.001) {
        throw new ApiError(400, "EXCEEDS_OUTSTANDING", `خصم السلف يتجاوز إجمالي المتبقي من السلف المصروفة (${roundMoney(outstanding)}).`);
      }
      let remaining = deduction;
      for (const advance of advances.rows) {
        if (remaining <= 0.001) break;
        const available = Math.max(0, roundMoney(Number(advance.amount) - Number(advance.deducted)));
        if (available <= 0) continue;
        const take = roundMoney(Math.min(available, remaining));
        await tx.query(
          `INSERT INTO advance_transactions (id, advance_id, type, amount, transaction_date, notes, created_by, payroll_record_id)
           VALUES ($1,$2,'deduction',$3,CURRENT_DATE,$4,$5,$6)`,
          [newId(), advance.id, take, `استقطاع من راتب ${record.month}/${record.year}`, actor.id, id],
        );
        advancePosted = roundMoney(advancePosted + take);
        remaining = roundMoney(remaining - take);
      }
      if (remaining > 0.001) {
        throw new ApiError(400, "EXCEEDS_OUTSTANDING", "تعذر استقطاع كامل المبلغ من السلف المصروفة.");
      }
      await tx.query("UPDATE payroll_records SET advance_outstanding = $2, updated_at = now() WHERE id = $1", [
        id,
        roundMoney(outstanding - deduction),
      ]);
    });
    await writeAudit(db, logger, {
      action: "payroll.updated",
      actor: { id: actor.id, username: actor.username },
      entityType: "payroll",
      entityId: id,
      branchId: record.branch_id,
      severity: input.reviewStatus === "approved" ? "warning" : "info",
      details: { changes, ...(advancePosted > 0 ? { advancePosted } : {}) },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true, advancePosted });
  });

  return router;
}
