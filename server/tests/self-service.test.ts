import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  XHR_HEADER,
  createBranch,
  createTestContext,
  loginAs,
  post,
  seedUser,
  type SeededUser,
  type TestAgent,
  type TestBranch,
  type TestContext,
} from "./helpers.js";

const PASSWORDS = {
  hr: "SelfHr2026!x",
  officer: "SelfOfficer2026!x",
  employee: "SelfEmployee2026!x",
  employee2: "SelfEmployeeTwo2026!x",
  unlinked: "SelfUnlinked2026!x",
};

interface OverviewDto {
  employee: { id: string; employeeNo: string; fullName: string; archived: boolean };
  balances: Array<{ code: string; entitlement: number; used: number; remaining: number; year: number }>;
  leaves: Array<{ id: string; status: string; leaveTypeName: string; days: number }>;
  leaveTypes: Array<{ id: string; name: string; requiresDocument: boolean; trackBalance: boolean }>;
  capabilities: { canRequestLeave: boolean };
}

describe("BATAWIL employee self-service", () => {
  let ctx: TestContext;
  let aden: TestBranch;
  let sanaa: TestBranch;
  let hrUser: SeededUser;
  let officerUser: SeededUser;
  let employeeUser: SeededUser;
  let employee2User: SeededUser;
  let unlinkedUser: SeededUser;
  let hr: TestAgent;
  let officer: TestAgent;
  let employee: TestAgent;
  let employee2: TestAgent;
  let unlinked: TestAgent;

  const year = new Date().getFullYear();
  let adenEmployee: { id: string; fullName: string };
  let adenEmployee2: { id: string; fullName: string };
  let sanaaEmployee: { id: string; fullName: string };

  const createEmployee = async (branchId: string, fullName: string, phone: string) => {
    const response = await post(hr, "/api/employees", {
      fullName,
      phone,
      branchId,
      hireDate: `${year}-01-01`,
      baseSalary: 120000,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.employee as { id: string; fullName: string };
  };

  const overview = (agent: TestAgent) => agent.get("/api/self-service/overview");

  const createSelfLeave = async (
    agent: TestAgent,
    leaveTypeId: string,
    startDate: string,
    endDate: string,
    reason = "طلب من الخدمة الذاتية",
  ) => post(agent, "/api/self-service/leaves", { leaveTypeId, startDate, endDate, reason });

  const upload = (agent: TestAgent, ownerType: string, ownerId: string, fileName: string) =>
    agent
      .post(`/api/attachments?ownerType=${ownerType}&ownerId=${ownerId}&fileName=${encodeURIComponent(fileName)}&documentType=other`)
      .set("X-Requested-With", XHR_HEADER)
      .set("Content-Type", "application/pdf")
      .send(Buffer.from(`%PDF-1.4 BATAWIL ${fileName}`));

  before(async () => {
    ctx = await createTestContext();
    aden = await createBranch(ctx.db, "ADEN", "فرع عدن", "عدن");
    sanaa = await createBranch(ctx.db, "SANAA", "فرع صنعاء", "صنعاء");
    hrUser = await seedUser(ctx.db, {
      username: "self.hr",
      password: PASSWORDS.hr,
      roleKey: "hr_director",
      fullName: "مدير الموارد البشرية",
      allBranches: true,
    });
    officerUser = await seedUser(ctx.db, {
      username: "self.officer",
      password: PASSWORDS.officer,
      roleKey: "hr_officer",
      fullName: "مسؤول عدن",
      branchIds: [aden.id],
    });
    hr = await loginAs(ctx.app, hrUser.username, PASSWORDS.hr);
    officer = await loginAs(ctx.app, officerUser.username, PASSWORDS.officer);

    adenEmployee = await createEmployee(aden.id, "موظف الخدمة الذاتية", "778100001");
    adenEmployee2 = await createEmployee(aden.id, "موظف ثانٍ للخدمة", "778100002");
    sanaaEmployee = await createEmployee(sanaa.id, "موظف صنعاء للخدمة", "778100003");

    employeeUser = await seedUser(ctx.db, {
      username: "self.employee",
      password: PASSWORDS.employee,
      roleKey: "employee",
      fullName: "موظف الخدمة الذاتية",
      branchIds: [aden.id],
      employeeId: adenEmployee.id,
    });
    employee2User = await seedUser(ctx.db, {
      username: "self.employee2",
      password: PASSWORDS.employee2,
      roleKey: "employee",
      fullName: "موظف ثانٍ للخدمة",
      branchIds: [aden.id],
      employeeId: adenEmployee2.id,
    });
    unlinkedUser = await seedUser(ctx.db, {
      username: "self.unlinked",
      password: PASSWORDS.unlinked,
      roleKey: "employee",
      fullName: "حساب غير مرتبط",
      branchIds: [aden.id],
    });
    employee = await loginAs(ctx.app, employeeUser.username, PASSWORDS.employee);
    employee2 = await loginAs(ctx.app, employee2User.username, PASSWORDS.employee2);
    unlinked = await loginAs(ctx.app, unlinkedUser.username, PASSWORDS.unlinked);
  });

  after(async () => {
    await ctx.db.close();
  });

  test("linked employee sees only their own overview", async () => {
    const response = await overview(employee);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body as OverviewDto;
    assert.equal(data.employee.id, adenEmployee.id);
    assert.equal(data.employee.employeeNo.length > 0, true);
    assert.equal(data.capabilities.canRequestLeave, true);
    const annual = data.balances.find((balance) => balance.code === "annual");
    assert.ok(annual);
    assert.equal(annual!.entitlement, 30);
    assert.equal(annual!.used, 0);
    assert.equal(annual!.remaining, 30);
    assert.ok(data.leaveTypes.some((type) => type.name === "إجازة سنوية"));

    const employees = await employee.get("/api/employees");
    assert.equal(employees.status, 403, "employee portal must not expose the employee directory");

    const noLink = await overview(unlinked);
    assert.equal(noLink.status, 403);
    assert.equal(noLink.body.error.code, "NO_EMPLOYEE_LINK");
    const deniedCreate = await createSelfLeave(unlinked, data.leaveTypes[0]!.id, `${year}-09-01`, `${year}-09-02`);
    assert.equal(deniedCreate.status, 403);
  });

  test("employee submits own leave and cannot act on someone else's request", async () => {
    const data = (await overview(employee)).body as OverviewDto;
    const annual = data.leaveTypes.find((type) => type.name === "إجازة سنوية")!;
    const created = await createSelfLeave(employee, annual.id, `${year}-11-01`, `${year}-11-02`);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.days, 2);
    assert.equal(created.body.requiresDocument, false);

    const submit = await post(employee, `/api/self-service/leaves/${created.body.id}/submit`, {});
    assert.equal(submit.status, 200, JSON.stringify(submit.body));

    const afterSubmit = (await overview(employee)).body as OverviewDto;
    const submitted = afterSubmit.leaves.find((leave) => leave.id === created.body.id);
    assert.equal(submitted?.status, "pending");

    const pending = await hr.get("/api/leaves?status=pending&branchId=" + aden.id + "&pageSize=50");
    assert.equal(pending.status, 200);
    assert.ok(pending.body.items.some((item: { id: string }) => item.id === created.body.id));

    const foreign = await post(hr, "/api/leaves", {
      employeeId: adenEmployee2.id,
      leaveTypeId: annual.id,
      startDate: `${year}-11-10`,
      endDate: `${year}-11-11`,
      reason: "طلب موظف آخر",
    });
    assert.equal(foreign.status, 201, JSON.stringify(foreign.body));
    const foreignSubmit = await post(employee, `/api/self-service/leaves/${foreign.body.id}/submit`, {});
    assert.equal(foreignSubmit.status, 404);
    const foreignCancel = await post(employee, `/api/self-service/leaves/${foreign.body.id}/cancel`, {});
    assert.equal(foreignCancel.status, 404);

    const cancel = await post(employee, `/api/self-service/leaves/${created.body.id}/cancel`, {});
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    const cancelled = await hr.get("/api/leaves?status=cancelled&branchId=" + aden.id + "&pageSize=50");
    assert.ok(cancelled.body.items.some((item: { id: string }) => item.id === created.body.id));
    const cancelAgain = await post(employee, `/api/self-service/leaves/${created.body.id}/cancel`, {});
    assert.equal(cancelAgain.status, 409);
  });

  test("attachments are limited to the owner while draft, and locked after submission", async () => {
    const data = (await overview(employee)).body as OverviewDto;
    const annual = data.leaveTypes.find((type) => type.name === "إجازة سنوية")!;
    const created = await createSelfLeave(employee, annual.id, `${year}-12-01`, `${year}-12-02`);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const leaveId = created.body.id as string;

    const uploaded = await upload(employee, "leave", leaveId, "certificate.pdf");
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));

    const ownList = await employee.get(`/api/attachments?ownerType=leave&ownerId=${leaveId}`);
    assert.equal(ownList.status, 200);
    assert.equal(ownList.body.items.length, 1);

    const foreignList = await employee2.get(`/api/attachments?ownerType=leave&ownerId=${leaveId}`);
    assert.equal(foreignList.status, 403);
    const foreignDownload = await employee2.get(`/api/attachments/${uploaded.body.id}/download`);
    assert.equal(foreignDownload.status, 403);
    const hrList = await hr.get(`/api/attachments?ownerType=leave&ownerId=${leaveId}`);
    assert.equal(hrList.status, 200);

    const submitted = await post(employee, `/api/self-service/leaves/${leaveId}/submit`, {});
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    const lockedUpload = await upload(employee, "leave", leaveId, "late.pdf");
    assert.equal(lockedUpload.status, 403);

    const document = await upload(hr, "employee", adenEmployee.id, "contract.pdf");
    assert.equal(document.status, 201, JSON.stringify(document.body));
    const ownDocuments = await employee.get(`/api/attachments?ownerType=employee&ownerId=${adenEmployee.id}`);
    assert.equal(ownDocuments.status, 200);
    const foreignDocuments = await employee2.get(`/api/attachments?ownerType=employee&ownerId=${adenEmployee.id}`);
    assert.equal(foreignDocuments.status, 403);
    const selfUpload = await upload(employee, "employee", adenEmployee.id, "self.pdf");
    assert.equal(selfUpload.status, 403);
  });

  test("document requirement blocks submission until a file is attached", async () => {
    const type = await post(hr, "/api/leave-types", {
      code: "medical_test",
      name: "إجازة مرضية بدليل",
      annualEntitlement: 0,
      trackBalance: false,
      requiresDocument: true,
    });
    assert.equal(type.status, 201, JSON.stringify(type.body));
    const typeId = type.body.leaveType.id as string;

    const created = await createSelfLeave(employee, typeId, `${year}-10-20`, `${year}-10-21`);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.requiresDocument, true);
    const blocked = await post(employee, `/api/self-service/leaves/${created.body.id}/submit`, {});
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error.code, "DOCUMENT_REQUIRED");
    const uploaded = await upload(employee, "leave", created.body.id, "medical.pdf");
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const submitted = await post(employee, `/api/self-service/leaves/${created.body.id}/submit`, {});
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  });

  test("user management links accounts to employees with scope and uniqueness checks", async () => {
    const createdOk = await post(hr, "/api/users", {
      username: "self.linked.ok",
      fullName: "حساب مرتبط صنعاء",
      email: "",
      roleKey: "employee",
      employeeId: sanaaEmployee.id,
      allBranches: false,
      branchIds: [sanaa.id],
    });
    assert.equal(createdOk.status, 201, JSON.stringify(createdOk.body));

    const duplicate = await post(hr, "/api/users", {
      username: "self.linked.dup",
      fullName: "حساب مكرر",
      email: "",
      roleKey: "employee",
      employeeId: sanaaEmployee.id,
      allBranches: false,
      branchIds: [sanaa.id],
    });
    assert.equal(duplicate.status, 409);

    const existing = await post(hr, "/api/users", {
      username: "self.linked.existing",
      fullName: "حساب مرتبط مسبقاً",
      email: "",
      roleKey: "employee",
      employeeId: adenEmployee2.id,
      allBranches: false,
      branchIds: [aden.id],
    });
    assert.equal(existing.status, 409);

    const mismatch = await post(officer, "/api/users", {
      username: "self.linked.sanaa",
      fullName: "حساب خارج النطاق",
      email: "",
      roleKey: "employee",
      employeeId: sanaaEmployee.id,
      allBranches: false,
      branchIds: [aden.id],
    });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error.code, "EMPLOYEE_BRANCH_MISMATCH");

    const list = await hr.get("/api/users?q=self.employee&pageSize=50");
    assert.equal(list.status, 200);
    const linked = list.body.items.find((item: { username: string }) => item.username === "self.employee");
    assert.ok(linked);
    assert.equal(linked.employeeId, adenEmployee.id);
    assert.equal(linked.employeeName, adenEmployee.fullName);
    assert.equal(linked.employeeNo.length > 0, true);

    const detail = await hr.get("/api/users?q=" + encodeURIComponent(adenEmployee.fullName) + "&pageSize=50");
    assert.ok(detail.body.items.some((item: { id: string }) => item.id === employeeUser.id));

    const archive = await post(hr, `/api/employees/${adenEmployee.id}/archive`, { reason: "اختبار أرشفة" });
    assert.equal(archive.status, 200, JSON.stringify(archive.body));
    const archivedOverview = await overview(employee);
    assert.equal(archivedOverview.status, 200);
    assert.equal(archivedOverview.body.employee.archived, true);
    assert.equal(archivedOverview.body.capabilities.canRequestLeave, false);
    const leaveTypeId = (archivedOverview.body.leaveTypes as OverviewDto["leaveTypes"])[0]!.id;
    const blocked = await createSelfLeave(employee, leaveTypeId, `${year}-08-01`, `${year}-08-02`);
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error.code, "EMPLOYEE_INACTIVE");
  });
});
