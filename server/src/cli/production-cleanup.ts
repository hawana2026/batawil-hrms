import { loadConfigForCli } from "../config.js";
import { createDb, type Row } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { createLogger } from "../logger.js";
import { writeAudit } from "../lib/audit.js";

// Demo seed identities only. Both username and full name must match, so a real
// account that happens to reuse one of these usernames is never disabled.
const DEMO_USERS = [
  { username: "hr.officer", fullName: "مسؤول شؤون الموظفين" },
  { username: "manager.sanaa", fullName: "مدير فرع صنعاء" },
  { username: "employee.aden", fullName: "موظف فرع عدن" },
];

interface UserRow extends Row {
  id: string;
  username: string;
  active: boolean;
}

function fail(message: string): never {
  process.stderr.write(`\n[خطأ] ${message}\n\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes("--yes")) {
    fail("هذا الأمر يعطّل حسابات العرض النشطة. أضف --yes بعد التأكد من قاعدة الهدف.");
  }
  const config = loadConfigForCli();
  if (!config.isProduction && !args.includes("--allow-non-production")) {
    fail("هذا الأمر مخصص لبيئة الإنتاج. للاختبار المحلي أضف --allow-non-production.");
  }

  const logger = createLogger({ production: config.isProduction });
  const db = await createDb(config.db, logger);
  try {
    await runMigrations(db, config.migrationsDir, logger);
    const disabled: string[] = [];

    for (const demo of DEMO_USERS) {
      const result = await db.query<UserRow>(
        `SELECT id, username, active FROM users
         WHERE lower(username) = lower($1) AND full_name = $2`,
        [demo.username, demo.fullName],
      );
      const user = result.rows[0];
      if (!user || !user.active) continue;

      await db.query(
        `UPDATE users
         SET active = false, session_version = session_version + 1, failed_attempts = 0,
             locked_until = NULL, updated_at = now()
         WHERE id = $1`,
        [user.id],
      );
      await db.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [user.id]);
      await writeAudit(db, logger, {
        action: "users.demo_account_disabled",
        actor: { id: null, username: "local-cli" },
        entityType: "user",
        entityId: user.id,
        severity: "critical",
        details: { username: user.username, reason: "demo_account_production_cleanup" },
        ip: "local-cli",
        userAgent: "production-cleanup",
      });
      disabled.push(user.username);
    }

    const remaining = await db.query<Row & { total: string }>(
      `SELECT count(*)::text AS total FROM users
       WHERE active = true AND (
         (lower(username) = 'hr.officer' AND full_name = 'مسؤول شؤون الموظفين') OR
         (lower(username) = 'manager.sanaa' AND full_name = 'مدير فرع صنعاء') OR
         (lower(username) = 'employee.aden' AND full_name = 'موظف فرع عدن')
       )`,
    );
    const remainingActive = Number(remaining.rows[0]?.total ?? "0");
    if (remainingActive !== 0) {
      throw new Error(`ما زال هناك ${remainingActive} حساب عرض نشطًا.`);
    }

    const admins = await db.query<Row & { total: string }>(
      `SELECT count(*)::text AS total FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.active = true AND r.key = 'admin'`,
    );
    const branches = await db.query<Row & { total: string }>(
      "SELECT count(*)::text AS total FROM branches WHERE active = true",
    );

    process.stdout.write(
      [
        "",
        "==================================================================",
        " تنظيف حسابات العرض — BATAWIL HRMS",
        "==================================================================",
        ` الحسابات التي عُطّلت الآن: ${disabled.length > 0 ? disabled.join(", ") : "لا شيء"}`,
        ` حسابات عرض نشطة متبقية: ${remainingActive}`,
        ` مديرو نظام نشطون: ${admins.rows[0]?.total ?? "0"}`,
        ` فروع نشطة: ${branches.rows[0]?.total ?? "0"}`,
        "------------------------------------------------------------------",
        " - أُلغيت جلسات الحسابات المعطلة وسُجّل الإجراء في التدقيق.",
        " - لم تُحذف أي بيانات موظفين أو فروع؛ الفروع التجريبية معطلة.",
        " - غيّر كلمة مرور المدير عبر reset-admin قبل فتح الموقع للمستخدمين.",
        "==================================================================",
        "",
      ].join("\n"),
    );
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[fatal] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
