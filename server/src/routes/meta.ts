import { Router } from "express";
import type { Row } from "../db/index.js";
import { hasPermission, type AuthUser } from "../auth/types.js";
import { MIN_PASSWORD_LENGTH } from "../auth/password.js";
import { unauthorized } from "../lib/errors.js";
import { listAssignableRoles, listRoles, type RoleRecord } from "../services/roles.js";
import { getSettings } from "../services/settings.js";
import { createRequireAuth, requirePasswordReady, type AuthDeps } from "../middleware/auth.js";

interface BranchMetaRow extends Row {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

function summarizeRole(role: RoleRecord, includePermissions: boolean) {
  return {
    id: role.id,
    key: role.key,
    nameAr: role.nameAr,
    descriptionAr: role.descriptionAr,
    allPermissions: role.allPermissions,
    sortOrder: role.sortOrder,
    ...(includePermissions ? { permissionKeys: role.permissionKeys } : {}),
  };
}

async function scopedBranches(actor: AuthUser, deps: AuthDeps): Promise<BranchMetaRow[]> {
  if (actor.allBranches) {
    const result = await deps.db.query<BranchMetaRow>("SELECT id, code, name, active FROM branches ORDER BY active DESC, name");
    return result.rows;
  }
  const ids = actor.branches.map((branch) => branch.id);
  if (ids.length === 0) return [];
  const result = await deps.db.query<BranchMetaRow>(
    "SELECT id, code, name, active FROM branches WHERE id = ANY($1::uuid[]) ORDER BY active DESC, name",
    [ids],
  );
  return result.rows;
}

export function createMetaRouter(deps: AuthDeps): Router {
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);

  router.get("/", async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const canViewBranches = hasPermission(actor, "branches.view") || hasPermission(actor, "users.view");
    const canManageUsers = hasPermission(actor, "users.manage");

    const canViewHr =
      hasPermission(actor, "employees.view") ||
      hasPermission(actor, "attendance.view") ||
      hasPermission(actor, "leaves.view") ||
      hasPermission(actor, "settings.view");
    const [branches, roles, departments, jobTitles, leaveTypes, settings] = await Promise.all([
      canViewBranches ? scopedBranches(actor, deps) : Promise.resolve(actor.branches as BranchMetaRow[]),
      canManageUsers
        ? listAssignableRoles(deps.db, actor)
        : hasPermission(actor, "users.view")
          ? listRoles(deps.db)
          : Promise.resolve([] as RoleRecord[]),
      canViewHr
        ? deps.db
            .query<Row & { id: string; name: string }>("SELECT id, name FROM departments WHERE active = true ORDER BY name")
            .then((result) => result.rows.map((row) => ({ id: row.id, name: row.name })))
        : Promise.resolve([] as Array<{ id: string; name: string }>),
      canViewHr
        ? deps.db
            .query<Row & { id: string; name: string; department_id: string | null }>(
              "SELECT id, name, department_id FROM job_titles WHERE active = true ORDER BY name",
            )
            .then((result) => result.rows.map((row) => ({ id: row.id, name: row.name, departmentId: row.department_id })))
        : Promise.resolve([] as Array<{ id: string; name: string; departmentId: string | null }>),
      canViewHr
        ? deps.db
            .query<Row & { id: string; code: string; name: string; annual_entitlement: string | number; paid: boolean; track_balance: boolean }>(
              "SELECT id, code, name, annual_entitlement, paid, track_balance FROM leave_types WHERE active = true ORDER BY sort_order, name",
            )
            .then((result) =>
              result.rows.map((row) => ({
                id: row.id,
                code: row.code,
                name: row.name,
                annualEntitlement: Number(row.annual_entitlement),
                paid: row.paid,
                trackBalance: row.track_balance,
              })),
            )
        : Promise.resolve([] as Array<{ id: string; code: string; name: string; annualEntitlement: number; paid: boolean; trackBalance: boolean }>),
      getSettings(deps.db),
    ]);

    res.json({
      passwordMinLength: MIN_PASSWORD_LENGTH,
      serverTime: new Date().toISOString(),
      company: settings.company,
      attendance: settings.attendance,
      branches: branches.map((branch) => ({
        id: branch.id,
        code: branch.code,
        name: branch.name,
        active: branch.active,
      })),
      departments,
      jobTitles,
      leaveTypes,
      roles: roles.map((role) => summarizeRole(role, canManageUsers)),
      capabilities: {
        manageUsers: canManageUsers,
        selfService: Boolean(actor.employeeId),
        manageBranches: hasPermission(actor, "branches.manage") && actor.allBranches,
        viewRoles: hasPermission(actor, "roles.view") || canManageUsers,
        viewAudit: hasPermission(actor, "audit.view"),
        viewEmployees: hasPermission(actor, "employees.view"),
        manageEmployees: hasPermission(actor, "employees.manage"),
        importEmployees: hasPermission(actor, "employees.import"),
        exportEmployees: hasPermission(actor, "employees.export") || hasPermission(actor, "reports.export"),
        manageAttendance: hasPermission(actor, "attendance.manage"),
        submitAttendance: hasPermission(actor, "attendance.submit"),
        approveAttendance: hasPermission(actor, "attendance.approve"),
        correctAttendance: hasPermission(actor, "attendance.correct"),
        manageLeaves: hasPermission(actor, "leaves.manage"),
        approveLeaves: hasPermission(actor, "leaves.approve"),
        manageTransfers: hasPermission(actor, "transfers.manage"),
        approveTransfers: hasPermission(actor, "transfers.approve"),
        manageNewHires: hasPermission(actor, "new_hires.manage"),
        approveNewHires: hasPermission(actor, "new_hires.approve"),
        manageAdvances: hasPermission(actor, "advances.manage"),
        approveAdvancesHr: hasPermission(actor, "advances.approve_hr"),
        approveAdvancesFinance: hasPermission(actor, "advances.approve_finance"),
        disburseAdvances: hasPermission(actor, "advances.disburse"),
        managePayroll: hasPermission(actor, "payroll.manage"),
        viewReports: hasPermission(actor, "reports.view"),
        exportReports: hasPermission(actor, "reports.export"),
        viewApprovals: hasPermission(actor, "approvals.view"),
        viewSettings: hasPermission(actor, "settings.view"),
        manageSettings: hasPermission(actor, "settings.manage"),
      },
    });
  });

  return router;
}
