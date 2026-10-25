import { Router } from "express";
import { listPermissions, listRoles } from "../services/roles.js";
import { createRequireAnyPermission, createRequireAuth, requirePasswordReady, type AuthDeps } from "../middleware/auth.js";

export function createRolesRouter(deps: AuthDeps): Router {
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);

  router.get("/", createRequireAnyPermission(["roles.view", "users.manage"], deps), async (_req, res) => {
    const [roles, permissions] = await Promise.all([listRoles(deps.db), listPermissions(deps.db)]);
    res.json({ roles, permissions });
  });

  return router;
}
