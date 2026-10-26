import type { Db, Row } from "../db/index.js";
import type { AuthUser } from "../auth/types.js";
import { getRoleById, type RoleRecord } from "./roles.js";

function toIso(value: string | Date | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

interface ManagedUserRow extends Row {
  id: string;
  username: string;
  full_name: string;
  email: string | null;
  role_id: string;
  active: boolean;
  all_branches: boolean;
  must_change_password: boolean;
  locked_until: string | Date | null;
  last_login_at: string | Date | null;
  session_version: number;
  created_at: string | Date;
  updated_at: string | Date;
}

interface IdRow extends Row {
  branch_id: string;
}

export interface ManagedUserRecord {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  role: RoleRecord;
  active: boolean;
  allBranches: boolean;
  branchIds: string[];
  mustChangePassword: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  sessionVersion: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export async function getManagedUser(db: Db, id: string): Promise<ManagedUserRecord | null> {
  const result = await db.query<ManagedUserRow>(
    `SELECT id, username, full_name, email, role_id, active, all_branches, must_change_password,
            locked_until, last_login_at, session_version, created_at, updated_at
     FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  const role = await getRoleById(db, row.role_id);
  if (!role) return null;
  const branches = await db.query<IdRow>("SELECT branch_id FROM user_branch_access WHERE user_id = $1", [row.id]);
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    email: row.email,
    role,
    active: row.active,
    allBranches: row.all_branches,
    branchIds: branches.rows.map((branch) => branch.branch_id),
    mustChangePassword: row.must_change_password,
    lockedUntil: toIso(row.locked_until),
    lastLoginAt: toIso(row.last_login_at),
    sessionVersion: row.session_version,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function isManagedUserInScope(actor: AuthUser, target: ManagedUserRecord): boolean {
  if (actor.allBranches) return true;
  if (target.id === actor.id) return true;
  if (target.allBranches) return false;
  const actorBranches = new Set(actor.branches.map((branch) => branch.id));
  return target.branchIds.some((branchId) => actorBranches.has(branchId));
}

export async function isActiveAdminCountAtLeast(db: Db, minimum: number, excludingUserId: string): Promise<boolean> {
  const result = await db.query<Row & { count: number }>(
    `SELECT count(*)::int AS count
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.active = true AND r.all_permissions = true AND u.id <> $1`,
    [excludingUserId],
  );
  return (result.rows[0]?.count ?? 0) >= minimum;
}
