import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import {
  countAudit,
  createBranch,
  createTestContext,
  loginAs,
  patch,
  post,
  seedUser,
  XHR_HEADER,
  type SeededUser,
  type TestAgent,
  type TestBranch,
  type TestContext,
} from "./helpers.js";

const PASSWORDS = {
  hrDirector: "HrDirector2026!x",
  hrOfficer: "HrOfficer2026!x",
  finance: "Finance2026!x",
  executive: "Executive2026!x",
  managerAden: "MgrAden2026!x",
  managerSanaa: "MgrSanaa2026!x",
};

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function localToday(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function shiftDate(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function monthInfo(iso: string, offset: number): { year: number; month: number; days: number; start: string; end: string } {
  const base = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  const shifted = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offset, 1));
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    year,
    month,
    days,
    start: `${year}-${pad(month)}-01`,
    end: `${year}-${pad(month)}-${pad(days)}`,
  };
}

function isWorkday(iso: string): boolean {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day !== 5 && day !== 6;
}

function workdaysOf(year: number, month: number, count: number): Array<{ iso: string; day: number }> {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const result: Array<{ iso: string; day: number }> = [];
  for (let day = 1; day <= days && result.length < count; day += 1) {
    const iso = `${year}-${pad(month)}-${pad(day)}`;
    if (isWorkday(iso)) result.push({ iso, day });
  }
  return result;
}

async function makeWorkbook(rows: Array<Record<string, string | number>>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Employees");
  const headers = [
    "employeeNo",
    "fullName",
    "phone",
    "nationalId",
    "branchCode",
    "departmentName",
    "jobTitle",
    "hireDate",
    "baseSalary",
    "status",
    "notes",
  ];
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(headers.map((header) => row[header] ?? ""));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

interface EmployeeDto {
  id: string;
  employeeNo: string;
  fullName: string;
  phone: string;
  branchId: string;
  branchName: string;
  departmentName: string | null;
  jobTitle: string;
  hireDate: string;
  baseSalary: number;
  status: string;
  archivedAt: string | null;
}

interface DailyDto {
  submission: { id: string | null; status: string; rejectionReason: string | null; preparedBy: string | null; submittedBy: string | null; approvedBy: string | null; lastCorrectedBy: string | null };
  rows: Array<{ id: string | null; employeeId: string | null; fullName: string; status: string; lateMinutes: number; reason: string; notes: string; recorded: boolean; temporary: boolean }>;
  counts: Record<string, number>;
  capabilities: Record<string, boolean>;
}

describe("BATAWIL Phase 2 HR operations", () => {
  let ctx: TestContext;
  let aden: TestBranch;
  let sanaa: TestBranch;
  let hrDirectorUser: SeededUser;
  let hrOfficerUser: SeededUser;
  let financeUser: SeededUser;
  let executiveUser: SeededUser;
  let managerAdenUser: SeededUser;
  let managerSanaaUser: SeededUser;
  let hr: TestAgent;
  let hrOfficer: TestAgent;
  let finance: TestAgent;
  let executive: TestAgent;
  let managerAden: TestAgent;
  let managerSanaa: TestAgent;

  const today = localToday();
  const yesterday = shiftDate(today, -1);
  const twoDaysAgo = shiftDate(today, -2);
  const previous = monthInfo(today, -1);
  const previousWorkdays = workdaysOf(previous.year, previous.month, 2);

  let departmentId = "";
  let employeeAden: EmployeeDto;
  let employeeSanaa: EmployeeDto;
  let employeeTransfer: EmployeeDto;
  let archivedEmployee: EmployeeDto;
  let importedEmployee: EmployeeDto;

  let todaySheetId = "";
  let previousSheetId = "";
  let leaveId = "";

  before(async () => {
    ctx = await createTestContext();
    aden = await createBranch(ctx.db, "ADEN", "فرع عدن", "عدن");
    sanaa = await createBranch(ctx.db, "SANAA", "فرع صنعاء", "صنعاء");
    hrDirectorUser = await seedUser(ctx.db, {
      username: "hr.director",
      password: PASSWORDS.hrDirector,
      roleKey: "hr_director",
      fullName: "مدير الموارد البشرية",
      allBranches: true,
    });
    hrOfficerUser = await seedUser(ctx.db, {
      username: "hr.officer2",
      password: PASSWORDS.hrOfficer,
      roleKey: "hr_officer",
      fullName: "مسؤول شؤون الموظفين",
      allBranches: true,
    });
    financeUser = await seedUser(ctx.db, {
      username: "finance2",
      password: PASSWORDS.finance,
      roleKey: "finance",
      fullName: "مسؤول المالية",
      allBranches: true,
    });
    executiveUser = await seedUser(ctx.db, {
      username: "executive2",
      password: PASSWORDS.executive,
      roleKey: "executive",
      fullName: "المدير التنفيذي",
      allBranches: true,
    });
    managerAdenUser = await seedUser(ctx.db, {
      username: "manager.aden2",
      password: PASSWORDS.managerAden,
      roleKey: "branch_manager",
      fullName: "مدير فرع عدن",
      branchIds: [aden.id],
    });
    managerSanaaUser = await seedUser(ctx.db, {
      username: "manager.sanaa2",
      password: PASSWORDS.managerSanaa,
      roleKey: "branch_manager",
      fullName: "مدير فرع صنعاء",
      branchIds: [sanaa.id],
    });
    hr = await loginAs(ctx.app, hrDirectorUser.username, PASSWORDS.hrDirector);
    hrOfficer = await loginAs(ctx.app, hrOfficerUser.username, PASSWORDS.hrOfficer);
    finance = await loginAs(ctx.app, financeUser.username, PASSWORDS.finance);
    executive = await loginAs(ctx.app, executiveUser.username, PASSWORDS.executive);
    managerAden = await loginAs(ctx.app, managerAdenUser.username, PASSWORDS.managerAden);
    managerSanaa = await loginAs(ctx.app, managerSanaaUser.username, PASSWORDS.managerSanaa);
  });

  after(async () => {
    await ctx.db.close();
  });

  test("department and employee records enforce scope, uniqueness and archival without hard delete", async () => {
    const created = await post(hr, "/api/departments", { name: "الموارد البشرية" });
    assert.equal(created.status, 201);
    departmentId = created.body.id as string;
    assert.equal((await post(hr, "/api/departments", { name: "الموارد البشرية" })).status, 409);

    const deniedCreate = await post(managerAden, "/api/employees", {
      fullName: "غير مصرح",
      phone: "770009999",
      branchId: aden.id,
      hireDate: "2020-01-01",
    });
    assert.equal(deniedCreate.status, 403);

    const createEmployee = async (payload: Record<string, unknown>) => {
      const response = await post(hr, "/api/employees", payload);
      assert.equal(response.status, 201, JSON.stringify(response.body));
      return response.body.employee as EmployeeDto;
    };

    employeeAden = await createEmployee({
      employeeNo: "",
      fullName: "أحمد علي عدن",
      phone: "770000001",
      nationalId: "NAT-1001",
      branchId: aden.id,
      departmentId,
      jobTitle: "محاسب",
      hireDate: "2020-01-01",
      baseSalary: 120000,
      status: "active",
      notes: "موظف فرع عدن",
    });
    assert.match(employeeAden.employeeNo, /^EMP-\d{5}$/);

    employeeSanaa = await createEmployee({
      fullName: "سالم صالح صنعاء",
      phone: "770000002",
      nationalId: "NAT-1002",
      branchId: sanaa.id,
      jobTitle: "مسؤول تشغيل",
      hireDate: "2020-01-01",
      baseSalary: 100000,
      status: "active",
    });

    employeeTransfer = await createEmployee({
      fullName: "تحويل وظيفي عدن",
      phone: "770000003",
      nationalId: "NAT-1003",
      branchId: aden.id,
      departmentId,
      jobTitle: "منسق",
      hireDate: "2020-01-01",
      baseSalary: 80000,
      status: "active",
    });

    archivedEmployee = await createEmployee({
      fullName: "موظف للأرشفة",
      phone: "770000005",
      branchId: aden.id,
      hireDate: "2020-01-01",
      baseSalary: 50000,
    });

    const duplicateNational = await post(hr, "/api/employees", {
      fullName: "مكرر وطني",
      phone: "770000006",
      nationalId: "NAT-1001",
      branchId: aden.id,
      hireDate: "2020-01-01",
    });
    assert.equal(duplicateNational.status, 409);
    assert.equal(duplicateNational.body.error.code, "DUPLICATE_NATIONAL_ID");

    const updated = await patch(hr, `/api/employees/${employeeAden.id}`, { jobTitle: "محاسب أول" });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.employee.jobTitle, "محاسب أول");

    const directBranchChange = await patch(hr, `/api/employees/${employeeAden.id}`, { branchId: sanaa.id });
    assert.equal(directBranchChange.status, 400);
    assert.equal(directBranchChange.body.error.code, "TRANSFER_REQUIRED");

    const managerList = await managerAden.get("/api/employees?pageSize=100");
    assert.equal(managerList.status, 200);
    const managerNames = (managerList.body.items as EmployeeDto[]).map((item) => item.fullName);
    assert.ok(managerNames.includes("أحمد علي عدن"));
    assert.equal(managerNames.includes("سالم صالح صنعاء"), false);

    const crossBranchSearch = await managerAden.get("/api/employees?q=سالم");
    assert.equal(crossBranchSearch.body.total, 0);
    assert.equal((await managerSanaa.get(`/api/employees/${employeeAden.id}`)).status, 404);
    assert.equal((await managerAden.get(`/api/employees/${employeeSanaa.id}`)).status, 404);

    const options = await managerAden.get(`/api/employees/options?branchId=${aden.id}`);
    assert.equal(options.status, 200);
    assert.ok((options.body.items as Array<{ id: string }>).some((item) => item.id === employeeAden.id));

    assert.equal((await managerAden.get("/api/employees/import-template")).status, 403);
    const template = await hr.get("/api/employees/import-template");
    assert.equal(template.status, 200);
    assert.match(String(template.headers["content-type"]), /spreadsheetml/);

    const exportResponse = await hr.get("/api/employees/export.xlsx");
    assert.equal(exportResponse.status, 200);
    assert.match(String(exportResponse.headers["content-type"]), /spreadsheetml/);
    assert.ok((await countAudit(ctx.db, "employee.exported")) >= 1);

    const invalidFile = await hr
      .post("/api/employees/import")
      .set("X-Requested-With", XHR_HEADER)
      .set("Content-Type", XLSX_MIME)
      .send(await makeWorkbook([{ branchCode: "ADEN", fullName: "ناقص هاتف", hireDate: "2021-01-01" }]));
    assert.equal(invalidFile.status, 400);
    assert.equal(invalidFile.body.error.code, "IMPORT_VALIDATION");

    const importResponse = await hr
      .post("/api/employees/import")
      .set("X-Requested-With", XHR_HEADER)
      .set("Content-Type", XLSX_MIME)
      .send(
        await makeWorkbook([
          {
            fullName: "موظف مستورد",
            phone: "770000004",
            nationalId: "NAT-1004",
            branchCode: "ADEN",
            departmentName: "الموارد البشرية",
            jobTitle: "منسق",
            hireDate: "2021-05-01",
            baseSalary: 55000,
            status: "نشط",
          },
        ]),
      );
    assert.equal(importResponse.status, 201, JSON.stringify(importResponse.body));
    assert.equal(importResponse.body.imported, 1);
    const imported = await hr.get("/api/employees?q=موظف مستورد");
    importedEmployee = (imported.body.items as EmployeeDto[])[0] as EmployeeDto;
    assert.ok(importedEmployee);
    assert.equal(importedEmployee.baseSalary, 55000);
    assert.ok((await countAudit(ctx.db, "employee.imported")) >= 1);

    const archive = await post(hr, `/api/employees/${archivedEmployee.id}/archive`, { reason: "انتهاء التعاقد" });
    assert.equal(archive.status, 200);
    const archived = await hr.get(`/api/employees/${archivedEmployee.id}`);
    assert.equal(archived.status, 200);
    assert.equal(archived.body.employee.status, "resigned");
    assert.ok(archived.body.employee.archivedAt);
    const defaultList = await hr.get("/api/employees?q=للأرشفة");
    assert.equal(defaultList.body.total, 0);
    const archivedList = await hr.get("/api/employees?q=للأرشفة&includeArchived=true");
    assert.equal(archivedList.body.total, 1);
    assert.ok((await countAudit(ctx.db, "employee.archived")) >= 1);
  });

  test("daily attendance saves once per branch and date, submits, approves, corrects and returns with reason", async () => {
    const initial = await managerAden.get(`/api/attendance/daily?branchId=${aden.id}&date=${today}`);
    assert.equal(initial.status, 200);
    assert.equal(initial.body.submission.status, "draft");
    assert.equal(initial.body.capabilities.canManage, true);
    assert.equal(initial.body.capabilities.canApprove, false);
    assert.ok((initial.body.rows as DailyDto["rows"]).some((row) => row.employeeId === employeeAden.id));

    assert.equal((await managerSanaa.get(`/api/attendance/daily?branchId=${aden.id}&date=${today}`)).status, 403);
    assert.equal(
      (
        await post(managerSanaa, "/api/attendance/daily/save", {
          branchId: aden.id,
          date: today,
          rows: [{ employeeId: employeeAden.id, status: "present" }],
          notes: "",
        })
      ).status,
      403,
    );

    const duplicateManual = await post(managerAden, "/api/attendance/daily/save", {
      branchId: aden.id,
      date: today,
      rows: [
        { manualName: "عامل يومي", status: "present" },
        { manualName: "عامل يومي", status: "present" },
      ],
      notes: "",
    });
    assert.equal(duplicateManual.status, 400);
    assert.equal(duplicateManual.body.error.code, "DUPLICATE_MANUAL");

    const firstSave = await post(managerAden, "/api/attendance/daily/save", {
      branchId: aden.id,
      date: today,
      rows: [
        { employeeId: employeeAden.id, status: "present", checkIn: "08:20", checkOut: "16:05", notes: "حضور أولي" },
        { employeeId: employeeTransfer.id, status: "absent", checkIn: "", checkOut: "", reason: "ظرف صحي" },
        { manualName: "عامل مؤقت", status: "present", checkIn: "08:00", checkOut: "16:00" },
      ],
      notes: "تحضير أولي",
    });
    assert.equal(firstSave.status, 200, JSON.stringify(firstSave.body));
    todaySheetId = firstSave.body.submission.id as string;
    assert.ok(todaySheetId);

    const afterFirst = await managerAden.get(`/api/attendance/daily?branchId=${aden.id}&date=${today}`);
    const recordedManual = (afterFirst.body.rows as DailyDto["rows"]).find((row) => row.temporary);
    assert.ok(recordedManual);
    assert.equal(afterFirst.body.counts.manual, 1);
    assert.equal((afterFirst.body.rows as DailyDto["rows"]).find((row) => row.employeeId === employeeAden.id)?.lateMinutes, 10);

    const secondSave = await post(managerAden, "/api/attendance/daily/save", {
      branchId: aden.id,
      date: today,
      rows: [
        { employeeId: employeeAden.id, status: "present", checkIn: "08:20", checkOut: "16:05", notes: "تعديل الحفظ" },
        { employeeId: employeeTransfer.id, status: "absent", checkIn: "", checkOut: "", reason: "ظرف صحي" },
      ],
      notes: "كشف نهائي",
    });
    assert.equal(secondSave.status, 200);
    assert.equal(secondSave.body.submission.id, todaySheetId);
    const afterSecond = await managerAden.get(`/api/attendance/daily?branchId=${aden.id}&date=${today}`);
    assert.equal(afterSecond.body.counts.manual, 0);
    assert.equal((afterSecond.body.rows as DailyDto["rows"]).some((row) => row.temporary), false);
    assert.equal((afterSecond.body.rows as DailyDto["rows"]).find((row) => row.employeeId === employeeAden.id)?.recorded, true);
    assert.equal((afterSecond.body.rows as DailyDto["rows"]).find((row) => row.employeeId === employeeTransfer.id)?.recorded, true);
    const duplicates = await ctx.db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM attendance_submissions WHERE branch_id = $1 AND work_date = $2::date",
      [aden.id, today],
    );
    assert.equal(duplicates.rows[0]?.count, 1);

    const submit = await post(managerAden, `/api/attendance/daily/${todaySheetId}/submit`, { note: "جاهز للاعتماد" });
    assert.equal(submit.status, 200);
    assert.equal((await post(managerAden, "/api/attendance/daily/save", { branchId: aden.id, date: today, rows: [], notes: "" })).status, 409);
    assert.equal((await post(managerAden, `/api/attendance/daily/${todaySheetId}/approve`, { reason: "" })).status, 403);
    assert.equal((await post(managerSanaa, `/api/attendance/daily/${todaySheetId}/approve`, { reason: "" })).status, 403);

    const hrNotifications = await hr.get("/api/notifications");
    assert.equal(hrNotifications.status, 200);
    assert.ok(hrNotifications.body.unread > 0);
    const firstNotification = (hrNotifications.body.items as Array<{ id: string }>)[0];
    assert.ok(firstNotification);
    const unreadBefore = hrNotifications.body.unread as number;
    assert.equal((await post(hr, `/api/notifications/${firstNotification.id}/read`)).status, 200);
    const afterRead = await hr.get("/api/notifications/unread-count");
    assert.equal(afterRead.body.unread, unreadBefore - 1);
    assert.equal((await post(hr, "/api/notifications/read-all")).status, 200);
    assert.equal((await hr.get("/api/notifications/unread-count")).body.unread, 0);

    const inbox = await hr.get("/api/approvals?type=attendance_day");
    assert.equal(inbox.status, 200);
    const approval = (inbox.body.items as Array<{ id: string; entityId: string; canDecide: boolean }>).find((item) => item.entityId === todaySheetId);
    assert.ok(approval);
    assert.equal(approval.canDecide, true);
    const details = await hr.get(`/api/approvals/${approval.id}`);
    assert.equal(details.status, 200);
    assert.equal(details.body.item.details.work_date, today);
    assert.ok(details.body.history.length >= 1);
    const approved = await post(hr, `/api/approvals/${approval.id}/approve`, { reason: "مطابق للسجلات" });
    assert.equal(approved.status, 200);

    const afterApprove = await hr.get(`/api/attendance/daily?branchId=${aden.id}&date=${today}`);
    assert.equal(afterApprove.body.submission.status, "approved");
    assert.equal(afterApprove.body.submission.approvedBy, "مدير الموارد البشرية");
    assert.equal(afterApprove.body.capabilities.canCorrect, true);
    assert.equal(afterApprove.body.submission.rejectionReason, null);
    const managerNotifications = await managerAden.get("/api/notifications");
    assert.ok(
      (managerNotifications.body.items as Array<{ title: string }>).some((item) => item.title.includes("اعتماد كشف التحضير")),
    );

    const rowId = (afterApprove.body.rows as DailyDto["rows"]).find((row) => row.employeeId === employeeAden.id)?.id as string;
    assert.ok(rowId);
    const missingReason = await patch(hr, `/api/attendance/daily/${todaySheetId}/rows/${rowId}`, { notes: "بدون سبب" });
    assert.equal(missingReason.status, 400);
    const correction = await patch(hr, `/api/attendance/daily/${todaySheetId}/rows/${rowId}`, {
      status: "late",
      checkIn: "08:30",
      correctionReason: "تصحيح وقت البصمة",
    });
    assert.equal(correction.status, 200);
    assert.equal(
      (await patch(managerAden, `/api/attendance/daily/${todaySheetId}/rows/${rowId}`, { status: "present", correctionReason: "محاولة غير مصرحة" })).status,
      403,
    );
    const corrected = await hr.get(`/api/attendance/daily?branchId=${aden.id}&date=${today}`);
    const correctedRow = (corrected.body.rows as DailyDto["rows"]).find((row) => row.employeeId === employeeAden.id);
    assert.equal(correctedRow?.status, "late");
    assert.equal(correctedRow?.lateMinutes, 20);
    assert.equal(corrected.body.submission.lastCorrectedBy, "مدير الموارد البشرية");
    assert.equal(corrected.body.submission.preparedBy, "مدير فرع عدن");
    assert.equal(corrected.body.submission.submittedBy, "مدير فرع عدن");
    assert.ok((await countAudit(ctx.db, "attendance.corrected")) >= 1);
    assert.equal((await post(managerAden, "/api/attendance/daily/save", { branchId: aden.id, date: today, rows: [], notes: "" })).status, 409);

    const rejectedSave = await post(managerAden, "/api/attendance/daily/save", {
      branchId: aden.id,
      date: yesterday,
      rows: [{ employeeId: employeeAden.id, status: "present", checkIn: "08:00" }],
      notes: "كشف الأمس",
    });
    assert.equal(rejectedSave.status, 200);
    const rejectedId = rejectedSave.body.submission.id as string;
    assert.equal((await post(managerAden, `/api/attendance/daily/${rejectedId}/submit`, { note: "" })).status, 200);
    const rejection = await post(hr, `/api/attendance/daily/${rejectedId}/reject`, { reason: "لا" });
    assert.equal(rejection.status, 400);
    const rejected = await post(hr, `/api/attendance/daily/${rejectedId}/reject`, { reason: "الكشف ناقص" });
    assert.equal(rejected.status, 200);
    const returned = await managerAden.get(`/api/attendance/daily?branchId=${aden.id}&date=${yesterday}`);
    assert.equal(returned.body.submission.status, "rejected");
    assert.equal(returned.body.submission.rejectionReason, "الكشف ناقص");
    const resave = await post(managerAden, "/api/attendance/daily/save", {
      branchId: aden.id,
      date: yesterday,
      rows: [{ employeeId: employeeAden.id, status: "present", checkIn: "08:00" }, { employeeId: employeeTransfer.id, status: "mission" }],
      notes: "مكتمل بعد الإعادة",
    });
    assert.equal(resave.status, 200);
    assert.equal((await post(managerAden, `/api/attendance/daily/${rejectedId}/submit`, { note: "" })).status, 200);
    assert.equal((await post(hr, `/api/attendance/daily/${rejectedId}/approve`, { reason: "" })).status, 200);
    const finallyApproved = await managerAden.get(`/api/attendance/daily?branchId=${aden.id}&date=${yesterday}`);
    assert.equal(finallyApproved.body.submission.status, "approved");
    assert.equal(finallyApproved.body.submission.rejectionReason, null);

    assert.equal((await post(hrOfficer, `/api/attendance/daily/${todaySheetId}/approve`, {})).status, 403);
  });

  test("monthly attendance derives from daily sheets, blocks unreviewed missing days and exposes branch follow-up", async () => {
    const first = previousWorkdays[0];
    const second = previousWorkdays[1];
    assert.ok(first && second);
    const emptyMonthly = await managerAden.get(`/api/attendance/monthly?branchId=${aden.id}&year=${previous.year}&month=${previous.month}`);
    assert.equal(emptyMonthly.status, 200);
    assert.equal(emptyMonthly.body.monthly.status, "draft");
    assert.ok(emptyMonthly.body.missingDays > 0);

    const previousDaily = await post(managerAden, "/api/attendance/daily/save", {
      branchId: aden.id,
      date: first.iso,
      rows: [
        { employeeId: employeeAden.id, status: "present", checkIn: "08:00", checkOut: "16:00" },
        { employeeId: employeeTransfer.id, status: "absent", reason: "بدون إشعار" },
      ],
      notes: "تحضير الشهر السابق",
    });
    assert.equal(previousDaily.status, 200, JSON.stringify(previousDaily.body));
    previousSheetId = previousDaily.body.submission.id as string;
    assert.equal((await post(managerAden, `/api/attendance/daily/${previousSheetId}/submit`, { note: "" })).status, 200);

    const derived = await managerAden.get(`/api/attendance/monthly?branchId=${aden.id}&year=${previous.year}&month=${previous.month}`);
    assert.equal(derived.status, 200);
    const adenRow = (derived.body.rows as Array<{ employeeId: string; days: Array<{ day: number; status: string | null; source: string }>; totals: Record<string, number> }>).find(
      (row) => row.employeeId === employeeAden.id,
    );
    assert.ok(adenRow);
    assert.equal(adenRow.days.find((day) => day.day === first.day)?.status, "present");
    assert.equal(adenRow.days.find((day) => day.day === first.day)?.source, "daily");
    assert.equal(adenRow.totals.present, 1);
    assert.ok(derived.body.missingDays > 0);
    assert.ok((derived.body.missingCells as Array<{ employeeId: string; day: number }>).length > 0);

    const saved = await post(managerAden, "/api/attendance/monthly/save", {
      branchId: aden.id,
      year: previous.year,
      month: previous.month,
      notes: "مراجعة شهرية",
      overrides: [{ employeeId: employeeAden.id, day: second.day, status: "mission", note: "مهمة رسمية" }],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const monthlyId = saved.body.id as string;
    const withOverride = await managerAden.get(`/api/attendance/monthly?branchId=${aden.id}&year=${previous.year}&month=${previous.month}`);
    const overridden = (withOverride.body.rows as Array<{ employeeId: string; days: Array<{ day: number; status: string | null; source: string; note: string }> }>).find(
      (row) => row.employeeId === employeeAden.id,
    );
    assert.equal(overridden?.days.find((day) => day.day === second.day)?.source, "override");
    assert.equal(overridden?.days.find((day) => day.day === second.day)?.status, "mission");
    assert.equal(overridden?.days.find((day) => day.day === second.day)?.note, "مهمة رسمية");

    const blocked = await post(managerAden, `/api/attendance/monthly/${monthlyId}/submit`, { missingDaysConfirmed: false, note: "" });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "MISSING_DAYS_CONFIRMATION");
    assert.ok(blocked.body.error.details.missingDays > 0);

    const submitted = await post(managerAden, `/api/attendance/monthly/${monthlyId}/submit`, { missingDaysConfirmed: true, note: "تمت مراجعة النواقص" });
    assert.equal(submitted.status, 200);
    assert.equal((await post(managerAden, `/api/attendance/monthly/${monthlyId}/approve`, {})).status, 403);
    assert.equal((await post(hr, `/api/attendance/monthly/${monthlyId}/reject`, { reason: "مراجعة" })).status, 200);
    assert.equal((await post(managerAden, `/api/attendance/monthly/save`, { branchId: aden.id, year: previous.year, month: previous.month, notes: "إعادة حفظ", overrides: [] })).status, 200);

    const resubmit = await post(managerAden, `/api/attendance/monthly/${monthlyId}/submit`, { missingDaysConfirmed: true, note: "إعادة إرسال" });
    assert.equal(resubmit.status, 200);
    assert.equal((await post(hr, `/api/attendance/monthly/${monthlyId}/approve`, { reason: "" })).status, 200);
    const approvedMonthly = await managerAden.get(`/api/attendance/monthly?branchId=${aden.id}&year=${previous.year}&month=${previous.month}`);
    assert.equal(approvedMonthly.body.monthly.status, "approved");
    assert.equal(approvedMonthly.body.monthly.approvedBy, "مدير الموارد البشرية");
    assert.equal((await post(managerAden, `/api/attendance/monthly/save`, { branchId: aden.id, year: previous.year, month: previous.month, notes: "", overrides: [] })).status, 409);

    const followUp = await hr.get(`/api/attendance/follow-up?year=${previous.year}&month=${previous.month}`);
    assert.equal(followUp.status, 200);
    const adenFollowUp = (followUp.body.rows as Array<{ branchId: string; status: string; monthlyStatus: string; late: boolean }>).find((row) => row.branchId === aden.id);
    assert.equal(adenFollowUp?.status, "approved");
    assert.equal(adenFollowUp?.monthlyStatus, "approved");
    assert.equal(adenFollowUp?.late, false);
    const lateOnly = await hr.get(`/api/attendance/follow-up?year=${previous.year}&month=${previous.month}&late=true`);
    assert.ok((lateOnly.body.rows as Array<{ late: boolean }>).every((row) => row.late === true));
    assert.ok((lateOnly.body.totals as { lateBranches: number }).lateBranches >= 1);
    const managerFollowUp = await managerSanaa.get(`/api/attendance/follow-up?year=${previous.year}&month=${previous.month}`);
    assert.deepEqual(
      (managerFollowUp.body.rows as Array<{ branchId: string }>).map((row) => row.branchId),
      [sanaa.id],
    );
  });

  test("approved leaves update covered draft attendance and cannot overlap", async () => {
    const draft = await post(managerAden, "/api/attendance/daily/save", {
      branchId: aden.id,
      date: twoDaysAgo,
      rows: [
        { employeeId: employeeAden.id, status: "present", checkIn: "08:00" },
        { employeeId: employeeTransfer.id, status: "present", checkIn: "08:00" },
      ],
      notes: "بانتظار إجازة",
    });
    assert.equal(draft.status, 200);

    const created = await post(managerAden, "/api/leaves", {
      employeeId: employeeAden.id,
      leaveType: "annual",
      startDate: twoDaysAgo,
      endDate: twoDaysAgo,
      reason: "ظرف عائلي",
      notes: "",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    leaveId = created.body.id as string;
    assert.equal((await post(managerAden, `/api/leaves/${leaveId}/submit`, { note: "" })).status, 200);
    assert.equal(
      (
        await post(managerAden, "/api/leaves", {
          employeeId: employeeAden.id,
          leaveType: "sick",
          startDate: twoDaysAgo,
          endDate: twoDaysAgo,
        })
      ).status,
      409,
    );

    const attachment = await managerAden
      .post(`/api/attachments?ownerType=leave&ownerId=${leaveId}&fileName=leave.pdf`)
      .set("X-Requested-With", XHR_HEADER)
      .set("Content-Type", "application/pdf")
      .send(Buffer.from("%PDF-1.4 leave approval"));
    assert.equal(attachment.status, 201, JSON.stringify(attachment.body));

    const inbox = await managerAden.get("/api/approvals?type=leave");
    const item = (inbox.body.items as Array<{ id: string; entityId: string; canDecide: boolean }>).find((row) => row.entityId === leaveId);
    assert.ok(item);
    assert.equal(item.canDecide, false);
    assert.equal((await post(managerAden, `/api/approvals/${item.id}/approve`, {})).status, 403);

    const details = await hr.get(`/api/approvals/${item.id}`);
    assert.equal(details.status, 200);
    assert.equal(details.body.item.entityType, "leave");
    assert.equal(details.body.attachments.length, 1);
    assert.equal((await post(hr, `/api/approvals/${item.id}/approve`, { reason: "موافق" })).status, 200);

    const daily = await managerAden.get(`/api/attendance/daily?branchId=${aden.id}&date=${twoDaysAgo}`);
    const leaveRow = (daily.body.rows as DailyDto["rows"]).find((row) => row.employeeId === employeeAden.id);
    assert.equal(leaveRow?.status, "leave");
    assert.ok(leaveRow?.reason.includes("إجازة معتمدة"));
    const leave = await hr.get("/api/leaves?employeeId=" + employeeAden.id);
    assert.equal((leave.body.items as Array<{ id: string; status: string }>).find((row) => row.id === leaveId)?.status, "approved");
  });

  test("transfers stay pending until approval, apply effective dating and preserve historical attendance", async () => {
    const futureAttempt = await post(managerAden, "/api/transfers", {
      employeeId: employeeTransfer.id,
      toBranchId: sanaa.id,
      effectiveDate: yesterday,
      reason: "نقل تشغيلي",
      notes: "نقل معتمد",
    });
    assert.equal(futureAttempt.status, 201, JSON.stringify(futureAttempt.body));
    const transferId = futureAttempt.body.id as string;
    const before = await hr.get(`/api/employees/${employeeTransfer.id}`);
    assert.equal(before.body.employee.branchId, aden.id);

    const deniedApprove = await managerAden.post(`/api/transfers/${transferId}/approve`).set("X-Requested-With", XHR_HEADER).send({});
    assert.equal(deniedApprove.status, 403);
    const approved = await post(hr, `/api/transfers/${transferId}/approve`, { reason: "موافق" });
    assert.equal(approved.status, 200);

    const after = await managerSanaa.get(`/api/employees/${employeeTransfer.id}`);
    assert.equal(after.status, 200);
    assert.equal(after.body.employee.branchId, sanaa.id);
    assert.ok(after.body.transfers[0].appliedAt);
    assert.equal((await managerAden.get(`/api/employees/${employeeTransfer.id}`)).status, 404);

    const historical = await ctx.db.query<{ branch_id: string; status: string }>(
      "SELECT branch_id, status FROM attendance_submissions WHERE id = $1",
      [todaySheetId],
    );
    assert.equal(historical.rows[0]?.branch_id, aden.id);
    const historicalRows = await ctx.db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM daily_attendance d JOIN attendance_submissions s ON s.id = d.submission_id
       WHERE d.employee_id = $1 AND s.branch_id = $2`,
      [employeeTransfer.id, aden.id],
    );
    assert.ok((historicalRows.rows[0]?.count ?? 0) >= 1);
    const adenDaily = await managerAden.get(`/api/attendance/daily?branchId=${aden.id}&date=${today}`);
    assert.ok((adenDaily.body.rows as DailyDto["rows"]).some((row) => row.employeeId === employeeTransfer.id));
  });

  test("new hire approval creates one employee atomically and records the approver", async () => {
    const created = await post(managerAden, "/api/new-hires", {
      fullName: "مرشح جديد",
      phone: "770000010",
      branchId: aden.id,
      departmentId,
      jobTitle: "فني دعم",
      proposedSalary: 60000,
      startDate: today,
      notes: "تمت المقابلة",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const requestId = created.body.id as string;
    assert.equal((await post(managerAden, `/api/new-hires/${requestId}/submit`, {})).status, 200);
    assert.equal(
      (
        await post(managerSanaa, `/api/new-hires/${requestId}/approve`, { reason: "" })
      ).status,
      403,
    );
    const approved = await post(hr, `/api/new-hires/${requestId}/approve`, { reason: "اعتماد التعيين" });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const employeeId = approved.body.employeeId as string;
    const employeeNo = approved.body.employeeNo as string;
    assert.ok(employeeId);
    assert.match(employeeNo, /^EMP-\d{5}$/);
    const employee = await hr.get(`/api/employees/${employeeId}`);
    assert.equal(employee.status, 200);
    assert.equal(employee.body.employee.fullName, "مرشح جديد");
    assert.equal(employee.body.employee.baseSalary, 60000);
    assert.equal(employee.body.employee.status, "active");
    const list = await hr.get("/api/new-hires?q=مرشح");
    const request = (list.body.items as Array<{ id: string; status: string; approvedBy: string | null; employeeNo: string | null }>).find((row) => row.id === requestId);
    assert.equal(request?.status, "completed");
    assert.equal(request?.approvedBy, "مدير الموارد البشرية");
    assert.equal(request?.employeeNo, employeeNo);

    const duplicate = await post(managerAden, "/api/new-hires", {
      fullName: "مرشح جديد",
      phone: "770000010",
      branchId: aden.id,
      jobTitle: "فني دعم",
      proposedSalary: 60000,
      startDate: today,
      notes: "",
    });
    assert.equal(duplicate.status, 201);
    assert.equal((await post(managerAden, `/api/new-hires/${duplicate.body.id}/submit`, {})).status, 409);
  });

  test("advances require HR then finance approval, disbursement before deduction and keep a movement ledger", async () => {
    const created = await post(managerAden, "/api/advances", {
      employeeId: employeeAden.id,
      amount: 1000,
      reason: "سلفة طارئة",
      requestDate: today,
      installments: 4,
      deductionMethod: "installments",
      notes: "",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const advanceId = created.body.id as string;
    assert.equal((await post(managerAden, `/api/advances/${advanceId}/submit`, {})).status, 200);
    const hrApproval = await post(hr, `/api/advances/${advanceId}/approve`, { reason: "موافقة الموارد البشرية" });
    assert.equal(hrApproval.status, 200);
    assert.equal(hrApproval.body.stage, "hr");
    const financeApproval = await post(finance, `/api/advances/${advanceId}/approve`, { reason: "موافقة المالية" });
    assert.equal(financeApproval.status, 200);
    assert.equal(financeApproval.body.stage, "finance");

    const earlyDeduction = await post(finance, `/api/advances/${advanceId}/deductions`, { amount: 100, transactionDate: today });
    assert.equal(earlyDeduction.status, 409);
    assert.equal((await post(hr, `/api/advances/${advanceId}/disburse`, {})).status, 403);
    const disbursed = await post(finance, `/api/advances/${advanceId}/disburse`, { transactionDate: today, notes: "صرف نقدي" });
    assert.equal(disbursed.status, 200);
    const excessive = await post(finance, `/api/advances/${advanceId}/deductions`, { amount: 2000, transactionDate: today });
    assert.equal(excessive.status, 400);
    assert.equal(excessive.body.error.code, "EXCEEDS_REMAINING");
    const deduction = await post(finance, `/api/advances/${advanceId}/deductions`, { amount: 300, transactionDate: today, notes: "القسط الأول" });
    assert.equal(deduction.status, 200);
    assert.equal(deduction.body.remaining, 700);

    const movements = await finance.get(`/api/advances/${advanceId}/movements`);
    assert.equal(movements.status, 200);
    assert.equal(movements.body.advance.status, "disbursed");
    assert.equal(movements.body.advance.remaining, 700);
    assert.equal(movements.body.movements.length, 2);
    assert.deepEqual(
      (movements.body.movements as Array<{ type: string; amount: number }>).map((row) => row.type).sort(),
      ["deduction", "disbursement"],
    );
    const list = await finance.get("/api/advances?pageSize=100");
    assert.equal(list.body.totals.approvedAmount, 1000);
    assert.equal(list.body.totals.deducted, 300);
    assert.equal(list.body.totals.outstanding, 700);
    assert.ok((await countAudit(ctx.db, "advance.disbursed")) >= 1);
    assert.ok((await countAudit(ctx.db, "advance.deduction_recorded")) >= 1);
  });

  test("payroll snapshots attendance and advances, posts linked deductions on approval and locks approved records", async () => {
    const generated = await post(hr, "/api/payroll/generate", { branchId: "", year: previous.year, month: previous.month });
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    assert.ok(generated.body.created >= 1);
    const again = await post(hr, "/api/payroll/generate", { branchId: "", year: previous.year, month: previous.month });
    assert.equal(again.status, 200);
    assert.equal(again.body.created, 0);

    const list = await hr.get(`/api/payroll?year=${previous.year}&month=${previous.month}`);
    assert.equal(list.status, 200);
    const record = (list.body.items as Array<{ id: string; employeeId: string; baseSalary: number; advanceOutstanding: number; advanceDeduction: number; allowances: number; deductions: number; net: number; presentDays: number; reviewStatus: string }>).find(
      (row) => row.employeeId === employeeAden.id,
    );
    assert.ok(record);
    assert.equal(record.baseSalary, 120000);
    assert.equal(record.advanceOutstanding, 700);
    assert.equal(record.advanceDeduction, 0);
    assert.equal(record.presentDays, 1);
    assert.equal(record.net, 120000);

    const review = await patch(hr, `/api/payroll/${record.id}`, { allowances: 500, deductions: 100, reviewStatus: "reviewed" });
    assert.equal(review.status, 200);
    const overCap = await patch(hr, `/api/payroll/${record.id}`, { advanceDeduction: 800 });
    assert.equal(overCap.status, 400);
    assert.equal(overCap.body.error.code, "EXCEEDS_OUTSTANDING");
    const approved = await patch(hr, `/api/payroll/${record.id}`, {
      advanceDeduction: 700,
      notes: "مراجعة نهائية",
      reviewStatus: "approved",
    });
    assert.equal(approved.status, 200);

    const updated = await hr.get(`/api/payroll?year=${previous.year}&month=${previous.month}`);
    const updatedRecord = (updated.body.items as Array<{ employeeId: string; net: number; reviewStatus: string; notes: string; totals?: unknown }>).find(
      (row) => row.employeeId === employeeAden.id,
    );
    assert.equal(updatedRecord?.net, 119700);
    assert.equal(updatedRecord?.reviewStatus, "approved");
    assert.equal(updatedRecord?.notes, "مراجعة نهائية");
    assert.equal(
      (updated.body.capabilities as { canManage: boolean }).canManage,
      true,
    );

    const advanceRow = await ctx.db.query<{ id: string }>(
      "SELECT id FROM advance_requests WHERE employee_id = $1 AND status = 'disbursed'",
      [employeeAden.id],
    );
    const advance = advanceRow.rows[0];
    assert.ok(advance);
    const ledger = await ctx.db.query<{ amount: string; payroll_record_id: string | null }>(
      "SELECT amount, payroll_record_id FROM advance_transactions WHERE advance_id = $1 AND type = 'deduction'",
      [advance.id],
    );
    const payrollPosting = ledger.rows.find((row) => row.payroll_record_id === record.id);
    assert.ok(payrollPosting);
    assert.equal(Number(payrollPosting.amount), 700);
    assert.equal(ledger.rows.reduce((total, row) => total + Number(row.amount), 0), 1000);
    const stored = await ctx.db.query<{ advance_outstanding: string }>(
      "SELECT advance_outstanding FROM payroll_records WHERE id = $1",
      [record.id],
    );
    const storedPayroll = stored.rows[0];
    assert.ok(storedPayroll);
    assert.equal(Number(storedPayroll.advance_outstanding), 0);
    const locked = await patch(hr, `/api/payroll/${record.id}`, { allowances: 600 });
    assert.equal(locked.status, 409);
    const lockedDeduction = await patch(hr, `/api/payroll/${record.id}`, { advanceDeduction: 0 });
    assert.equal(lockedDeduction.status, 409);

    assert.ok((await countAudit(ctx.db, "payroll.generated")) >= 1);
    assert.ok((await countAudit(ctx.db, "payroll.updated")) >= 2);
  });

  test("reports cover all requested types, honour scope and export audited Excel files", async () => {
    const dailyAbsent = await hr.get(`/api/reports/daily-absent?date=${today}`);
    assert.equal(dailyAbsent.status, 200);
    assert.equal(dailyAbsent.body.type, "daily-absent");
    assert.ok((dailyAbsent.body.rows as Array<{ employeeName: string }>).some((row) => row.employeeName === "تحويل وظيفي عدن"));
    assert.ok((dailyAbsent.body.columns as unknown[]).length > 0);

    const monthlyAbsent = await hr.get(`/api/reports/monthly-absent?year=${previous.year}&month=${previous.month}`);
    assert.equal(monthlyAbsent.status, 200);
    assert.ok((monthlyAbsent.body.rows as Array<{ employeeName: string }>).some((row) => row.employeeName === "تحويل وظيفي عدن"));

    const mostAbsent = await hr.get(`/api/reports/most-absent?year=${previous.year}&month=${previous.month}`);
    assert.equal(mostAbsent.status, 200);
    assert.equal(mostAbsent.body.type, "most-absent");

    const lateness = await hr.get(`/api/reports/lateness?from=${today}&to=${today}`);
    assert.equal(lateness.status, 200);
    assert.ok((lateness.body.rows as Array<{ employeeName: string; lateMinutes: number }>).some((row) => row.employeeName === "أحمد علي عدن" && row.lateMinutes === 20));

    const workdays = await hr.get(`/api/reports/workdays?year=${previous.year}&month=${previous.month}`);
    assert.equal(workdays.status, 200);
    const workdayRow = (workdays.body.rows as Array<{ employeeId?: string; employeeName: string; presentDays: number }>).find((row) => row.employeeName === "أحمد علي عدن");
    assert.equal(workdayRow?.presentDays, 1);

    const employeeDetail = await hr.get(`/api/reports/employee-detail?employeeId=${employeeAden.id}&from=${previous.start}&to=${previous.end}`);
    assert.equal(employeeDetail.status, 200);
    assert.equal((employeeDetail.body.rows as unknown[]).length, 1);
    assert.equal(employeeDetail.body.rows[0].status, "حاضر");

    const comparison = await hr.get(`/api/reports/branch-comparison?year=${previous.year}&month=${previous.month}`);
    assert.equal(comparison.status, 200);
    assert.equal((comparison.body.rows as unknown[]).length, 2);
    assert.ok((comparison.body.rows as Array<{ monthlyStatus: string }>).some((row) => row.monthlyStatus === "معتمد"));

    assert.equal((await managerSanaa.get(`/api/reports/daily-absent?date=${today}&branchId=${aden.id}`)).status, 403);
    assert.equal((await managerSanaa.get(`/api/reports/employee-detail?employeeId=${employeeAden.id}`)).status, 404);
    assert.equal((await executive.get(`/api/reports/daily-absent?date=${today}`)).status, 200);
    assert.equal((await executive.post("/api/employees").set("X-Requested-With", XHR_HEADER).send({})).status, 403);

    const exported = await hr.get(`/api/reports/daily-absent/export.xlsx?date=${today}`);
    assert.equal(exported.status, 200);
    assert.match(String(exported.headers["content-type"]), /spreadsheetml/);
    assert.ok((await countAudit(ctx.db, "report.exported")) >= 1);
  });

  test("settings are permission guarded, validated and persisted", async () => {
    const initial = await hr.get("/api/settings");
    assert.equal(initial.status, 200);
    assert.equal(initial.body.company.name, "BATAWIL");
    assert.equal(initial.body.capabilities.canManage, true);

    const changed = await patch(hr, "/api/settings", {
      company: { name: "BATAWIL", currency: "YER", printFooter: "نظام الموارد البشرية BATAWIL — نسخة الاختبار" },
    });
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.body.changed, ["company"]);
    const reloaded = await hr.get("/api/settings");
    assert.ok(reloaded.body.company.printFooter.includes("نسخة الاختبار"));
    assert.equal(
      (
        await patch(hr, "/api/settings", {
          attendance: { workStart: "25:00", workEnd: "16:00", lateGraceMinutes: 10, weekendDays: [5, 6] },
        })
      ).status,
      400,
    );
    assert.equal((await managerAden.get("/api/settings")).status, 403);
    assert.equal((await finance.get("/api/settings")).status, 403);
    assert.ok((await countAudit(ctx.db, "settings.updated")) >= 1);
  });

  test("attachments are scoped, validated and audited", async () => {
    const content = Buffer.from("%PDF-1.4 contract content");
    const upload = await hr
      .post(`/api/attachments?ownerType=employee&ownerId=${employeeAden.id}&fileName=contract.pdf`)
      .set("X-Requested-With", XHR_HEADER)
      .set("Content-Type", "application/pdf")
      .send(content);
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    const attachmentId = upload.body.id as string;

    const list = await hr.get(`/api/attachments?ownerType=employee&ownerId=${employeeAden.id}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].fileName, "contract.pdf");

    const download = await hr.get(`/api/attachments/${attachmentId}/download`);
    assert.equal(download.status, 200);
    assert.match(String(download.headers["content-type"]), /application\/pdf/);
    assert.match(String(download.headers["content-disposition"]), /contract\.pdf/);
    assert.equal(Buffer.from(download.body).length, content.length);

    assert.equal((await managerSanaa.get(`/api/attachments/${attachmentId}/download`)).status, 404);
    assert.equal(
      (
        await managerAden
          .post(`/api/attachments?ownerType=employee&ownerId=${employeeAden.id}&fileName=blocked.pdf`)
          .set("X-Requested-With", XHR_HEADER)
          .set("Content-Type", "application/pdf")
          .send(Buffer.from("%PDF-1.4 blocked"))
      ).status,
      403,
    );
    const invalidType = await hr
      .post(`/api/attachments?ownerType=employee&ownerId=${employeeAden.id}&fileName=bad.exe`)
      .set("X-Requested-With", XHR_HEADER)
      .set("Content-Type", "application/x-msdownload")
      .send(Buffer.from("bad"));
    assert.equal(invalidType.status, 400);

    const deleted = await hr.delete(`/api/attachments/${attachmentId}`).set("X-Requested-With", XHR_HEADER);
    assert.equal(deleted.status, 200);
    assert.equal((await hr.get(`/api/attachments?ownerType=employee&ownerId=${employeeAden.id}`)).body.items.length, 0);
    assert.ok((await countAudit(ctx.db, "attachment.uploaded")) >= 1);
    assert.ok((await countAudit(ctx.db, "attachment.deleted")) >= 1);
  });

  test("phase 2 actions are fully audited and legacy data remains readable", async () => {
    for (const action of [
      "employee.created",
      "employee.updated",
      "department.created",
      "attendance.saved",
      "attendance.submitted",
      "attendance.approved",
      "attendance.rejected",
      "attendance.monthly_saved",
      "attendance.monthly_submitted",
      "attendance.monthly_approved",
      "leave.created",
      "leave.submitted",
      "leave.approved",
      "transfer.requested",
      "transfer.approved",
      "new_hire.created",
      "new_hire.submitted",
      "new_hire.approved",
      "advance.created",
      "advance.submitted",
      "advance.hr_approved",
      "advance.approved",
      "payroll.generated",
      "payroll.updated",
      "settings.updated",
      "attachment.uploaded",
    ]) {
      assert.ok(await countAudit(ctx.db, action) > 0, `missing audit action ${action}`);
    }
    const attendance = await hr.get(`/api/attendance/daily?branchId=${aden.id}&date=${today}`);
    assert.equal(attendance.status, 200);
    const meta = await hr.get("/api/meta");
    assert.equal(meta.status, 200);
    assert.equal(meta.body.capabilities.manageEmployees, true);
    assert.equal(meta.body.capabilities.manageSettings, true);
  });
});
