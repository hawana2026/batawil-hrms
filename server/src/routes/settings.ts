import { Router } from "express";
import type { Row } from "../db/index.js";
import { hasPermission } from "../auth/types.js";
import { writeAudit } from "../lib/audit.js";
import { parseBody, requestIp, requestUserAgent, unauthorized } from "../lib/errors.js";
import { settingsSchema } from "../lib/hr-schemas.js";
import { getSettings } from "../services/settings.js";
import { createRequireAuth, createRequirePermission, requirePasswordReady, type AuthDeps } from "../middleware/auth.js";

export function createSettingsRouter(deps: AuthDeps): Router {
  const { db, logger } = deps;
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);
  const requireView = createRequirePermission("settings.view", deps);
  const requireManage = createRequirePermission("settings.manage", deps);

  router.get("/", requireView, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const settings = await getSettings(db);
    const updated = await db.query<Row & { key: string; updated_at: string | Date }>(
      "SELECT key, updated_at FROM system_settings ORDER BY key",
    );
    res.json({
      ...settings,
      updatedAt: Object.fromEntries(updated.rows.map((row) => [row.key, new Date(row.updated_at).toISOString()])),
      capabilities: { canManage: hasPermission(req.auth.user, "settings.manage") },
    });
  });

  router.patch("/", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const input = parseBody(settingsSchema, req.body);
    if (!input.company && !input.attendance) {
      res.json({ ok: true, changed: [] });
      return;
    }
    const current = await getSettings(db);
    const changed: string[] = [];
    await db.transaction(async (tx) => {
      if (input.company) {
        const merged = { ...current.company, ...input.company };
        await tx.query(
          `INSERT INTO system_settings (key, value, updated_by, updated_at)
           VALUES ('company', $1::jsonb, $2, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [JSON.stringify(merged), req.auth?.user.id ?? null],
        );
        changed.push("company");
      }
      if (input.attendance) {
        const merged = {
          ...current.attendance,
          ...input.attendance,
          weekendDays: [...new Set(input.attendance.weekendDays)].sort((a, b) => a - b),
        };
        await tx.query(
          `INSERT INTO system_settings (key, value, updated_by, updated_at)
           VALUES ('attendance', $1::jsonb, $2, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [JSON.stringify(merged), req.auth?.user.id ?? null],
        );
        changed.push("attendance");
      }
    });
    await writeAudit(db, logger, {
      action: "settings.updated",
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "settings",
      severity: "warning",
      details: { changed, ...(input.company ? { company: input.company } : {}), ...(input.attendance ? { attendance: input.attendance } : {}) },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true, changed, settings: await getSettings(db) });
  });

  return router;
}
