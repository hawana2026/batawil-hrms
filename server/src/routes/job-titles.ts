import { Router } from "express";
import { z } from "zod";
import type { Db, Row } from "../db/index.js";
import { writeAudit } from "../lib/audit.js";
import { conflict, notFound, parseBody, requestIp, requestUserAgent, unauthorized } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { jobTitleSchema, jobTitleUpdateSchema } from "../lib/hr-schemas.js";
import { assertDepartmentUsable } from "../services/employees.js";
import { createRequireAuth, createRequirePermission, requirePasswordReady, type AuthDeps } from "../middleware/auth.js";

interface JobTitleRow extends Row {
  id: string;
  name: string;
  department_id: string | null;
  department_name: string | null;
  active: boolean;
  employees_count: number;
  created_at: string | Date;
  updated_at: string | Date;
}

function presentJobTitle(row: JobTitleRow) {
  return {
    id: row.id,
    name: row.name,
    departmentId: row.department_id,
    departmentName: row.department_name,
    active: row.active,
    employeesCount: row.employees_count,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function loadJobTitle(db: Db, id: string): Promise<JobTitleRow> {
  const result = await db.query<JobTitleRow>(
    `SELECT jt.id, jt.name, jt.department_id, d.name AS department_name, jt.active,
            (SELECT count(*)::int FROM employees e WHERE e.job_title_id = jt.id AND e.archived_at IS NULL) AS employees_count,
            jt.created_at, jt.updated_at
     FROM job_titles jt LEFT JOIN departments d ON d.id = jt.department_id
     WHERE jt.id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw notFound("المسمى الوظيفي غير موجود.");
  return row;
}

async function assertUniqueName(
  db: Db,
  name: string,
  excludeId: string | null,
): Promise<void> {
  const result = await db.query<Row & { id: string }>(
    "SELECT id FROM job_titles WHERE lower(name) = lower($1) AND ($2::uuid IS NULL OR id <> $2::uuid) LIMIT 1",
    [name, excludeId],
  );
  if (result.rows[0]) throw conflict("يوجد مسمى وظيفي بهذا الاسم بالفعل.");
}

export function createJobTitlesRouter(deps: AuthDeps): Router {
  const { db, logger } = deps;
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);

  const requireView = createRequirePermission("employees.view", deps);
  const requireManage = createRequirePermission("employees.manage", deps);

  router.get("/", requireView, async (_req, res) => {
    const result = await db.query<JobTitleRow>(
      `SELECT jt.id, jt.name, jt.department_id, d.name AS department_name, jt.active,
              (SELECT count(*)::int FROM employees e WHERE e.job_title_id = jt.id AND e.archived_at IS NULL) AS employees_count,
              jt.created_at, jt.updated_at
       FROM job_titles jt LEFT JOIN departments d ON d.id = jt.department_id
       ORDER BY jt.active DESC, jt.name`,
    );
    res.json({ items: result.rows.map(presentJobTitle) });
  });

  router.post("/", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const input = parseBody(jobTitleSchema, req.body);
    await assertUniqueName(db, input.name, null);
    await assertDepartmentUsable(db, input.departmentId ?? null);
    const id = newId();
    await db.query(
      `INSERT INTO job_titles (id, name, department_id, active, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, input.name, input.departmentId ?? null, input.active, actor.id],
    );
    await writeAudit(db, logger, {
      action: "job_title.created",
      actor: { id: actor.id, username: actor.username },
      entityType: "job_title",
      entityId: id,
      severity: "info",
      details: { name: input.name, departmentId: input.departmentId ?? null },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.status(201).json({ jobTitle: presentJobTitle(await loadJobTitle(db, id)) });
  });

  router.patch("/:id", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const id = z.uuid("معرّف مسمى وظيفي غير صالح.").parse(req.params.id);
    const input = parseBody(jobTitleUpdateSchema, req.body);
    const current = await loadJobTitle(db, id);
    const name = input.name ?? current.name;
    const departmentId = input.departmentId !== undefined ? (input.departmentId ?? null) : current.department_id;
    const active = input.active ?? current.active;
    await assertUniqueName(db, name, id);
    if (departmentId !== current.department_id) await assertDepartmentUsable(db, departmentId);
    if (name === current.name && departmentId === current.department_id && active === current.active) {
      res.json({ jobTitle: presentJobTitle(current) });
      return;
    }
    await db.transaction(async (tx) => {
      await tx.query(
        "UPDATE job_titles SET name = $2, department_id = $3, active = $4, updated_at = now() WHERE id = $1",
        [id, name, departmentId, active],
      );
      if (name !== current.name) {
        await tx.query("UPDATE employees SET job_title = $2, updated_at = now() WHERE job_title_id = $1", [id, name]);
      }
    });
    await writeAudit(db, logger, {
      action: "job_title.updated",
      actor: { id: actor.id, username: actor.username },
      entityType: "job_title",
      entityId: id,
      severity: active !== current.active ? "warning" : "info",
      details: {
        changes: {
          ...(name !== current.name ? { name: { from: current.name, to: name } } : {}),
          ...(departmentId !== current.department_id ? { departmentId: { from: current.department_id, to: departmentId } } : {}),
          ...(active !== current.active ? { active: { from: current.active, to: active } } : {}),
        },
      },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ jobTitle: presentJobTitle(await loadJobTitle(db, id)) });
  });

  return router;
}
