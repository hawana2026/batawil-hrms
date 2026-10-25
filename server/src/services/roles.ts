import type { Db, Row } from "../db/index.js";
import type { AuthUser } from "../auth/types.js";

interface RoleRow extends Row {
  id: string;
  key: string;
  name_ar: string;
  description_ar: string;
  all_permissions: boolean;
  sort_order: number;
}

interface RolePermissionRow extends Row {
  role_id: string;
  permission_key: string;
}

interface PermissionCatalogRow extends Row {
  key: string;
}

export interface RoleRecord {
  id: string;
  key: string;
  nameAr: string;
  descriptionAr: string;
  allPermissions: boolean;
  sortOrder: number;
  permissionKeys: string[];
}

function assembleRoles(
  rows: RoleRow[],
  permissionRows: RolePermissionRow[],
  catalogKeys: string[],
): RoleRecord[] {
  const byRole = new Map<string, string[]>();
  for (const row of permissionRows) {
    const list = byRole.get(row.role_id) ?? [];
    list.push(row.permission_key);
    byRole.set(row.role_id, list);
  }
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    nameAr: row.name_ar,
    descriptionAr: row.description_ar,
    allPermissions: row.all_permissions,
    sortOrder: row.sort_order,
    permissionKeys: row.all_permissions ? [...catalogKeys] : (byRole.get(row.id) ?? []).sort(),
  }));
}

export async function listRoles(db: Db): Promise<RoleRecord[]> {
  const [rolesResult, permissionsResult, catalogResult] = await Promise.all([
    db.query<RoleRow>(
      "SELECT id, key, name_ar, description_ar, all_permissions, sort_order FROM roles ORDER BY sort_order, key",
    ),
    db.query<RolePermissionRow>("SELECT role_id, permission_key FROM role_permissions"),
    db.query<PermissionCatalogRow>("SELECT key FROM permissions ORDER BY sort_order, key"),
  ]);
  return assembleRoles(
    rolesResult.rows,
    permissionsResult.rows,
    catalogResult.rows.map((row) => row.key),
  );
}

export async function getRoleByKey(db: Db, key: string): Promise<RoleRecord | null> {
  const roles = await listRoles(db);
  return roles.find((role) => role.key === key) ?? null;
}

export async function getRoleById(db: Db, id: string): Promise<RoleRecord | null> {
  const roles = await listRoles(db);
  return roles.find((role) => role.id === id) ?? null;
}

export function canActorAssignRole(actor: AuthUser, role: RoleRecord): boolean {
  if (actor.role.allPermissions) return true;
  if (role.allPermissions) return false;
  return role.permissionKeys.every((permission) => actor.permissions.includes(permission));
}

export async function listAssignableRoles(db: Db, actor: AuthUser): Promise<RoleRecord[]> {
  const roles = await listRoles(db);
  return roles.filter((role) => canActorAssignRole(actor, role));
}

export interface PermissionRecord {
  key: string;
  nameAr: string;
  sortOrder: number;
}

export async function listPermissions(db: Db): Promise<PermissionRecord[]> {
  const result = await db.query<Row & { key: string; name_ar: string; sort_order: number }>(
    "SELECT key, name_ar, sort_order FROM permissions ORDER BY sort_order, key",
  );
  return result.rows.map((row) => ({ key: row.key, nameAr: row.name_ar, sortOrder: row.sort_order }));
}
