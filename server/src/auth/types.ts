export interface BranchAccess {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

export interface RoleSummary {
  id: string;
  key: string;
  nameAr: string;
  allPermissions: boolean;
  sortOrder: number;
}

export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  employeeId: string | null;
  role: RoleSummary;
  permissions: string[];
  allBranches: boolean;
  branches: BranchAccess[];
  mustChangePassword: boolean;
  active: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AuthSession {
  id: string;
  remember: boolean;
  expiresAt: string;
  absoluteExpiresAt: string;
}

export interface AuthContext {
  user: AuthUser;
  session: AuthSession;
}

export function hasPermission(user: Pick<AuthUser, "role" | "permissions">, permission: string): boolean {
  return user.role.allPermissions || user.permissions.includes(permission);
}

export function hasAnyPermission(user: Pick<AuthUser, "role" | "permissions">, permissions: string[]): boolean {
  return permissions.some((permission) => hasPermission(user, permission));
}

export function isActorWithinBranches(user: AuthUser, branchIds: string[]): boolean {
  if (user.allBranches) return true;
  const allowed = new Set(user.branches.map((branch) => branch.id));
  return branchIds.every((branchId) => allowed.has(branchId));
}

export function actorBranchIds(user: AuthUser): string[] {
  if (user.allBranches) return [];
  return user.branches.map((branch) => branch.id);
}
