import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createSession } from "../src/auth/session.js";
import { loadConfig } from "../src/config.js";
import type { Row } from "../src/db/index.js";
import {
  countAudit,
  createBranch,
  createTestContext,
  login,
  loginAs,
  patch,
  post,
  seedUser,
  XHR_HEADER,
  type SeededUser,
  type TestBranch,
  type TestContext,
} from "./helpers.js";

const PASSWORDS = {
  admin: "RootPass2026!x",
  hr: "HrOfficer2026!x",
  manager: "MgrAden2026!x",
  employee: "Employee2026!x",
  forced: "ForcedTemp2026!x",
  lockme: "LockTest2026!x",
};

interface UserItem {
  id: string;
  username: string;
  active: boolean;
  isSelf: boolean;
  manageable: boolean;
  branches: Array<{ code: string }>;
  role: { key: string };
}

describe("BATAWIL Phase 1 API", () => {
  let ctx: TestContext;
  let aden: TestBranch;
  let sanaa: TestBranch;
  let admin: SeededUser;
  let hr: SeededUser;
  let manager: SeededUser;
  let employee: SeededUser;
  let forced: SeededUser;
  let lockme: SeededUser;

  before(async () => {
    ctx = await createTestContext();
    aden = await createBranch(ctx.db, "ADEN", "فرع عدن", "عدن");
    sanaa = await createBranch(ctx.db, "SANAA", "فرع صنعاء الرئيسي", "صنعاء");
    admin = await seedUser(ctx.db, {
      username: "admin",
      password: PASSWORDS.admin,
      roleKey: "admin",
      fullName: "مدير النظام",
      allBranches: true,
    });
    hr = await seedUser(ctx.db, {
      username: "hr.officer",
      password: PASSWORDS.hr,
      roleKey: "hr_officer",
      fullName: "مسؤول شؤون الموظفين",
      branchIds: [aden.id, sanaa.id],
    });
    manager = await seedUser(ctx.db, {
      username: "manager.aden",
      password: PASSWORDS.manager,
      roleKey: "branch_manager",
      fullName: "مدير فرع عدن",
      branchIds: [aden.id],
    });
    employee = await seedUser(ctx.db, {
      username: "employee.aden",
      password: PASSWORDS.employee,
      roleKey: "employee",
      fullName: "موظف فرع عدن",
      branchIds: [aden.id],
    });
    forced = await seedUser(ctx.db, {
      username: "forced.user",
      password: PASSWORDS.forced,
      roleKey: "employee",
      fullName: "مستخدم بكلمة مرور مؤقتة",
      branchIds: [aden.id],
      mustChangePassword: true,
    });
    lockme = await seedUser(ctx.db, {
      username: "lockme.user",
      password: PASSWORDS.lockme,
      roleKey: "employee",
      fullName: "حساب اختبار القفل",
      branchIds: [aden.id],
    });
  });

  after(async () => {
    await ctx.db.close();
  });

  test("a fresh database reports uninitialized and accepts no default credentials", async () => {
    const fresh = await createTestContext();
    try {
      const status = await request(fresh.app).get("/api/public/status");
      assert.equal(status.status, 200);
      assert.equal(status.body.initialized, false);
      assert.equal(status.body.passwordMinLength, 10);

      const users = await fresh.db.query<Row & { count: number }>("SELECT count(*)::int AS count FROM users");
      assert.equal(users.rows[0]?.count, 0);

      const attempt = await request(fresh.app)
        .post("/api/auth/login")
        .set("X-Requested-With", XHR_HEADER)
        .send({ username: "admin", password: "admin" });
      assert.equal(attempt.status, 401);
      assert.equal(attempt.body.error.code, "INVALID_CREDENTIALS");
    } finally {
      await fresh.db.close();
    }
  });

  test("production configuration rejects dev-only databases and plain HTTP", () => {
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: "production",
          DB_DRIVER: "pglite",
          PUBLIC_ORIGIN: "https://hrms.example.com",
        }),
      /DB_DRIVER=postgres/,
    );
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: "production",
          DB_DRIVER: "postgres",
          DATABASE_URL: "postgres://user:pass@db:5432/batawil",
          PUBLIC_ORIGIN: "http://hrms.example.com",
        }),
      /https:\/\//,
    );

    const production = loadConfig({
      NODE_ENV: "production",
      DB_DRIVER: "postgres",
      DATABASE_URL: "postgres://user:pass@db:5432/batawil",
      PUBLIC_ORIGIN: "https://hrms.example.com",
    });
    assert.equal(production.isProduction, true);
    assert.equal(production.session.secure, true);
    assert.deepEqual(production.allowedOrigins, ["https://hrms.example.com"]);
  });

  test("health check, public status and security headers are correct", async () => {
    const health = await request(ctx.app).get("/healthz");
    assert.equal(health.status, 200);
    assert.equal(health.body.status, "ok");
    assert.equal(health.headers["cache-control"], "no-store");

    const status = await request(ctx.app).get("/api/public/status");
    assert.equal(status.status, 200);
    assert.equal(status.body.product, "BATAWIL HRMS");
    assert.equal(status.body.phase, 2);
    assert.equal(status.body.initialized, true);
    assert.equal(status.body.passwordMinLength, 10);
    assert.ok(!Number.isNaN(Date.parse(status.body.serverTime)));

    assert.equal(status.headers["x-powered-by"], undefined);
    assert.equal(status.headers["strict-transport-security"], undefined);
    assert.match(String(status.headers["content-security-policy"]), /frame-ancestors 'none'/);
    assert.match(String(status.headers["content-security-policy"]), /script-src 'self'/);
    assert.match(String(status.headers["permissions-policy"]), /camera=\(\)/);
    assert.equal(status.headers["cache-control"], "no-store");

    const missing = await request(ctx.app).get("/api/status");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "NOT_FOUND");
  });

  test("mutating requests are protected against CSRF and malformed JSON", async () => {
    const credentials = { username: admin.username, password: PASSWORDS.admin };

    const noHeader = await request(ctx.app).post("/api/auth/login").send(credentials);
    assert.equal(noHeader.status, 403);
    assert.equal(noHeader.body.error.code, "CSRF_BLOCKED");

    const badOrigin = await request(ctx.app)
      .post("/api/auth/login")
      .set("Origin", "https://evil.example")
      .send(credentials);
    assert.equal(badOrigin.status, 403);
    assert.equal(badOrigin.body.error.code, "CSRF_BLOCKED");

    const allowedOrigin = await request(ctx.app)
      .post("/api/auth/login")
      .set("Origin", "http://localhost:3000")
      .send(credentials);
    assert.equal(allowedOrigin.status, 200);

    const malformed = await request(ctx.app)
      .post("/api/auth/login")
      .set("X-Requested-With", XHR_HEADER)
      .set("Content-Type", "application/json")
      .send('{"username":');
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, "INVALID_JSON");
  });

  test("login, session lookup, remember duration and logout behave correctly", async () => {
    const wrong = await login(ctx.app, admin.username, "WrongPass2026!x");
    assert.equal(wrong.response.status, 401);
    assert.equal(wrong.response.body.error.code, "INVALID_CREDENTIALS");

    const unknown = await login(ctx.app, "ghost.user", "WrongPass2026!x");
    assert.equal(unknown.response.status, 401);
    assert.equal(unknown.response.body.error.message, wrong.response.body.error.message);
    assert.equal(await countAudit(ctx.db, "auth.login_failed"), 2);

    const { agent, response } = await login(ctx.app, admin.username, PASSWORDS.admin, true);
    assert.equal(response.status, 200);
    assert.equal(response.body.user.username, "admin");
    assert.equal(response.body.user.role.key, "admin");
    assert.equal(response.body.user.allBranches, true);
    assert.equal(response.body.user.mustChangePassword, false);
    assert.equal(response.body.user.permissions.length, 37);
    assert.deepEqual(new Set(response.body.user.branches.map((b: { code: string }) => b.code)), new Set(["ADEN", "SANAA"]));
    assert.equal(response.body.session.remember, true);

    const cookies = response.headers["set-cookie"];
    assert.ok(Array.isArray(cookies));
    const sessionCookie = cookies.find((cookie: string) => cookie.startsWith("batawil_session="));
    assert.ok(sessionCookie);
    assert.match(sessionCookie, /HttpOnly/i);
    assert.match(sessionCookie, /SameSite=Lax/i);
    assert.match(sessionCookie, /Path=\//i);
    assert.match(sessionCookie, /Max-Age=604800/i);
    assert.doesNotMatch(sessionCookie, /Secure/i);

    const session = await agent.get("/api/auth/session");
    assert.equal(session.status, 200);
    assert.equal(session.body.user.username, "admin");
    assert.equal(session.body.session.remember, true);

    const logout = await post(agent, "/api/auth/logout");
    assert.equal(logout.status, 204);
    const afterLogout = await agent.get("/api/auth/session");
    assert.equal(afterLogout.status, 401);
    assert.equal(await countAudit(ctx.db, "auth.logout"), 1);
  });

  test("temporary passwords force a change before any management API can be used", async () => {
    const { agent, response } = await login(ctx.app, forced.username, PASSWORDS.forced);
    assert.equal(response.status, 200);
    assert.equal(response.body.user.mustChangePassword, true);

    const blocked = await agent.get("/api/users");
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, "PASSWORD_CHANGE_REQUIRED");

    const wrongCurrent = await post(agent, "/api/auth/change-password", {
      currentPassword: "NopePass2026!x",
      newPassword: "ForcedNew2026!x",
    });
    assert.equal(wrongCurrent.status, 400);
    assert.equal(wrongCurrent.body.error.code, "INVALID_CURRENT_PASSWORD");

    const weak = await post(agent, "/api/auth/change-password", {
      currentPassword: PASSWORDS.forced,
      newPassword: "short1",
    });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.error.code, "WEAK_PASSWORD");

    const reused = await post(agent, "/api/auth/change-password", {
      currentPassword: PASSWORDS.forced,
      newPassword: PASSWORDS.forced,
    });
    assert.equal(reused.status, 400);
    assert.equal(reused.body.error.code, "PASSWORD_REUSED");

    const changed = await post(agent, "/api/auth/change-password", {
      currentPassword: PASSWORDS.forced,
      newPassword: "ForcedNew2026!x",
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.user.mustChangePassword, false);
    assert.ok(changed.body.session.expiresAt);

    const allowed = await agent.get("/api/dashboard");
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.users, null);

    const oldLogin = await login(ctx.app, forced.username, PASSWORDS.forced);
    assert.equal(oldLogin.response.status, 401);
    const newLogin = await login(ctx.app, forced.username, "ForcedNew2026!x");
    assert.equal(newLogin.response.status, 200);
    assert.equal(newLogin.response.body.user.mustChangePassword, false);
    assert.ok((await countAudit(ctx.db, "auth.password_changed")) >= 1);
  });

  test("administrators can create, update, reset and deactivate users", async () => {
    const agent = await loginAs(ctx.app, admin.username, PASSWORDS.admin);

    const list = await agent.get("/api/users");
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 6);
    const items = list.body.items as UserItem[];
    const adminRow = items.find((item) => item.username === "admin");
    assert.ok(adminRow);
    assert.equal(adminRow.isSelf, true);
    assert.equal(adminRow.manageable, false);
    const employeeRow = items.find((item) => item.username === "employee.aden");
    assert.ok(employeeRow);
    assert.equal(employeeRow.manageable, true);
    assert.equal(employeeRow.role.key, "employee");
    assert.deepEqual(employeeRow.branches.map((branch) => branch.code), ["ADEN"]);

    const created = await post(agent, "/api/users", {
      username: "new.manager",
      fullName: "مدير جديد",
      email: "New.Manager@Example.test",
      roleKey: "branch_manager",
      branchIds: [aden.id],
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.user.role, "branch_manager");
    assert.equal(created.body.temporaryPassword.length, 14);
    const createdId = created.body.user.id as string;

    const duplicate = await post(agent, "/api/users", {
      username: "new.manager",
      fullName: "مكرر",
      roleKey: "employee",
      branchIds: [aden.id],
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, "CONFLICT");

    const update = await patch(agent, `/api/users/${createdId}`, { fullName: "مدير محدث" });
    assert.equal(update.status, 200);
    assert.deepEqual(update.body.changed, ["fullName"]);

    const reset = await post(agent, `/api/users/${createdId}/reset-password`);
    assert.equal(reset.status, 200);
    assert.equal(reset.body.temporaryPassword.length, 14);
    assert.notEqual(reset.body.temporaryPassword, created.body.temporaryPassword);

    const deactivate = await patch(agent, `/api/users/${createdId}`, { active: false });
    assert.equal(deactivate.status, 200);
    assert.deepEqual(deactivate.body.changed, ["active"]);

    const noChanges = await patch(agent, `/api/users/${createdId}`, { active: false });
    assert.equal(noChanges.status, 400);
    assert.equal(noChanges.body.error.code, "NO_CHANGES");

    const reactivate = await patch(agent, `/api/users/${createdId}`, { active: true });
    assert.equal(reactivate.status, 200);

    const selfEdit = await patch(agent, `/api/users/${admin.id}`, { fullName: "اسم مختلف" });
    assert.equal(selfEdit.status, 400);
    assert.equal(selfEdit.body.error.code, "SELF_EDIT_FORBIDDEN");

    assert.ok((await countAudit(ctx.db, "user.created")) >= 1);
    assert.ok((await countAudit(ctx.db, "user.updated")) >= 1);
    assert.ok((await countAudit(ctx.db, "user.password_reset")) >= 1);
    assert.ok((await countAudit(ctx.db, "user.deactivated")) >= 1);
    assert.ok((await countAudit(ctx.db, "user.activated")) >= 1);

    const updatedList = await agent.get("/api/users");
    assert.equal(updatedList.body.total, 7);
  });

  test("branch management is centralized and protected", async () => {
    const adminAgent = await loginAs(ctx.app, admin.username, PASSWORDS.admin);

    const list = await adminAgent.get("/api/branches");
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 2);
    assert.equal(list.body.items[0].userCount >= 0, true);

    const created = await post(adminAgent, "/api/branches", {
      code: "hodeidah",
      name: "فرع الحديدة",
      city: "الحديدة",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.branch.code, "HODEIDAH");
    assert.equal(created.body.branch.active, true);
    const createdId = created.body.branch.id as string;

    const duplicate = await post(adminAgent, "/api/branches", { code: "HODEIDAH", name: "مكرر" });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, "CONFLICT");

    const renamed = await patch(adminAgent, `/api/branches/${createdId}`, { city: "الحديدة الساحلية" });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.branch.city, "الحديدة الساحلية");

    const deactivated = await patch(adminAgent, `/api/branches/${createdId}`, { active: false });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.branch.active, false);
    assert.ok((await countAudit(ctx.db, "branch.deactivated")) >= 1);

    const blocked = await patch(adminAgent, `/api/branches/${aden.id}`, { active: false });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "CONFLICT");

    const reactivated = await patch(adminAgent, `/api/branches/${createdId}`, { active: true });
    assert.equal(reactivated.status, 200);
    assert.equal(reactivated.body.branch.active, true);

    const managerAgent = await loginAs(ctx.app, manager.username, PASSWORDS.manager);
    const denied = await post(managerAgent, "/api/branches", { code: "TAIZ", name: "فرع تعز" });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "FORBIDDEN");

    const denial = await ctx.db.query<Row & { count: number }>(
      `SELECT count(*)::int AS count FROM audit_logs
       WHERE action = 'security.permission_denied'
         AND actor_username = $1
         AND details->>'permission' = 'branches.manage'`,
      [manager.username],
    );
    assert.ok((denial.rows[0]?.count ?? 0) >= 1);
  });

  test("the role and permission catalog reflects the seeded policy", async () => {
    const adminAgent = await loginAs(ctx.app, admin.username, PASSWORDS.admin);
    const catalog = await adminAgent.get("/api/roles");
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.roles.length, 8);
    assert.equal(catalog.body.permissions.length, 37);
    const adminRole = catalog.body.roles.find((role: { key: string }) => role.key === "admin");
    const employeeRole = catalog.body.roles.find((role: { key: string }) => role.key === "employee");
    assert.equal(adminRole.allPermissions, true);
    assert.equal(adminRole.permissionKeys.length, 37);
    assert.deepEqual(employeeRole.permissionKeys, []);

    const employeeAgent = await loginAs(ctx.app, employee.username, PASSWORDS.employee);
    const denied = await employeeAgent.get("/api/roles");
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "FORBIDDEN");
    const denial = await ctx.db.query<Row & { count: number }>(
      "SELECT count(*)::int AS count FROM audit_logs WHERE action = 'security.permission_denied' AND actor_username = $1",
      [employee.username],
    );
    assert.ok((denial.rows[0]?.count ?? 0) >= 1);
  });

  test("dashboard metrics respect the capabilities of the viewer", async () => {
    const adminAgent = await loginAs(ctx.app, admin.username, PASSWORDS.admin);
    const adminDashboard = await adminAgent.get("/api/dashboard");
    assert.equal(adminDashboard.status, 200);
    assert.equal(adminDashboard.body.users.total, 7);
    assert.equal(adminDashboard.body.branches.total, 3);
    assert.ok(adminDashboard.body.audit.last24h > 0);
    assert.ok(adminDashboard.body.recentActivity.length > 0);
    assert.deepEqual(adminDashboard.body.capabilities, {
      canViewUsers: true,
      canViewBranches: true,
      canViewAudit: true,
    });

    const employeeAgent = await loginAs(ctx.app, employee.username, PASSWORDS.employee);
    const employeeDashboard = await employeeAgent.get("/api/dashboard");
    assert.equal(employeeDashboard.status, 200);
    assert.equal(employeeDashboard.body.users, null);
    assert.equal(employeeDashboard.body.branches, null);
    assert.equal(employeeDashboard.body.audit, null);
    assert.deepEqual(employeeDashboard.body.recentActivity, []);
    assert.deepEqual(employeeDashboard.body.capabilities, {
      canViewUsers: false,
      canViewBranches: false,
      canViewAudit: false,
    });
  });

  test("the audit trail is queryable, filterable and immutable", async () => {
    const adminAgent = await loginAs(ctx.app, admin.username, PASSWORDS.admin);

    const firstPage = await adminAgent.get("/api/audit?page=1&pageSize=5");
    assert.equal(firstPage.status, 200);
    assert.equal(firstPage.body.items.length, 5);
    assert.ok(firstPage.body.total > 5);
    assert.equal(firstPage.body.pageSize, 5);

    const secondPage = await adminAgent.get("/api/audit?page=2&pageSize=5");
    assert.equal(secondPage.status, 200);
    assert.notEqual(firstPage.body.items[0].id, secondPage.body.items[0].id);

    const filtered = await adminAgent.get("/api/audit?action=auth.login&pageSize=50");
    assert.equal(filtered.status, 200);
    assert.ok(filtered.body.items.length > 0);
    for (const item of filtered.body.items) assert.equal(item.action, "auth.login");

    const invalid = await adminAgent.get("/api/audit?page=0");
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, "VALIDATION_ERROR");

    const employeeAgent = await loginAs(ctx.app, employee.username, PASSWORDS.employee);
    const denied = await employeeAgent.get("/api/audit");
    assert.equal(denied.status, 403);
    const denial = await ctx.db.query<Row & { count: number }>(
      `SELECT count(*)::int AS count FROM audit_logs
       WHERE action = 'security.permission_denied'
         AND actor_username = $1
         AND details->>'permission' = 'audit.view'`,
      [employee.username],
    );
    assert.ok((denial.rows[0]?.count ?? 0) >= 1);

    await assert.rejects(async () => {
      await ctx.db.query("UPDATE audit_logs SET severity = 'info'");
    }, /append-only/);
    await assert.rejects(async () => {
      await ctx.db.query("DELETE FROM audit_logs");
    }, /append-only/);
    await assert.rejects(async () => {
      await ctx.db.query("TRUNCATE audit_logs");
    }, /append-only/);
  });

  test("expired and revoked sessions are rejected", async () => {
    const version = await ctx.db.query<Row & { session_version: number }>(
      "SELECT session_version FROM users WHERE id = $1",
      [admin.id],
    );
    const created = await createSession(ctx.db, ctx.config, {
      userId: admin.id,
      sessionVersion: version.rows[0]?.session_version ?? 1,
      remember: false,
      ip: "test",
      userAgent: "test",
    });
    await ctx.db.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [created.id]);

    const expired = await request(ctx.app)
      .get("/api/auth/session")
      .set("Cookie", `${ctx.config.session.cookieName}=${created.token}`);
    assert.equal(expired.status, 401);

    const stored = await ctx.db.query<Row & { revoked_at: string | Date | null }>(
      "SELECT revoked_at FROM sessions WHERE id = $1",
      [created.id],
    );
    assert.ok(stored.rows[0]?.revoked_at);
  });

  test("logout-all revokes every other session of the account", async () => {
    const first = await loginAs(ctx.app, admin.username, PASSWORDS.admin);
    const second = await loginAs(ctx.app, admin.username, PASSWORDS.admin);

    const all = await post(first, "/api/auth/logout-all");
    assert.equal(all.status, 204);

    assert.equal((await first.get("/api/auth/session")).status, 401);
    assert.equal((await second.get("/api/auth/session")).status, 401);
    assert.ok((await countAudit(ctx.db, "auth.logout_all")) >= 1);
  });

  test("resetting a password revokes existing sessions and forces a new change", async () => {
    const adminAgent = await loginAs(ctx.app, admin.username, PASSWORDS.admin);
    const employeeAgent = await loginAs(ctx.app, employee.username, PASSWORDS.employee);
    assert.equal((await employeeAgent.get("/api/auth/session")).status, 200);

    const reset = await post(adminAgent, `/api/users/${employee.id}/reset-password`);
    assert.equal(reset.status, 200);
    assert.equal(reset.body.temporaryPassword.length, 14);

    assert.equal((await employeeAgent.get("/api/auth/session")).status, 401);
    const oldLogin = await login(ctx.app, employee.username, PASSWORDS.employee);
    assert.equal(oldLogin.response.status, 401);

    const tempLogin = await login(ctx.app, employee.username, reset.body.temporaryPassword);
    assert.equal(tempLogin.response.status, 200);
    assert.equal(tempLogin.response.body.user.mustChangePassword, true);
  });

  test("repeated password failures lock the account and are audited", async () => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const failed = await login(ctx.app, lockme.username, "WrongLock2026!x");
      assert.equal(failed.response.status, 401);
    }
    const fifth = await login(ctx.app, lockme.username, "WrongLock2026!x");
    assert.equal(fifth.response.status, 429);
    assert.equal(fifth.response.body.error.code, "ACCOUNT_LOCKED");
    assert.equal(fifth.response.body.error.details.retryAfterMinutes, 15);

    const correctWhileLocked = await login(ctx.app, lockme.username, PASSWORDS.lockme);
    assert.equal(correctWhileLocked.response.status, 429);

    const stored = await ctx.db.query<Row & { failed_attempts: number; locked_until: string | Date | null }>(
      "SELECT failed_attempts, locked_until FROM users WHERE id = $1",
      [lockme.id],
    );
    assert.equal(stored.rows[0]?.failed_attempts, 5);
    assert.ok(stored.rows[0]?.locked_until);

    const lockAudit = await ctx.db.query<Row & { severity: string }>(
      "SELECT severity FROM audit_logs WHERE action = 'auth.account_locked' ORDER BY id DESC LIMIT 1",
    );
    assert.equal(lockAudit.rows[0]?.severity, "critical");
  });

  test("login attempts are throttled per IP address", async () => {
    const sample = await ctx.db.query<Row & { ip: string }>(
      "SELECT ip FROM login_attempts WHERE success = false AND ip <> '' ORDER BY id LIMIT 1",
    );
    const ip = sample.rows[0]?.ip;
    assert.ok(ip);
    const window = await ctx.db.query<Row & { count: number }>(
      `SELECT count(*)::int AS count FROM login_attempts
       WHERE ip = $1 AND success = false AND created_at > now() - make_interval(mins => $2)`,
      [ip, ctx.config.security.ipWindowMinutes],
    );
    const current = window.rows[0]?.count ?? 0;
    const missing = Math.max(0, ctx.config.security.maxIpFailures - current);
    for (let attempt = 0; attempt < missing; attempt += 1) {
      await ctx.db.query("INSERT INTO login_attempts (username, ip, success) VALUES ($1, $2, false)", [
        "spray.user",
        ip,
      ]);
    }

    const limited = await login(ctx.app, "spray.user", "SprayPass2026!x");
    assert.equal(limited.response.status, 429);
    assert.equal(limited.response.body.error.code, "RATE_LIMITED");
  });
});
