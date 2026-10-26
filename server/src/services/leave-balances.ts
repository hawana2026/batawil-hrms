import type { DbClient, Row } from "../db/index.js";
import { ApiError, conflict, notFound } from "../lib/errors.js";
import { newId } from "../lib/ids.js";

export interface LeaveTypeRow extends Row {
  id: string;
  code: string;
  name: string;
  annual_entitlement: string | number;
  paid: boolean;
  track_balance: boolean;
  requires_document: boolean;
  active: boolean;
  sort_order: number;
}

export interface LeaveBalanceRow extends Row {
  id: string;
  employee_id: string;
  leave_type_id: string;
  year: number;
  entitlement: string | number;
  used: string | number;
  adjusted: string | number;
  updated_at: string | Date;
}

const leaveTypeColumns = `id, code, name, annual_entitlement, paid, track_balance, requires_document, active, sort_order`;

export async function findLeaveType(client: DbClient, typeId: string): Promise<LeaveTypeRow> {
  const result = await client.query<LeaveTypeRow>(`SELECT ${leaveTypeColumns} FROM leave_types WHERE id = $1`, [typeId]);
  const type = result.rows[0];
  if (!type) throw notFound("نوع الإجازة غير موجود.");
  return type;
}

export async function findLeaveTypeByCode(client: DbClient, code: string): Promise<LeaveTypeRow | null> {
  const result = await client.query<LeaveTypeRow>(`SELECT ${leaveTypeColumns} FROM leave_types WHERE lower(code) = lower($1)`, [code]);
  return result.rows[0] ?? null;
}

export async function resolveLeaveType(client: DbClient, typeId: string | null | undefined, code: string | undefined): Promise<LeaveTypeRow> {
  if (typeId) return findLeaveType(client, typeId);
  if (code) {
    const type = await findLeaveTypeByCode(client, code);
    if (type) return type;
  }
  throw new ApiError(400, "LEAVE_TYPE_REQUIRED", "يجب اختيار نوع إجازة معتمد.");
}

export function balanceNumber(value: string | number, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function balanceYear(startDate: string): number {
  return Number(startDate.slice(0, 4));
}

export function presentBalance(balance: LeaveBalanceRow, type: LeaveTypeRow) {
  const entitlement = balanceNumber(balance.entitlement);
  const used = balanceNumber(balance.used);
  const adjusted = balanceNumber(balance.adjusted);
  return {
    id: balance.id,
    leaveTypeId: type.id,
    code: type.code,
    name: type.name,
    year: balance.year,
    entitlement,
    used,
    adjusted,
    remaining: Number((entitlement + adjusted - used).toFixed(2)),
    paid: type.paid,
    trackBalance: type.track_balance,
    active: type.active,
    updatedAt: new Date(balance.updated_at).toISOString(),
  };
}

export async function ensureLeaveBalance(
  client: DbClient,
  employeeId: string,
  type: LeaveTypeRow,
  year: number,
  actorId: string | null = null,
): Promise<LeaveBalanceRow> {
  const inserted = await client.query<Row & { id: string }>(
    `INSERT INTO leave_balances (id, employee_id, leave_type_id, year, entitlement, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (employee_id, leave_type_id, year) DO NOTHING
     RETURNING id`,
    [newId(), employeeId, type.id, year, balanceNumber(type.annual_entitlement), actorId],
  );
  const insertedRow = inserted.rows[0];
  if (insertedRow) {
    const approved = await client.query<Row & { id: string; days: number }>(
      `SELECT id, days FROM leave_requests
       WHERE employee_id = $1 AND leave_type_id = $2 AND status = 'approved'
         AND EXTRACT(YEAR FROM start_date)::int = $3`,
      [employeeId, type.id, year],
    );
    for (const leave of approved.rows) {
      await client.query(
        `INSERT INTO leave_balance_movements (id, balance_id, leave_request_id, kind, days, note, created_by)
         VALUES ($1, $2, $3, 'usage', $4, 'رصيد افتتاحي', $5)
         ON CONFLICT DO NOTHING`,
        [newId(), insertedRow.id, leave.id, leave.days, actorId],
      );
    }
    if (approved.rows.length) {
      await client.query(
        `UPDATE leave_balances SET used = COALESCE((
           SELECT sum(days) FROM leave_balance_movements WHERE balance_id = $1 AND kind = 'usage'
         ), 0) WHERE id = $1`,
        [insertedRow.id],
      );
    }
  }
  const result = await client.query<LeaveBalanceRow>(
    `SELECT id, employee_id, leave_type_id, year, entitlement, used, adjusted, updated_at
     FROM leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND year = $3`,
    [employeeId, type.id, year],
  );
  const balance = result.rows[0];
  if (!balance) throw new ApiError(500, "BALANCE_MISSING", "تعذّر إنشاء رصيد الإجازة.");
  return balance;
}

export async function consumeLeaveBalance(
  client: DbClient,
  input: { leaveId: string; employeeId: string; type: LeaveTypeRow; startDate: string; days: number; actorId: string },
): Promise<{ deducted: boolean; remaining: number | null }> {
  if (!input.type.track_balance) return { deducted: false, remaining: null };
  const year = balanceYear(input.startDate);
  const balance = await ensureLeaveBalance(client, input.employeeId, input.type, year, input.actorId);
  const existing = await client.query<Row & { id: string }>(
    "SELECT id FROM leave_balance_movements WHERE leave_request_id = $1 AND kind = 'usage' LIMIT 1",
    [input.leaveId],
  );
  if (existing.rows[0]) throw conflict("تم خصم رصيد هذا الطلب مسبقاً.");
  const remaining = balanceNumber(balance.entitlement) + balanceNumber(balance.adjusted) - balanceNumber(balance.used);
  if (remaining < input.days) {
    throw conflict(`رصيد ${input.type.name} لا يكفي. المتاح ${remaining} يوم والمطلوب ${input.days} يوم.`);
  }
  await client.query(
    "UPDATE leave_balances SET used = used + $2, updated_at = now() WHERE id = $1",
    [balance.id, input.days],
  );
  await client.query(
    `INSERT INTO leave_balance_movements (id, balance_id, leave_request_id, kind, days, note, created_by)
     VALUES ($1, $2, $3, 'usage', $4, $5, $6)`,
    [newId(), balance.id, input.leaveId, input.days, `خصم اعتماد ${input.type.name}`, input.actorId],
  );
  return { deducted: true, remaining: Number((remaining - input.days).toFixed(2)) };
}

export async function adjustLeaveBalance(
  client: DbClient,
  input: { employeeId: string; type: LeaveTypeRow; year: number; days: number; note: string; actorId: string },
): Promise<{ balance: ReturnType<typeof presentBalance>; before: number; after: number }> {
  const balance = await ensureLeaveBalance(client, input.employeeId, input.type, input.year, input.actorId);
  const before = balanceNumber(balance.entitlement) + balanceNumber(balance.adjusted) - balanceNumber(balance.used);
  const after = Number((before + input.days).toFixed(2));
  if (after < 0) throw conflict(`التعديل يجعل الرصيد سالباً. المتاح حالياً ${before} يوم.`);
  await client.query(
    "UPDATE leave_balances SET adjusted = adjusted + $2, updated_by = $3, updated_at = now() WHERE id = $1",
    [balance.id, input.days, input.actorId],
  );
  await client.query(
    `INSERT INTO leave_balance_movements (id, balance_id, kind, days, note, created_by)
     VALUES ($1, $2, 'adjustment', $3, $4, $5)`,
    [newId(), balance.id, input.days, input.note, input.actorId],
  );
  const updated = await client.query<LeaveBalanceRow>(
    "SELECT id, employee_id, leave_type_id, year, entitlement, used, adjusted, updated_at FROM leave_balances WHERE id = $1",
    [balance.id],
  );
  const row = updated.rows[0];
  if (!row) throw notFound("رصيد الإجازة غير موجود.");
  return { balance: presentBalance(row, input.type), before, after };
}

export async function listEmployeeBalances(
  client: DbClient,
  employeeId: string,
  year: number,
  actorId: string | null,
) {
  const types = await client.query<LeaveTypeRow>(
    `SELECT ${leaveTypeColumns} FROM leave_types
     WHERE track_balance = true OR EXISTS (
       SELECT 1 FROM leave_balances b WHERE b.leave_type_id = leave_types.id AND b.employee_id = $1 AND b.year = $2
     )
     ORDER BY sort_order, name`,
    [employeeId, year],
  );
  const balances = [];
  for (const type of types.rows) {
    const balance = await ensureLeaveBalance(client, employeeId, type, year, actorId);
    balances.push(presentBalance(balance, type));
  }
  const movements = await client.query<Row & { id: string; leave_type_id: string; kind: string; days: string | number; note: string; created_at: string | Date; actor_name: string | null }>(
    `SELECT m.id, b.leave_type_id, m.kind, m.days, m.note, m.created_at, u.full_name AS actor_name
     FROM leave_balance_movements m
     JOIN leave_balances b ON b.id = m.balance_id
     LEFT JOIN users u ON u.id = m.created_by
     WHERE b.employee_id = $1 AND b.year = $2
     ORDER BY m.created_at DESC
     LIMIT 30`,
    [employeeId, year],
  );
  return {
    year,
    balances,
    movements: movements.rows.map((row) => ({
      id: row.id,
      leaveTypeId: row.leave_type_id,
      kind: row.kind,
      days: balanceNumber(row.days),
      note: row.note,
      actor: row.actor_name ?? "—",
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}
