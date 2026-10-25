import { Router } from "express";
import { z } from "zod";
import type { Row } from "../db/index.js";
import { notFound, parseBody, unauthorized } from "../lib/errors.js";
import { createRequireAuth, requirePasswordReady, type AuthDeps } from "../middleware/auth.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

interface NotificationRow extends Row {
  id: string;
  title: string;
  body: string;
  link: string;
  read_at: string | Date | null;
  created_at: string | Date;
}

export function createNotificationsRouter(deps: AuthDeps): Router {
  const { db } = deps;
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);

  router.get("/", async (req, res) => {
    if (!req.auth) throw unauthorized();
    const query = parseBody(listQuerySchema, req.query);
    const [items, unread] = await Promise.all([
      db.query<NotificationRow>(
        `SELECT id, title, body, link, read_at, created_at
         FROM notifications WHERE user_id = $1
         ORDER BY read_at NULLS FIRST, created_at DESC LIMIT $2`,
        [req.auth.user.id, query.limit],
      ),
      db.query<Row & { count: number }>(
        "SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL",
        [req.auth.user.id],
      ),
    ]);
    res.json({
      items: items.rows.map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        link: row.link,
        read: row.read_at !== null,
        createdAt: new Date(row.created_at).toISOString(),
      })),
      unread: unread.rows[0]?.count ?? 0,
    });
  });

  router.get("/unread-count", async (req, res) => {
    if (!req.auth) throw unauthorized();
    const result = await db.query<Row & { count: number }>(
      "SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL",
      [req.auth.user.id],
    );
    res.json({ unread: result.rows[0]?.count ?? 0 });
  });

  router.post("/:id/read", async (req, res) => {
    if (!req.auth) throw unauthorized();
    const id = z.uuid("معرّف إشعار غير صالح.").parse(req.params.id);
    const result = await db.query(
      "UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2",
      [id, req.auth.user.id],
    );
    if (result.rowCount === 0) throw notFound("الإشعار غير موجود.");
    res.json({ ok: true });
  });

  router.post("/read-all", async (req, res) => {
    if (!req.auth) throw unauthorized();
    await db.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL", [req.auth.user.id]);
    res.json({ ok: true });
  });

  return router;
}
