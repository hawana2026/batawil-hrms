import { loadConfigForCli } from "../config.js";
import { createLogger } from "../logger.js";
import { createDb } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { revokeAllUserSessions } from "../auth/session.js";
import {
  generateTemporaryPassword,
  hashPassword,
  validatePasswordStrength,
} from "../auth/password.js";
import { writeAudit } from "../lib/audit.js";
import type { Row } from "../db/index.js";

const MAX_ARG_LENGTH = 64;

function fail(message: string): never {
  process.stderr.write(`\n[خطأ] ${message}\n\n`);
  process.exit(1);
}

function usernameFromArgs(): string {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--username");
  if (flag !== -1) return (args[flag + 1] ?? "").trim();
  return (args[0] ?? "").trim();
}

function generateValidPassword(username: string): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = generateTemporaryPassword(16);
    if (validatePasswordStrength(candidate, username).ok) return candidate;
  }
  fail("تعذر إنشاء كلمة مرور مؤقتة آمنة. حاول مجدداً.");
}

interface AdminRow extends Row {
  id: string;
  username: string;
  active: boolean;
}

async function main(): Promise<void> {
  const config = loadConfigForCli();
  const logger = createLogger({ production: false });
  const username = usernameFromArgs();
  if (!username || username.length > MAX_ARG_LENGTH) {
    fail("حدد اسم مستخدم مدير النظام: npm run reset-admin -- --username admin");
  }

  const db = await createDb(config.db, logger);

  try {
    await runMigrations(db, config.migrationsDir, logger);

    const result = await db.query<AdminRow>(
      `SELECT u.id, u.username, u.active
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE lower(u.username) = lower($1) AND r.key = 'admin'`,
      [username],
    );
    const admin = result.rows[0];
    if (!admin) fail(`لا يوجد حساب مدير نظام باسم "${username}".`);
    if (!admin.active) fail("حساب المدير معطل. فعّله أولاً قبل إعادة تعيين كلمة المرور.");

    const password = generateValidPassword(admin.username);
    const passwordHash = await hashPassword(password);

    await db.query(
      `UPDATE users
       SET password_hash = $2, must_change_password = true, password_changed_at = now(),
           session_version = session_version + 1, failed_attempts = 0, locked_until = NULL, updated_at = now()
       WHERE id = $1`,
      [admin.id, passwordHash],
    );
    await revokeAllUserSessions(db, admin.id);

    await writeAudit(db, logger, {
      action: "auth.password_reset",
      actor: { id: null, username: "local-cli" },
      entityType: "user",
      entityId: admin.id,
      severity: "critical",
      details: { username: admin.username, reason: "cli_recovery", sessionsRevoked: true, mustChangePassword: true },
      ip: "local-cli",
      userAgent: "reset-admin",
    });

    const lines = [
      "",
      "==================================================================",
      " إعادة تعيين كلمة مرور مدير النظام — BATAWIL HRMS",
      "==================================================================",
      ` اسم المستخدم: ${admin.username}`,
      ` كلمة المرور المؤقتة: ${password}`,
      "------------------------------------------------------------------",
      " - سيُطلب تغيير كلمة المرور عند أول تسجيل دخول.",
      " - أُنهيت جميع الجلسات النشطة لهذا الحساب.",
      " - تُعرض كلمة المرور مرة واحدة فقط ولم تُحفظ في أي ملف.",
      " - سُجّلت العملية في سجل التدقيق.",
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
