import type { AuthUser } from "../auth/types.js";

export interface SqlScope {
  sql: string;
  params: unknown[];
}

export function userScopeSql(actor: AuthUser, alias: string, firstParamIndex: number): SqlScope {
  if (actor.allBranches) return { sql: "TRUE", params: [] };
  const branchIds = actor.branches.map((branch) => branch.id);
  if (branchIds.length === 0) {
    return { sql: `${alias}.id = $${firstParamIndex}`, params: [actor.id] };
  }
  return {
    sql: `(${alias}.id = $${firstParamIndex} OR EXISTS (
      SELECT 1 FROM user_branch_access scope_uba
      WHERE scope_uba.user_id = ${alias}.id
        AND scope_uba.branch_id = ANY($${firstParamIndex + 1}::uuid[])
    ))`,
    params: [actor.id, branchIds],
  };
}

export function branchScopeSql(actor: AuthUser, alias: string, firstParamIndex: number): SqlScope {
  if (actor.allBranches) return { sql: "TRUE", params: [] };
  const branchIds = actor.branches.map((branch) => branch.id);
  if (branchIds.length === 0) return { sql: "FALSE", params: [] };
  return { sql: `${alias}.branch_id = ANY($${firstParamIndex}::uuid[])`, params: [branchIds] };
}

export function canAccessBranch(actor: AuthUser, branchId: string): boolean {
  return actor.allBranches || actor.branches.some((branch) => branch.id === branchId);
}

export function auditScopeSql(actor: AuthUser, alias: string, firstParamIndex: number): SqlScope {
  if (actor.allBranches) return { sql: "TRUE", params: [] };
  const branchIds = actor.branches.map((branch) => branch.id);
  if (branchIds.length === 0) {
    return { sql: `${alias}.actor_user_id = $${firstParamIndex}`, params: [actor.id] };
  }
  return {
    sql: `(${alias}.actor_user_id = $${firstParamIndex} OR ${alias}.branch_id = ANY($${firstParamIndex + 1}::uuid[]))`,
    params: [actor.id, branchIds],
  };
}
