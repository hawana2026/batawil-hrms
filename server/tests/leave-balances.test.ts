import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createBranch,
  createTestContext,
  loginAs,
  patch,
  post,
  seedUser,
  type SeededUser,
  type TestAgent,
  type TestBranch,
  type TestContext,
} from "./helpers.js";

const PASSWORDS = {
  hr: "HrDirector2026!x",
  officer: "OfficerAden2026!x",
  executive: "Exec2026!x",
};

interface LeaveTypeDto {
  id: string;
  code: string;
  name: string;
  annualEntitlement: number;
  trackBalance: boolean;
  paid: boolean;
  active: boolean;
  requestsCount: number;
}

interface BalanceDto {
  leaveTypeId: string;
  code: string;
  name: string;
  year: number;
  entitlement: number;
  used: number;
  adjusted: number;
  remaining: number;
}

describe("BATAWIL leave types and balances", () => {
  let ctx: TestContext;
  let aden: TestBranch;
  let sanaa: TestBranch;
  let hrUser: SeededUser;
  let officerUser: SeededUser;
  let executiveUser: SeededUser;
  let hr: TestAgent;
  let officer: TestAgent;
  let executive: TestAgent;

  const year = new Date().getFullYear();
  let annualType: LeaveTypeDto;
  let sickType: LeaveTypeDto;
  let hajjType: LeaveTypeDto;
  let employee: { id: string; fullName: string };
  let sanaaEmployee: { id: string; fullName: string };

  const createEmployee = async (branchId: string, fullName: string, phone: string) => {
    const response = await post(hr, "/api/employees", {
      fullName,
      phone,
      branchId,
      hireDate: `${year}-01-01`,
      baseSalary: 100000,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.employee as { id: string; fullName: string };
  };

  const balancesFor = async (agent: TestAgent, employeeId: string) => {
    const response = await agent.get(`/api/leave-balances?employeeId=${employeeId}&year=${year}`);
    return response;
  };

  const createLeave = async (employeeId: string, type: LeaveTypeDto, startDate: string, days: number, reason = "اختبار رصيد") => {
    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(start.getTime() + (days - 1) * 86_400_000);
    const response = await post(hr, "/api/leaves", {
      employeeId,
      leaveTypeId: type.id,
      startDate,
      endDate: end.toISOString().slice(0, 10),
      reason,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return { id: response.body.id as string, startDate };
  };

  const submitAndApprove = async (leaveId: string) => {
    const submit = await post(hr, `/api/leaves/${leaveId}/submit`, {});
    assert.equal(submit.status, 200, JSON.stringify(submit.body));
    return post(hr, `/api/leaves/${leaveId}/approve`, { reason: "" });
  };

  before(async () => {
    ctx = await createTestContext();
    aden = await createBranch(ctx.db, "ADEN", "فرع عدن", "عدن");
    sanaa = await createBranch(ctx.db, "SANAA", "فرع صنعاء", "صنعاء");
    hrUser = await seedUser(ctx.db, {
      username: "leave.hr",
      password: PASSWORDS.hr,
      roleKey: "hr_director",
      fullName: "مدير الموارد البشرية",
      allBranches: true,
    });
    officerUser = await seedUser(ctx.db, {
      username: "leave.officer",
      password: PASSWORDS.officer,
      roleKey: "hr_officer",
      fullName: "مسؤول شؤون الموظفين - عدن",
      branchIds: [aden.id],
    });
    executiveUser = await seedUser(ctx.db, {
      username: "leave.exec",
      password: PASSWORDS.executive,
      roleKey: "executive",
      fullName: "مدير تنفيذي",
      allBranches: true,
    });
    hr = await loginAs(ctx.app, hrUser.username, PASSWORDS.hr);
    officer = await loginAs(ctx.app, officerUser.username, PASSWORDS.officer);
    executive = await loginAs(ctx.app, executiveUser.username, PASSWORDS.executive);
  });

  after(async () => {
    await ctx.db.close();
  });

  test("leave types are seeded, uniquely identified and permission guarded", async () => {
    const listed = await hr.get("/api/leave-types");
    assert.equal(listed.status, 200);
    const items = listed.body.items as LeaveTypeDto[];
    assert.deepEqual(
      items.map((item) => item.code).sort(),
      ["annual", "emergency", "other", "permission", "sick", "unpaid"],
    );
    annualType = items.find((item) => item.code === "annual")!;
    sickType = items.find((item) => item.code === "sick")!;
    assert.equal(annualType.annualEntitlement, 30);
    assert.equal(annualType.trackBalance, true);
    assert.equal(items.find((item) => item.code === "unpaid")!.trackBalance, false);

    const denied = await post(executive, "/api/leave-types", {
      code: "hajj",
      name: "إجازة حج",
      annualEntitlement: 0,
      trackBalance: false,
    });
    assert.equal(denied.status, 403);

    const created = await post(hr, "/api/leave-types", {
      code: "hajj",
      name: "إجازة حج",
      annualEntitlement: 0,
      trackBalance: false,
      paid: true,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    hajjType = created.body.leaveType as LeaveTypeDto;
    assert.equal(hajjType.active, true);

    const duplicateName = await post(hr, "/api/leave-types", { code: "hajj_2", name: "إجازة حج" });
    assert.equal(duplicateName.status, 409);
    const duplicateCode = await post(hr, "/api/leave-types", { code: "hajj", name: "حج آخر" });
    assert.equal(duplicateCode.status, 409);

    const renamed = await patch(hr, `/api/leave-types/${hajjType.id}`, { code: "hajj2", name: "إجازة الحج" });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.leaveType.code, "hajj2");
    assert.equal(renamed.body.leaveType.name, "إجازة الحج");
  });

  test("approval consumes balances once and refuses insufficient balances", async () => {
    employee = await createEmployee(aden.id, "موظف أرصدة الإجازات", "779000001");
    sanaaEmployee = await createEmployee(sanaa.id, "موظف فرع صنعاء", "779000002");

    const initial = await balancesFor(hr, employee.id);
    assert.equal(initial.status, 200, JSON.stringify(initial.body));
    const annual = (initial.body.balances as BalanceDto[]).find((item) => item.code === "annual")!;
    assert.equal(annual.entitlement, 30);
    assert.equal(annual.used, 0);
    assert.equal(annual.remaining, 30);
    const sick = (initial.body.balances as BalanceDto[]).find((item) => item.code === "sick")!;
    assert.equal(sick.remaining, 14);

    const annualLeave = await createLeave(employee.id, annualType, `${year}-03-01`, 5);
    const approval = await submitAndApprove(annualLeave.id);
    assert.equal(approval.status, 200, JSON.stringify(approval.body));

    const afterApprove = await balancesFor(hr, employee.id);
    const annualAfter = (afterApprove.body.balances as BalanceDto[]).find((item) => item.code === "annual")!;
    assert.equal(annualAfter.used, 5);
    assert.equal(annualAfter.remaining, 25);
    const movements = afterApprove.body.movements as Array<{ kind: string; days: number }>;
    assert.equal(movements.filter((item) => item.kind === "usage" && item.days === 5).length, 1);

    const twice = await post(hr, `/api/leaves/${annualLeave.id}/approve`, { reason: "" });
    assert.equal(twice.status, 409);
    const usageCount = await ctx.db.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM leave_balance_movements WHERE leave_request_id = $1 AND kind = 'usage'",
      [annualLeave.id],
    );
    assert.equal(usageCount.rows[0]?.total, 1);

    const tooMuch = await createLeave(employee.id, sickType, `${year}-04-01`, 20);
    const refused = await submitAndApprove(tooMuch.id);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(String(refused.body.error.message), /لا يكفي/);
    const sickAfterRefusal = (await balancesFor(hr, employee.id)).body.balances as BalanceDto[];
    assert.equal(sickAfterRefusal.find((item) => item.code === "sick")!.used, 0);

    const adjusted = await post(hr, "/api/leave-balances/adjust", {
      employeeId: employee.id,
      leaveTypeId: sickType.id,
      year,
      days: 10,
      note: "رصيد إضافي بقرار إداري",
    });
    assert.equal(adjusted.status, 200, JSON.stringify(adjusted.body));
    assert.equal(adjusted.body.after, 24);

    const retry = await post(hr, `/api/leaves/${tooMuch.id}/approve`, { reason: "" });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    const sickAfter = (await balancesFor(hr, employee.id)).body.balances as BalanceDto[];
    assert.equal(sickAfter.find((item) => item.code === "sick")!.remaining, 4);

    const excessiveCut = await post(hr, "/api/leave-balances/adjust", {
      employeeId: employee.id,
      leaveTypeId: sickType.id,
      year,
      days: -100,
      note: "خصم مبالغ",
    });
    assert.equal(excessiveCut.status, 409);

    const unpaidType = (await hr.get("/api/leave-types")).body.items.find((item: LeaveTypeDto) => item.code === "unpaid") as LeaveTypeDto;
    const unpaidLeave = await createLeave(employee.id, unpaidType, `${year}-05-01`, 3);
    const unpaidApproval = await submitAndApprove(unpaidLeave.id);
    assert.equal(unpaidApproval.status, 200, JSON.stringify(unpaidApproval.body));
    const unpaidUsage = await ctx.db.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM leave_balance_movements WHERE leave_request_id = $1",
      [unpaidLeave.id],
    );
    assert.equal(unpaidUsage.rows[0]?.total, 0);

    const rejectedLeave = await createLeave(employee.id, annualType, `${year}-06-01`, 2);
    assert.equal((await post(hr, `/api/leaves/${rejectedLeave.id}/submit`, {})).status, 200);
    const rejected = await post(hr, `/api/leaves/${rejectedLeave.id}/reject`, { reason: "غير مناسب" });
    assert.equal(rejected.status, 200);
    const annualFinal = (await balancesFor(hr, employee.id)).body.balances as BalanceDto[];
    assert.equal(annualFinal.find((item) => item.code === "annual")!.used, 5);
    const adjustmentCount = await ctx.db.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM leave_balance_movements WHERE leave_request_id = $1",
      [rejectedLeave.id],
    );
    assert.equal(adjustmentCount.rows[0]?.total, 0);
  });

  test("balances stay inside branch scope and block archived or inactive types", async () => {
    const crossBranch = await balancesFor(officer, sanaaEmployee.id);
    assert.equal(crossBranch.status, 404);
    const ownBranch = await balancesFor(officer, employee.id);
    assert.equal(ownBranch.status, 200);

    const crossAdjust = await post(officer, "/api/leave-balances/adjust", {
      employeeId: sanaaEmployee.id,
      leaveTypeId: annualType.id,
      year,
      days: 1,
      note: "محاولة خارج النطاق",
    });
    assert.equal(crossAdjust.status, 404);

    const deactivated = await patch(hr, `/api/leave-types/${annualType.id}`, { active: false });
    assert.equal(deactivated.status, 200);
    const blocked = await post(hr, "/api/leaves", {
      employeeId: employee.id,
      leaveTypeId: annualType.id,
      startDate: `${year}-11-01`,
      endDate: `${year}-11-02`,
      reason: "نوع معطل",
    });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error.code, "LEAVE_TYPE_INACTIVE");
    await patch(hr, `/api/leave-types/${annualType.id}`, { active: true });
  });

  test("types that require a document block submission until one is attached", async () => {
    const type = await post(hr, "/api/leave-types", {
      code: "medical_cert",
      name: "إجازة بتقرير طبي",
      annualEntitlement: 0,
      trackBalance: false,
      paid: true,
      requiresDocument: true,
    });
    assert.equal(type.status, 201, JSON.stringify(type.body));
    const leave = await createLeave(employee.id, type.body.leaveType as LeaveTypeDto, `${year}-07-01`, 1, "تقرير طبي");
    const blocked = await post(hr, `/api/leaves/${leave.id}/submit`, {});
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error.code, "DOCUMENT_REQUIRED");

    const relaxed = await patch(hr, `/api/leave-types/${type.body.leaveType.id}`, { requiresDocument: false });
    assert.equal(relaxed.status, 200);
    const submitted = await post(hr, `/api/leaves/${leave.id}/submit`, {});
    assert.equal(submitted.status, 200);
    const cancelled = await post(hr, `/api/leaves/${leave.id}/cancel`, {});
    assert.equal(cancelled.status, 200);
  });
});
