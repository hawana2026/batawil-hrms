import { loadConfigForCli } from "../config.js";
import { createLogger } from "../logger.js";
import { createDb, type DbClient, type Row } from "../db/index.js";
import { newId } from "../lib/ids.js";

interface BranchInfo {
  id: string;
  code: string;
}

const BRANCH_CODES = ["SANAA", "ADEN", "TAIZ"] as const;
const DEPARTMENT_SEEDS = [
  { name: "الإدارة", titles: ["مدير فرع", "مساعد إداري"] },
  { name: "المبيعات", titles: ["مندوب مبيعات", "مشرف مبيعات"] },
  { name: "المخازن", titles: ["أمين مخزن", "مساعد مخزن"] },
  { name: "المحاسبة", titles: ["محاسب", "مساعد محاسبة"] },
  { name: "خدمة العملاء", titles: ["موظف خدمة عملاء", "مشرف خدمة عملاء"] },
] as const;
const FIRST_NAMES = ["سالم", "أحمد", "محمد", "عبدالله", "خالد", "طه", "أمين", "فؤاد", "هاني", "وليد", "ياسر", "عادل"];
const LAST_NAMES = ["الحداد", "العمري", "الشامي", "الحاج", "السقاف", "بامطرف", "الجابري", "المقطري", "العولقي", "الحميري", "الصبري", "الأهدل"];
const EMPLOYEES_PER_BRANCH = 12;
const YEAR = 2026;
const MONTH = 10;
const LAST_DAY = 25;
const WEEKEND_DAYS = new Set([5, 6]);
const ATTENDANCE_STATUSES = ["present", "absent", "leave", "permission", "mission", "weekly_rest", "late", "excused_absence"] as const;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function employeeName(index: number): string {
  const first = FIRST_NAMES[index % FIRST_NAMES.length];
  const cycle = Math.floor(index / FIRST_NAMES.length);
  const last = LAST_NAMES[(index * 7 + cycle) % LAST_NAMES.length];
  return `${first} ${last}`;
}

function workHours(lateMinutes: number): number {
  return Math.round((8 - lateMinutes / 60) * 100) / 100;
}

async function loadBranches(db: DbClient): Promise<BranchInfo[]> {
  const rows = await db.query<Row & { id: string; code: string }>("SELECT id, code FROM branches WHERE upper(code) = ANY($1::text[])", [
    BRANCH_CODES,
  ]);
  const byCode = new Map(rows.rows.map((row) => [row.code.toUpperCase(), row.id]));
  const missing = BRANCH_CODES.filter((code) => !byCode.has(code));
  if (missing.length > 0) {
    throw new Error(`الفروع التالية غير موجودة: ${missing.join(", ")}. شغّل npm run seed:demo أولاً.`);
  }
  return BRANCH_CODES.map((code) => ({ code, id: byCode.get(code) as string }));
}

async function seedDepartments(db: DbClient): Promise<Map<string, string>> {
  const existing = await db.query<Row & { id: string; name: string }>("SELECT id, name FROM departments");
  const byName = new Map(existing.rows.map((row) => [row.name, row.id]));
  for (const name of DEPARTMENT_SEEDS.map((seed) => seed.name)) {
    if (byName.has(name)) continue;
    const id = newId();
    await db.query("INSERT INTO departments (id, name) VALUES ($1, $2)", [id, name]);
    byName.set(name, id);
  }
  return byName;
}

async function seedEmployees(
  db: DbClient,
  branches: BranchInfo[],
  departments: Map<string, string>,
  adminId: string | null,
): Promise<Map<string, string[]>> {
  const byBranch = new Map<string, string[]>();
  let index = 0;
  for (const branch of branches) {
    const ids: string[] = [];
    for (let employeeInBranch = 0; employeeInBranch < EMPLOYEES_PER_BRANCH; employeeInBranch += 1) {
      const department = DEPARTMENT_SEEDS[index % DEPARTMENT_SEEDS.length] ?? DEPARTMENT_SEEDS[0];
      const departmentName = department.name;
      const titles = department.titles;
      const employeeId = newId();
      const employeeNo = `DEMO-${String(index + 1).padStart(3, "0")}`;
      const name = employeeName(index);
      const phone = `77${String(1000000 + index).padStart(7, "0")}`;
      const salary = 150000 + (index % 8) * 25000 + branches.indexOf(branch) * 10000;
      const hireDate = new Date(Date.UTC(2021, 5, 1 + index * 17)).toISOString().slice(0, 10);
      await db.query(
        `INSERT INTO employees
          (id, employee_no, full_name, phone, branch_id, department_id, job_title, hire_date, base_salary, status, notes, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', 'بيانات تجريبية مولدة', $10, $10)`,
        [
          employeeId,
          employeeNo,
          name,
          phone,
          branch.id,
          departments.get(departmentName) ?? null,
          titles[employeeInBranch % titles.length] ?? titles[0],
          hireDate,
          salary,
          adminId,
        ],
      );
      ids.push(employeeId);
      index += 1;
    }
    byBranch.set(branch.code, ids);
  }
  return byBranch;
}

interface DailyRow {
  employeeId: string;
  day: number;
  status: (typeof ATTENDANCE_STATUSES)[number];
  checkIn: string | null;
  checkOut: string | null;
  lateMinutes: number;
  workHours: number;
  reason: string;
}

function attendanceForWeekday(random: () => number): Omit<DailyRow, "employeeId" | "day"> {
  const roll = random();
  if (roll < 0.86) {
    return { status: "present", checkIn: "08:00", checkOut: "16:00", lateMinutes: 0, workHours: 8, reason: "" };
  }
  if (roll < 0.9) {
    const lateOptions = [15, 30, 45] as const;
    const lateMinutes = lateOptions[Math.floor(random() * lateOptions.length)] ?? 15;
    const checkIn = `08:${String(lateMinutes).padStart(2, "0")}`;
    return { status: "late", checkIn, checkOut: "16:00", lateMinutes, workHours: workHours(lateMinutes), reason: "تأخر صباحي" };
  }
  if (roll < 0.95) {
    return { status: "absent", checkIn: null, checkOut: null, lateMinutes: 0, workHours: 0, reason: "غياب بدون إشعار" };
  }
  if (roll < 0.97) {
    return { status: "leave", checkIn: null, checkOut: null, lateMinutes: 0, workHours: 0, reason: "إجازة سنوية" };
  }
  return { status: "permission", checkIn: null, checkOut: null, lateMinutes: 0, workHours: 0, reason: "إذن خروج" };
}

async function seedAttendance(db: DbClient, branches: BranchInfo[], employeesByBranch: Map<string, string[]>, adminId: string | null): Promise<{ submissions: number; rows: number }> {
  const random = mulberry32(20261025);
  let submissions = 0;
  let rows = 0;
  for (const branch of branches) {
    const employeeIds = employeesByBranch.get(branch.code) ?? [];
    for (let day = 1; day <= LAST_DAY; day += 1) {
      const workDate = isoDate(YEAR, MONTH, day);
      const weekday = new Date(Date.UTC(YEAR, MONTH - 1, day)).getUTCDay();
      const isWeekend = WEEKEND_DAYS.has(weekday);
      const submissionId = newId();
      await db.query(
        `INSERT INTO attendance_submissions
          (id, branch_id, work_date, status, notes, prepared_by, submitted_by, submitted_at, approved_by, approved_at)
         VALUES ($1, $2, $3, 'approved', '', $4, $4, now(), $4, now())`,
        [submissionId, branch.id, workDate, adminId],
      );
      submissions += 1;
      for (const employeeId of employeeIds) {
        const attendance: Omit<DailyRow, "employeeId" | "day"> = isWeekend
          ? { status: "weekly_rest", checkIn: null, checkOut: null, lateMinutes: 0, workHours: 0, reason: "راحة أسبوعية" }
          : attendanceForWeekday(random);
        await db.query(
          `INSERT INTO daily_attendance
            (id, submission_id, employee_id, status, check_in, check_out, late_minutes, work_hours, reason, notes, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '', $10, $10)`,
          [
            newId(),
            submissionId,
            employeeId,
            attendance.status,
            attendance.checkIn,
            attendance.checkOut,
            attendance.lateMinutes,
            attendance.workHours,
            attendance.reason,
            adminId,
          ],
        );
        rows += 1;
      }
    }
  }
  return { submissions, rows };
}

async function seedMonthly(db: DbClient, branches: BranchInfo[], adminId: string | null): Promise<number> {
  let count = 0;
  for (const branch of branches) {
    await db.query(
      `INSERT INTO monthly_attendance
        (id, branch_id, year, month, status, missing_days_confirmed, notes, prepared_by, submitted_by, submitted_at, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, 'approved', true, '', $5, $5, now(), $5, now())`,
      [newId(), branch.id, YEAR, MONTH, adminId],
    );
    count += 1;
  }
  return count;
}

async function main(): Promise<void> {
  if (process.env.DEMO_DATA_CONFIRM !== "yes") {
    throw new Error("هذا السكربت يضيف بيانات وهمية. أعد تشغيله مع DEMO_DATA_CONFIRM=yes للتأكيد.");
  }
  const config = loadConfigForCli();
  const schema = config.db.schema;
  if (!schema || schema === "public") {
    throw new Error("DATABASE_SCHEMA مطلوب ويجب ألا يكون public حمايةً لقواعد أخرى.");
  }
  if (config.db.driver !== "postgres") {
    throw new Error("شغّل هذا السكربت على قاعدة العرض فقط (DB_DRIVER=postgres + DATABASE_SCHEMA).");
  }

  const logger = createLogger({ production: false });
  const db = await createDb(config.db, logger);
  try {
    const existing = await db.query<Row & { count: number }>("SELECT count(*)::int AS count FROM employees");
    if ((existing.rows[0]?.count ?? 0) > 0) {
      throw new Error("الموظفون موجودون بالفعل في هذا الـ Schema. لم يتم إدخال أي بيانات.");
    }
    const admin = await db.query<Row & { id: string }>("SELECT id FROM users WHERE lower(username) = 'admin' LIMIT 1");
    const adminId = admin.rows[0]?.id ?? null;
    const branches = await loadBranches(db);

    let employees = 0;
    let submissions = 0;
    let attendanceRows = 0;
    let monthly = 0;
    let departments = 0;
    await db.transaction(async (tx) => {
      const departmentsByName = await seedDepartments(tx);
      departments = departmentsByName.size;
      const employeesByBranch = await seedEmployees(tx, branches, departmentsByName, adminId);
      employees = [...employeesByBranch.values()].reduce((sum, ids) => sum + ids.length, 0);
      const attendance = await seedAttendance(tx, branches, employeesByBranch, adminId);
      submissions = attendance.submissions;
      attendanceRows = attendance.rows;
      monthly = await seedMonthly(tx, branches, adminId);
    });

    process.stdout.write(
      [
        "",
        "==================================================================",
        " بيانات وهمية للعرض — BATAWIL HRMS",
        "==================================================================",
        `Schema: ${schema}`,
        `الفروع: ${branches.map((branch) => branch.code).join(", ")}`,
        `الأقسام: ${departments}`,
        `الموظفون: ${employees}`,
        `كشوف الحضور اليومية: ${submissions}`,
        `سجلات الحضور: ${attendanceRows}`,
        `كشوف الحضور الشهرية: ${monthly}`,
        " - كل الأسماء والأرقام مولدة، ولا تمثل موظفين حقيقيين.",
        "==================================================================",
        "",
      ].join("\n"),
    );
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[خطأ] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
