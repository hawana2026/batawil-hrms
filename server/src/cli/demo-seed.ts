import { loadConfigForCli } from "../config.js";
import { createLogger } from "../logger.js";
import { createDb, type Db } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { generateTemporaryPassword, hashPassword, validatePasswordStrength } from "../auth/password.js";
import { newId } from "../lib/ids.js";
import type { Row } from "../db/index.js";

interface BranchSeed {
  code: string;
  name: string;
  city: string;
}

interface UserSeed {
  username: string;
  fullName: string;
  roleKey: string;
  allBranches: boolean;
  branchCodes: string[];
}

const BRANCHES: BranchSeed[] = [
  { code: "SANAA", name: "فرع صنعاء الرئيسي", city: "صنعاء" },
  { code: "ADEN", name: "فرع عدن", city: "عدن" },
  { code: "TAIZ", name: "فرع تعز", city: "تعز" },
];

const USERS: UserSeed[] = [
  { username: "hr.officer", fullName: "مسؤول شؤون الموظفين", roleKey: "hr_officer", allBranches: false, branchCodes: ["SANAA", "ADEN"] },
  { username: "manager.sanaa", fullName: "مدير فرع صنعاء", roleKey: "branch_manager", allBranches: false, branchCodes: ["SANAA"] },
  { username: "employee.aden", fullName: "موظف فرع عدن", roleKey: "employee", allBranches: false, branchCodes: ["ADEN"] },
];

function passwordFor(username: string): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = generateTemporaryPassword(16);
    if (validatePasswordStrength(candidate, username).ok) return candidate;
  }
  throw new Error("تعذر إنشاء كلمة مرور مؤقتة آمنة.");
}

async function seedBranches(db: Db): Promise<Map<string, string>> {
  const existing = await db.query<Row & { id: string; code: string }>("SELECT id, code FROM branches");
  const byCode = new Map(existing.rows.map((row) => [row.code.toUpperCase(), row.id]));
  for (const branch of BRANCHES) {
    if (byCode.has(branch.code)) continue;
    const id = newId();
    await db.query("INSERT INTO branches (id, code, name, city, active) VALUES ($1, $2, $3, $4, true)", [
      id,
      branch.code,
      branch.name,
      branch.city,
    ]);
    byCode.set(branch.code, id);
  }
  return byCode;
}

async function main(): Promise<void> {
  const config = loadConfigForCli();
  if (config.isProduction) {
    throw new Error("بيانات العرض التجريبية ممنوعة في بيئة الإنتاج.");
  }
  const logger = createLogger({ production: false });
  const db = await createDb(config.db, logger);

  try {
    await runMigrations(db, config.migrationsDir, logger);
    const adminCount = await db.query<Row & { count: number }>(
      "SELECT count(*)::int AS count FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'admin' AND u.active = true",
    );
    if ((adminCount.rows[0]?.count ?? 0) === 0) {
      throw new Error("أنشئ حساب مدير النظام أولاً باستخدام: npm run setup");
    }

    const branches = await seedBranches(db);
    const credentials: Array<{ username: string; password: string; note: string }> = [];

    for (const seed of USERS) {
      const existing = await db.query<Row & { id: string }>("SELECT id FROM users WHERE lower(username) = $1", [seed.username]);
      if (existing.rows.length > 0) continue;

      const role = await db.query<Row & { id: string }>("SELECT id FROM roles WHERE key = $1", [seed.roleKey]);
      const roleId = role.rows[0]?.id;
      if (!roleId) throw new Error(`الدور ${seed.roleKey} غير موجود.`);

      const branchIds = seed.branchCodes.map((code) => {
        const id = branches.get(code);
        if (!id) throw new Error(`الفرع ${code} غير موجود.`);
        return id;
      });

      const password = passwordFor(seed.username);
      const userId = newId();
      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO users
            (id, username, full_name, password_hash, must_change_password, role_id, active, all_branches)
           VALUES ($1, $2, $3, $4, true, $5, true, $6)`,
          [userId, seed.username, seed.fullName, await hashPassword(password), roleId, seed.allBranches],
        );
        for (const branchId of branchIds) {
          await tx.query("INSERT INTO user_branch_access (user_id, branch_id) VALUES ($1, $2)", [userId, branchId]);
        }
      });
      credentials.push({
        username: seed.username,
        password,
        note: seed.branchCodes.join(", ") + " — " + seed.roleKey,
      });
    }

    if (credentials.length === 0) {
      process.stdout.write("\n[معلومة] الحسابات التجريبية موجودة بالفعل، لم يتم إنشاء أي حساب جديد.\n\n");
      return;
    }

    const lines = [
      "",
      "==================================================================",
      " بيانات تجريبية للتطوير فقط — BATAWIL HRMS",
      "==================================================================",
      "تم إنشاء الفروع: " + BRANCHES.map((branch) => branch.code).join(", "),
      "الحسابات التالية بكلمات مرور مؤقتة تُعرض مرة واحدة:",
      "",
      ...credentials.map((item) => `  ${item.username}  |  ${item.password}  |  ${item.note}`),
      "",
      " - سيُطلب تغيير كلمة المرور عند أول دخول.",
      " - لا تستخدم هذه البيانات في بيئة إنتاج أو مع موظفين حقيقيين.",
      "==================================================================",
      "",
    ];
    process.stdout.write(lines.join("\n"));
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[خطأ] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
