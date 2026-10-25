import { loadConfigForCli } from "../config.js";
import { createLogger } from "../logger.js";
import { createDb } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import {
  generateTemporaryPassword,
  hashPassword,
  validatePasswordStrength,
} from "../auth/password.js";
import { writeAudit } from "../lib/audit.js";
import { newId } from "../lib/ids.js";
import { emailSchema, fullNameSchema, usernameSchema } from "../lib/schemas.js";
import type { Row } from "../db/index.js";

function fail(message: string): never {
  process.stderr.write(`\n[خطأ] ${message}\n\n`);
  process.exit(1);
}

function generateValidPassword(username: string): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = generateTemporaryPassword(16);
    if (validatePasswordStrength(candidate, username).ok) return candidate;
  }
  fail("تعذر إنشاء كلمة مرور مؤقتة آمنة. حاول مجدداً.");
}

async function main(): Promise<void> {
  const config = loadConfigForCli();
  const logger = createLogger({ production: false });
  const db = await createDb(config.db, logger);

  try {
    await runMigrations(db, config.migrationsDir, logger);

    const userCount = await db.query<Row & { count: number }>("SELECT count(*)::int AS count FROM users");
    if ((userCount.rows[0]?.count ?? 0) > 0) {
      fail("توجد حسابات مستخدمين بالفعل. أداة التهيئة تعمل فقط على قاعدة بيانات بلا حسابات. استخدم شاشة إدارة المستخدمين.");
    }

    const usernameParsed = usernameSchema.safeParse(config.setup.username);
    if (!usernameParsed.success) fail(`اسم المستخدم الأولي غير صالح: ${usernameParsed.error.issues[0]?.message ?? ""}`);
    const username = usernameParsed.data;

    const nameParsed = fullNameSchema.safeParse(config.setup.fullName);
    if (!nameParsed.success) fail(`اسم مدير النظام غير صالح: ${nameParsed.error.issues[0]?.message ?? ""}`);
    const fullName = nameParsed.data;

    const emailParsed = emailSchema.safeParse(config.setup.email ?? "");
    if (!emailParsed.success) fail(`البريد الإلكتروني غير صالح: ${emailParsed.error.issues[0]?.message ?? ""}`);
    const email = emailParsed.data ?? null;

    let password = config.setup.password;
    let generated = false;
    if (password) {
      const check = validatePasswordStrength(password, username);
      if (!check.ok) fail(`كلمة المرور المحددة في ADMIN_PASSWORD غير مقبولة: ${check.message ?? ""}`);
    } else {
      password = generateValidPassword(username);
      generated = true;
    }

    const passwordHash = await hashPassword(password);
    const roleResult = await db.query<Row & { id: string }>("SELECT id FROM roles WHERE key = 'admin'");
    const adminRoleId = roleResult.rows[0]?.id;
    if (!adminRoleId) fail("دور مدير النظام غير موجود. تحقق من تنفيذ ملفات الترحيل.");

    const userId = newId();
    await db.query(
      `INSERT INTO users
        (id, username, full_name, email, password_hash, must_change_password, role_id, active, all_branches)
       VALUES ($1, $2, $3, $4, $5, true, $6, true, true)`,
      [userId, username, fullName, email, passwordHash, adminRoleId],
    );

    await writeAudit(db, logger, {
      action: "setup.admin_created",
      actor: { id: userId, username },
      entityType: "user",
      entityId: userId,
      severity: "critical",
      details: { username, allBranches: true, passwordGenerated: generated, mustChangePassword: true },
      ip: "local-cli",
      userAgent: "setup-admin",
    });

    const lines = [
      "",
      "==================================================================",
      " تم إنشاء حساب مدير النظام بنجاح — BATAWIL HRMS",
      "==================================================================",
      ` اسم المستخدم: ${username}`,
      ` كلمة المرور المؤقتة: ${password}`,
      "------------------------------------------------------------------",
      " - سيُطلب تغيير كلمة المرور عند أول تسجيل دخول.",
      " - تُعرض كلمة المرور مرة واحدة فقط ولم تُحفظ في أي ملف.",
      " - لا تشارك هذه البيانات عبر قنوات غير آمنة.",
      " - الخطوة التالية: شغّل الخادم ثم أنشئ الفروع والمستخدمين.",
      "==================================================================",
      "",
    ];
    process.stdout.write(lines.join("\n"));
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[fatal] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
