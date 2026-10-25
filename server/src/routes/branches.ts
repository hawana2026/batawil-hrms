import { Router } from "express";
import { z } from "zod";
import type { Db, Row } from "../db/index.js";
import { hasPermission, type AuthUser } from "../auth/types.js";
import { writeAudit } from "../lib/audit.js";
import { ApiError, conflict, forbidden, notFound, parseBody, requestIp, requestUserAgent, unauthorized } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { createRequireAuth, createRequirePermission, requirePasswordReady, type AuthDeps } from "../middleware/auth.js";

const codeSchema = z
  .string()
  .trim()
  .min(2, "رمز الفرع قصير جداً.")
  .max(20, "رمز الفرع طويل جداً.")
  .regex(/^[A-Za-z0-9_-]+$/, "رمز الفرع يسمح بالحروف والأرقام والشرطة فقط.")
  .transform((value) => value.toUpperCase());

const createBranchSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(2, "اسم الفرع مطلوب.").max(100, "اسم الفرع طويل جداً."),
  city: z.string().trim().max(100).default(""),
});

const updateBranchSchema = z
  .object({
    code: codeSchema.optional(),
    name: z.string().trim().min(2, "اسم الفرع مطلوب.").max(100).optional(),
    city: z.string().trim().max(100).optional(),
    active: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), { message: "لا توجد تغييرات لحفظها." });

interface BranchRow extends Row {
  id: string;
  code: string;
  name: string;
  city: string;
  active: boolean;
  created_at: string | Date;
  updated_at: string | Date;
  user_count: number;
  active_user_count: number;
}

function toIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function serializeBranch(row: BranchRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    city: row.city,
    active: row.active,
    userCount: row.user_count,
    activeUserCount: row.active_user_count,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const branchSelect = `
  SELECT b.id, b.code, b.name, b.city, b.active, b.created_at, b.updated_at,
         (SELECT count(*)::int FROM user_branch_access uba WHERE uba.branch_id = b.id) AS user_count,
         (SELECT count(*)::int FROM user_branch_access uba JOIN users u ON u.id = uba.user_id
          WHERE uba.branch_id = b.id AND u.active = true) AS active_user_count
  FROM branches b
`;

async function loadBranch(db: Db, id: string): Promise<BranchRow | null> {
  const result = await db.query<BranchRow>(`${branchSelect} WHERE b.id = $1`, [id]);
  return result.rows[0] ?? null;
}

function assertCanManageBranches(actor: AuthUser): void {
  if (!hasPermission(actor, "branches.manage")) throw forbidden();
  if (!actor.allBranches) throw forbidden("إدارة الفروع متاحة للمستخدمين ذوي الوصول إلى كل الفروع فقط.");
}

async function ensureUniqueCode(db: Db, code: string, excludeId: string | null): Promise<void> {
  const result = await db.query<Row & { id: string; code: string }>(
    "SELECT id, code FROM branches WHERE upper(code) = upper($1) AND ($2::uuid IS NULL OR id <> $2::uuid) LIMIT 1",
    [code, excludeId],
  );
  if (result.rows[0]) throw conflict("رمز الفرع مستخدم بالفعل.");
}

export function createBranchesRouter(deps: AuthDeps): Router {
  const { db, logger } = deps;
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);
  const requireView = createRequirePermission("branches.view", deps);
  const requireManage = createRequirePermission("branches.manage", deps);

  router.get("/", requireView, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    let result;
    if (actor.allBranches) {
      result = await db.query<BranchRow>(`${branchSelect} ORDER BY b.active DESC, b.name ASC`);
    } else {
      const ids = actor.branches.map((branch) => branch.id);
      result = ids.length
        ? await db.query<BranchRow>(`${branchSelect} WHERE b.id = ANY($1::uuid[]) ORDER BY b.active DESC, b.name ASC`, [ids])
        : { rows: [] as BranchRow[] };
    }
    res.json({ items: result.rows.map(serializeBranch) });
  });

  router.post("/", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    assertCanManageBranches(actor);
    const input = parseBody(createBranchSchema, req.body);
    await ensureUniqueCode(db, input.code, null);
    const id = newId();
    await db.query(
      `INSERT INTO branches (id, code, name, city, active, created_by)
       VALUES ($1, $2, $3, $4, true, $5)`,
      [id, input.code, input.name, input.city, actor.id],
    );
    await writeAudit(db, logger, {
      action: "branch.created",
      actor: { id: actor.id, username: actor.username },
      entityType: "branch",
      entityId: id,
      branchId: id,
      details: { code: input.code, name: input.name, city: input.city },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    const created = await loadBranch(db, id);
    if (!created) throw new ApiError(500, "INTERNAL_ERROR", "تعذر تحميل الفرع بعد إنشائه.");
    res.status(201).json({ branch: serializeBranch(created) });
  });

  router.patch("/:id", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    assertCanManageBranches(actor);
    const branchId = z.uuid("معرّف فرع غير صالح.").parse(req.params.id);
    const input = parseBody(updateBranchSchema, req.body);
    const existing = await loadBranch(db, branchId);
    if (!existing) throw notFound("الفرع غير موجود.");

    const newActive = input.active ?? existing.active;
    const newCode = input.code ?? existing.code;
    const newName = input.name ?? existing.name;
    const newCity = input.city ?? existing.city;

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (newCode !== existing.code) changes.code = { from: existing.code, to: newCode };
    if (newName !== existing.name) changes.name = { from: existing.name, to: newName };
    if (newCity !== existing.city) changes.city = { from: existing.city, to: newCity };
    if (newActive !== existing.active) changes.active = { from: existing.active, to: newActive };
    if (Object.keys(changes).length === 0) throw new ApiError(400, "NO_CHANGES", "لا توجد تغييرات لحفظها.");

    if (newCode !== existing.code) await ensureUniqueCode(db, newCode, existing.id);

    const deactivating = existing.active && !newActive;
    if (deactivating) {
      if (existing.active_user_count > 0) {
        throw conflict("لا يمكن تعطيل فرع مرتبط بمستخدمين نشطين. أعد إسناد المستخدمين أولاً.", {
          activeUsers: existing.active_user_count,
        });
      }
      const remaining = await db.query<Row & { count: number }>(
        "SELECT count(*)::int AS count FROM branches WHERE active = true AND id <> $1",
        [existing.id],
      );
      if ((remaining.rows[0]?.count ?? 0) === 0) {
        throw conflict("لا يمكن تعطيل آخر فرع نشط في النظام.");
      }
    }

    await db.query(
      `UPDATE branches SET code = $2, name = $3, city = $4, active = $5, updated_at = now() WHERE id = $1`,
      [existing.id, newCode, newName, newCity, newActive],
    );

    const action = deactivating ? "branch.deactivated" : !existing.active && newActive ? "branch.activated" : "branch.updated";
    await writeAudit(db, logger, {
      action,
      actor: { id: actor.id, username: actor.username },
      entityType: "branch",
      entityId: existing.id,
      branchId: existing.id,
      severity: deactivating ? "warning" : "info",
      details: { changes },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });

    const updated = await loadBranch(db, existing.id);
    if (!updated) throw new ApiError(500, "INTERNAL_ERROR", "تعذر تحميل الفرع بعد تحديثه.");
    res.json({ branch: serializeBranch(updated) });
  });

  return router;
}
