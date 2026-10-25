import path from "node:path";
import { loadConfigForCli } from "../config.js";
import { createDb, type DbClient, type Row } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import {
  SKIPPED_TABLES,
  dependencyOrder,
  listPublicTables,
  loadAndVerifyTables,
  quoteIdent,
  readManifest,
  type LoadedTable,
  type TransferManifest,
} from "../db/transfer.js";
import { createLogger } from "../logger.js";

interface ImportArgs {
  inDir: string;
  confirmed: boolean;
  replace: boolean;
}

const BATCH_SIZE = 500;

function usage(): never {
  process.stderr.write(
    [
      "",
      "الاستخدام:",
      "  npm run import:data -- --in <مجلد-التصدير> --yes [--replace]",
      "",
      "  --yes      تأكيد الكتابة فوق بيانات قاعدة الهدف.",
      "  --replace  مطلوب إذا كانت قاعدة الهدف تحتوي مستخدمين بالفعل.",
      "",
      "أوقف خدمة التطبيق قبل الاستيراد، وليس قاعدة البيانات.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

function parseArgs(): ImportArgs {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) usage();
  const flag = args.indexOf("--in");
  const inDir = flag === -1 ? "" : (args[flag + 1] ?? "").trim();
  if (!inDir) usage();
  return {
    inDir: path.resolve(process.cwd(), inDir),
    confirmed: args.includes("--yes"),
    replace: args.includes("--replace"),
  };
}

async function countRows(db: DbClient, table: string): Promise<number> {
  const result = await db.query<Row & { total: string }>(
    `SELECT count(*)::text AS total FROM public.${quoteIdent(table)}`,
  );
  return Number(result.rows[0]?.total ?? "0");
}

async function selfReferencingTables(db: DbClient): Promise<Set<string>> {
  const result = await db.query<Row & { table_name: string }>(
    `SELECT c.relname AS table_name
     FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = con.connamespace
     WHERE con.contype = 'f' AND con.conrelid = con.confrelid AND n.nspname = 'public'`,
  );
  return new Set(result.rows.map((row) => row.table_name));
}

async function insertTable(tx: DbClient, table: LoadedTable, singleStatement: boolean): Promise<number> {
  if (table.rowCount === 0) return 0;
  const lines = table.content.split(/\r?\n/).filter((line) => line.length > 0);
  const batchSize = singleStatement ? Math.max(lines.length, 1) : BATCH_SIZE;
  let inserted = 0;
  for (let offset = 0; offset < lines.length; offset += batchSize) {
    const payload = `[${lines.slice(offset, offset + batchSize).join(",")}]`;
    await tx.query(
      `INSERT INTO public.${quoteIdent(table.name)}
       SELECT * FROM jsonb_populate_recordset(NULL::public.${quoteIdent(table.name)}, $1::jsonb)`,
      [payload],
    );
    inserted += Math.min(batchSize, lines.length - offset);
  }
  return inserted;
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.confirmed) {
    process.stderr.write("\n[خطأ] الاستيراد يستبدل بيانات قاعدة الهدف. أضف --yes بعد التأكد.\n\n");
    process.exit(1);
  }

  const manifest: TransferManifest = await readManifest(args.inDir);
  const sourceTables = await loadAndVerifyTables(args.inDir, manifest);
  process.stdout.write(`[import] تم التحقق من ${sourceTables.length} جدولًا في ${args.inDir}\n`);

  const config = loadConfigForCli();
  const logger = createLogger({ production: config.isProduction, level: "warn" });
  const db = await createDb(config.db, logger);

  try {
    await runMigrations(db, config.migrationsDir, logger);
    const targetTables = await listPublicTables(db);
    const targetSet = new Set(targetTables);
    const importedSet = new Set(sourceTables.map((table) => table.name));
    const missing = [...importedSet].filter((table) => !targetSet.has(table)).sort();
    if (missing.length > 0) {
      throw new Error(`قاعدة الهدف لا تحتوي جداول من التصدير: ${missing.join(", ")}. حدّث النسخة ثم أعد التصدير.`);
    }
    const extra = targetTables.filter((table) => !importedSet.has(table) && !SKIPPED_TABLES.has(table));
    for (const table of extra) {
      if ((await countRows(db, table)) > 0) {
        throw new Error(`جدول هدف غير موجود في التصدير يحتوي بيانات: ${table}. نسختا البرنامج غير متطابقتين.`);
      }
    }

    const existingUsers = await countRows(db, "users");
    if (existingUsers > 0 && !args.replace) {
      throw new Error(
        `قاعدة الهدف تحتوي ${existingUsers} مستخدمًا. إن كانت قاعدة إنتاج مستخدمة فأوقف العملية. ` +
          "للاستبدال الكامل أضف --replace.",
      );
    }

    const order = await dependencyOrder(db, [...importedSet]);
    const ordered = order.map((name) => {
      const item = sourceTables.find((table) => table.name === name);
      if (!item) throw new Error(`جدول مفقود من الحزمة: ${name}`);
      return item;
    });
    const selfRefs = await selfReferencingTables(db);

    process.stdout.write("[import] بدء المعاملة: تفريغ قاعدة الهدف ثم إدخال البيانات...\n");
    await db.transaction(async (tx) => {
      const truncateAll = targetTables.filter((table) => table !== "schema_migrations");
      const truncateTrigger = await tx.query<Row>(
        "SELECT 1 FROM pg_trigger WHERE tgname = 'audit_logs_no_truncate' AND NOT tgisinternal",
      );
      const hasTruncateTrigger = truncateTrigger.rows.length > 0;
      if (hasTruncateTrigger) {
        await tx.query("ALTER TABLE public.audit_logs DISABLE TRIGGER audit_logs_no_truncate");
      }
      await tx.query(`TRUNCATE TABLE ${truncateAll.map((table) => `public.${quoteIdent(table)}`).join(", ")} RESTART IDENTITY CASCADE`);
      if (hasTruncateTrigger) {
        await tx.query("ALTER TABLE public.audit_logs ENABLE TRIGGER audit_logs_no_truncate");
      }

      for (const table of ordered) {
        const inserted = await insertTable(tx, table, selfRefs.has(table.name));
        if (inserted !== table.rowCount) {
          throw new Error(`أُدخل ${inserted} صفًا في ${table.name} بدل ${table.rowCount}.`);
        }
        const actual = await countRows(tx, table.name);
        if (actual !== table.rowCount) {
          throw new Error(`عدد صفوف ${table.name} في الهدف ${actual} بدل ${table.rowCount}.`);
        }
      }

      for (const sequence of manifest.sequences) {
        const exists = await tx.query<Row>(
          "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'S' AND c.relname = $1",
          [sequence.name],
        );
        if (exists.rows.length === 0) {
          throw new Error(`تسلسل مفقود في قاعدة الهدف: ${sequence.name}`);
        }
        await tx.query(`SELECT setval($1::regclass, $2::bigint, $3)`, [
          `public.${quoteIdent(sequence.name)}`,
          sequence.lastValue,
          sequence.isCalled,
        ]);
      }
    });

    const keyTables = ["users", "branches", "employees", "attendance_submissions", "daily_attendance", "monthly_attendance", "audit_logs"];
    const summary: string[] = [];
    for (const table of keyTables) {
      const expected = sourceTables.find((item) => item.name === table)?.rowCount;
      if (expected === undefined) continue;
      const actual = await countRows(db, table);
      summary.push(`  ${table}: ${actual}`);
      if (actual !== expected) {
        throw new Error(`تحقق ما بعد الاستيراد فشل في ${table}: ${actual} بدل ${expected}`);
      }
    }

    process.stdout.write(
      [
        "",
        "==================================================================",
        " استيراد قاعدة BATAWIL HRMS",
        "==================================================================",
        " تم الاستيراد في معاملة واحدة واجتاز التحقق من الأعداد.",
        ...summary,
        " الجلسات ومحاولات الدخول: لم تُنقل.",
        ` مستخدمو الهدف قبل الاستبدال: ${existingUsers}.`,
        "------------------------------------------------------------------",
        " الخطوات التالية على الخادم:",
        "  1. شغّل التطبيق: docker compose -f docker-compose.prod.yml --env-file .env.production up -d",
        "  2. ولّد كلمة مرور مؤقتة جديدة للمدير وألغِ أي جلسات قديمة:",
        "     docker compose -f docker-compose.prod.yml --env-file .env.production \\",
        "       exec app node dist/server/src/cli/reset-admin.js --username admin",
        "  3. سجّل الدخول عبر HTTPS وغيّر كلمة المرور، ثم تحقق من الفروع والموظفين والاعتمادات.",
        "  4. احذف حزمة التصدير من الخادم ومن الجهاز المحلي بعد التحقق.",
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
