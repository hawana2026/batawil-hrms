import { Router } from "express";
import { z } from "zod";
import type { Row } from "../db/index.js";
import { writeAudit } from "../lib/audit.js";
import { ApiError, conflict, forbidden, notFound, parseBody, requestIp, requestUserAgent, unauthorized } from "../lib/errors.js";
import { newHireSchema } from "../lib/hr-schemas.js";
import { newId } from "../lib/ids.js";
import { branchScopeSql, canAccessBranch } from "../services/access.js";
import { cancelApproval, notifyPermissionHolders, openApproval } from "../services/approvals.js";
import { decideNewHire } from "../services/decisions.js";
import { assertBranchUsable, assertDepartmentUsable } from "../services/employees.js";
import { createRequireAuth, createRequirePermission, requirePasswordReady, type AuthDeps } from "../middleware/auth.js";

const listQuerySchema = z.object({
  status: z.enum(["all", "draft", "pending", "approved", "rejected", "completed"]).default("all"),
  branchId: z.string().trim().max(64).default(""),
  q: z.string().trim().max(100).default(""),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const updateSchema = newHireSchema.partial();

interface RequestRow extends Row {
  id: string;
  full_name: string;
  phone: string;
  branch_id: string;
  branch_name: string;
  department_id: string | null;
  department_name: string | null;
  job_title: string;
  proposed_salary: string | number;
  start_date: string;
  notes: string;
  status: string;
  requested_by_name: string | null;
  approved_by_name: string | null;
  approved_at: string | Date | null;
  decision_note: string | null;
  employee_id: string | null;
  employee_no: string | null;
  attachments_count: number;
  created_at: string | Date;
}

function presentRequest(row: RequestRow) {
  return {
    id: row.id,
    fullName: row.full_name,
    phone: row.phone,
    branchId: row.branch_id,
    branchName: row.branch_name,
    departmentId: row.department_id,
    departmentName: row.department_name,
    jobTitle: row.job_title,
    proposedSalary: Number(row.proposed_salary),
    startDate: row.start_date,
    notes: row.notes,
    status: row.status,
    requestedBy: row.requested_by_name,
    approvedBy: row.approved_by_name,
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
    decisionNote: row.decision_note,
    employeeId: row.employee_id,
    employeeNo: row.employee_no,
    attachmentsCount: row.attachments_count,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export function createNewHiresRouter(deps: AuthDeps): Router {
  const { db, logger } = deps;
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);

  const requireView = createRequirePermission("new_hires.view", deps);
  const requireManage = createRequirePermission("new_hires.manage", deps);
  const requireApprove = createRequirePermission("new_hires.approve", deps);

  router.get("/", requireView, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const query = parseBody(listQuerySchema, req.query);
    const scope = branchScopeSql(req.auth.user, "n", 1);
    const params: unknown[] = [...scope.params];
    const where: string[] = [scope.sql];
    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.status !== "all") where.push(`n.status = ${add(query.status)}`);
    if (query.branchId) where.push(`n.branch_id = ${add(query.branchId)}::uuid`);
    if (query.q) {
      const p = add(`%${query.q}%`);
      where.push(`(n.full_name ILIKE ${p} OR n.phone ILIKE ${p} OR n.job_title ILIKE ${p})`);
    }
    const count = await db.query<Row & { total: number }>(
      `SELECT count(*)::int AS total FROM new_employee_requests n WHERE ${where.join(" AND ")}`,
      params,
    );
    const limit = add(query.pageSize);
    const offset = add((query.page - 1) * query.pageSize);
    const result = await db.query<RequestRow>(
      `SELECT n.id, n.full_name, n.phone, n.branch_id, b.name AS branch_name, n.department_id, d.name AS department_name,
              n.job_title, n.proposed_salary, n.start_date::text AS start_date, n.notes, n.status,
              ru.full_name AS requested_by_name, au.full_name AS approved_by_name, n.approved_at, n.decision_note,
              n.employee_id, e.employee_no,
              (SELECT count(*)::int FROM attachments a WHERE a.owner_type = 'new_hire' AND a.owner_id = n.id) AS attachments_count,
              n.created_at
       FROM new_employee_requests n
       JOIN branches b ON b.id = n.branch_id
       LEFT JOIN departments d ON d.id = n.department_id
       LEFT JOIN users ru ON ru.id = n.requested_by
       LEFT JOIN users au ON au.id = n.approved_by
       LEFT JOIN employees e ON e.id = n.employee_id
       WHERE ${where.join(" AND ")}
       ORDER BY n.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    res.json({
      items: result.rows.map(presentRequest),
      total: count.rows[0]?.total ?? 0,
      page: query.page,
      pageSize: query.pageSize,
      capabilities: {
        canManage: req.auth.user.role.allPermissions || req.auth.user.permissions.includes("new_hires.manage"),
        canApprove: req.auth.user.role.allPermissions || req.auth.user.permissions.includes("new_hires.approve"),
      },
    });
  });

  router.post("/", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const input = parseBody(newHireSchema, req.body);
    await assertBranchUsable(db, actor, input.branchId);
    await assertDepartmentUsable(db, input.departmentId ?? null);
    const id = newId();
    await db.query(
      `INSERT INTO new_employee_requests
        (id, full_name, phone, branch_id, department_id, job_title, proposed_salary, start_date, notes, requested_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,'draft')`,
      [id, input.fullName, input.phone, input.branchId, input.departmentId ?? null, input.jobTitle, input.proposedSalary, input.startDate, input.notes, actor.id],
    );
    await writeAudit(db, logger, {
      action: "new_hire.created",
      actor: { id: actor.id, username: actor.username },
      entityType: "new_hire",
      entityId: id,
      branchId: input.branchId,
      severity: "info",
      details: { fullName: input.fullName, jobTitle: input.jobTitle, startDate: input.startDate },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.status(201).json({ id });
  });

  router.patch("/:id", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const id = z.uuid("معرّف طلب غير صالح.").parse(req.params.id);
    const input = parseBody(updateSchema, req.body);
    const current = await db.query<Row & { status: string; branch_id: string }>(
      "SELECT status, branch_id FROM new_employee_requests WHERE id = $1",
      [id],
    );
    const request = current.rows[0];
    if (!request) throw notFound("الطلب غير موجود.");
    if (!canAccessBranch(req.auth.user, request.branch_id)) throw notFound("الطلب غير موجود أو خارج نطاق صلاحيتك.");
    if (request.status !== "draft" && request.status !== "rejected") throw conflict("لا يمكن تعديل طلب في هذه الحالة.");
    if (input.branchId && input.branchId !== request.branch_id) throw forbidden("لا يمكن تغيير فرع الطلب بعد إنشائه.");
    await assertDepartmentUsable(db, input.departmentId ?? null);
    const fields: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown) => {
      params.push(value);
      fields.push(`${column} = $${params.length}`);
    };
    if (input.fullName !== undefined) set("full_name", input.fullName);
    if (input.phone !== undefined) set("phone", input.phone);
    if (input.departmentId !== undefined) set("department_id", input.departmentId ?? null);
    if (input.jobTitle !== undefined) set("job_title", input.jobTitle);
    if (input.proposedSalary !== undefined) set("proposed_salary", input.proposedSalary);
    if (input.startDate !== undefined) set("start_date", input.startDate);
    if (input.notes !== undefined) set("notes", input.notes);
    if (fields.length === 0) throw new ApiError(400, "NO_CHANGES", "لا توجد تغييرات لحفظها.");
    params.push(id);
    await db.query(`UPDATE new_employee_requests SET ${fields.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
    await writeAudit(db, logger, {
      action: "new_hire.updated",
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "new_hire",
      entityId: id,
      branchId: request.branch_id,
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
    const result = await db.query<Row & { status: string; branch_id: string; branch_name: string; full_name: string; phone: string; job_title: string; start_date: string }>(
      `SELECT n.status, n.branch_id, b.name AS branch_name, n.full_name, n.phone, n.job_title, n.start_date::text AS start_date
       FROM new_employee_requests n JOIN branches b ON b.id = n.branch_id WHERE n.id = $1`,
      [id],
    );
    const request = result.rows[0];
    if (!request) throw notFound("الطلب غير موجود.");
    if (!canAccessBranch(actor, request.branch_id)) throw notFound("الطلب غير موجود أو خارج نطاق صلاحيتك.");
    if (request.status !== "draft" && request.status !== "rejected") throw conflict("لا يمكن إرسال طلب في هذه الحالة.");
    const duplicate = await db.query<Row & { id: string }>(
      "SELECT id FROM employees WHERE phone = $1 AND lower(full_name) = lower($2) AND archived_at IS NULL LIMIT 1",
      [request.phone, request.full_name],
    );
    if (duplicate.rows[0]) throw conflict("يوجد موظف مسجل بنفس الاسم ورقم الهاتف.");
    await db.query("UPDATE new_employee_requests SET status='pending', updated_at=now() WHERE id=$1", [id]);
    await openApproval(db, {
      entityType: "new_hire",
      entityId: id,
      branchId: request.branch_id,
      title: `موظف جديد — ${request.full_name}`,
      summary: `${request.job_title || "بدون مسمى"} — ${request.branch_name} — بدء ${request.start_date}`,
      requestedBy: actor.id,
    });
    await notifyPermissionHolders(
      db,
      "new_hires.approve",
      request.branch_id,
      "طلب تعيين بانتظار الاعتماد",
      `${actor.fullName} أرسل طلب تعيين ${request.full_name} في ${request.branch_name}.`,
      "#/approvals",
    );
    await writeAudit(db, logger, {
      action: "new_hire.submitted",
      actor: { id: actor.id, username: actor.username },
      entityType: "new_hire",
      entityId: id,
      branchId: request.branch_id,
      severity: "info",
      details: { fullName: request.full_name, branch: request.branch_name },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  });

  router.post("/:id/approve", requireApprove, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const id = z.uuid("معرّف طلب غير صالح.").parse(req.params.id);
    const scope = await db.query<Row & { branch_id: string }>("SELECT branch_id FROM new_employee_requests WHERE id = $1", [id]);
    if (!scope.rows[0] || !canAccessBranch(req.auth.user, scope.rows[0].branch_id)) throw notFound("الطلب غير موجود أو خارج نطاق صلاحيتك.");
    const outcome = await decideNewHire(db, req.auth.user, id, "approved", String((req.body as { reason?: string })?.reason ?? ""));
    await writeAudit(db, logger, {
      action: outcome.action,
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "new_hire",
      entityId: id,
      branchId: outcome.branchId,
      severity: "info",
      details: outcome.details,
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true, employeeId: outcome.details.employeeId, employeeNo: outcome.details.employeeNo });
  });

  router.post("/:id/reject", requireApprove, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const id = z.uuid("معرّف طلب غير صالح.").parse(req.params.id);
    const body = req.body as { reason?: string };
    const scope = await db.query<Row & { branch_id: string }>("SELECT branch_id FROM new_employee_requests WHERE id = $1", [id]);
    if (!scope.rows[0] || !canAccessBranch(req.auth.user, scope.rows[0].branch_id)) throw notFound("الطلب غير موجود أو خارج نطاق صلاحيتك.");
    const outcome = await decideNewHire(db, req.auth.user, id, "rejected", String(body?.reason ?? ""));
    await writeAudit(db, logger, {
      action: outcome.action,
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "new_hire",
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
    const result = await db.query<Row & { status: string; branch_id: string; full_name: string }>(
      "SELECT status, branch_id, full_name FROM new_employee_requests WHERE id = $1",
      [id],
    );
    const request = result.rows[0];
    if (!request) throw notFound("الطلب غير موجود.");
    if (!canAccessBranch(req.auth.user, request.branch_id)) throw forbidden("الطلب خارج نطاق صلاحيتك.");
    if (request.status !== "draft" && request.status !== "pending" && request.status !== "rejected") {
      throw conflict("لا يمكن إلغاء طلب في هذه الحالة.");
    }
    await db.query("UPDATE new_employee_requests SET status='rejected', decision_note='أُلغي الطلب', updated_at=now() WHERE id=$1", [id]);
    await cancelApproval(db, "new_hire", id);
    await writeAudit(db, logger, {
      action: "new_hire.cancelled",
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "new_hire",
      entityId: id,
      branchId: request.branch_id,
      severity: "info",
      details: { fullName: request.full_name },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  });

  return router;
}
