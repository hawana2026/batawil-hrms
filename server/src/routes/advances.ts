import { Router } from "express";
import { z } from "zod";
import type { Row } from "../db/index.js";
import { hasPermission } from "../auth/types.js";
import { writeAudit } from "../lib/audit.js";
import { ApiError, conflict, forbidden, notFound, parseBody, requestIp, requestUserAgent, unauthorized } from "../lib/errors.js";
import { advanceDeductionSchema, advanceSchema } from "../lib/hr-schemas.js";
import { newId } from "../lib/ids.js";
import { branchScopeSql, canAccessBranch } from "../services/access.js";
import { closeApproval, notifyPermissionHolders, notifyUser, openApproval } from "../services/approvals.js";
import { decideAdvance } from "../services/decisions.js";
import { loadEmployee, today } from "../services/employees.js";
import { createRequireAuth, createRequireAnyPermission, createRequirePermission, requirePasswordReady, type AuthDeps } from "../middleware/auth.js";

const listQuerySchema = z.object({
  status: z.enum(["all", "draft", "pending_hr", "pending_finance", "approved", "rejected", "disbursed"]).default("all"),
  employeeId: z.string().trim().max(64).default(""),
  branchId: z.string().trim().max(64).default(""),
  q: z.string().trim().max(100).default(""),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const disburseSchema = z.object({
  transactionDate: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional(),
  notes: z.string().trim().max(1000).default(""),
});

const updateSchema = advanceSchema.partial();

const rejectSchema = z.object({ reason: z.string().trim().min(3, "سبب الرفض مطلوب.").max(1000) });

interface AdvanceRow extends Row {
  id: string;
  employee_id: string;
  employee_no: string;
  employee_name: string;
  branch_id: string;
  branch_name: string;
  amount: string | number;
  reason: string;
  notes: string;
  request_date: string;
  installments: number;
  deduction_method: string;
  status: string;
  requested_by: string | null;
  requested_by_name: string | null;
  hr_approved_by_name: string | null;
  hr_approved_at: string | Date | null;
  finance_approved_by_name: string | null;
  finance_approved_at: string | Date | null;
  disbursed_by_name: string | null;
  disbursed_at: string | Date | null;
  decision_note: string | null;
  deducted: string | number;
  disbursed: string | number;
  attachments_count: number;
  created_at: string | Date;
}

function presentAdvance(row: AdvanceRow) {
  const amount = Number(row.amount);
  const deducted = Number(row.deducted);
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeNo: row.employee_no,
    employeeName: row.employee_name,
    branchId: row.branch_id,
    branchName: row.branch_name,
    amount,
    reason: row.reason,
    notes: row.notes,
    requestDate: row.request_date,
    installments: row.installments,
    deductionMethod: row.deduction_method,
    status: row.status,
    requestedBy: row.requested_by_name,
    hrApprovedBy: row.hr_approved_by_name,
    hrApprovedAt: row.hr_approved_at ? new Date(row.hr_approved_at).toISOString() : null,
    financeApprovedBy: row.finance_approved_by_name,
    financeApprovedAt: row.finance_approved_at ? new Date(row.finance_approved_at).toISOString() : null,
    disbursedBy: row.disbursed_by_name,
    disbursedAt: row.disbursed_at ? new Date(row.disbursed_at).toISOString() : null,
    decisionNote: row.decision_note,
    deducted,
    disbursedAmount: Number(row.disbursed),
    remaining: Math.max(0, Math.round((amount - deducted) * 100) / 100),
    attachmentsCount: row.attachments_count,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const ADVANCE_SELECT = `
  SELECT a.id, a.employee_id, e.employee_no, e.full_name AS employee_name, a.branch_id, b.name AS branch_name,
         a.amount, a.reason, a.notes, a.request_date::text AS request_date, a.installments, a.deduction_method, a.status,
         ru.full_name AS requested_by_name, hu.full_name AS hr_approved_by_name, a.hr_approved_at,
         fu.full_name AS finance_approved_by_name, a.finance_approved_at,
         du.full_name AS disbursed_by_name, a.disbursed_at, a.decision_note,
         COALESCE((SELECT sum(t.amount) FROM advance_transactions t WHERE t.advance_id = a.id AND t.type = 'deduction'), 0) AS deducted,
         COALESCE((SELECT sum(t.amount) FROM advance_transactions t WHERE t.advance_id = a.id AND t.type = 'disbursement'), 0) AS disbursed,
         (SELECT count(*)::int FROM attachments at WHERE at.owner_type = 'advance' AND at.owner_id = a.id) AS attachments_count,
         a.created_at
  FROM advance_requests a
  JOIN employees e ON e.id = a.employee_id
  JOIN branches b ON b.id = a.branch_id
  LEFT JOIN users ru ON ru.id = a.requested_by
  LEFT JOIN users hu ON hu.id = a.hr_approved_by
  LEFT JOIN users fu ON fu.id = a.finance_approved_by
  LEFT JOIN users du ON du.id = a.disbursed_by
`;

export function createAdvancesRouter(deps: AuthDeps): Router {
  const { db, logger } = deps;
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);

  const requireView = createRequirePermission("advances.view", deps);
  const requireManage = createRequirePermission("advances.manage", deps);
  const requireApproveAny = createRequireAnyPermission(["advances.approve_hr", "advances.approve_finance"], deps);
  const requireDisburse = createRequirePermission("advances.disburse", deps);

  router.get("/", requireView, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const query = parseBody(listQuerySchema, req.query);
    const scope = branchScopeSql(req.auth.user, "a", 1);
    const params: unknown[] = [...scope.params];
    const where: string[] = [scope.sql];
    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.status !== "all") where.push(`a.status = ${add(query.status)}`);
    if (query.employeeId) where.push(`a.employee_id = ${add(query.employeeId)}::uuid`);
    if (query.branchId) where.push(`a.branch_id = ${add(query.branchId)}::uuid`);
    if (query.q) {
      const p = add(`%${query.q}%`);
      where.push(`(e.full_name ILIKE ${p} OR e.employee_no ILIKE ${p})`);
    }
    const count = await db.query<Row & { total: number }>(
      `SELECT count(*)::int AS total FROM advance_requests a JOIN employees e ON e.id = a.employee_id WHERE ${where.join(" AND ")}`,
      params,
    );
    const limit = add(query.pageSize);
    const offset = add((query.page - 1) * query.pageSize);
    const result = await db.query<AdvanceRow>(
      `${ADVANCE_SELECT} WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    const totals = await db.query<Row & { amount: string | number; deducted: string | number; count: number }>(
      `SELECT COALESCE(sum(a.amount), 0) AS amount,
              COALESCE(sum((SELECT COALESCE(sum(t.amount),0) FROM advance_transactions t WHERE t.advance_id = a.id AND t.type='deduction')), 0) AS deducted,
              count(*)::int AS count
       FROM advance_requests a WHERE ${scope.sql} AND a.status IN ('approved','disbursed')`,
      scope.params,
    );
    res.json({
      items: result.rows.map(presentAdvance),
      total: count.rows[0]?.total ?? 0,
      page: query.page,
      pageSize: query.pageSize,
      totals: {
        approvedAmount: Number(totals.rows[0]?.amount ?? 0),
        deducted: Number(totals.rows[0]?.deducted ?? 0),
        outstanding: Math.max(0, Number(totals.rows[0]?.amount ?? 0) - Number(totals.rows[0]?.deducted ?? 0)),
        approvedCount: totals.rows[0]?.count ?? 0,
      },
      capabilities: {
        canManage: hasPermission(req.auth.user, "advances.manage"),
        canApproveHr: hasPermission(req.auth.user, "advances.approve_hr"),
        canApproveFinance: hasPermission(req.auth.user, "advances.approve_finance"),
        canDisburse: hasPermission(req.auth.user, "advances.disburse"),
      },
    });
  });

  router.post("/", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const input = parseBody(advanceSchema, req.body);
    const employee = await loadEmployee(db, input.employeeId);
    if (!canAccessBranch(actor, employee.branch_id)) throw notFound("الموظف غير موجود أو خارج نطاق صلاحيتك.");
    if (employee.archived_at) throw new ApiError(400, "EMPLOYEE_ARCHIVED", "الموظف مؤرشف ولا يمكن إنشاء سلفة له.");
    const installments = input.deductionMethod === "one_time" ? 1 : input.installments;
    const id = newId();
    await db.query(
      `INSERT INTO advance_requests
        (id, employee_id, branch_id, amount, reason, notes, request_date, installments, deduction_method, status, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,'draft',$10)`,
      [id, employee.id, employee.branch_id, input.amount, input.reason, input.notes, input.requestDate, installments, input.deductionMethod, actor.id],
    );
    await writeAudit(db, logger, {
      action: "advance.created",
      actor: { id: actor.id, username: actor.username },
      entityType: "advance",
      entityId: id,
      branchId: employee.branch_id,
      severity: "info",
      details: { employee: employee.full_name, amount: input.amount, installments, method: input.deductionMethod },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.status(201).json({ id });
  });

  router.patch("/:id", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const id = z.uuid("معرّف طلب غير صالح.").parse(req.params.id);
    const input = parseBody(updateSchema, req.body);
    const current = await db.query<Row & { status: string; branch_id: string }>("SELECT status, branch_id FROM advance_requests WHERE id = $1", [id]);
    const advance = current.rows[0];
    if (!advance) throw notFound("الطلب غير موجود.");
    if (!canAccessBranch(req.auth.user, advance.branch_id)) throw notFound("الطلب غير موجود أو خارج نطاق صلاحيتك.");
    if (advance.status !== "draft" && advance.status !== "rejected") throw conflict("لا يمكن تعديل طلب في هذه الحالة.");
    if (input.employeeId) {
      const employee = await loadEmployee(db, input.employeeId);
      if (employee.branch_id !== advance.branch_id) throw new ApiError(400, "INVALID_EMPLOYEE", "لا يمكن نقل الطلب إلى فرع آخر.");
    }
    const fields: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      params.push(value);
      fields.push(`${column} = $${params.length}`);
    };
    if (input.employeeId !== undefined) set("employee_id", input.employeeId);
    if (input.amount !== undefined) set("amount", input.amount);
    if (input.reason !== undefined) set("reason", input.reason);
    if (input.notes !== undefined) set("notes", input.notes);
    if (input.requestDate !== undefined) set("request_date", input.requestDate);
    if (input.deductionMethod !== undefined) set("deduction_method", input.deductionMethod);
    if (input.installments !== undefined) set("installments", input.deductionMethod === "one_time" ? 1 : input.installments);
    if (fields.length === 0) throw new ApiError(400, "NO_CHANGES", "لا توجد تغييرات لحفظها.");
    params.push(id);
    await db.query(`UPDATE advance_requests SET ${fields.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
    await writeAudit(db, logger, {
      action: "advance.updated",
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "advance",
      entityId: id,
      branchId: advance.branch_id,
      severity: "info",
      details: { changed: Object.keys(input) },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  });

  router.post("/:id/submit", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const id = z.uuid("معرّف طلب غير صالح.").parse(req.params.id);
    const result = await db.query<Row & { status: string; branch_id: string; employee_name: string; amount: string | number; installments: number }>(
      `SELECT a.status, a.branch_id, e.full_name AS employee_name, a.amount, a.installments
       FROM advance_requests a JOIN employees e ON e.id = a.employee_id WHERE a.id = $1`,
      [id],
    );
    const advance = result.rows[0];
    if (!advance) throw notFound("الطلب غير موجود.");
    if (!canAccessBranch(actor, advance.branch_id)) throw notFound("الطلب غير موجود أو خارج نطاق صلاحيتك.");
    if (advance.status !== "draft" && advance.status !== "rejected") throw conflict("لا يمكن إرسال طلب في هذه الحالة.");
    await db.query("UPDATE advance_requests SET status='pending_hr', updated_at=now() WHERE id=$1", [id]);
    await openApproval(db, {
      entityType: "advance",
      entityId: id,
      branchId: advance.branch_id,
      title: `سلفة مالية — ${advance.employee_name}`,
      summary: `المبلغ ${Number(advance.amount)} — ${advance.installments} قسط`,
      requestedBy: actor.id,
    });
    await notifyPermissionHolders(
      db,
      "advances.approve_hr",
      advance.branch_id,
      "طلب سلفة بانتظار اعتماد الموارد البشرية",
      `${actor.fullName} أرسل سلفة ${advance.employee_name} بمبلغ ${Number(advance.amount)}.`,
      "#/approvals",
    );
    await writeAudit(db, logger, {
      action: "advance.submitted",
      actor: { id: actor.id, username: actor.username },
      entityType: "advance",
      entityId: id,
      branchId: advance.branch_id,
      severity: "info",
      details: { employee: advance.employee_name, amount: Number(advance.amount) },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  });

  router.post("/:id/approve", requireApproveAny, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const id = z.uuid("معرّف طلب غير صالح.").parse(req.params.id);
    const scope = await db.query<Row & { branch_id: string }>("SELECT branch_id FROM advance_requests WHERE id = $1", [id]);
    if (!scope.rows[0] || !canAccessBranch(req.auth.user, scope.rows[0].branch_id)) throw notFound("الطلب غير موجود أو خارج نطاق صلاحيتك.");
    const outcome = await decideAdvance(db, req.auth.user, id, "approved", String((req.body as { reason?: string })?.reason ?? ""), {
      canHr: hasPermission(req.auth.user, "advances.approve_hr"),
      canFinance: hasPermission(req.auth.user, "advances.approve_finance"),
    });
    await writeAudit(db, logger, {
      action: outcome.action,
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "advance",
      entityId: id,
      branchId: outcome.branchId,
      severity: "info",
      details: outcome.details,
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true, stage: outcome.details.stage });
  });

  router.post("/:id/reject", requireApproveAny, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const id = z.uuid("معرّف طلب غير صالح.").parse(req.params.id);
    const input = parseBody(rejectSchema, req.body);
    const scope = await db.query<Row & { branch_id: string }>("SELECT branch_id FROM advance_requests WHERE id = $1", [id]);
    if (!scope.rows[0] || !canAccessBranch(req.auth.user, scope.rows[0].branch_id)) throw notFound("الطلب غير موجود أو خارج نطاق صلاحيتك.");
    const outcome = await decideAdvance(db, req.auth.user, id, "rejected", input.reason, {
      canHr: hasPermission(req.auth.user, "advances.approve_hr"),
      canFinance: hasPermission(req.auth.user, "advances.approve_finance"),
    });
    await writeAudit(db, logger, {
      action: outcome.action,
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "advance",
      entityId: id,
      branchId: outcome.branchId,
      severity: "warning",
      details: outcome.details,
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  });

  router.post("/:id/disburse", requireDisburse, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const id = z.uuid("معرّف طلب غير صالح.").parse(req.params.id);
    const input = parseBody(disburseSchema, req.body ?? {});
    const result = await db.query<AdvanceRow>("SELECT * FROM advance_requests WHERE id = $1", [id]);
    const advance = result.rows[0];
    if (!advance) throw notFound("السلفة غير موجودة.");
    if (!canAccessBranch(actor, advance.branch_id)) throw notFound("السلفة غير موجودة أو خارج نطاق صلاحيتك.");
    if (advance.status !== "approved") throw conflict("يمكن صرف السلفة بعد اكتمال الاعتمادات فقط.");
    const transactionDate = input.transactionDate || today();
    await db.transaction(async (tx) => {
      const locked = await tx.query<Row & { status: string }>("SELECT status FROM advance_requests WHERE id = $1 FOR UPDATE", [id]);
      if (locked.rows[0]?.status !== "approved") throw conflict("تمت معالجة الصرف مسبقاً.");
      await tx.query(
        `INSERT INTO advance_transactions (id, advance_id, type, amount, transaction_date, notes, created_by)
         VALUES ($1,$2,'disbursement',$3,$4::date,$5,$6)`,
        [newId(), id, Number(advance.amount), transactionDate, input.notes, actor.id],
      );
      await tx.query(
        "UPDATE advance_requests SET status='disbursed', disbursed_by=$2, disbursed_at=now(), updated_at=now() WHERE id=$1",
        [id, actor.id],
      );
    });
    await notifyUser(
      db,
      advance.requested_by,
      "صرف سلفة مالية",
      `تم صرف سلفة ${Number(advance.amount)} بتاريخ ${transactionDate}.`,
      "#/advances",
    );
    await writeAudit(db, logger, {
      action: "advance.disbursed",
      actor: { id: actor.id, username: actor.username },
      entityType: "advance",
      entityId: id,
      branchId: advance.branch_id,
      severity: "warning",
      details: { amount: Number(advance.amount), transactionDate, notes: input.notes },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  });

  router.post("/:id/deductions", requireDisburse, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const id = z.uuid("معرّف طلب غير صالح.").parse(req.params.id);
    const input = parseBody(advanceDeductionSchema, req.body);
    const result = await db.query<Row & { status: string; branch_id: string; amount: string | number; deducted: string | number; employee_name: string }>(
      `SELECT a.status, a.branch_id, a.amount, e.full_name AS employee_name,
              COALESCE((SELECT sum(t.amount) FROM advance_transactions t WHERE t.advance_id = a.id AND t.type='deduction'), 0) AS deducted
       FROM advance_requests a JOIN employees e ON e.id = a.employee_id WHERE a.id = $1`,
      [id],
    );
    const advance = result.rows[0];
    if (!advance) throw notFound("السلفة غير موجودة.");
    if (!canAccessBranch(actor, advance.branch_id)) throw notFound("السلفة غير موجودة أو خارج نطاق صلاحيتك.");
    if (advance.status !== "disbursed") throw conflict("لا يمكن تسجيل استقطاع قبل صرف السلفة فعلياً.");
    const remaining = Number(advance.amount) - Number(advance.deducted);
    if (input.amount > remaining + 0.001) {
      throw new ApiError(400, "EXCEEDS_REMAINING", `مبلغ الاستقطاع يتجاوز المتبقي (${Math.max(0, remaining)}).`);
    }
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO advance_transactions (id, advance_id, type, amount, transaction_date, notes, created_by)
         VALUES ($1,$2,'deduction',$3,$4::date,$5,$6)`,
        [newId(), id, input.amount, input.transactionDate, input.notes, actor.id],
      );
    });
    await writeAudit(db, logger, {
      action: "advance.deduction_recorded",
      actor: { id: actor.id, username: actor.username },
      entityType: "advance",
      entityId: id,
      branchId: advance.branch_id,
      severity: "warning",
      details: { employee: advance.employee_name, amount: input.amount, transactionDate: input.transactionDate, remaining: Math.round((remaining - input.amount) * 100) / 100 },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true, remaining: Math.max(0, Math.round((remaining - input.amount) * 100) / 100) });
  });

  router.get("/:id/movements", requireView, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const id = z.uuid("معرّف طلب غير صالح.").parse(req.params.id);
    const result = await db.query<AdvanceRow>(`${ADVANCE_SELECT} WHERE a.id = $1`, [id]);
    const advance = result.rows[0];
    if (!advance || !canAccessBranch(req.auth.user, advance.branch_id)) throw notFound("السلفة غير موجودة أو خارج نطاق صلاحيتك.");
    const movements = await db.query<Row & { id: string; type: string; amount: string | number; transaction_date: string; notes: string; created_by_name: string | null; created_at: string | Date }>(
      `SELECT t.id, t.type, t.amount, t.transaction_date::text AS transaction_date, t.notes, u.full_name AS created_by_name, t.created_at
       FROM advance_transactions t LEFT JOIN users u ON u.id = t.created_by
       WHERE t.advance_id = $1 ORDER BY t.transaction_date ASC, t.created_at ASC`,
      [id],
    );
    res.json({
      advance: presentAdvance(advance),
      movements: movements.rows.map((row) => ({
        id: row.id,
        type: row.type,
        amount: Number(row.amount),
        transactionDate: row.transaction_date,
        notes: row.notes,
        createdBy: row.created_by_name,
        createdAt: new Date(row.created_at).toISOString(),
      })),
    });
  });

  return router;
}
