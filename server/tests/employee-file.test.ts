import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createBranch,
  createTestContext,
  del,
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
  hr: "HrDirector2026!x",
  manager: "MgrAden2026!x",
  scoped: "ScopedOfficer2026!x",
};

interface EmployeeDto {
  id: string;
  employeeNo: string;
  fullName: string;
  branchId: string;
  jobTitle: string;
  jobTitleId: string | null;
  managerId: string | null;
  managerName: string | null;
  baseSalary: number;
  archivedAt: string | null;
}

interface ContractDto {
  id: string;
  contractNo: string;
  contractType: string;
  startDate: string;
  endDate: string | null;
  baseSalary: number;
  status: string;
}

interface HistoryDto {
  changeType: string;
  summary: string;
}

interface DetailDto {
  employee: EmployeeDto;
  contracts: ContractDto[];
  documents: Array<{ id: string; title: string; documentType: string; expiresAt: string | null }>;
  history: HistoryDto[];
}

describe("BATAWIL employee file", () => {
  let ctx: TestContext;
  let aden: TestBranch;
  let sanaa: TestBranch;
  let hrUser: SeededUser;
  let managerUser: SeededUser;
  let scopedUser: SeededUser;
  let hr: TestAgent;
  let managerAden: TestAgent;
  let scopedOfficer: TestAgent;

  let departmentId = "";
  let accountantTitleId = "";
  let supervisorTitleId = "";
  let managerEmployee: EmployeeDto;
  let employee: EmployeeDto;
  let sanaaEmployee: EmployeeDto;
  let archivedTarget: EmployeeDto;

  const createEmployee = async (payload: Record<string, unknown>): Promise<EmployeeDto> => {
    const response = await post(hr, "/api/employees", payload);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.employee as EmployeeDto;
  };

  const detail = async (id: string): Promise<DetailDto> => {
    const response = await hr.get(`/api/employees/${id}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body as DetailDto;
  };

  const historyTypes = (value: DetailDto) => value.history.map((row) => row.changeType);

  before(async () => {
    ctx = await createTestContext();
    aden = await createBranch(ctx.db, "ADEN", "فرع عدن", "عدن");
    sanaa = await createBranch(ctx.db, "SANAA", "فرع صنعاء", "صنعاء");
    hrUser = await seedUser(ctx.db, {
      username: "file.hr",
      password: PASSWORDS.hr,
      roleKey: "hr_director",
      fullName: "مدير الموارد البشرية",
      allBranches: true,
    });
    managerUser = await seedUser(ctx.db, {
      username: "file.manager",
      password: PASSWORDS.manager,
      roleKey: "branch_manager",
      fullName: "مدير فرع عدن",
      branchIds: [aden.id],
    });
    scopedUser = await seedUser(ctx.db, {
      username: "file.officer",
      password: PASSWORDS.scoped,
      roleKey: "hr_officer",
      fullName: "مسؤول شؤون الموظفين - عدن",
      branchIds: [aden.id],
    });
    hr = await loginAs(ctx.app, hrUser.username, PASSWORDS.hr);
    managerAden = await loginAs(ctx.app, managerUser.username, PASSWORDS.manager);
    scopedOfficer = await loginAs(ctx.app, scopedUser.username, PASSWORDS.scoped);
  });

  after(async () => {
    await ctx.db.close();
  });

  test("job titles are unique, renamable, deactivatable and permission guarded", async () => {
    const department = await post(hr, "/api/departments", { name: "المالية" });
    assert.equal(department.status, 201);
    departmentId = department.body.id as string;

    const created = await post(hr, "/api/job-titles", { name: "محاسب", departmentId });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    accountantTitleId = created.body.jobTitle.id as string;
    assert.equal(created.body.jobTitle.departmentId, departmentId);

    const duplicate = await post(hr, "/api/job-titles", { name: "محاسب" });
    assert.equal(duplicate.status, 409);

    const denied = await post(managerAden, "/api/job-titles", { name: "مشرف" });
    assert.equal(denied.status, 403);

    const supervisor = await post(hr, "/api/job-titles", { name: "مشرف عمليات" });
    assert.equal(supervisor.status, 201);
    supervisorTitleId = supervisor.body.jobTitle.id as string;

    managerEmployee = await createEmployee({
      fullName: "مدير فرع عدن",
      phone: "771000001",
      branchId: aden.id,
      departmentId,
      jobTitleId: accountantTitleId,
      hireDate: "2019-01-01",
      baseSalary: 200000,
    });
    assert.equal(managerEmployee.jobTitle, "محاسب");
    assert.equal(managerEmployee.jobTitleId, accountantTitleId);

    employee = await createEmployee({
      fullName: "موظف ملف شامل",
      phone: "771000002",
      nationalId: "FILE-1001",
      branchId: aden.id,
      departmentId,
      jobTitleId: accountantTitleId,
      managerId: managerEmployee.id,
      hireDate: "2021-03-01",
      baseSalary: 120000,
    });
    assert.equal(employee.jobTitle, "محاسب");
    assert.equal(employee.managerId, managerEmployee.id);
    assert.equal(employee.managerName, "مدير فرع عدن");

    sanaaEmployee = await createEmployee({
      fullName: "موظف فرع صنعاء",
      phone: "771000003",
      branchId: sanaa.id,
      hireDate: "2021-03-01",
      baseSalary: 90000,
    });

    const crossBranchManager = await patch(hr, `/api/employees/${employee.id}`, { managerId: sanaaEmployee.id });
    assert.equal(crossBranchManager.status, 400);
    assert.equal(crossBranchManager.body.error.code, "INVALID_MANAGER");

    const selfManager = await patch(hr, `/api/employees/${employee.id}`, { managerId: employee.id });
    assert.equal(selfManager.status, 400);
    assert.equal(selfManager.body.error.code, "INVALID_MANAGER");

    const cycle = await patch(hr, `/api/employees/${managerEmployee.id}`, { managerId: employee.id });
    assert.equal(cycle.status, 400);
    assert.equal(cycle.body.error.code, "MANAGER_CYCLE");

    const linked = await patch(hr, `/api/employees/${employee.id}`, { jobTitleId: supervisorTitleId });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.employee.jobTitle, "مشرف عمليات");
    assert.equal(linked.body.employee.jobTitleId, supervisorTitleId);

    const renamed = await patch(hr, `/api/job-titles/${supervisorTitleId}`, { name: "مشرف تشغيل" });
    assert.equal(renamed.status, 200);
    const afterRename = await detail(employee.id);
    assert.equal(afterRename.employee.jobTitle, "مشرف تشغيل");

    const deactivated = await patch(hr, `/api/job-titles/${supervisorTitleId}`, { active: false });
    assert.equal(deactivated.status, 200);
    const inactiveLink = await patch(hr, `/api/employees/${sanaaEmployee.id}`, { jobTitleId: supervisorTitleId });
    assert.equal(inactiveLink.status, 400);
    assert.equal(inactiveLink.body.error.code, "INACTIVE_JOB_TITLE");

    const unrelatedEdit = await patch(hr, `/api/employees/${employee.id}`, { phone: "771000099" });
    assert.equal(unrelatedEdit.status, 200);
    assert.equal(unrelatedEdit.body.employee.jobTitle, "مشرف تشغيل");

    const list = await hr.get("/api/job-titles");
    assert.equal(list.status, 200);
    const accountant = (list.body.items as Array<{ id: string; employeesCount: number; active: boolean }>).find(
      (row) => row.id === accountantTitleId,
    );
    assert.ok(accountant);
    assert.equal(accountant.employeesCount, 1);

    const history = await detail(employee.id);
    assert.ok(historyTypes(history).includes("hired"));
    assert.ok(historyTypes(history).includes("updated"));
  });

  test("contracts keep a single active record and sync the base salary", async () => {
    const first = await post(hr, `/api/employees/${employee.id}/contracts`, {
      contractNo: "CT-100",
      contractType: "permanent",
      startDate: "2021-03-01",
      endDate: "",
      baseSalary: 150000,
      status: "active",
      notes: "عقد أول",
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const firstId = first.body.contract.id as string;

    const afterFirst = await detail(employee.id);
    assert.equal(afterFirst.employee.baseSalary, 150000);
    assert.equal(afterFirst.contracts.length, 1);
    assert.ok(historyTypes(afterFirst).includes("contract_added"));
    assert.ok(historyTypes(afterFirst).includes("salary_changed"));

    const secondActive = await post(hr, `/api/employees/${employee.id}/contracts`, {
      contractNo: "CT-101",
      contractType: "fixed",
      startDate: "2022-03-01",
      endDate: "2023-03-01",
      baseSalary: 160000,
      status: "active",
    });
    assert.equal(secondActive.status, 409);

    const ended = await post(hr, `/api/employees/${employee.id}/contracts`, {
      contractNo: "CT-101",
      contractType: "fixed",
      startDate: "2022-03-01",
      endDate: "2023-03-01",
      baseSalary: 160000,
      status: "ended",
    });
    assert.equal(ended.status, 201);
    const endedId = ended.body.contract.id as string;
    assert.equal((await detail(employee.id)).employee.baseSalary, 150000);

    const reactivateEnded = await patch(hr, `/api/employees/${employee.id}/contracts/${endedId}`, { status: "active" });
    assert.equal(reactivateEnded.status, 409);

    const closeFirst = await patch(hr, `/api/employees/${employee.id}/contracts/${firstId}`, {
      status: "ended",
      endDate: "2022-02-28",
    });
    assert.equal(closeFirst.status, 200);
    assert.equal(closeFirst.body.contract.status, "ended");

    const activateSecond = await patch(hr, `/api/employees/${employee.id}/contracts/${endedId}`, { status: "active" });
    assert.equal(activateSecond.status, 200);
    const afterActivate = await detail(employee.id);
    assert.equal(afterActivate.employee.baseSalary, 160000);
    assert.equal(afterActivate.contracts.filter((contract) => contract.status === "active").length, 1);

    const invalidDates = await patch(hr, `/api/employees/${employee.id}/contracts/${endedId}`, {
      startDate: "2024-01-01",
      endDate: "2023-01-01",
    });
    assert.equal(invalidDates.status, 400);
    assert.equal(invalidDates.body.error.code, "INVALID_CONTRACT_DATES");

    const managerDenied = await post(managerAden, `/api/employees/${employee.id}/contracts`, {
      contractType: "permanent",
      startDate: "2024-01-01",
      baseSalary: 170000,
      status: "ended",
    });
    assert.equal(managerDenied.status, 403);

    const crossBranch = await post(scopedOfficer, `/api/employees/${sanaaEmployee.id}/contracts`, {
      contractType: "permanent",
      startDate: "2024-01-01",
      baseSalary: 100000,
      status: "ended",
    });
    assert.equal(crossBranch.status, 404);
  });

  test("employee documents carry metadata and are recorded in the history", async () => {
    const upload = await hr
      .post(
        `/api/attachments?ownerType=employee&ownerId=${employee.id}&fileName=${encodeURIComponent("id-card.png")}&title=${encodeURIComponent("صورة الهوية")}&documentType=national_id&expiresAt=2030-01-01`,
      )
      .set("X-Requested-With", XHR_HEADER)
      .set("Content-Type", "image/png")
      .send(Buffer.from("fake-png-content"));
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    const attachmentId = upload.body.id as string;
    assert.equal(upload.body.title, "صورة الهوية");

    const list = await hr.get(`/api/attachments?ownerType=employee&ownerId=${employee.id}`);
    assert.equal(list.status, 200);
    const document = (list.body.items as Array<{ id: string; title: string; documentType: string; expiresAt: string | null }>).find(
      (row) => row.id === attachmentId,
    );
    assert.ok(document);
    assert.equal(document.title, "صورة الهوية");
    assert.equal(document.documentType, "national_id");
    assert.equal(document.expiresAt, "2030-01-01");

    const updated = await patch(hr, `/api/attachments/${attachmentId}`, {
      title: "الهوية الوطنية",
      documentType: "certificate",
      expiresAt: "2031-12-31",
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.attachment.title, "الهوية الوطنية");
    assert.equal(updated.body.attachment.documentType, "certificate");

    const withDocument = await detail(employee.id);
    const documentRow = withDocument.documents.find((row) => row.id === attachmentId);
    assert.ok(documentRow);
    assert.equal(documentRow.title, "الهوية الوطنية");
    assert.ok(historyTypes(withDocument).includes("document_added"));
    assert.ok(historyTypes(withDocument).includes("document_updated"));

    const download = await hr.get(`/api/attachments/${attachmentId}/download`);
    assert.equal(download.status, 200);
    assert.equal(download.headers["content-type"], "image/png");

    const removed = await del(hr, `/api/attachments/${attachmentId}`);
    assert.equal(removed.status, 200);
    const afterDelete = await detail(employee.id);
    assert.equal(afterDelete.documents.length, 0);
    assert.ok(historyTypes(afterDelete).includes("document_deleted"));
  });

  test("archiving closes active contracts and writes permanent history", async () => {
    archivedTarget = await createEmployee({
      fullName: "موظف للإنهاء",
      phone: "771000004",
      branchId: aden.id,
      hireDate: "2022-01-01",
      baseSalary: 70000,
    });
    const contract = await post(hr, `/api/employees/${archivedTarget.id}/contracts`, {
      contractNo: "CT-ARCH",
      contractType: "permanent",
      startDate: "2022-01-01",
      baseSalary: 70000,
      status: "active",
    });
    assert.equal(contract.status, 201);

    const archived = await post(hr, `/api/employees/${archivedTarget.id}/archive`, {
      reason: "انتهاء الخدمة لأسباب شخصية",
      terminationDate: "2026-09-30",
    });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));

    const afterArchive = await detail(archivedTarget.id);
    assert.ok(afterArchive.employee.archivedAt);
    assert.equal(afterArchive.contracts.length, 1);
    assert.equal(afterArchive.contracts[0]?.status, "ended");
    assert.ok(historyTypes(afterArchive).includes("archived"));

    const editArchived = await patch(hr, `/api/employees/${archivedTarget.id}`, { jobTitle: "مغادر" });
    assert.equal(editArchived.status, 400);
    assert.equal(editArchived.body.error.code, "EMPLOYEE_ARCHIVED");

    const contractForArchived = await post(hr, `/api/employees/${archivedTarget.id}/contracts`, {
      contractType: "permanent",
      startDate: "2026-10-01",
      baseSalary: 70000,
      status: "ended",
    });
    assert.equal(contractForArchived.status, 400);
    assert.equal(contractForArchived.body.error.code, "EMPLOYEE_ARCHIVED");

    const historyRows = await ctx.db.query<{ change_type: string }>(
      "SELECT change_type FROM employee_history WHERE employee_id = $1",
      [archivedTarget.id],
    );
    assert.deepEqual(historyRows.rows.map((row) => row.change_type).sort(), ["archived", "contract_added", "hired"]);
  });

  test("employee detail and contracts remain branch scoped", async () => {
    assert.equal((await managerAden.get(`/api/employees/${sanaaEmployee.id}`)).status, 404);
    assert.equal((await managerAden.get(`/api/employees/${employee.id}`)).status, 200);
    const detailForManager = await managerAden.get(`/api/employees/${employee.id}`);
    assert.equal(detailForManager.body.employee.managerName, "مدير فرع عدن");
  });
});
