import { Router } from "express";
import { z } from "zod";
import type { Row } from "../db/index.js";
import { departmentSchema } from "../lib/hr-schemas.js";
import { writeAudit } from "../lib/audit.js";
import { conflict, notFound, parseBody, requestIp, requestUserAgent, unauthorized } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { createRequireAuth, createRequireAnyPermission, createRequirePermission, requirePasswordReady, type AuthDeps } from "../middleware/auth.js";

interface DepartmentRow extends Row {
  id: string;
  name: string;
  active: boolean;
  employees_count: number;
  created_at: string | Date;
}

export function createDepartmentsRouter(deps: AuthDeps): Router {
  const { db, logger } = deps;
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);

  const requireView = createRequireAnyPermission(["employees.view", "attendance.view", "settings.view"], deps);
  const requireManage = createRequireAnyPermission(["employees.manage", "settings.manage"], deps);

  router.get("/", requireView, async (req, res) => {
    const includeInactive = req.query.includeInactive === "true";
    const result = await db.query<DepartmentRow>(
      `SELECT d.id, d.name, d.active, d.created_at,
              (SELECT count(*)::int FROM employees e WHERE e.department_id = d.id AND e.archived_at IS NULL) AS employees_count
       FROM departments d
       ${includeInactive ? "" : "WHERE d.active = true"}
       ORDER BY d.active DESC, d.name`,
    );
    res.json({
      items: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        active: row.active,
        employeesCount: row.employees_count,
        createdAt: new Date(row.created_at).toISOString(),
      })),
    });
  });

  router.post("/", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const input = parseBody(departmentSchema, req.body);
    const existing = await db.query<Row & { id: string }>("SELECT id FROM departments WHERE lower(name) = lower($1)", [input.name]);
    if (existing.rows[0]) throw conflict("يوجد قسم بنفس الاسم.");
    const id = newId();
    await db.query("INSERT INTO departments (id, name, active, created_by) VALUES ($1, $2, $3, $4)", [
      id,
      input.name,
      input.active,
      req.auth.user.id,
    ]);
    await writeAudit(db, logger, {
      action: "department.created",
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "department",
      entityId: id,
      severity: "info",
      details: { name: input.name },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.status(201).json({ id, name: input.name, active: input.active, employeesCount: 0 });
  });

  router.patch("/:id", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const id = z.uuid("معرّف قسم غير صالح.").parse(req.params.id);
    const input = parseBody(departmentSchema.partial(), req.body);
    const current = await db.query<Row & { name: string; active: boolean }>("SELECT name, active FROM departments WHERE id = $1", [id]);
    const row = current.rows[0];
    if (!row) throw notFound("القسم غير موجود.");
    if (input.name && input.name.toLowerCase() !== row.name.toLowerCase()) {
      const duplicate = await db.query<Row & { id: string }>(
        "SELECT id FROM departments WHERE lower(name) = lower($1) AND id <> $2",
        [input.name, id],
      );
      if (duplicate.rows[0]) throw conflict("يوجد قسم بنفس الاسم.");
    }
    const name = input.name ?? row.name;
    const active = input.active ?? row.active;
    await db.query("UPDATE departments SET name = $2, active = $3, updated_at = now() WHERE id = $1", [id, name, active]);
    await writeAudit(db, logger, {
      action: "department.updated",
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "department",
      entityId: id,
      severity: "info",
      details: { from: { name: row.name, active: row.active }, to: { name, active } },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  });

  return router;
}
