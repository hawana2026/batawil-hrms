import { Router } from "express";
import type { Row } from "../db/index.js";
import { MIN_PASSWORD_LENGTH } from "../auth/password.js";
import type { AuthDeps } from "../middleware/auth.js";

export function createPublicRouter({ db }: AuthDeps): Router {
  const router = Router();

  router.get("/status", async (_req, res) => {
    const result = await db.query<Row & { count: number }>("SELECT count(*)::int AS count FROM users");
    res.json({
      product: "BATAWIL HRMS",
      phase: 2,
      initialized: (result.rows[0]?.count ?? 0) > 0,
      passwordMinLength: MIN_PASSWORD_LENGTH,
      serverTime: new Date().toISOString(),
    });
  });

  return router;
}
