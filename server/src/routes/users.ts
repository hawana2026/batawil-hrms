import { Router } from "express";
import { z } from "zod";
import type { Db, Row } from "../db/index.js";
import { hasPermission, type AuthUser } from "../auth/types.js";
import {
  generateTemporaryPassword,
  hashPassword,
  validatePasswordStrength,
} from "../auth/password.js";
import { revokeAllUserSessions } from "../auth/session.js";
import { writeAudit } from "../lib/audit.js";
import { ApiError, conflict, forbidden, notFound, parseBody, requestIp, requestUserAgent, unauthorized } from "../lib/errors.js";
import { branchIdsSchema, emailSchema, fullNameSchema, roleKeySchema, usernameSchema } from "../lib/schemas.js";
import { userScopeSql } from "../services/access.js";
import { newId } from "../lib/ids.js";
import {
  getManagedUser,
  isActiveAdminCountAtLeast,
  isManagedUserInScope,
  type ManagedUserRecord,
} from "../services/managed-users.js";
import { canActorAssignRole, getRoleByKey } from "../services/roles.js";
import { createRequireAuth, createRequirePermission, requirePasswordReady, type AuthDeps } from "../middleware/auth.js";

const listQuerySchema = z.object({
  q: z.string().trim().max(100).default(""),
  branchId: z.string().trim().max(64).default(""),
  roleKey: z.string().trim().max(50).default(""),
  status: z.enum(["all", "active", "inactive", "locked"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const createUserSchema = z.object({
  username: usernameSchema,
  fullName: fullNameSchema,
  email: emailSchema,
  roleKey: roleKeySchema,
  employeeId: z.union([z.uuid("معرّف الموظف غير صالح."), z.literal(""), z.null()]).transform((value) => value || null).optional(),
  allBranches: z.boolean().default(false),
  branchIds: branchIdsSchema,
});

const updateUserSchema = z
  .object({
    fullName: fullNameSchema.optional(),
    email: emailSchema,
    roleKey: roleKeySchema.optional(),
    active: z.boolean().optional(),
    employeeId: z.union([z.uuid("معرّف الموظف غير صالح."), z.literal(""), z.null()]).transform((value) => value || null).optional(),
    allBranches: z.boolean().optional(),
    branchIds: z.array(z.uuid("معرّف فرع غير صالح.")).max(200).optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: "لا توجد تغييرات لحفظها.",
  });

interface UserListRow extends Row {
  id: string;
  username: string;
  full_name: string;
  email: string | null;
  employee_id: string | null;
  employee_name: string | null;
  employee_no: string | null;
  active: boolean;
  all_branches: boolean;
  must_change_password: boolean;
  locked_until: string | Date | null;
  last_login_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  role_id: string;
  role_key: string;
  role_name: string;
  all_permissions: boolean;
  sort_order: number;
  branches: unknown;
}

interface BranchOptionRow extends Row {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

function toIso(value: string | Date | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseBranches(value: unknown): BranchOptionRow[] {
  if (Array.isArray(value)) return value as BranchOptionRow[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as BranchOptionRow[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function canFullyManage(
  actor: AuthUser,
  target: ManagedUserRecord | { id: string; allBranches: boolean; branchIds: string[]; role?: { allPermissions: boolean } },
): boolean {
  if (target.id === actor.id) return false;
  if (!actor.role.allPermissions && target.role?.allPermissions) return false;
  if (actor.allBranches) return true;
  if (target.allBranches) return false;
  const allowed = new Set(actor.branches.map((branch) => branch.id));
  return target.branchIds.length > 0 && target.branchIds.every((branchId) => allowed.has(branchId));
}

async function assertRoleAssignable(db: Db, actor: AuthUser, roleKey: string) {
  const role = await getRoleByKey(db, roleKey);
  if (!role) throw new ApiError(400, "INVALID_ROLE", "الدور المحدد غير موجود.");
  if (!canActorAssignRole(actor, role)) {
    throw forbidden("لا يمكنك منح دور يتجاوز صلاحياتك الحالية.");
  }
  return role;
}

async function loadActiveBranches(db: Db, branchIds: string[]): Promise<BranchOptionRow[]> {
  if (branchIds.length === 0) return [];
  const result = await db.query<BranchOptionRow>(
    "SELECT id, code, name, active FROM branches WHERE id = ANY($1::uuid[])",
    [branchIds],
  );
  return result.rows;
}

async function validateBranchSelection(
  db: Db,
  actor: AuthUser,
  branchIds: string[],
  allBranches: boolean,
): Promise<BranchOptionRow[]> {
  if (allBranches) {
    if (branchIds.length > 0) {
      throw new ApiError(400, "INVALID_BRANCH_SCOPE", "لا يمكن تحديد فروع عند منح الوصول إلى كل الفروع.");
    }
    if (!actor.allBranches) throw forbidden("لا يمكنك منح وصول إلى كل الفروع.");
    return [];
  }
  const unique = [...new Set(branchIds)];
  if (unique.length === 0) {
    throw new ApiError(400, "BRANCH_REQUIRED", "يجب تحديد فرع واحد على الأقل للمستخدم.");
  }
  const branches = await loadActiveBranches(db, unique);
  if (branches.length !== unique.length) {
    throw new ApiError(400, "INVALID_BRANCH", "أحد الفروع المحددة غير موجود.");
  }
  if (branches.some((branch) => !branch.active)) {
    throw new ApiError(400, "INACTIVE_BRANCH", "لا يمكن إسناد مستخدم إلى فرع معطل.");
  }
  if (!actor.allBranches) {
    const allowed = new Set(actor.branches.map((branch) => branch.id));
    if (unique.some((branchId) => !allowed.has(branchId))) {
      throw forbidden("لا يمكنك إسناد المستخدم إلى فرع خارج نطاق صلاحيتك.");
    }
  }
  return branches;
}

async function resolveEmployeeLink(
  db: Db,
  actor: AuthUser,
  employeeId: string | null | undefined,
  branchIds: string[],
  allBranches: boolean,
  excludeUserId: string | null,
): Promise<{ id: string; full_name: string; employee_no: string; branch_id: string } | null> {
  if (!employeeId) return null;
  const result = await db.query<Row & { id: string; full_name: string; employee_no: string; branch_id: string; archived_at: string | Date | null }>(
    "SELECT id, full_name, employee_no, branch_id, archived_at FROM employees WHERE id = $1",
    [employeeId],
  );
  const employee = result.rows[0];
  if (!employee) throw new ApiError(400, "INVALID_EMPLOYEE", "الموظف المحدد غير موجود.");
  if (employee.archived_at) throw new ApiError(400, "INVALID_EMPLOYEE", "لا يمكن ربط حساب بموظف مؤرشف.");
  const allowedBranches = allBranches && actor.allBranches ? null : new Set(branchIds);
  if (allowedBranches && !allowedBranches.has(employee.branch_id)) {
    throw new ApiError(400, "EMPLOYEE_BRANCH_MISMATCH", "فرع الموظف يجب أن يكون ضمن نطاق فروع المستخدم.");
  }
  const taken = await db.query<Row & { username: string }>(
    "SELECT username FROM users WHERE employee_id = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid) LIMIT 1",
    [employeeId, excludeUserId],
  );
  if (taken.rows[0]) throw conflict(`الموظف مرتبط بالفعل بحساب "${taken.rows[0].username}".`);
  return employee;
}

async function ensureUniqueIdentity(db: Db, username: string, email: string | null, excludeUserId: string | null): Promise<void> {
  const result = await db.query<Row & { id: string; username: string; email: string | null }>(
    `SELECT id, username, email FROM users
     WHERE (lower(username) = $1 OR ($2::text IS NOT NULL AND lower(email) = lower($2)))
       AND ($3::uuid IS NULL OR id <> $3::uuid)
     LIMIT 1`,
    [username, email, excludeUserId],
  );
  const row = result.rows[0];
  if (!row) return;
  if (row.username.toLowerCase() === username.toLowerCase()) {
    throw conflict("اسم المستخدم مستخدم بالفعل.");
  }
  throw conflict("البريد الإلكتروني مستخدم بالفعل.");
}

async function nextTemporaryPassword(username: string): Promise<string> {
  for (let i = 0; i < 5; i += 1) {
    const candidate = generateTemporaryPassword(14);
    if (validatePasswordStrength(candidate, username).ok) return candidate;
  }
  throw new ApiError(500, "INTERNAL_ERROR", "تعذر إنشاء كلمة مرور مؤقتة آمنة.");
}

export function createUsersRouter(deps: AuthDeps): Router {
  const { db, logger } = deps;
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);
  const requireView = createRequirePermission("users.view", deps);
  const requireManage = createRequirePermission("users.manage", deps);

  router.get("/", requireView, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const query = parseBody(listQuerySchema, req.query);
    const params: unknown[] = [];
    const where: string[] = [];

    const scope = userScopeSql(actor, "u", 1);
    params.push(...scope.params);
    where.push(scope.sql);
    where.push("u.deleted_at IS NULL");

    const addParam = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (query.q) {
      const p = addParam(`%${query.q}%`);
      where.push(
        `(u.username ILIKE ${p} OR u.full_name ILIKE ${p} OR COALESCE(u.email, '') ILIKE ${p}
          OR COALESCE(emp.full_name, '') ILIKE ${p} OR COALESCE(emp.employee_no, '') ILIKE ${p})`,
      );
    }
    if (query.roleKey) {
      const p = addParam(query.roleKey);
      where.push(`r.key = ${p}`);
    }
    if (query.branchId) {
      const p = addParam(query.branchId);
      where.push(`(u.all_branches = true OR EXISTS (
        SELECT 1 FROM user_branch_access filter_uba
        WHERE filter_uba.user_id = u.id AND filter_uba.branch_id = ${p}::uuid
      ))`);
    }
    if (query.status === "active") where.push("u.active = true");
    if (query.status === "inactive") where.push("u.active = false");
    if (query.status === "locked") where.push("u.locked_until IS NOT NULL AND u.locked_until > now()");

    const offset = (query.page - 1) * query.pageSize;
    const countResult = await db.query<Row & { total: number }>(
      `SELECT count(*)::int AS total
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN employees emp ON emp.id = u.employee_id
       WHERE ${where.join(" AND ")}`,
      params,
    );
    const limitParam = addParam(query.pageSize);
    const offsetParam = addParam(offset);
    const rowsResult = await db.query<UserListRow>(
      `SELECT u.id, u.username, u.full_name, u.email, u.employee_id, emp.full_name AS employee_name,
              emp.employee_no AS employee_no,
              u.active, u.all_branches, u.must_change_password,
              u.locked_until, u.last_login_at, u.created_at, u.updated_at,
              r.id AS role_id, r.key AS role_key, r.name_ar AS role_name, r.all_permissions, r.sort_order,
              COALESCE((
                SELECT json_agg(json_build_object('id', b.id, 'code', b.code, 'name', b.name, 'active', b.active) ORDER BY b.name)
                FROM user_branch_access uba
                JOIN branches b ON b.id = uba.branch_id
                WHERE uba.user_id = u.id
              ), '[]'::json) AS branches
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN employees emp ON emp.id = u.employee_id
       WHERE ${where.join(" AND ")}
       ORDER BY u.created_at DESC, u.username ASC
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    );

    const canManage = hasPermission(actor, "users.manage");
    const now = Date.now();
    const items = rowsResult.rows.map((row) => {
      const branches = parseBranches(row.branches).map((branch) => ({
        id: branch.id,
        code: branch.code,
        name: branch.name,
        active: branch.active,
      }));
      const lockedUntil = toIso(row.locked_until);
      const target = {
        id: row.id,
        allBranches: row.all_branches,
        branchIds: branches.map((branch) => branch.id),
        role: { allPermissions: row.all_permissions },
      };
      return {
        id: row.id,
        username: row.username,
        fullName: row.full_name,
        email: row.email,
        employeeId: row.employee_id,
        employeeName: row.employee_name,
        employeeNo: row.employee_no,
        active: row.active,
        allBranches: row.all_branches,
        branches,
        role: {
          id: row.role_id,
          key: row.role_key,
          nameAr: row.role_name,
          allPermissions: row.all_permissions,
          sortOrder: row.sort_order,
        },
        mustChangePassword: row.must_change_password,
        lockedUntil,
        isLocked: lockedUntil !== null && new Date(lockedUntil).getTime() > now,
        lastLoginAt: toIso(row.last_login_at),
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
        isSelf: row.id === actor.id,
        manageable: canManage && canFullyManage(actor, target),
      };
    });

    res.json({
      items,
      page: query.page,
      pageSize: query.pageSize,
      total: countResult.rows[0]?.total ?? 0,
    });
  });

  router.post("/", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const input = parseBody(createUserSchema, req.body);
    const role = await assertRoleAssignable(db, actor, input.roleKey);
    const branches = await validateBranchSelection(db, actor, input.branchIds, input.allBranches);
    await ensureUniqueIdentity(db, input.username, input.email ?? null, null);
    const employee = await resolveEmployeeLink(db, actor, input.employeeId, branches.map((branch) => branch.id), input.allBranches, null);

    const temporaryPassword = await nextTemporaryPassword(input.username);
    const passwordHash = await hashPassword(temporaryPassword);
    const userId = newId();

    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO users
          (id, username, full_name, email, password_hash, must_change_password, role_id, active, all_branches, employee_id, created_by)
         VALUES ($1, $2, $3, $4, $5, true, $6, true, $7, $8, $9)`,
        [userId, input.username, input.fullName, input.email ?? null, passwordHash, role.id, input.allBranches, employee?.id ?? null, actor.id],
      );
      for (const branch of branches) {
        await tx.query("INSERT INTO user_branch_access (user_id, branch_id) VALUES ($1, $2)", [userId, branch.id]);
      }
    });

    await writeAudit(db, logger, {
      action: "user.created",
      actor: { id: actor.id, username: actor.username },
      entityType: "user",
      entityId: userId,
      branchId: branches.length === 1 ? (branches[0]?.id ?? null) : null,
      severity: "info",
      details: {
        username: input.username,
        roleKey: role.key,
        allBranches: input.allBranches,
        branches: branches.map((branch) => branch.code),
        temporaryPasswordIssued: true,
        ...(employee ? { employeeNo: employee.employee_no } : {}),
      },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });

    res.status(201).json({
      user: { id: userId, username: input.username, fullName: input.fullName, role: role.key },
      temporaryPassword,
    });
  });

  router.patch("/:id", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const targetId = z.uuid("معرّف مستخدم غير صالح.").parse(req.params.id);
    const input = parseBody(updateUserSchema, req.body);
    const target = await getManagedUser(db, targetId);
    if (!target || !isManagedUserInScope(actor, target)) throw notFound("المستخدم غير موجود أو خارج نطاق صلاحيتك.");
    if (target.role.allPermissions && !actor.role.allPermissions) {
      throw forbidden("لا يمكنك تعديل حساب مدير نظام إلا إذا كنت مدير نظام.");
    }
    if (!canFullyManage(actor, target)) {
      if (target.id === actor.id) throw new ApiError(400, "SELF_EDIT_FORBIDDEN", "لا يمكنك تعديل حسابك من هذه الشاشة.");
      throw forbidden("لا يمكنك تعديل مستخدم مرتبط بفروع خارج نطاق صلاحيتك.");
    }

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    let newRoleId = target.role.id;
    let newRoleKey = target.role.key;
    if (input.roleKey !== undefined && input.roleKey !== target.role.key) {
      const role = await assertRoleAssignable(db, actor, input.roleKey);
      newRoleId = role.id;
      newRoleKey = role.key;
      changes.role = { from: target.role.key, to: role.key };
    }

    const newAllBranches = input.allBranches ?? target.allBranches;
    let newBranchIds = input.branchIds !== undefined ? [...new Set(input.branchIds)] : [...target.branchIds];
    if (input.allBranches === true && !actor.allBranches) {
      throw forbidden("لا يمكنك منح وصول إلى كل الفروع.");
    }
    if (newAllBranches) {
      if (input.branchIds !== undefined && input.branchIds.length > 0) {
        throw new ApiError(400, "INVALID_BRANCH_SCOPE", "لا يمكن تحديد فروع عند منح الوصول إلى كل الفروع.");
      }
      newBranchIds = [];
    } else if (input.branchIds !== undefined || (target.allBranches && input.allBranches === false)) {
      await validateBranchSelection(db, actor, newBranchIds, false);
      if (newBranchIds.length === 0) {
        throw new ApiError(400, "BRANCH_REQUIRED", "يجب تحديد فرع واحد على الأقل للمستخدم.");
      }
    }
    if (newAllBranches !== target.allBranches) {
      changes.allBranches = { from: target.allBranches, to: newAllBranches };
    }
    const targetBranchesSorted = [...target.branchIds].sort();
    const newBranchesSorted = [...newBranchIds].sort();
    if (JSON.stringify(targetBranchesSorted) !== JSON.stringify(newBranchesSorted)) {
      changes.branches = { from: targetBranchesSorted, to: newBranchesSorted };
    }

    const newActive = input.active ?? target.active;
    if (newActive !== target.active) changes.active = { from: target.active, to: newActive };

    const newFullName = input.fullName ?? target.fullName;
    const newEmail = input.email !== undefined ? (input.email ?? null) : target.email;
    if (newFullName !== target.fullName) changes.fullName = { from: target.fullName, to: newFullName };
    if ((newEmail ?? null) !== (target.email ?? null)) changes.email = { from: target.email, to: newEmail };

    const newEmployeeId = input.employeeId !== undefined ? input.employeeId : target.employeeId;
    if ((input.employeeId !== undefined && newEmployeeId !== target.employeeId) || changes.branches || changes.allBranches) {
      await resolveEmployeeLink(db, actor, newEmployeeId, newBranchIds, newAllBranches, target.id);
    }
    if (newEmployeeId !== target.employeeId) changes.employee = { from: target.employeeId, to: newEmployeeId };

    if (Object.keys(changes).length === 0) throw new ApiError(400, "NO_CHANGES", "لا توجد تغييرات لحفظها.");

    await ensureUniqueIdentity(db, target.username, newEmail, target.id);

    if (newActive === false && target.active && target.role.allPermissions) {
      const anotherAdminExists = await isActiveAdminCountAtLeast(db, 1, target.id);
      if (!anotherAdminExists) {
        throw conflict("لا يمكن تعطيل آخر حساب مدير نظام نشط.");
      }
    }

    const deactivating = target.active && newActive === false;
    const reactivating = !target.active && newActive;
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE users
         SET full_name = $2, email = $3, role_id = $4, active = $5, all_branches = $6, employee_id = $7,
             session_version = session_version + $8, updated_at = now()
         WHERE id = $1`,
        [target.id, newFullName, newEmail, newRoleId, newActive, newAllBranches, newEmployeeId, deactivating ? 1 : 0],
      );
      if (changes.branches || changes.allBranches) {
        await tx.query("DELETE FROM user_branch_access WHERE user_id = $1", [target.id]);
        for (const branchId of newBranchIds) {
          await tx.query("INSERT INTO user_branch_access (user_id, branch_id) VALUES ($1, $2)", [target.id, branchId]);
        }
      }
    });

    if (deactivating) {
      await revokeAllUserSessions(db, target.id);
    }

    let action = "user.updated";
    if (deactivating) action = "user.deactivated";
    else if (reactivating) action = "user.activated";

    await writeAudit(db, logger, {
      action,
      actor: { id: actor.id, username: actor.username },
      entityType: "user",
      entityId: target.id,
      branchId: newBranchIds.length === 1 ? (newBranchIds[0] ?? null) : null,
      severity: deactivating || changes.role || changes.allBranches ? "warning" : "info",
      details: {
        username: target.username,
        changes,
        ...(changes.role ? { newRole: newRoleKey } : {}),
        ...(deactivating ? { sessionsRevoked: true } : {}),
      },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });

    res.json({ ok: true, changed: Object.keys(changes) });
  });

  router.post("/:id/reset-password", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const targetId = z.uuid("معرّف مستخدم غير صالح.").parse(req.params.id);
    const target = await getManagedUser(db, targetId);
    if (!target || !isManagedUserInScope(actor, target)) throw notFound("المستخدم غير موجود أو خارج نطاق صلاحيتك.");
    if (target.role.allPermissions && !actor.role.allPermissions) {
      throw forbidden("لا يمكنك إعادة تعيين كلمة مرور مدير نظام إلا إذا كنت مدير نظام.");
    }
    if (!canFullyManage(actor, target)) {
      if (target.id === actor.id) throw new ApiError(400, "SELF_EDIT_FORBIDDEN", "استخدم شاشة الحساب لتغيير كلمة مرورك.");
      throw forbidden("لا يمكنك إدارة هذا المستخدم خارج نطاق صلاحيتك الكامل.");
    }

    const temporaryPassword = await nextTemporaryPassword(target.username);
    const passwordHash = await hashPassword(temporaryPassword);
    await db.query(
      `UPDATE users
       SET password_hash = $2, must_change_password = true, password_changed_at = now(),
           failed_attempts = 0, locked_until = NULL, session_version = session_version + 1, updated_at = now()
       WHERE id = $1`,
      [target.id, passwordHash],
    );
    await revokeAllUserSessions(db, target.id);

    await writeAudit(db, logger, {
      action: "user.password_reset",
      actor: { id: actor.id, username: actor.username },
      entityType: "user",
      entityId: target.id,
      severity: "warning",
      details: { username: target.username, sessionsRevoked: true, temporaryPasswordIssued: true },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });

    res.json({ temporaryPassword });
  });

  router.post("/:id/revoke-sessions", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const targetId = z.uuid("معرّف مستخدم غير صالح.").parse(req.params.id);
    const target = await getManagedUser(db, targetId);
    if (!target || !isManagedUserInScope(actor, target)) throw notFound("المستخدم غير موجود أو خارج نطاق صلاحيتك.");
    if (target.role.allPermissions && !actor.role.allPermissions) {
      throw forbidden("لا يمكنك إدارة جلسات مدير نظام إلا إذا كنت مدير نظام.");
    }
    if (!canFullyManage(actor, target)) {
      if (target.id === actor.id) throw new ApiError(400, "SELF_EDIT_FORBIDDEN", "استخدم خيار إنهاء كل الجلسات من شاشة حسابك.");
      throw forbidden("لا يمكنك إدارة هذا المستخدم خارج نطاق صلاحيتك الكامل.");
    }

    await revokeAllUserSessions(db, target.id);
    await db.query("UPDATE users SET session_version = session_version + 1, updated_at = now() WHERE id = $1", [target.id]);
    await writeAudit(db, logger, {
      action: "user.sessions_revoked",
      actor: { id: actor.id, username: actor.username },
      entityType: "user",
      entityId: target.id,
      severity: "warning",
      details: { username: target.username },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  });

  return router;
}
