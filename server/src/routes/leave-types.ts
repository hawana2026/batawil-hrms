import { Router } from "express";
import { z } from "zod";
import type { Db, Row } from "../db/index.js";
import { writeAudit } from "../lib/audit.js";
import { conflict, notFound, parseBody, requestIp, requestUserAgent, unauthorized } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { leaveBalanceAdjustSchema, leaveTypeSchema, leaveTypeUpdateSchema } from "../lib/hr-schemas.js";
import { canAccessBranch } from "../services/access.js";
import { adjustLeaveBalance, findLeaveType, listEmployeeBalances, presentBalance } from "../services/leave-balances.js";
import { loadEmployee } from "../services/employees.js";
import { createRequireAuth, createRequirePermission, requirePasswordReady, type AuthDeps } from "../middleware/auth.js";

interface LeaveTypeListRow extends Row {
  id: string;
  code: string;
  name: string;
  annual_entitlement: string | number;
  paid: boolean;
  track_balance: boolean;
  requires_document: boolean;
  active: boolean;
  sort_order: number;
  requests_count: number;
  created_at: string | Date;
  updated_at: string | Date;
}

function presentType(row: LeaveTypeListRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    annualEntitlement: Number(row.annual_entitlement),
    paid: row.paid,
    trackBalance: row.track_balance,
    requiresDocument: row.requires_document,
    active: row.active,
    sortOrder: row.sort_order,
    requestsCount: row.requests_count,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function loadType(db: Db, id: string): Promise<LeaveTypeListRow> {
  const result = await db.query<LeaveTypeListRow>(
    `SELECT t.*, (SELECT count(*)::int FROM leave_requests l WHERE l.leave_type_id = t.id) AS requests_count
     FROM leave_types t WHERE t.id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw notFound("نوع الإجازة غير موجود.");
  return row;
}

async function assertUnique(db: Db, name: string, code: string, excludeId: string | null): Promise<void> {
  const result = await db.query<Row & { id: string; name: string; code: string }>(
    "SELECT id, name, code FROM leave_types WHERE (lower(name) = lower($1) OR lower(code) = lower($2)) AND ($3::uuid IS NULL OR id <> $3::uuid) LIMIT 1",
    [name, code, excludeId],
  );
  const clash = result.rows[0];
  if (!clash) return;
  if (clash.name.toLowerCase() === name.toLowerCase()) throw conflict("يوجد نوع إجازة بهذا الاسم بالفعل.");
  throw conflict("يوجد نوع إجازة بهذا الرمز بالفعل.");
}

export function createLeaveTypesRouter(deps: AuthDeps): Router {
  const { db, logger } = deps;
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);
  const requireView = createRequirePermission("leaves.view", deps);
  const requireManage = createRequirePermission("leaves.manage", deps);

  router.get("/", requireView, async (_req, res) => {
    const result = await db.query<LeaveTypeListRow>(
      `SELECT t.*, (SELECT count(*)::int FROM leave_requests l WHERE l.leave_type_id = t.id) AS requests_count
       FROM leave_types t ORDER BY t.active DESC, t.sort_order, t.name`,
    );
    res.json({ items: result.rows.map(presentType) });
  });

  router.post("/", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const input = parseBody(leaveTypeSchema, req.body);
    await assertUnique(db, input.name, input.code, null);
    const id = newId();
    await db.query(
      `INSERT INTO leave_types
        (id, code, name, annual_entitlement, paid, track_balance, requires_document, active, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, input.code, input.name, input.annualEntitlement, input.paid, input.trackBalance, input.requiresDocument, input.active, input.sortOrder, actor.id],
    );
    await writeAudit(db, logger, {
      action: "leave_type.created",
      actor: { id: actor.id, username: actor.username },
      entityType: "leave_type",
      entityId: id,
      severity: "info",
      details: { code: input.code, name: input.name, annualEntitlement: input.annualEntitlement, trackBalance: input.trackBalance },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.status(201).json({ leaveType: presentType(await loadType(db, id)) });
  });

  router.patch("/:id", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const id = z.uuid("معرّف نوع إجازة غير صالح.").parse(req.params.id);
    const input = parseBody(leaveTypeUpdateSchema, req.body);
    const current = await loadType(db, id);
    const name = input.name ?? current.name;
    const code = input.code ?? current.code;
    const annualEntitlement = input.annualEntitlement ?? Number(current.annual_entitlement);
    const paid = input.paid ?? current.paid;
    const trackBalance = input.trackBalance ?? current.track_balance;
    const requiresDocument = input.requiresDocument ?? current.requires_document;
    const active = input.active ?? current.active;
    const sortOrder = input.sortOrder ?? current.sort_order;
    await assertUnique(db, name, code, id);
    const unchanged =
      name === current.name &&
      code === current.code &&
      annualEntitlement === Number(current.annual_entitlement) &&
      paid === current.paid &&
      trackBalance === current.track_balance &&
      requiresDocument === current.requires_document &&
      active === current.active &&
      sortOrder === current.sort_order;
    if (!unchanged) {
      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE leave_types
           SET code = $2, name = $3, annual_entitlement = $4, paid = $5, track_balance = $6,
               requires_document = $7, active = $8, sort_order = $9, updated_by = $10, updated_at = now()
           WHERE id = $1`,
          [id, code, name, annualEntitlement, paid, trackBalance, requiresDocument, active, sortOrder, actor.id],
        );
        if (code !== current.code) {
          await tx.query("UPDATE leave_requests SET leave_type = $2, updated_at = now() WHERE leave_type_id = $1", [id, code]);
        }
      });
      await writeAudit(db, logger, {
        action: "leave_type.updated",
        actor: { id: actor.id, username: actor.username },
        entityType: "leave_type",
        entityId: id,
        severity: active !== current.active ? "warning" : "info",
        details: {
          changes: {
            ...(code !== current.code ? { code: { from: current.code, to: code } } : {}),
            ...(name !== current.name ? { name: { from: current.name, to: name } } : {}),
            ...(annualEntitlement !== Number(current.annual_entitlement) ? { annualEntitlement: { from: Number(current.annual_entitlement), to: annualEntitlement } } : {}),
            ...(trackBalance !== current.track_balance ? { trackBalance: { from: current.track_balance, to: trackBalance } } : {}),
            ...(active !== current.active ? { active: { from: current.active, to: active } } : {}),
          },
        },
        ip: requestIp(req),
        userAgent: requestUserAgent(req),
      });
    }
    res.json({ leaveType: presentType(await loadType(db, id)) });
  });

  return router;
}

const balanceQuerySchema = z.object({
  employeeId: z.uuid("معرّف الموظف غير صالح."),
  year: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()),
});

export function createLeaveBalancesRouter(deps: AuthDeps): Router {
  const { db, logger } = deps;
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);
  const requireView = createRequirePermission("leaves.view", deps);
  const requireManage = createRequirePermission("leaves.manage", deps);

  router.get("/", requireView, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const query = parseBody(balanceQuerySchema, req.query);
    const employee = await loadEmployee(db, query.employeeId);
    if (!canAccessBranch(req.auth.user, employee.branch_id)) throw notFound("الموظف غير موجود أو خارج نطاق صلاحيتك.");
    const data = await listEmployeeBalances(db, employee.id, query.year, req.auth.user.id);
    res.json({ ...data, employee: { id: employee.id, fullName: employee.full_name, employeeNo: employee.employee_no, branchName: employee.branch_name } });
  });

  router.post("/adjust", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const input = parseBody(leaveBalanceAdjustSchema, req.body);
    const employee = await loadEmployee(db, input.employeeId);
    if (!canAccessBranch(actor, employee.branch_id)) throw notFound("الموظف غير موجود أو خارج نطاق صلاحيتك.");
    if (employee.archived_at) throw conflict("الموظف مؤرشف ولا يمكن تعديل رصيده.");
    const type = await findLeaveType(db, input.leaveTypeId);
    const result = await adjustLeaveBalance(db, {
      employeeId: input.employeeId,
      type,
      year: input.year,
      days: input.days,
      note: input.note,
      actorId: actor.id,
    });
    await writeAudit(db, logger, {
      action: "leave_balance.adjusted",
      actor: { id: actor.id, username: actor.username },
      entityType: "employee",
      entityId: input.employeeId,
      branchId: employee.branch_id,
      severity: "warning",
      details: { employee: employee.full_name, type: type.name, year: input.year, days: input.days, before: result.before, after: result.after, note: input.note },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ balance: result.balance, before: result.before, after: result.after });
  });

  return router;
}
