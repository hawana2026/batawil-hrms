import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import {
  countAudit,
  createBranch,
  createTestContext,
  del,
  loginAs,
  patch,
  seedUser,
  XHR_HEADER,
  type SeededUser,
  type TestAgent,
  type TestBranch,
  type TestContext,
} from "./helpers.js";

const ADMIN_PASSWORD = "DeleteAdmin2026!x";
const MANAGER_PASSWORD = "DeleteManager2026!x";

async function insertEmployee(
  ctx: TestContext,
  branch: TestBranch,
  employeeNo: string,
  fullName: string,
  departmentId: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await ctx.db.query(
    `INSERT INTO employees (id, employee_no, full_name, phone, branch_id, department_id, job_title, hire_date, base_salary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, employeeNo, fullName, "777000111", branch.id, departmentId, "موظف", "2026-01-01", 100000],
  );
  return id;
}

describe("Administrative record deletion", () => {
  let ctx: TestContext;
  let branch: TestBranch;
  let emptyBranch: TestBranch;
  let departmentId: string;
  let admin: SeededUser;
  let manager: SeededUser;
  let adminAgent: TestAgent;
  let managerAgent: TestAgent;

  before(async () => {
    ctx = await createTestContext();
    branch = await createBranch(ctx.db, "DEL-ADEN", "عدن", "عدن");
    emptyBranch = await createBranch(ctx.db, "DEL-TAIZ", "تعز", "تعز");
    departmentId = randomUUID();
    await ctx.db.query("INSERT INTO departments (id, name) VALUES ($1, $2)", [departmentId, "قسم الحذف"]);
    admin = await seedUser(ctx.db, {
      username: "delete.admin",
      password: ADMIN_PASSWORD,
      roleKey: "admin",
      allBranches: true,
    });
    manager = await seedUser(ctx.db, {
      username: "delete.manager",
      password: MANAGER_PASSWORD,
      roleKey: "branch_manager",
      branchIds: [branch.id],
    });
    adminAgent = await loginAs(ctx.app, admin.username, admin.password);
    managerAgent = await loginAs(ctx.app, manager.username, manager.password);
  });

  after(async () => {
    await ctx.db.close();
  });

  test("deletion requires authentication and the records.delete permission", async () => {
    const employeeId = await insertEmployee(ctx, branch, "DEL-100", "موظف بلا صلاحية");
    const anonymous = await request(ctx.app)
      .delete(`/api/admin/records/employee/${employeeId}`)
      .set("X-Requested-With", XHR_HEADER);
    assert.equal(anonymous.status, 401);

    const employeeId2 = await insertEmployee(ctx, branch, "DEL-101", "موظف محمي");
    const denied = await del(managerAgent, `/api/admin/records/employee/${employeeId2}`);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "FORBIDDEN");
    assert.equal((await ctx.db.query("SELECT 1 FROM employees WHERE id = $1", [employeeId2])).rows.length, 1);
  });

  test("an admin can delete a leave request and its attachments are removed", async () => {
    const employeeId = await insertEmployee(ctx, branch, "DEL-200", "صاحب الإجازة");
    const leaveId = randomUUID();
    await ctx.db.query(
      `INSERT INTO leave_requests (id, employee_id, branch_id, leave_type, start_date, end_date, days, reason, status)
       VALUES ($1, $2, $3, 'annual', '2026-10-01', '2026-10-01', 1, 'اختبار', 'pending')`,
      [leaveId, employeeId, branch.id],
    );
    await ctx.db.query(
      `INSERT INTO attachments (id, owner_type, owner_id, file_name, mime_type, size_bytes, content)
       VALUES ($1, 'leave', $2, 'leave.pdf', 'application/pdf', 8, $3)`,
      [randomUUID(), leaveId, Buffer.from("%PDF-1.4")],
    );
    await ctx.db.query(
      `INSERT INTO approval_requests (id, entity_type, entity_id, branch_id, title, status)
       VALUES ($1, 'leave', $2, $3, 'طلب إجازة', 'pending')`,
      [randomUUID(), leaveId, branch.id],
    );

    const response = await del(adminAgent, `/api/admin/records/leave/${leaveId}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal((await ctx.db.query("SELECT 1 FROM leave_requests WHERE id = $1", [leaveId])).rows.length, 0);
    assert.equal((await ctx.db.query("SELECT 1 FROM attachments WHERE owner_type = 'leave' AND owner_id = $1", [leaveId])).rows.length, 0);
    assert.equal((await ctx.db.query("SELECT 1 FROM approval_requests WHERE entity_type = 'leave' AND entity_id = $1", [leaveId])).rows.length, 0);
    assert.equal(await countAudit(ctx.db, "leave.deleted"), 1);
    const audit = await ctx.db.query<{ severity: string; details: Record<string, unknown> }>(
      "SELECT severity, details FROM audit_logs WHERE action = 'leave.deleted'",
    );
    assert.equal(audit.rows[0]?.severity, "warning");
    assert.equal(audit.rows[0]?.details.employeeNo, "DEL-200");
  });

  test("employee deletion is blocked while dependent records exist, then succeeds after cleanup", async () => {
    const employeeId = await insertEmployee(ctx, branch, "DEL-300", "موظف مرتبط");
    const submissionId = randomUUID();
    await ctx.db.query(
      `INSERT INTO attendance_submissions (id, branch_id, work_date, status)
       VALUES ($1, $2, '2026-10-02', 'approved')`,
      [submissionId, branch.id],
    );
    await ctx.db.query(
      `INSERT INTO daily_attendance (id, submission_id, employee_id, status)
       VALUES ($1, $2, $3, 'present')`,
      [randomUUID(), submissionId, employeeId],
    );

    const blocked = await del(adminAgent, `/api/admin/records/employee/${employeeId}`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "CONFLICT");
    assert.equal(blocked.body.error.details.attendance, 1);
    assert.equal((await ctx.db.query("SELECT 1 FROM employees WHERE id = $1", [employeeId])).rows.length, 1);

    const submissionDeleted = await del(adminAgent, `/api/admin/records/daily_submission/${submissionId}`);
    assert.equal(submissionDeleted.status, 200);
    assert.equal((await ctx.db.query("SELECT 1 FROM daily_attendance WHERE submission_id = $1", [submissionId])).rows.length, 0);
    assert.equal(await countAudit(ctx.db, "attendance_daily.deleted"), 1);

    const deleted = await del(adminAgent, `/api/admin/records/employee/${employeeId}`);
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(await countAudit(ctx.db, "employee.deleted"), 1);

    const missing = await del(adminAgent, `/api/admin/records/employee/${employeeId}`);
    assert.equal(missing.status, 404);
  });

  test("branches with dependents cannot be deleted; empty branch and department can", async () => {
    const blocked = await del(adminAgent, `/api/admin/records/branch/${branch.id}`);
    assert.equal(blocked.status, 409);
    assert.ok(blocked.body.error.details.employees > 0);

    const branchDeleted = await del(adminAgent, `/api/admin/records/branch/${emptyBranch.id}`);
    assert.equal(branchDeleted.status, 200);

    const departmentDeleted = await del(adminAgent, `/api/admin/records/department/${departmentId}`);
    assert.equal(departmentDeleted.status, 200);
    assert.equal((await ctx.db.query("SELECT 1 FROM departments WHERE id = $1", [departmentId])).rows.length, 0);
    assert.equal(await countAudit(ctx.db, "branch.deleted"), 1);
    assert.equal(await countAudit(ctx.db, "department.deleted"), 1);
  });

  test("user deletion is soft, revokes access and hides the account from the users list", async () => {
    const target = await seedUser(ctx.db, {
      username: "delete.target",
      password: "TargetPass2026!x",
      roleKey: "employee",
    });
    const selfDelete = await del(adminAgent, `/api/admin/records/user/${admin.id}`);
    assert.equal(selfDelete.status, 409);

    const response = await del(adminAgent, `/api/admin/records/user/${target.id}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const row = (
      await ctx.db.query<{ active: boolean; deleted_at: string | null; username: string; password_hash: string }>(
        "SELECT active, deleted_at, username, password_hash FROM users WHERE id = $1",
        [target.id],
      )
    ).rows[0];
    assert.equal(row?.active, false);
    assert.ok(row?.deleted_at);
    assert.equal(row?.username, `deleted.${target.id.slice(0, 8)}`);
    assert.equal(row?.password_hash, "!deleted");

    const list = await adminAgent.get("/api/users?includeInactive=true&pageSize=100");
    assert.equal(
      (list.body.items as Array<{ id: string }>).some((item) => item.id === target.id),
      false,
    );
    const loginAttempt = await request(ctx.app)
      .post("/api/auth/login")
      .set("X-Requested-With", XHR_HEADER)
      .send({ username: target.username, password: target.password });
    assert.equal(loginAttempt.status, 401);
    const revivalAttempt = await patch(adminAgent, `/api/users/${target.id}`, { active: true });
    assert.equal(revivalAttempt.status, 404);
    assert.equal(await countAudit(ctx.db, "user.deleted"), 1);
  });
});
