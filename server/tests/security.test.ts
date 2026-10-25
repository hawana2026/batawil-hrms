import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
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
  type SeededUser,
  type TestBranch,
  type TestContext,
} from "./helpers.js";

const PASSWORDS = {
  admin: "RootPass2026!x",
  hrAden: "HrAdenPass2026!x",
  hrSanaa: "HrSanaaPass2026!x",
  managerAden: "MgrAdenPass2026!x",
  managerSanaa: "MgrSanaaPass2026!x",
  employeeAden: "EmpAdenPass2026!x",
  employeeSanaa: "EmpSanaaPass2026!x",
  execAden: "ExecAdenPass2026!x",
  disabled: "DisabledPass2026!x",
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

interface AuditItem {
  actorUsername: string;
  action: string;
  branchId: string | null;
  branchName: string | null;
  details: Record<string, unknown>;
}

describe("BATAWIL Phase 1 security boundaries", () => {
  let ctx: TestContext;
  let aden: TestBranch;
  let sanaa: TestBranch;
  let hodeidah: TestBranch;
  let admin: SeededUser;
  let hrAden: SeededUser;
  let hrSanaa: SeededUser;
  let managerAden: SeededUser;
  let managerSanaa: SeededUser;
  let employeeAden: SeededUser;
  let employeeSanaa: SeededUser;
  let execAden: SeededUser;

  before(async () => {
    ctx = await createTestContext();
    aden = await createBranch(ctx.db, "ADEN", "فرع عدن", "عدن");
    sanaa = await createBranch(ctx.db, "SANAA", "فرع صنعاء الرئيسي", "صنعاء");
    hodeidah = await createBranch(ctx.db, "HODEIDAH", "فرع الحديدة", "الحديدة");
    admin = await seedUser(ctx.db, {
      username: "admin",
      password: PASSWORDS.admin,
      roleKey: "admin",
      allBranches: true,
    });
    hrAden = await seedUser(ctx.db, {
      username: "hr.aden",
      password: PASSWORDS.hrAden,
      roleKey: "hr_officer",
      branchIds: [aden.id],
    });
    hrSanaa = await seedUser(ctx.db, {
      username: "hr.sanaa",
      password: PASSWORDS.hrSanaa,
      roleKey: "hr_officer",
      branchIds: [sanaa.id],
    });
    managerAden = await seedUser(ctx.db, {
      username: "manager.aden",
      password: PASSWORDS.managerAden,
      roleKey: "branch_manager",
      branchIds: [aden.id],
    });
    managerSanaa = await seedUser(ctx.db, {
      username: "manager.sanaa",
      password: PASSWORDS.managerSanaa,
      roleKey: "branch_manager",
      branchIds: [sanaa.id],
    });
    employeeAden = await seedUser(ctx.db, {
      username: "employee.aden",
      password: PASSWORDS.employeeAden,
      roleKey: "employee",
      branchIds: [aden.id],
    });
    employeeSanaa = await seedUser(ctx.db, {
      username: "employee.sanaa",
      password: PASSWORDS.employeeSanaa,
      roleKey: "employee",
      branchIds: [sanaa.id],
    });
    execAden = await seedUser(ctx.db, {
      username: "exec.aden",
      password: PASSWORDS.execAden,
      roleKey: "executive",
      branchIds: [aden.id],
    });
    await seedUser(ctx.db, {
      username: "disabled.user",
      password: PASSWORDS.disabled,
      roleKey: "employee",
      branchIds: [sanaa.id],
      active: false,
    });
  });

  after(async () => {
    await ctx.db.close();
  });

  test("branch managers see only users, branches and metrics inside their scope", async () => {
    const agent = await loginAs(ctx.app, managerAden.username, PASSWORDS.managerAden);

    const users = await agent.get("/api/users?pageSize=100");
    assert.equal(users.status, 200);
    assert.equal(users.body.total, 4);
    const usernames = (users.body.items as UserItem[]).map((item) => item.username).sort();
    assert.deepEqual(usernames, ["employee.aden", "exec.aden", "hr.aden", "manager.aden"]);
    for (const forbidden of ["admin", "manager.sanaa", "employee.sanaa", "hr.sanaa"]) {
      assert.equal(usernames.includes(forbidden), false);
    }

    const crossBranchFilter = await agent.get(`/api/users?branchId=${sanaa.id}`);
    assert.equal(crossBranchFilter.status, 200);
    assert.equal(crossBranchFilter.body.total, 0);
    assert.deepEqual(crossBranchFilter.body.items, []);

    const search = await agent.get("/api/users?q=employee.sanaa");
    assert.equal(search.body.total, 0);

    const branches = await agent.get("/api/branches");
    assert.equal(branches.status, 200);
    assert.equal(branches.body.items.length, 1);
    assert.equal(branches.body.items[0].code, "ADEN");

    const meta = await agent.get("/api/meta");
    assert.equal(meta.status, 200);
    assert.deepEqual(meta.body.branches.map((branch: { code: string }) => branch.code), ["ADEN"]);
    assert.equal(meta.body.roles.length, 8);
    assert.equal(meta.body.roles[0].permissionKeys, undefined);
    assert.deepEqual(
      {
        manageUsers: meta.body.capabilities.manageUsers,
        manageBranches: meta.body.capabilities.manageBranches,
        viewRoles: meta.body.capabilities.viewRoles,
        viewAudit: meta.body.capabilities.viewAudit,
      },
      { manageUsers: false, manageBranches: false, viewRoles: false, viewAudit: false },
    );
    assert.equal(meta.body.capabilities.viewEmployees, true);
    assert.equal(meta.body.capabilities.manageAttendance, true);
    assert.equal(meta.body.capabilities.submitAttendance, true);
    assert.equal(meta.body.capabilities.approveAttendance, false);
    assert.equal(meta.body.capabilities.manageAdvances, true);
    assert.equal(meta.body.capabilities.approveAdvancesFinance, false);
    assert.equal(meta.body.capabilities.manageSettings, false);

    const dashboard = await agent.get("/api/dashboard");
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.body.users.total, 4);
    assert.equal(dashboard.body.branches.total, 1);
    assert.deepEqual(dashboard.body.branchList.map((branch: { code: string }) => branch.code), ["ADEN"]);
    assert.equal(dashboard.body.audit, null);
    assert.deepEqual(dashboard.body.recentActivity, []);

    assert.equal((await agent.get("/api/roles")).status, 403);
    assert.equal((await agent.get("/api/audit")).status, 403);
    assert.equal((await post(agent, "/api/branches", { code: "TAIZ", name: "تعز" })).status, 403);

    const denials = await ctx.db.query<Row & { count: number }>(
      "SELECT count(*)::int AS count FROM audit_logs WHERE action = 'security.permission_denied' AND actor_username = $1",
      [managerAden.username],
    );
    assert.ok((denials.rows[0]?.count ?? 0) >= 3);

    const sanaaAgent = await loginAs(ctx.app, managerSanaa.username, PASSWORDS.managerSanaa);
    const sanaaUsers = await sanaaAgent.get("/api/users?pageSize=100");
    assert.equal(sanaaUsers.body.total, 4);
    const sanaaNames = (sanaaUsers.body.items as UserItem[]).map((item) => item.username);
    assert.ok(sanaaNames.includes("manager.sanaa"));
    assert.ok(sanaaNames.includes("employee.sanaa"));
    assert.equal(sanaaNames.includes("employee.aden"), false);
    const sanaaBranches = await sanaaAgent.get("/api/branches");
    assert.equal(sanaaBranches.body.items.length, 1);
    assert.equal(sanaaBranches.body.items[0].code, "SANAA");
  });

  test("cross-branch writes and role escalation are refused for scoped managers", async () => {
    const agent = await loginAs(ctx.app, hrAden.username, PASSWORDS.hrAden);

    const list = await agent.get("/api/users?pageSize=100");
    assert.equal(list.body.total, 4);

    const outsideEdit = await patch(agent, `/api/users/${employeeSanaa.id}`, { fullName: "تعديل خارج النطاق" });
    assert.equal(outsideEdit.status, 404);
    assert.equal(outsideEdit.body.error.code, "NOT_FOUND");

    const outsideReset = await post(agent, `/api/users/${employeeSanaa.id}/reset-password`);
    assert.equal(outsideReset.status, 404);

    const outsideRevoke = await post(agent, `/api/users/${employeeSanaa.id}/revoke-sessions`);
    assert.equal(outsideRevoke.status, 404);

    const moveOutside = await patch(agent, `/api/users/${employeeAden.id}`, { branchIds: [sanaa.id] });
    assert.equal(moveOutside.status, 403);
    assert.equal(moveOutside.body.error.code, "FORBIDDEN");

    const emptyBranches = await patch(agent, `/api/users/${employeeAden.id}`, { branchIds: [] });
    assert.equal(emptyBranches.status, 400);
    assert.equal(emptyBranches.body.error.code, "BRANCH_REQUIRED");

    const outsideCreate = await post(agent, "/api/users", {
      username: "outside.user",
      fullName: "مستخدم خارج النطاق",
      roleKey: "employee",
      branchIds: [sanaa.id],
    });
    assert.equal(outsideCreate.status, 403);

    const allBranchesCreate = await post(agent, "/api/users", {
      username: "global.user",
      fullName: "مستخدم لكل الفروع",
      roleKey: "employee",
      allBranches: true,
    });
    assert.equal(allBranchesCreate.status, 403);

    const adminRoleCreate = await post(agent, "/api/users", {
      username: "new.admin",
      fullName: "مدير جديد",
      roleKey: "admin",
      branchIds: [aden.id],
    });
    assert.equal(adminRoleCreate.status, 403);

    const salaryRoleCreate = await post(agent, "/api/users", {
      username: "new.director",
      fullName: "مدير موارد بشرية",
      roleKey: "hr_director",
      branchIds: [aden.id],
    });
    assert.equal(salaryRoleCreate.status, 403);

    const escalateExisting = await patch(agent, `/api/users/${employeeAden.id}`, { roleKey: "hr_director" });
    assert.equal(escalateExisting.status, 403);

    const selfEdit = await patch(agent, `/api/users/${hrAden.id}`, { fullName: "اسم جديد" });
    assert.equal(selfEdit.status, 400);
    assert.equal(selfEdit.body.error.code, "SELF_EDIT_FORBIDDEN");
    assert.equal((await post(agent, `/api/users/${hrAden.id}/reset-password`)).status, 400);
    assert.equal((await post(agent, `/api/users/${hrAden.id}/revoke-sessions`)).status, 400);

    const created = await post(agent, "/api/users", {
      username: "scoped.new",
      fullName: "مستخدم داخل النطاق",
      roleKey: "employee",
      branchIds: [aden.id],
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.temporaryPassword.length, 14);

    const storedBranch = await ctx.db.query<Row & { branch_id: string }>(
      "SELECT branch_id FROM user_branch_access WHERE user_id = $1",
      [created.body.user.id],
    );
    assert.deepEqual(storedBranch.rows.map((row) => row.branch_id), [aden.id]);

    const createdAudit = await ctx.db.query<Row & { branch_id: string | null; details: { branches?: string[] } }>(
      `SELECT branch_id, details FROM audit_logs
       WHERE action = 'user.created' AND details->>'username' = 'scoped.new'
       ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(createdAudit.rows[0]?.branch_id, aden.id);
    assert.ok(createdAudit.rows[0]?.details.branches?.includes("ADEN"));

    const unchanged = await ctx.db.query<Row & { full_name: string }>(
      "SELECT full_name FROM users WHERE id = $1",
      [employeeSanaa.id],
    );
    assert.notEqual(unchanged.rows[0]?.full_name, "تعديل خارج النطاق");

    const forbiddenCreates = await ctx.db.query<Row & { count: number }>(
      "SELECT count(*)::int AS count FROM users WHERE username = ANY($1::text[])",
      [["outside.user", "global.user", "new.admin", "new.director"]],
    );
    assert.equal(forbiddenCreates.rows[0]?.count, 0);
  });

  test("metadata exposes only the branches and assignable roles of the actor", async () => {
    const adminAgent = await loginAs(ctx.app, admin.username, PASSWORDS.admin);
    const adminMeta = await adminAgent.get("/api/meta");
    assert.equal(adminMeta.status, 200);
    assert.deepEqual(
      new Set(adminMeta.body.branches.map((branch: { code: string }) => branch.code)),
      new Set(["ADEN", "SANAA", "HODEIDAH"]),
    );
    assert.equal(adminMeta.body.roles.length, 8);
    assert.ok(Array.isArray(adminMeta.body.roles[0].permissionKeys));
    assert.deepEqual(
      {
        manageUsers: adminMeta.body.capabilities.manageUsers,
        manageBranches: adminMeta.body.capabilities.manageBranches,
        viewRoles: adminMeta.body.capabilities.viewRoles,
        viewAudit: adminMeta.body.capabilities.viewAudit,
      },
      { manageUsers: true, manageBranches: true, viewRoles: true, viewAudit: true },
    );
    assert.equal(adminMeta.body.capabilities.manageEmployees, true);
    assert.equal(adminMeta.body.capabilities.approveAdvancesFinance, true);
    assert.equal(adminMeta.body.capabilities.manageSettings, true);

    const hrAgent = await loginAs(ctx.app, hrAden.username, PASSWORDS.hrAden);
    const hrMeta = await hrAgent.get("/api/meta");
    assert.equal(hrMeta.status, 200);
    assert.deepEqual(hrMeta.body.branches.map((branch: { code: string }) => branch.code), ["ADEN"]);
    const assignable = (hrMeta.body.roles as Array<{ key: string; permissionKeys: string[] }>).map((role) => role.key);
    assert.equal(assignable.includes("admin"), false);
    assert.equal(assignable.includes("hr_director"), false);
    assert.equal(assignable.includes("executive"), false);
    assert.ok(assignable.includes("branch_manager"));
    assert.ok(assignable.includes("employee"));
    for (const role of hrMeta.body.roles) assert.ok(Array.isArray(role.permissionKeys));

    const execAgent = await loginAs(ctx.app, execAden.username, PASSWORDS.execAden);
    const execMeta = await execAgent.get("/api/meta");
    assert.equal(execMeta.status, 200);
    assert.deepEqual(execMeta.body.branches.map((branch: { code: string }) => branch.code), ["ADEN"]);
    assert.equal(execMeta.body.roles.length, 8);
    assert.equal(execMeta.body.roles[0].permissionKeys, undefined);
    assert.deepEqual(
      {
        manageUsers: execMeta.body.capabilities.manageUsers,
        manageBranches: execMeta.body.capabilities.manageBranches,
        viewRoles: execMeta.body.capabilities.viewRoles,
        viewAudit: execMeta.body.capabilities.viewAudit,
      },
      {
        manageUsers: false,
        manageBranches: false,
        viewRoles: true,
        viewAudit: true,
      },
    );

    const employeeAgent = await loginAs(ctx.app, employeeAden.username, PASSWORDS.employeeAden);
    const employeeMeta = await employeeAgent.get("/api/meta");
    assert.equal(employeeMeta.status, 200);
    assert.deepEqual(employeeMeta.body.branches.map((branch: { code: string }) => branch.code), ["ADEN"]);
    assert.deepEqual(employeeMeta.body.roles, []);
    assert.deepEqual(
      {
        manageUsers: employeeMeta.body.capabilities.manageUsers,
        manageBranches: employeeMeta.body.capabilities.manageBranches,
        viewRoles: employeeMeta.body.capabilities.viewRoles,
        viewAudit: employeeMeta.body.capabilities.viewAudit,
      },
      {
        manageUsers: false,
        manageBranches: false,
        viewRoles: false,
        viewAudit: false,
      },
    );
  });

  test("branch-scoped auditors see only their own activity and their branches", async () => {
    const hrSanaaAgent = await loginAs(ctx.app, hrSanaa.username, PASSWORDS.hrSanaa);
    const sanaaCreated = await post(hrSanaaAgent, "/api/users", {
      username: "sanaa.new",
      fullName: "مستخدم صنعاء الجديد",
      roleKey: "employee",
      branchIds: [sanaa.id],
    });
    assert.equal(sanaaCreated.status, 201);

    const execAgent = await loginAs(ctx.app, execAden.username, PASSWORDS.execAden);
    const scopedAudit = await execAgent.get("/api/audit?pageSize=100");
    assert.equal(scopedAudit.status, 200);
    const items = scopedAudit.body.items as AuditItem[];
    assert.ok(items.some((item) => item.action === "auth.login" && item.actorUsername === execAden.username));
    assert.ok(
      items.some(
        (item) => item.action === "user.created" && item.details.username === "scoped.new" && item.branchId === aden.id,
      ),
    );
    assert.equal(items.some((item) => item.details.username === "sanaa.new"), false);
    assert.equal(items.some((item) => item.action === "auth.login" && item.actorUsername === admin.username), false);
    for (const item of items) {
      assert.ok(
        item.actorUsername === execAden.username || item.branchId === aden.id,
        `unexpected audit row: ${JSON.stringify(item)}`,
      );
    }

    const adminAgent = await loginAs(ctx.app, admin.username, PASSWORDS.admin);
    const globalAudit = await adminAgent.get("/api/audit?action=user.created&pageSize=100");
    assert.equal(globalAudit.status, 200);
    const globalItems = globalAudit.body.items as AuditItem[];
    assert.ok(globalItems.some((item) => item.details.username === "scoped.new"));
    assert.ok(globalItems.some((item) => item.details.username === "sanaa.new"));

    const execUsers = await execAgent.get("/api/users?pageSize=100");
    assert.equal(execUsers.status, 200);
    assert.equal(execUsers.body.total, 5);
    const execNames = (execUsers.body.items as UserItem[]).map((item) => item.username);
    assert.equal(execNames.includes("employee.sanaa"), false);
  });

  test("disabling a user kills sessions and resetting a password forces a new one", async () => {
    const hrAgent = await loginAs(ctx.app, hrAden.username, PASSWORDS.hrAden);
    const employeeAgent = await loginAs(ctx.app, employeeAden.username, PASSWORDS.employeeAden);
    assert.equal((await employeeAgent.get("/api/auth/session")).status, 200);

    const revoked = await post(hrAgent, `/api/users/${employeeAden.id}/revoke-sessions`);
    assert.equal(revoked.status, 200);
    assert.equal((await employeeAgent.get("/api/auth/session")).status, 401);
    assert.ok((await countAudit(ctx.db, "user.sessions_revoked")) >= 1);

    const second = await loginAs(ctx.app, employeeAden.username, PASSWORDS.employeeAden);
    const deactivated = await patch(hrAgent, `/api/users/${employeeAden.id}`, { active: false });
    assert.equal(deactivated.status, 200);
    assert.equal((await second.get("/api/auth/session")).status, 401);

    const disabledLogin = await login(ctx.app, employeeAden.username, PASSWORDS.employeeAden);
    assert.equal(disabledLogin.response.status, 403);
    assert.equal(disabledLogin.response.body.error.code, "ACCOUNT_DISABLED");

    const reactivated = await patch(hrAgent, `/api/users/${employeeAden.id}`, { active: true });
    assert.equal(reactivated.status, 200);
    const third = await loginAs(ctx.app, employeeAden.username, PASSWORDS.employeeAden);

    const reset = await post(hrAgent, `/api/users/${employeeAden.id}/reset-password`);
    assert.equal(reset.status, 200);
    assert.equal((await third.get("/api/auth/session")).status, 401);
    const oldLogin = await login(ctx.app, employeeAden.username, PASSWORDS.employeeAden);
    assert.equal(oldLogin.response.status, 401);
    const tempLogin = await login(ctx.app, employeeAden.username, reset.body.temporaryPassword);
    assert.equal(tempLogin.response.status, 200);
    assert.equal(tempLogin.response.body.user.mustChangePassword, true);

    const disabledAudit = await ctx.db.query<Row & { count: number }>(
      `SELECT count(*)::int AS count FROM audit_logs
       WHERE action = 'auth.login_failed' AND details->>'reason' = 'account_disabled'`,
    );
    assert.ok((disabledAudit.rows[0]?.count ?? 0) >= 1);
  });

  test("disabled accounts are refused and inactive branches cannot receive users", async () => {
    const disabled = await login(ctx.app, "disabled.user", PASSWORDS.disabled);
    assert.equal(disabled.response.status, 403);
    assert.equal(disabled.response.body.error.code, "ACCOUNT_DISABLED");

    const adminAgent = await loginAs(ctx.app, admin.username, PASSWORDS.admin);
    const deactivated = await patch(adminAgent, `/api/branches/${hodeidah.id}`, { active: false });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.branch.active, false);

    const inactiveAssignment = await post(adminAgent, "/api/users", {
      username: "inactive.branch.user",
      fullName: "مستخدم فرع معطل",
      roleKey: "employee",
      branchIds: [hodeidah.id],
    });
    assert.equal(inactiveAssignment.status, 400);
    assert.equal(inactiveAssignment.body.error.code, "INACTIVE_BRANCH");

    const reactivated = await patch(adminAgent, `/api/branches/${hodeidah.id}`, { active: true });
    assert.equal(reactivated.status, 200);
  });
});
