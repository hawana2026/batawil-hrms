import type { Db } from "../db/index.js";
import { newId } from "../lib/ids.js";

export type ApprovalEntityType = "attendance_day" | "attendance_month" | "leave" | "advance" | "transfer" | "new_hire";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";

export const APPROVAL_PERMISSION: Record<ApprovalEntityType, string> = {
  attendance_day: "attendance.approve",
  attendance_month: "attendance.approve",
  leave: "leaves.approve",
  advance: "advances.approve_hr",
  transfer: "transfers.approve",
  new_hire: "new_hires.approve",
};

export const APPROVAL_LABEL: Record<ApprovalEntityType, string> = {
  attendance_day: "تحضير يومي",
  attendance_month: "تحضير شهري",
  leave: "إجازة أو إذن",
  advance: "سلفة مالية",
  transfer: "تحويل وظيفي",
  new_hire: "موظف جديد",
};

export interface OpenApprovalInput {
  entityType: ApprovalEntityType;
  entityId: string;
  branchId: string | null;
  title: string;
  summary?: string;
  requestedBy: string | null;
}

export async function openApproval(db: Db, input: OpenApprovalInput): Promise<void> {
  await db.query(
    `INSERT INTO approval_requests
      (id, entity_type, entity_id, branch_id, title, summary, status, requested_by, requested_at)
     VALUES ($7, $1, $2, $3, $4, $5, 'pending', $6, now())
     ON CONFLICT (entity_type, entity_id) DO UPDATE SET
       branch_id = EXCLUDED.branch_id,
       title = EXCLUDED.title,
       summary = EXCLUDED.summary,
       status = 'pending',
       requested_by = EXCLUDED.requested_by,
       requested_at = now(),
       decided_by = NULL,
       decided_at = NULL,
       decision_note = NULL`,
    [input.entityType, input.entityId, input.branchId, input.title, input.summary ?? "", input.requestedBy, newId()],
  );
}

export async function closeApproval(
  db: Db,
  entityType: ApprovalEntityType,
  entityId: string,
  status: Exclude<ApprovalStatus, "pending">,
  actorId: string | null,
  note: string | null,
): Promise<void> {
  await db.query(
    `UPDATE approval_requests
     SET status = $3, decided_by = $4, decided_at = now(), decision_note = $5
     WHERE entity_type = $1 AND entity_id = $2`,
    [entityType, entityId, status, actorId, note],
  );
}

export async function cancelApproval(db: Db, entityType: ApprovalEntityType, entityId: string): Promise<void> {
  await db.query(
    `UPDATE approval_requests SET status = 'cancelled', decided_at = now()
     WHERE entity_type = $1 AND entity_id = $2 AND status = 'pending'`,
    [entityType, entityId],
  );
}

export async function notifyUser(
  db: Db,
  userId: string | null,
  title: string,
  body: string,
  link: string,
): Promise<void> {
  if (!userId) return;
  try {
    await db.query("INSERT INTO notifications (id, user_id, title, body, link) VALUES ($1, $2, $3, $4, $5)", [
      newId(),
      userId,
      title.slice(0, 200),
      body.slice(0, 500),
      link.slice(0, 200),
    ]);
  } catch {
    // Notifications must never block the business action that triggered them.
  }
}

export async function notifyPermissionHolders(
  db: Db,
  permission: string,
  branchId: string | null,
  title: string,
  body: string,
  link: string,
): Promise<void> {
  try {
    const result = await db.query<{ id: string }>(
      `SELECT DISTINCT u.id
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.active
         AND (r.all_permissions OR EXISTS (
           SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_key = $1
         ))
         AND ($2::uuid IS NULL OR u.all_branches OR EXISTS (
           SELECT 1 FROM user_branch_access uba WHERE uba.user_id = u.id AND uba.branch_id = $2
         ))`,
      [permission, branchId],
    );
    for (const row of result.rows) {
      await db.query("INSERT INTO notifications (id, user_id, title, body, link) VALUES ($1, $2, $3, $4, $5)", [
        newId(),
        row.id,
        title.slice(0, 200),
        body.slice(0, 500),
        link.slice(0, 200),
      ]);
    }
  } catch {
    // Best-effort delivery.
  }
}
