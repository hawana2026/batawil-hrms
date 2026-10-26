import type { Db, Row } from "../db/index.js";
import type { AuthUser } from "../auth/types.js";
import { ApiError, forbidden, notFound } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { canAccessBranch } from "./access.js";

export interface EmployeeRow extends Row {
  id: string;
  employee_no: string;
  full_name: string;
  phone: string;
  national_id: string | null;
  branch_id: string;
  branch_name: string;
  branch_code: string;
  department_id: string | null;
  department_name: string | null;
  job_title: string;
  job_title_id: string | null;
  manager_id: string | null;
  manager_name: string | null;
  manager_no: string | null;
  hire_date: string | Date;
  base_salary: string | number;
  status: string;
  notes: string;
  termination_date: string | Date | null;
  termination_reason: string | null;
  archived_at: string | Date | null;
  archive_reason: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export function toDateOnly(value: string | Date | null): string | null {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

export function today(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

export async function nextEmployeeNo(db: Pick<Db, "query">): Promise<string> {
  const result = await db.query<Row & { n: number }>("SELECT nextval('employee_no_seq')::int AS n");
  const n = result.rows[0]?.n ?? 1;
  return `EMP-${String(n).padStart(5, "0")}`;
}

export async function assertBranchUsable(db: Db, actor: AuthUser, branchId: string): Promise<void> {
  if (!canAccessBranch(actor, branchId)) throw forbidden("الفرع خارج نطاق صلاحيتك.");
  const result = await db.query<Row & { active: boolean }>("SELECT active FROM branches WHERE id = $1", [branchId]);
  const row = result.rows[0];
  if (!row) throw new ApiError(400, "INVALID_BRANCH", "الفرع المحدد غير موجود.");
  if (!row.active) throw new ApiError(400, "INACTIVE_BRANCH", "لا يمكن استخدام فرع معطل.");
}

export async function assertDepartmentUsable(db: Db, departmentId: string | null | undefined): Promise<void> {
  if (!departmentId) return;
  const result = await db.query<Row & { active: boolean }>("SELECT active FROM departments WHERE id = $1", [departmentId]);
  const row = result.rows[0];
  if (!row) throw new ApiError(400, "INVALID_DEPARTMENT", "القسم المحدد غير موجود.");
  if (!row.active) throw new ApiError(400, "INACTIVE_DEPARTMENT", "لا يمكن استخدام قسم معطل.");
}

export async function loadEmployee(db: Db, id: string): Promise<EmployeeRow> {
  const result = await db.query<EmployeeRow>(
    `SELECT e.id, e.employee_no, e.full_name, e.phone, e.national_id,
            e.branch_id, b.name AS branch_name, b.code AS branch_code,
            e.department_id, d.name AS department_name,
            e.job_title, e.job_title_id, e.manager_id, m.full_name AS manager_name, m.employee_no AS manager_no,
            e.hire_date, e.base_salary, e.status, e.notes,
            e.termination_date, e.termination_reason, e.archived_at, e.archive_reason,
            e.created_at, e.updated_at
     FROM employees e
     JOIN branches b ON b.id = e.branch_id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN employees m ON m.id = e.manager_id
     WHERE e.id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw notFound("الموظف غير موجود.");
  return row;
}

export async function assertJobTitleUsable(db: Db, jobTitleId: string | null | undefined): Promise<string> {
  if (!jobTitleId) return "";
  const result = await db.query<Row & { name: string; active: boolean }>(
    "SELECT name, active FROM job_titles WHERE id = $1",
    [jobTitleId],
  );
  const row = result.rows[0];
  if (!row) throw new ApiError(400, "INVALID_JOB_TITLE", "المسمى الوظيفي المحدد غير موجود.");
  if (!row.active) throw new ApiError(400, "INACTIVE_JOB_TITLE", "لا يمكن استخدام مسمى وظيفي معطل.");
  return row.name;
}

export async function assertManagerUsable(
  db: Db,
  managerId: string | null | undefined,
  branchId: string,
  excludeId: string | null,
): Promise<string> {
  if (!managerId) return "";
  if (managerId === excludeId) {
    throw new ApiError(400, "INVALID_MANAGER", "لا يمكن أن يكون الموظف مديراً مباشراً لنفسه.");
  }
  const result = await db.query<Row & { branch_id: string; archived_at: string | Date | null; full_name: string }>(
    "SELECT branch_id, archived_at, full_name FROM employees WHERE id = $1",
    [managerId],
  );
  const row = result.rows[0];
  if (!row) throw new ApiError(400, "INVALID_MANAGER", "المدير المباشر المحدد غير موجود.");
  if (row.archived_at) throw new ApiError(400, "INVALID_MANAGER", "لا يمكن اختيار موظف مؤرشف كمدير مباشر.");
  if (row.branch_id !== branchId) {
    throw new ApiError(400, "INVALID_MANAGER", "المدير المباشر يجب أن يكون في نفس فرع الموظف.");
  }
  if (excludeId) {
    const cycle = await db.query<Row & { id: string }>(
      `WITH RECURSIVE chain AS (
         SELECT id, manager_id, 1 AS depth FROM employees WHERE id = $1
         UNION ALL
         SELECT e.id, e.manager_id, c.depth + 1
         FROM employees e JOIN chain c ON e.id = c.manager_id
         WHERE c.depth < 25
       )
       SELECT id FROM chain WHERE id = $2 LIMIT 1`,
      [managerId, excludeId],
    );
    if (cycle.rows[0]) throw new ApiError(400, "MANAGER_CYCLE", "اختيار هذا المدير ينشئ حلقة دائرية في سلسلة الإدارة.");
  }
  return row.full_name;
}

export interface EmployeeHistoryInput {
  employeeId: string;
  changeType: string;
  summary: string;
  details?: Record<string, unknown>;
  effectiveDate?: string | null;
  actorId: string | null;
}

export async function writeEmployeeHistory(db: Pick<Db, "query">, input: EmployeeHistoryInput): Promise<void> {
  await db.query(
    `INSERT INTO employee_history (id, employee_id, change_type, summary, details, effective_date, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [
      newId(),
      input.employeeId,
      input.changeType,
      input.summary.slice(0, 300),
      JSON.stringify(input.details ?? {}),
      input.effectiveDate ?? null,
      input.actorId,
    ],
  );
}

export interface ContractRow extends Row {
  id: string;
  employee_id: string;
  contract_no: string;
  contract_type: string;
  start_date: string | Date;
  end_date: string | Date | null;
  base_salary: string | number;
  status: string;
  notes: string;
  created_by_name: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export async function loadContract(db: Db, employeeId: string, contractId: string): Promise<ContractRow> {
  const result = await db.query<ContractRow>(
    `SELECT c.id, c.employee_id, c.contract_no, c.contract_type, c.start_date, c.end_date, c.base_salary,
            c.status, c.notes, u.full_name AS created_by_name, c.created_at, c.updated_at
     FROM employee_contracts c
     LEFT JOIN users u ON u.id = c.created_by
     WHERE c.id = $1 AND c.employee_id = $2`,
    [contractId, employeeId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("العقد غير موجود.");
  return row;
}

export async function loadContracts(db: Db, employeeId: string): Promise<ContractRow[]> {
  const result = await db.query<ContractRow>(
    `SELECT c.id, c.employee_id, c.contract_no, c.contract_type, c.start_date, c.end_date, c.base_salary,
            c.status, c.notes, u.full_name AS created_by_name, c.created_at, c.updated_at
     FROM employee_contracts c
     LEFT JOIN users u ON u.id = c.created_by
     WHERE c.employee_id = $1
     ORDER BY c.start_date DESC, c.created_at DESC`,
    [employeeId],
  );
  return result.rows;
}

export function presentContract(row: ContractRow) {
  return {
    id: row.id,
    contractNo: row.contract_no,
    contractType: row.contract_type,
    startDate: toDateOnly(row.start_date),
    endDate: toDateOnly(row.end_date),
    baseSalary: Number(row.base_salary),
    status: row.status,
    notes: row.notes,
    createdBy: row.created_by_name,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function assertEmployeeInScope(actor: AuthUser, employee: EmployeeRow): void {
  if (!canAccessBranch(actor, employee.branch_id)) {
    throw notFound("الموظف غير موجود أو خارج نطاق صلاحيتك.");
  }
  if (employee.archived_at) throw new ApiError(400, "EMPLOYEE_ARCHIVED", "الموظف مؤرشف ولا يمكن تعديل بياناته.");
}

export async function assertUniqueEmployeeIdentity(
  db: Db,
  employeeNo: string,
  nationalId: string | null,
  excludeId: string | null,
): Promise<void> {
  const result = await db.query<Row & { employee_no: string; national_id: string | null; full_name: string }>(
    `SELECT employee_no, national_id, full_name FROM employees
     WHERE (lower(employee_no) = lower($1) OR ($2::text IS NOT NULL AND national_id = $2))
       AND ($3::uuid IS NULL OR id <> $3::uuid)
     LIMIT 1`,
    [employeeNo, nationalId, excludeId],
  );
  const row = result.rows[0];
  if (!row) return;
  if (row.employee_no.toLowerCase() === employeeNo.toLowerCase()) {
    throw new ApiError(409, "DUPLICATE_EMPLOYEE_NO", "الرقم الوظيفي مستخدم بالفعل.");
  }
  throw new ApiError(409, "DUPLICATE_NATIONAL_ID", `الرقم الوطني مستخدم بالفعل للموظف ${row.full_name}.`);
}

/**
 * Applies approved transfers whose effective date has arrived. Historical attendance
 * remains bound to the branch recorded on its submission sheet.
 */
export async function applyDueTransfers(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    const due = await tx.query<
      Row & { id: string; employee_id: string; to_branch_id: string; to_department_id: string | null; effective_date: string }
    >(
      `SELECT id, employee_id, to_branch_id, to_department_id, effective_date::text AS effective_date
       FROM employee_transfers
       WHERE status = 'approved' AND applied_at IS NULL AND effective_date <= CURRENT_DATE
       ORDER BY effective_date ASC
       FOR UPDATE`,
    );
    let applied = 0;
    for (const transfer of due.rows) {
      const updated = await tx.query(
        `UPDATE employee_transfers SET applied_at = now(), updated_at = now()
         WHERE id = $1 AND applied_at IS NULL`,
        [transfer.id],
      );
      if (updated.rowCount === 0) continue;
      await tx.query(
        "UPDATE employees SET branch_id = $2, department_id = $3, updated_by = NULL, updated_at = now() WHERE id = $1",
        [transfer.employee_id, transfer.to_branch_id, transfer.to_department_id],
      );
      applied += 1;
    }
    return applied;
  });
}

export function presentEmployee(employee: EmployeeRow) {
  return {
    id: employee.id,
    employeeNo: employee.employee_no,
    fullName: employee.full_name,
    phone: employee.phone,
    nationalId: employee.national_id,
    branchId: employee.branch_id,
    branchName: employee.branch_name,
    branchCode: employee.branch_code,
    departmentId: employee.department_id,
    departmentName: employee.department_name,
    jobTitle: employee.job_title,
    jobTitleId: employee.job_title_id,
    managerId: employee.manager_id,
    managerName: employee.manager_name,
    managerNo: employee.manager_no,
    hireDate: toDateOnly(employee.hire_date),
    baseSalary: Number(employee.base_salary),
    status: employee.status,
    notes: employee.notes,
    terminationDate: toDateOnly(employee.termination_date),
    terminationReason: employee.termination_reason,
    archivedAt: employee.archived_at ? new Date(employee.archived_at).toISOString() : null,
    archiveReason: employee.archive_reason,
    createdAt: new Date(employee.created_at).toISOString(),
    updatedAt: new Date(employee.updated_at).toISOString(),
  };
}
