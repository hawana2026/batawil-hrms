import { Router } from "express";
import { z } from "zod";
import ExcelJS from "exceljs";
import type { Row } from "../db/index.js";
import { addDataSheet, createWorkbook, sendWorkbook } from "../lib/xlsx.js";
import {
  archiveEmployeeSchema,
  contractSchema,
  contractUpdateSchema,
  createEmployeeSchema,
  employeeImportRowSchema,
  updateEmployeeSchema,
} from "../lib/hr-schemas.js";
import { writeAudit } from "../lib/audit.js";
import { ApiError, conflict, forbidden, notFound, parseBody, requestIp, requestUserAgent, unauthorized } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { branchScopeSql, canAccessBranch } from "../services/access.js";
import {
  applyDueTransfers,
  assertBranchUsable,
  assertDepartmentUsable,
  assertJobTitleUsable,
  assertManagerUsable,
  assertUniqueEmployeeIdentity,
  loadContract,
  loadContracts,
  loadEmployee,
  nextEmployeeNo,
  presentContract,
  presentEmployee,
  toDateOnly,
  today,
  writeEmployeeHistory,
  type EmployeeRow,
} from "../services/employees.js";
import {
  createRequireAuth,
  createRequireAnyPermission,
  createRequirePermission,
  requirePasswordReady,
  type AuthDeps,
} from "../middleware/auth.js";

const listQuerySchema = z.object({
  q: z.string().trim().max(100).default(""),
  branchId: z.string().trim().max(64).default(""),
  departmentId: z.string().trim().max(64).default(""),
  status: z.enum(["all", "active", "leave", "suspended", "resigned", "transferred"]).default("all"),
  includeArchived: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

const IMPORT_HEADERS: Record<string, string> = {
  employeeNo: "employeeNo",
  "الرقم الوظيفي": "employeeNo",
  fullName: "fullName",
  "الاسم الكامل": "fullName",
  phone: "phone",
  "الهاتف": "phone",
  nationalId: "nationalId",
  "الرقم الوطني": "nationalId",
  branchCode: "branchCode",
  "كود الفرع": "branchCode",
  departmentName: "departmentName",
  "القسم": "departmentName",
  jobTitle: "jobTitle",
  "المسمى الوظيفي": "jobTitle",
  hireDate: "hireDate",
  "تاريخ التعيين": "hireDate",
  baseSalary: "baseSalary",
  "الراتب الأساسي": "baseSalary",
  status: "status",
  "الحالة": "status",
  notes: "notes",
  "ملاحظات": "notes",
};

const STATUS_AR: Record<string, string> = {
  نشط: "active",
  إجازة: "leave",
  موقوف: "suspended",
  مستقيل: "resigned",
  منقول: "transferred",
};

function toIsoDate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const offset = value.getTimezoneOffset() * 60_000;
    return new Date(value.getTime() - offset).toISOString().slice(0, 10);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = Math.round((value - 25569) * 86_400_000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  return String(value ?? "").trim();
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return toIsoDate(value);
  if (typeof value === "object") {
    const obj = value as { text?: unknown; richText?: Array<{ text?: string }>; result?: unknown; formula?: string };
    if (typeof obj.text === "string") return obj.text.trim();
    if (Array.isArray(obj.richText)) return obj.richText.map((part) => part.text ?? "").join("").trim();
    if (obj.result !== undefined) return cellText(obj.result);
    if (typeof obj.formula === "string") return "";
  }
  return String(value).trim();
}

function buildEmployeeFilters(actor: Parameters<typeof branchScopeSql>[0], query: z.infer<typeof listQuerySchema>, startIndex: number) {
  const params: unknown[] = [];
  const where: string[] = [];
  const scope = branchScopeSql(actor, "e", startIndex);
  params.push(...scope.params);
  where.push(scope.sql);
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (!query.includeArchived) where.push("e.archived_at IS NULL");
  if (query.q) {
    const p = add(`%${query.q}%`);
    where.push(`(e.employee_no ILIKE ${p} OR e.full_name ILIKE ${p} OR e.phone ILIKE ${p} OR COALESCE(e.national_id,'') ILIKE ${p} OR e.job_title ILIKE ${p})`);
  }
  if (query.branchId) {
    const p = add(query.branchId);
    where.push(`e.branch_id = ${p}::uuid`);
  }
  if (query.departmentId) {
    const p = add(query.departmentId);
    where.push(`e.department_id = ${p}::uuid`);
  }
  if (query.status !== "all") {
    const p = add(query.status);
    where.push(`e.status = ${p}`);
  }
  return { where, params, add };
}

export function createEmployeesRouter(deps: AuthDeps): Router {
  const { db, logger } = deps;
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);

  const requireView = createRequirePermission("employees.view", deps);
  const requireManage = createRequirePermission("employees.manage", deps);
  const requireImport = createRequirePermission("employees.import", deps);
  const requireExport = createRequireAnyPermission(["employees.export", "reports.export"], deps);

  router.get("/options", createRequireAnyPermission(["employees.view", "attendance.view", "leaves.view", "advances.view", "transfers.view"], deps), async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const branchId = z.union([z.uuid(), z.literal("")]).optional().parse(req.query.branchId);
    const params: unknown[] = [];
    const where: string[] = ["e.archived_at IS NULL"];
    if (actor.allBranches) {
      if (branchId) {
        params.push(branchId);
        where.push(`e.branch_id = $${params.length}::uuid`);
      }
    } else {
      params.push(actor.branches.map((branch) => branch.id));
      where.push(`e.branch_id = ANY($${params.length}::uuid[])`);
      if (branchId) {
        if (!canAccessBranch(actor, branchId)) throw forbidden("الفرع خارج نطاق صلاحيتك.");
        params.push(branchId);
        where.push(`e.branch_id = $${params.length}::uuid`);
      }
    }
    const result = await db.query<Row & EmployeeRow>(
      `SELECT e.id, e.employee_no, e.full_name, e.branch_id, e.department_id, d.name AS department_name, e.status, e.base_salary
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id
       WHERE ${where.join(" AND ")}
       ORDER BY e.full_name ASC
       LIMIT 3000`,
      params,
    );
    res.json({
      items: result.rows.map((row) => ({
        id: row.id,
        employeeNo: row.employee_no,
        fullName: row.full_name,
        branchId: row.branch_id,
        departmentId: row.department_id,
        departmentName: row.department_name,
        status: row.status,
        baseSalary: Number(row.base_salary),
      })),
    });
  });

  router.get("/", requireView, async (req, res) => {
    if (!req.auth) throw unauthorized();
    await applyDueTransfers(db);
    const query = parseBody(listQuerySchema, req.query);
    const { where, params, add } = buildEmployeeFilters(req.auth.user, query, 1);
    const count = await db.query<Row & { total: number }>(
      `SELECT count(*)::int AS total FROM employees e WHERE ${where.join(" AND ")}`,
      params,
    );
    const limit = add(query.pageSize);
    const offset = add((query.page - 1) * query.pageSize);
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
       WHERE ${where.join(" AND ")}
       ORDER BY e.archived_at NULLS FIRST, e.full_name ASC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    res.json({
      items: result.rows.map(presentEmployee),
      page: query.page,
      pageSize: query.pageSize,
      total: count.rows[0]?.total ?? 0,
    });
  });

  router.get("/import-template", requireImport, async (_req, res) => {
    const workbook = createWorkbook();
    addDataSheet(
      workbook,
      "قالب الموظفين",
      Object.keys(IMPORT_HEADERS).filter((key) => !/^[a-zA-Z]/.test(key)),
      [],
      { title: "قالب استيراد الموظفين", subtitle: "املأ الصفوف مع الالتزام بكود الفرع المسجل في النظام" },
    );
    const instructions = workbook.addWorksheet("تعليمات", { views: [{ rightToLeft: true }] });
    instructions.columns = [{ width: 4 }, { width: 90 }];
    const lines = [
      "لا تغيّر أسماء الأعمدة في ورقة البيانات.",
      "الرقم الوظيفي اختياري؛ عند تركه فارغاً يولّد النظام رقماً تلقائياً.",
      "كود الفرع يجب أن يطابق كود فرع نشط في النظام.",
      "القسم يجب أن يكون مسجلاً مسبقاً في شاشة الأقسام (يمكن تركه فارغاً).",
      "الحالة المقبولة: نشط، إجازة، موقوف، مستقيل، منقول.",
      "تاريخ التعيين بصيغة YYYY-MM-DD، والراتب الأساسي رقم.",
      "الهاتف مطلوب، والرقم الوطني اختياري ويجب ألا يتكرر.",
    ];
    lines.forEach((line, index) => {
      const row = instructions.getRow(index + 1);
      row.getCell(1).value = index + 1;
      row.getCell(2).value = line;
      row.alignment = { horizontal: "right", vertical: "middle", wrapText: true };
    });
    await sendWorkbook(res, workbook, "employee-import-template");
  });

  router.get("/export.xlsx", requireExport, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const query = parseBody(listQuerySchema, req.query);
    const { where, params } = buildEmployeeFilters(req.auth.user, query, 1);
    const result = await db.query<EmployeeRow>(
      `SELECT e.id, e.employee_no, e.full_name, e.phone, e.national_id,
              e.branch_id, b.name AS branch_name, b.code AS branch_code,
              e.department_id, d.name AS department_name,
              e.job_title, e.hire_date, e.base_salary, e.status, e.notes,
              e.termination_date, e.termination_reason, e.archived_at, e.archive_reason,
              e.created_at, e.updated_at
       FROM employees e
       JOIN branches b ON b.id = e.branch_id
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE ${where.join(" AND ")}
       ORDER BY e.full_name ASC
       LIMIT 5000`,
      params,
    );
    const statusLabels: Record<string, string> = {
      active: "نشط",
      leave: "إجازة",
      suspended: "موقوف",
      resigned: "مستقيل",
      transferred: "منقول",
    };
    const workbook = createWorkbook();
    addDataSheet(
      workbook,
      "الموظفون",
      ["الرقم الوظيفي", "الاسم الكامل", "الهاتف", "الرقم الوطني", "الفرع", "كود الفرع", "القسم", "المسمى الوظيفي", "تاريخ التعيين", "الراتب الأساسي", "الحالة", "ملاحظات"],
      result.rows.map((row) => [
        row.employee_no,
        row.full_name,
        row.phone,
        row.national_id ?? "",
        row.branch_name,
        row.branch_code,
        row.department_name ?? "",
        row.job_title,
        toDateOnly(row.hire_date),
        Number(row.base_salary),
        statusLabels[row.status] ?? row.status,
        row.notes,
      ]),
      {
        title: "بيانات الموظفين",
        subtitle: `تاريخ التصدير: ${new Date().toISOString().slice(0, 10)} — عدد السجلات: ${result.rows.length}`,
      },
    );
    await writeAudit(db, logger, {
      action: "employee.exported",
      actor: { id: req.auth.user.id, username: req.auth.user.username },
      entityType: "employee",
      severity: "info",
      details: { count: result.rows.length, filters: { q: query.q, branchId: query.branchId, status: query.status } },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    await sendWorkbook(res, workbook, "employees");
  });

  router.post("/import", requireImport, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new ApiError(400, "FILE_REQUIRED", "أرفق ملف Excel بصيغة xlsx.");
    }
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(req.body as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    } catch {
      throw new ApiError(400, "INVALID_FILE", "تعذر قراءة ملف Excel. تأكد من أنه ملف xlsx صالح.");
    }
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new ApiError(400, "EMPTY_FILE", "الملف لا يحتوي على ورقة بيانات.");
    if (sheet.rowCount < 2) throw new ApiError(400, "EMPTY_FILE", "الملف لا يحتوي على صفوف بيانات.");

    const headerMapping: Record<number, string> = {};
    let headerRowNumber = 0;
    for (let candidate = 1; candidate <= Math.min(10, sheet.rowCount); candidate += 1) {
      const mapping: Record<number, string> = {};
      sheet.getRow(candidate).eachCell((cell, col) => {
        const mapped = IMPORT_HEADERS[cellText(cell.value)];
        if (mapped) mapping[col] = mapped;
      });
      const fields = Object.values(mapping);
      if (fields.includes("fullName") && fields.includes("phone")) {
        Object.assign(headerMapping, mapping);
        headerRowNumber = candidate;
        break;
      }
    }
    if (!headerRowNumber) {
      throw new ApiError(400, "INVALID_HEADERS", "الملف لا يحتوي على الأعمدة المطلوبة. استخدم القالب الرسمي.");
    }
    if (sheet.rowCount - headerRowNumber > 500) {
      throw new ApiError(400, "TOO_MANY_ROWS", "الحد الأقصى للاستيراد 500 صف في المرة الواحدة.");
    }

    const [branches, departments, jobTitles] = await Promise.all([
      db.query<Row & { id: string; code: string; active: boolean }>("SELECT id, code, active FROM branches"),
      db.query<Row & { id: string; name: string; active: boolean }>("SELECT id, name, active FROM departments"),
      db.query<Row & { id: string; name: string; active: boolean }>(
        "SELECT id, name, active FROM job_titles ORDER BY active DESC, name",
      ),
    ]);
    const branchByCode = new Map(branches.rows.map((row) => [row.code.trim().toUpperCase(), row]));
    const departmentByName = new Map(departments.rows.map((row) => [row.name.trim().toLowerCase(), row]));
    const jobTitleByName = new Map(jobTitles.rows.map((row) => [row.name.trim().toLowerCase(), row]));

    interface Prepared {
      rowNumber: number;
      employeeNo: string;
      fullName: string;
      phone: string;
      nationalId: string | null;
      branchId: string;
      departmentId: string | null;
      jobTitle: string;
      jobTitleId: string | null;
      hireDate: string;
      baseSalary: number;
      status: string;
      notes: string;
    }

    const errors: Array<{ row: number; message: string }> = [];
    const prepared: Prepared[] = [];
    const seenEmployeeNos = new Set<string>();
    const seenNationalIds = new Set<string>();

    for (let rowNumber = headerRowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const raw: Record<string, unknown> = {};
      row.eachCell((cell, col) => {
        const key = headerMapping[col];
        if (key) raw[key] = cell.value;
      });
      const values: Record<string, string> = Object.fromEntries(
        Object.entries(raw).map(([key, value]) => [key, cellText(value)]),
      );
      if (Object.values(values).every((value) => value === "")) continue;
      const translatedStatus = values.status ? STATUS_AR[values.status] : undefined;
      if (translatedStatus) values.status = translatedStatus;
      if (values.hireDate) values.hireDate = toIsoDate(raw.hireDate);
      if (values.baseSalary) values.baseSalary = String(Number(values.baseSalary.replace(/[^\d.-]/g, "")));

      const parsed = employeeImportRowSchema.safeParse(values);
      if (!parsed.success) {
        errors.push({ row: rowNumber, message: parsed.error.issues.map((issue) => issue.message).join("، ") });
        continue;
      }
      const data = parsed.data;
      const branch = branchByCode.get(data.branchCode.trim().toUpperCase());
      if (!branch) {
        errors.push({ row: rowNumber, message: `كود الفرع ${data.branchCode} غير موجود.` });
        continue;
      }
      if (!branch.active) {
        errors.push({ row: rowNumber, message: `الفرع ${data.branchCode} معطل.` });
        continue;
      }
      if (!canAccessBranch(actor, branch.id)) {
        errors.push({ row: rowNumber, message: `الفرع ${data.branchCode} خارج نطاق صلاحيتك.` });
        continue;
      }
      let departmentId: string | null = null;
      if (data.departmentName) {
        const department = departmentByName.get(data.departmentName.trim().toLowerCase());
        if (!department) {
          errors.push({ row: rowNumber, message: `القسم ${data.departmentName} غير مسجل.` });
          continue;
        }
        departmentId = department.id;
      }
      const employeeNo = data.employeeNo ?? "";
      if (employeeNo) {
        const key = employeeNo.toLowerCase();
        if (seenEmployeeNos.has(key)) {
          errors.push({ row: rowNumber, message: "الرقم الوظيفي مكرر داخل الملف." });
          continue;
        }
        seenEmployeeNos.add(key);
      }
      if (data.nationalId) {
        if (seenNationalIds.has(data.nationalId)) {
          errors.push({ row: rowNumber, message: "الرقم الوطني مكرر داخل الملف." });
          continue;
        }
        seenNationalIds.add(data.nationalId);
      }
      prepared.push({
        rowNumber,
        employeeNo,
        fullName: data.fullName,
        phone: data.phone,
        nationalId: data.nationalId ?? null,
        branchId: branch.id,
        departmentId,
        jobTitle: data.jobTitle,
        jobTitleId: data.jobTitle ? (jobTitleByName.get(data.jobTitle.trim().toLowerCase())?.id ?? null) : null,
        hireDate: data.hireDate,
        baseSalary: data.baseSalary,
        status: data.status,
        notes: data.notes,
      });
    }

    if (prepared.length > 0) {
      const existing = await db.query<Row & { employee_no: string; national_id: string | null }>(
        `SELECT employee_no, national_id FROM employees
         WHERE lower(employee_no) = ANY($1::text[]) OR national_id = ANY($2::text[])`,
        [
          prepared.filter((row) => row.employeeNo).map((row) => row.employeeNo.toLowerCase()),
          prepared.filter((row) => row.nationalId).map((row) => row.nationalId as string),
        ],
      );
      const existingNos = new Set(existing.rows.map((row) => row.employee_no.toLowerCase()));
      const existingNational = new Set(existing.rows.map((row) => row.national_id).filter(Boolean) as string[]);
      for (const row of prepared) {
        if (row.employeeNo && existingNos.has(row.employeeNo.toLowerCase())) {
          errors.push({ row: row.rowNumber, message: `الرقم الوظيفي ${row.employeeNo} مسجل مسبقاً.` });
        }
        if (row.nationalId && existingNational.has(row.nationalId)) {
          errors.push({ row: row.rowNumber, message: "الرقم الوطني مسجل مسبقاً لموظف آخر." });
        }
      }
    }

    if (errors.length > 0) {
      errors.sort((a, b) => a.row - b.row);
      throw new ApiError(400, "IMPORT_VALIDATION", "لم يتم استيراد أي صف بسبب وجود أخطاء. صحح الصفوف التالية ثم أعد المحاولة.", {
        rows: errors.slice(0, 100),
      });
    }
    if (prepared.length === 0) throw new ApiError(400, "EMPTY_FILE", "لا توجد صفوف صالحة للاستيراد.");

    const created = await db.transaction(async (tx) => {
      const inserted: Array<{ id: string; employeeNo: string }> = [];
      for (const row of prepared) {
        const employeeNo = row.employeeNo || (await nextEmployeeNo(tx));
        const id = newId();
        await tx.query(
          `INSERT INTO employees
            (id, employee_no, full_name, phone, national_id, branch_id, department_id, job_title, job_title_id,
             hire_date, base_salary, status, notes, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
          [id, employeeNo, row.fullName, row.phone, row.nationalId, row.branchId, row.departmentId, row.jobTitle, row.jobTitleId, row.hireDate, row.baseSalary, row.status, row.notes, actor.id],
        );
        await writeEmployeeHistory(tx, {
          employeeId: id,
          changeType: "hired",
          summary: `استيراد تعيين ${row.fullName}${row.jobTitle ? ` — ${row.jobTitle}` : ""}`,
          details: { employeeNo, source: "import", branchId: row.branchId, departmentId: row.departmentId, jobTitle: row.jobTitle || null, baseSalary: row.baseSalary, status: row.status },
          effectiveDate: row.hireDate,
          actorId: actor.id,
        });
        inserted.push({ id, employeeNo });
      }
      return inserted;
    });

    await writeAudit(db, logger, {
      action: "employee.imported",
      actor: { id: actor.id, username: actor.username },
      entityType: "employee",
      severity: "warning",
      details: { count: created.length, file: String(req.get("x-file-name") ?? "").slice(0, 200), ids: created.map((row) => row.id).slice(0, 50) },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });

    res.status(201).json({ imported: created.length, employees: created });
  });

  router.get("/:id", requireView, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const id = z.uuid("معرّف موظف غير صالح.").parse(req.params.id);
    const employee = await loadEmployee(db, id);
    if (!canAccessBranch(req.auth.user, employee.branch_id)) throw notFound("الموظف غير موجود أو خارج نطاق صلاحيتك.");
    const [transfers, contracts, documents, history] = await Promise.all([
      db.query<Row & { id: string; from_branch_name: string; to_branch_name: string; from_department_name: string | null; to_department_name: string | null; effective_date: string; reason: string; status: string; approved_at: string | Date | null; applied_at: string | Date | null }>(
        `SELECT t.id, fb.name AS from_branch_name, tb.name AS to_branch_name,
                fd.name AS from_department_name, td.name AS to_department_name,
                t.effective_date::text AS effective_date, t.reason, t.status, t.approved_at, t.applied_at
         FROM employee_transfers t
         JOIN branches fb ON fb.id = t.from_branch_id
         JOIN branches tb ON tb.id = t.to_branch_id
         LEFT JOIN departments fd ON fd.id = t.from_department_id
         LEFT JOIN departments td ON td.id = t.to_department_id
         WHERE t.employee_id = $1
         ORDER BY t.created_at DESC`,
        [id],
      ),
      loadContracts(db, id),
      db.query<Row & { id: string; file_name: string; mime_type: string; size_bytes: number; title: string; document_type: string; expires_at: string | null; uploaded_by_name: string | null; created_at: string | Date }>(
        `SELECT a.id, a.file_name, a.mime_type, a.size_bytes, a.title, a.document_type, a.expires_at::text AS expires_at,
                u.full_name AS uploaded_by_name, a.created_at
         FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
         WHERE a.owner_type = 'employee' AND a.owner_id = $1
         ORDER BY a.created_at DESC`,
        [id],
      ),
      db.query<Row & { id: string; change_type: string; summary: string; details: unknown; effective_date: string | null; created_by_name: string | null; created_at: string | Date }>(
        `SELECT h.id, h.change_type, h.summary, h.details, h.effective_date::text AS effective_date,
                u.full_name AS created_by_name, h.created_at
         FROM employee_history h LEFT JOIN users u ON u.id = h.created_by
         WHERE h.employee_id = $1
         ORDER BY h.created_at DESC
         LIMIT 200`,
        [id],
      ),
    ]);
    res.json({
      employee: presentEmployee(employee),
      transfers: transfers.rows.map((row) => ({
        id: row.id,
        fromBranch: row.from_branch_name,
        toBranch: row.to_branch_name,
        fromDepartment: row.from_department_name,
        toDepartment: row.to_department_name,
        effectiveDate: row.effective_date,
        reason: row.reason,
        status: row.status,
        approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
        appliedAt: row.applied_at ? new Date(row.applied_at).toISOString() : null,
      })),
      contracts: contracts.map(presentContract),
      documents: documents.rows.map((row) => ({
        id: row.id,
        fileName: row.file_name,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        title: row.title,
        documentType: row.document_type,
        expiresAt: row.expires_at,
        uploadedBy: row.uploaded_by_name,
        createdAt: new Date(row.created_at).toISOString(),
        downloadUrl: `/api/attachments/${row.id}/download`,
      })),
      history: history.rows.map((row) => ({
        id: row.id,
        changeType: row.change_type,
        summary: row.summary,
        details: row.details && typeof row.details === "object" ? row.details : {},
        effectiveDate: row.effective_date,
        createdBy: row.created_by_name,
        createdAt: new Date(row.created_at).toISOString(),
      })),
    });
  });

  router.post("/", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const input = parseBody(createEmployeeSchema, req.body);
    await assertBranchUsable(db, actor, input.branchId);
    await assertDepartmentUsable(db, input.departmentId ?? null);
    const jobTitleName = await assertJobTitleUsable(db, input.jobTitleId ?? null);
    await assertManagerUsable(db, input.managerId ?? null, input.branchId, null);
    const employeeNo = input.employeeNo ?? (await nextEmployeeNo(db));
    await assertUniqueEmployeeIdentity(db, employeeNo, input.nationalId ?? null, null);
    const id = newId();
    const jobTitle = jobTitleName || input.jobTitle;
    await db.query(
      `INSERT INTO employees
        (id, employee_no, full_name, phone, national_id, branch_id, department_id, job_title, job_title_id, manager_id,
         hire_date, base_salary, status, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
      [
        id,
        employeeNo,
        input.fullName,
        input.phone,
        input.nationalId ?? null,
        input.branchId,
        input.departmentId ?? null,
        jobTitle,
        input.jobTitleId ?? null,
        input.managerId ?? null,
        input.hireDate,
        input.baseSalary,
        input.status,
        input.notes,
        actor.id,
      ],
    );
    await writeEmployeeHistory(db, {
      employeeId: id,
      changeType: "hired",
      summary: `تعيين ${input.fullName}${jobTitle ? ` — ${jobTitle}` : ""}`,
      details: {
        employeeNo,
        branchId: input.branchId,
        departmentId: input.departmentId ?? null,
        jobTitle: jobTitle || null,
        managerId: input.managerId ?? null,
        baseSalary: input.baseSalary,
        status: input.status,
      },
      effectiveDate: input.hireDate,
      actorId: actor.id,
    });
    const employee = await loadEmployee(db, id);
    await writeAudit(db, logger, {
      action: "employee.created",
      actor: { id: actor.id, username: actor.username },
      entityType: "employee",
      entityId: id,
      branchId: input.branchId,
      severity: "info",
      details: { employeeNo, fullName: input.fullName, branch: employee.branch_code, department: employee.department_name },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.status(201).json({ employee: presentEmployee(employee) });
  });

  router.patch("/:id", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const id = z.uuid("معرّف موظف غير صالح.").parse(req.params.id);
    const input = parseBody(updateEmployeeSchema, req.body);
    const current = await loadEmployee(db, id);
    if (!canAccessBranch(actor, current.branch_id)) throw notFound("الموظف غير موجود أو خارج نطاق صلاحيتك.");
    if (current.archived_at) throw new ApiError(400, "EMPLOYEE_ARCHIVED", "الموظف مؤرشف ولا يمكن تعديل بياناته.");
    if (input.branchId && input.branchId !== current.branch_id) {
      throw new ApiError(400, "TRANSFER_REQUIRED", "تغيير فرع الموظف يتم من خلال طلب تحويل وظيفي معتمد.");
    }
    await assertDepartmentUsable(db, input.departmentId ?? null);
    const employeeNo = input.employeeNo ?? current.employee_no;
    const nationalId = input.nationalId !== undefined ? (input.nationalId ?? null) : current.national_id;
    await assertUniqueEmployeeIdentity(db, employeeNo, nationalId, id);

    let jobTitleId = current.job_title_id;
    let jobTitle = current.job_title;
    if (input.jobTitleId !== undefined) {
      jobTitleId = input.jobTitleId ?? null;
      jobTitle =
        jobTitleId === current.job_title_id ? current.job_title : await assertJobTitleUsable(db, jobTitleId);
    } else if (input.jobTitle !== undefined) {
      jobTitleId = null;
      jobTitle = input.jobTitle;
    }
    const managerId = input.managerId !== undefined ? (input.managerId ?? null) : current.manager_id;
    const managerName =
      managerId === current.manager_id
        ? (current.manager_name ?? "")
        : await assertManagerUsable(db, managerId, current.branch_id, id);

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const next = {
      employee_no: employeeNo,
      full_name: input.fullName ?? current.full_name,
      phone: input.phone ?? current.phone,
      national_id: nationalId,
      department_id: input.departmentId !== undefined ? (input.departmentId ?? null) : current.department_id,
      job_title: jobTitle,
      job_title_id: jobTitleId,
      manager_id: managerId,
      hire_date: input.hireDate ?? toDateOnly(current.hire_date),
      base_salary: input.baseSalary ?? Number(current.base_salary),
      status: input.status ?? current.status,
      notes: input.notes ?? current.notes,
      termination_date: input.terminationDate !== undefined ? (input.terminationDate ?? null) : toDateOnly(current.termination_date),
      termination_reason: input.terminationReason !== undefined ? (input.terminationReason || null) : current.termination_reason,
    };
    const labels: Record<string, string> = {
      employee_no: "الرقم الوظيفي",
      full_name: "الاسم",
      phone: "الهاتف",
      national_id: "الرقم الوطني",
      department_id: "القسم",
      job_title: "المسمى الوظيفي",
      job_title_id: "ربط المسمى الوظيفي",
      manager_id: "المدير المباشر",
      hire_date: "تاريخ التعيين",
      base_salary: "الراتب الأساسي",
      status: "الحالة",
      notes: "الملاحظات",
      termination_date: "تاريخ انتهاء الخدمة",
      termination_reason: "سبب انتهاء الخدمة",
    };
    for (const key of Object.keys(next) as Array<keyof typeof next>) {
      const before = current[key] as unknown;
      if (String(before ?? "") !== String(next[key] ?? "")) {
        if (key === "manager_id") {
          changes[labels[key] ?? key] = { from: current.manager_name ?? "—", to: managerName || "—" };
          continue;
        }
        if (key === "job_title_id") {
          changes[labels[key] ?? key] = {
            from: current.job_title_id ? current.job_title : "—",
            to: next.job_title_id ? next.job_title || "—" : "—",
          };
          continue;
        }
        changes[labels[key] ?? key] = { from: before ?? "—", to: next[key] ?? "—" };
      }
    }
    if (Object.keys(changes).length === 0) throw new ApiError(400, "NO_CHANGES", "لا توجد تغييرات لحفظها.");
    await db.query(
      `UPDATE employees SET employee_no=$2, full_name=$3, phone=$4, national_id=$5, department_id=$6,
         job_title=$7, job_title_id=$8, manager_id=$9, hire_date=$10, base_salary=$11, status=$12, notes=$13,
         termination_date=$14, termination_reason=$15, updated_by=$16, updated_at=now()
       WHERE id=$1`,
      [id, next.employee_no, next.full_name, next.phone, next.national_id, next.department_id, next.job_title, next.job_title_id, next.manager_id, next.hire_date, next.base_salary, next.status, next.notes, next.termination_date, next.termination_reason, actor.id],
    );
    const salaryChanged = Number(next.base_salary) !== Number(current.base_salary);
    const statusChanged = next.status !== current.status;
    const changedLabels = Object.keys(changes);
    await writeEmployeeHistory(db, {
      employeeId: id,
      changeType: salaryChanged ? "salary_changed" : statusChanged ? "status_changed" : "updated",
      summary: `تعديل بيانات ${next.full_name}: ${changedLabels.slice(0, 6).join("، ")}${changedLabels.length > 6 ? "…" : ""}`,
      details: { changes, employeeNo },
      effectiveDate: today(),
      actorId: actor.id,
    });
    await writeAudit(db, logger, {
      action: "employee.updated",
      actor: { id: actor.id, username: actor.username },
      entityType: "employee",
      entityId: id,
      branchId: current.branch_id,
      severity: next.status !== current.status ? "warning" : "info",
      details: { employeeNo, changes },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    const employee = await loadEmployee(db, id);
    res.json({ employee: presentEmployee(employee) });
  });

  router.post("/:id/archive", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const id = z.uuid("معرّف موظف غير صالح.").parse(req.params.id);
    const input = parseBody(archiveEmployeeSchema, req.body);
    const current = await loadEmployee(db, id);
    if (!canAccessBranch(actor, current.branch_id)) throw notFound("الموظف غير موجود أو خارج نطاق صلاحيتك.");
    if (current.archived_at) throw conflict("الموظف مؤرشف مسبقاً.");
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE employees SET archived_at = now(), archive_reason = $2, termination_date = COALESCE($3::date, CURRENT_DATE),
           termination_reason = COALESCE(termination_reason, $2), status = CASE WHEN status = 'resigned' THEN status ELSE 'resigned' END,
           updated_by = $4, updated_at = now()
         WHERE id = $1`,
        [id, input.reason, input.terminationDate || null, actor.id],
      );
      await tx.query(
        `UPDATE employee_contracts SET status = 'ended', updated_by = $2, updated_at = now()
         WHERE employee_id = $1 AND status = 'active'`,
        [id, actor.id],
      );
      await writeEmployeeHistory(tx, {
        employeeId: id,
        changeType: "archived",
        summary: `أرشفة الخدمة — ${input.reason}`,
        details: {
          reason: input.reason,
          terminationDate: input.terminationDate || today(),
          employeeNo: current.employee_no,
        },
        effectiveDate: input.terminationDate || today(),
        actorId: actor.id,
      });
    });
    await writeAudit(db, logger, {
      action: "employee.archived",
      actor: { id: actor.id, username: actor.username },
      entityType: "employee",
      entityId: id,
      branchId: current.branch_id,
      severity: "warning",
      details: { employeeNo: current.employee_no, reason: input.reason },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  });

  const CONTRACT_TYPES_AR: Record<string, string> = {
    permanent: "دائم",
    fixed: "محدد المدة",
    probation: "تحت التجربة",
    part_time: "دوام جزئي",
  };
  const CONTRACT_STATUS_AR: Record<string, string> = {
    active: "نشط",
    ended: "منتهٍ",
    terminated: "ملغي",
  };

  router.post("/:id/contracts", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const id = z.uuid("معرّف موظف غير صالح.").parse(req.params.id);
    const input = parseBody(contractSchema, req.body);
    const current = await loadEmployee(db, id);
    if (!canAccessBranch(actor, current.branch_id)) throw notFound("الموظف غير موجود أو خارج نطاق صلاحيتك.");
    if (current.archived_at) throw new ApiError(400, "EMPLOYEE_ARCHIVED", "الموظف مؤرشف ولا يمكن إضافة عقود له.");
    if (input.status === "active") {
      const active = await db.query<Row & { contract_no: string }>(
        "SELECT contract_no FROM employee_contracts WHERE employee_id = $1 AND status = 'active' LIMIT 1",
        [id],
      );
      if (active.rows[0]) {
        throw conflict(`يوجد عقد نشط بالفعل${active.rows[0].contract_no ? ` (${active.rows[0].contract_no})` : ""}. أنهِ العقد الحالي أولاً.`);
      }
    }
    const contractId = newId();
    const salaryChanged = input.status === "active" && Number(input.baseSalary) !== Number(current.base_salary);
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO employee_contracts
          (id, employee_id, contract_no, contract_type, start_date, end_date, base_salary, status, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
        [
          contractId,
          id,
          input.contractNo || "",
          input.contractType,
          input.startDate,
          input.endDate ?? null,
          input.baseSalary,
          input.status,
          input.notes,
          actor.id,
        ],
      );
      if (salaryChanged) {
        await tx.query("UPDATE employees SET base_salary = $2, updated_by = $3, updated_at = now() WHERE id = $1", [
          id,
          input.baseSalary,
          actor.id,
        ]);
      }
      await writeEmployeeHistory(tx, {
        employeeId: id,
        changeType: "contract_added",
        summary: `إضافة عقد ${CONTRACT_TYPES_AR[input.contractType] ?? input.contractType}${input.contractNo ? ` رقم ${input.contractNo}` : ""} — ${CONTRACT_STATUS_AR[input.status] ?? input.status}`,
        details: { contractId, contractNo: input.contractNo, contractType: input.contractType, startDate: input.startDate, endDate: input.endDate ?? null, baseSalary: input.baseSalary, status: input.status },
        effectiveDate: input.startDate,
        actorId: actor.id,
      });
      if (salaryChanged) {
        await writeEmployeeHistory(tx, {
          employeeId: id,
          changeType: "salary_changed",
          summary: `تحديث الراتب الأساسي من العقد إلى ${input.baseSalary}`,
          details: { from: Number(current.base_salary), to: input.baseSalary, source: "contract", contractId },
          effectiveDate: input.startDate,
          actorId: actor.id,
        });
      }
    });
    await writeAudit(db, logger, {
      action: "contract.created",
      actor: { id: actor.id, username: actor.username },
      entityType: "employee_contract",
      entityId: contractId,
      branchId: current.branch_id,
      severity: "info",
      details: { employeeId: id, employeeNo: current.employee_no, contractNo: input.contractNo, status: input.status, baseSalary: input.baseSalary },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    const contract = await loadContract(db, id, contractId);
    res.status(201).json({ contract: presentContract(contract) });
  });

  router.patch("/:id/contracts/:contractId", requireManage, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const id = z.uuid("معرّف موظف غير صالح.").parse(req.params.id);
    const contractId = z.uuid("معرّف عقد غير صالح.").parse(req.params.contractId);
    const input = parseBody(contractUpdateSchema, req.body);
    const current = await loadEmployee(db, id);
    if (!canAccessBranch(actor, current.branch_id)) throw notFound("الموظف غير موجود أو خارج نطاق صلاحيتك.");
    if (current.archived_at) throw new ApiError(400, "EMPLOYEE_ARCHIVED", "الموظف مؤرشف ولا يمكن تعديل عقوده.");
    const existing = await loadContract(db, id, contractId);
    const next = {
      contract_no: input.contractNo ?? existing.contract_no,
      contract_type: input.contractType ?? existing.contract_type,
      start_date: input.startDate ?? toDateOnly(existing.start_date) ?? today(),
      end_date: input.endDate !== undefined ? (input.endDate ?? null) : toDateOnly(existing.end_date),
      base_salary: input.baseSalary ?? Number(existing.base_salary),
      status: input.status ?? existing.status,
      notes: input.notes ?? existing.notes,
    };
    if (next.end_date && next.end_date < next.start_date) {
      throw new ApiError(400, "INVALID_CONTRACT_DATES", "تاريخ نهاية العقد يجب ألا يسبق بدايته.");
    }
    if (next.status === "active" && existing.status !== "active") {
      const active = await db.query<Row & { id: string; contract_no: string }>(
        "SELECT id, contract_no FROM employee_contracts WHERE employee_id = $1 AND status = 'active' AND id <> $2 LIMIT 1",
        [id, contractId],
      );
      if (active.rows[0]) {
        throw conflict(`يوجد عقد نشط آخر${active.rows[0].contract_no ? ` (${active.rows[0].contract_no})` : ""}. أنهِه أولاً.`);
      }
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const compare = (label: string, before: unknown, after: unknown) => {
      if (String(before ?? "") !== String(after ?? "")) changes[label] = { from: before ?? "—", to: after ?? "—" };
    };
    compare("رقم العقد", existing.contract_no, next.contract_no);
    compare("نوع العقد", CONTRACT_TYPES_AR[existing.contract_type] ?? existing.contract_type, CONTRACT_TYPES_AR[next.contract_type] ?? next.contract_type);
    compare("تاريخ البداية", toDateOnly(existing.start_date), next.start_date);
    compare("تاريخ النهاية", toDateOnly(existing.end_date), next.end_date);
    compare("الراتب الأساسي", Number(existing.base_salary), next.base_salary);
    compare("الحالة", CONTRACT_STATUS_AR[existing.status] ?? existing.status, CONTRACT_STATUS_AR[next.status] ?? next.status);
    compare("ملاحظات", existing.notes, next.notes);
    if (Object.keys(changes).length === 0) throw new ApiError(400, "NO_CHANGES", "لا توجد تغييرات لحفظها.");
    const salaryChanged = next.status === "active" && Number(next.base_salary) !== Number(current.base_salary);
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE employee_contracts SET contract_no=$3, contract_type=$4, start_date=$5, end_date=$6,
           base_salary=$7, status=$8, notes=$9, updated_by=$10, updated_at=now()
         WHERE id=$1 AND employee_id=$2`,
        [contractId, id, next.contract_no, next.contract_type, next.start_date, next.end_date, next.base_salary, next.status, next.notes, actor.id],
      );
      if (salaryChanged) {
        await tx.query("UPDATE employees SET base_salary = $2, updated_by = $3, updated_at = now() WHERE id = $1", [
          id,
          next.base_salary,
          actor.id,
        ]);
      }
      await writeEmployeeHistory(tx, {
        employeeId: id,
        changeType: "contract_updated",
        summary: `تعديل عقد${next.contract_no ? ` ${next.contract_no}` : ""}: ${Object.keys(changes).join("، ")}`,
        details: { contractId, changes },
        effectiveDate: next.start_date,
        actorId: actor.id,
      });
      if (salaryChanged) {
        await writeEmployeeHistory(tx, {
          employeeId: id,
          changeType: "salary_changed",
          summary: `تحديث الراتب الأساسي من العقد إلى ${next.base_salary}`,
          details: { from: Number(current.base_salary), to: next.base_salary, source: "contract", contractId },
          effectiveDate: next.start_date,
          actorId: actor.id,
        });
      }
    });
    await writeAudit(db, logger, {
      action: "contract.updated",
      actor: { id: actor.id, username: actor.username },
      entityType: "employee_contract",
      entityId: contractId,
      branchId: current.branch_id,
      severity: "info",
      details: { employeeId: id, employeeNo: current.employee_no, changes },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    const contract = await loadContract(db, id, contractId);
    res.json({ contract: presentContract(contract) });
  });

  return router;
}
