import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfigForCli } from "../config.js";
import { createDb } from "../db/index.js";
import type { Row } from "../db/index.js";
import {
  SKIPPED_TABLES,
  TRANSFER_FORMAT,
  TRANSFER_VERSION,
  listPublicSequences,
  listPublicTables,
  quoteIdent,
  sha256,
  type ManifestTable,
  type TransferManifest,
} from "../db/transfer.js";
import { createLogger } from "../logger.js";

interface ExportArgs {
  outDir: string;
}

function usage(): never {
  process.stderr.write(
    [
      "",
      "الاستخدام:",
      "  npm run export:data -- --out .data/transfer/batawil-20261025",
      "",
      "ينتج مجلدًا يحتوي manifest.json وملفات NDJSON لكل جدول.",
      "أوقف الخادم المحلي قبل التصدير لأن PGlite تسمح بعملية واحدة فقط.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

function parseArgs(): ExportArgs {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) usage();
  const flag = args.indexOf("--out");
  const value = flag === -1 ? "" : (args[flag + 1] ?? "").trim();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const outDir = path.resolve(process.cwd(), value || `.data/transfer/batawil-${stamp}`);
  return { outDir };
}

async function ensureEmptyDirectory(dir: string): Promise<void> {
  const publicDir = path.resolve(process.cwd(), "public");
  const relativeToPublic = path.relative(publicDir, dir);
  if (relativeToPublic !== "" && !relativeToPublic.startsWith("..") && !path.isAbsolute(relativeToPublic)) {
    throw new Error("لا يمكن حفظ تصدير يحتوي بيانات موظفين داخل مجلد public.");
  }
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir);
  if (entries.length > 0) {
    throw new Error(`مجلد التصدير ليس فارغًا: ${dir}. اختر مسارًا جديدًا.`);
  }
  await chmod(dir, 0o700).catch(() => undefined);
}

async function main(): Promise<void> {
  const { outDir } = parseArgs();
  const config = loadConfigForCli();
  const logger = createLogger({ production: false, level: "warn" });
  await ensureEmptyDirectory(outDir);

  const db = await createDb(config.db, logger);
  try {
    const allTables = await listPublicTables(db);
    const tables = allTables.filter((table) => !SKIPPED_TABLES.has(table));
    if (!tables.includes("users") || !tables.includes("employees")) {
      throw new Error("قاعدة البيانات لا تحتوي الجداول الأساسية. نفّذ الترحيلات أولًا.");
    }

    const manifestTables: ManifestTable[] = [];
    for (const table of tables) {
      const result = await db.query<Row & { row: unknown }>(
        `SELECT to_jsonb(t) AS row FROM public.${quoteIdent(table)} t`,
      );
      const lines = result.rows.map((row) => JSON.stringify(row.row));
      const content = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
      await writeFile(path.join(outDir, `${table}.ndjson`), content, { encoding: "utf8", mode: 0o600 });
      await chmod(path.join(outDir, `${table}.ndjson`), 0o600).catch(() => undefined);
      manifestTables.push({ name: table, rowCount: lines.length, sha256: sha256(content) });
    }

    const manifest: TransferManifest = {
      format: TRANSFER_FORMAT,
      version: TRANSFER_VERSION,
      createdAt: new Date().toISOString(),
      sourceDriver: db.driver,
      skippedTables: [...SKIPPED_TABLES].sort(),
      tables: manifestTables,
      sequences: await listPublicSequences(db),
    };
    await writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(path.join(outDir, "manifest.json"), 0o600).catch(() => undefined);

    const keyTables = ["users", "branches", "employees", "attendance_submissions", "daily_attendance", "monthly_attendance", "audit_logs"];
    const summary = keyTables
      .map((name) => {
        const entry = manifestTables.find((table) => table.name === name);
        return entry ? `  ${name}: ${entry.rowCount}` : null;
      })
      .filter((line): line is string => line !== null);

    process.stdout.write(
      [
        "",
        "==================================================================",
        " تصدير قاعدة BATAWIL HRMS",
        "==================================================================",
        ` المسار: ${outDir}`,
        ` الجداول: ${manifestTables.length} | التسلسلات: ${manifest.sequences.length}`,
        ...summary,
        "------------------------------------------------------------------",
        " - تم توقيع كل ملف ببصمة SHA-256 داخل manifest.json.",
        " - لم تُصدّر الجلسات ولا محاولات الدخول ولا جدول الترحيلات.",
        " - الحزمة تحتوي بيانات شخصية وتجزئات كلمات مرور ومرفقات. انقلها عبر SSH،",
        "   واحذفها من الجهاز المحلي والخادم بعد نجاح الاستيراد.",
        "==================================================================",
        "",
      ].join("\n"),
    );
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[fatal] ${message}\n`);
  if (/lock|already (open|in use)|PGlite/i.test(message)) {
    process.stderr.write("[fatal] أوقف خادم PGlite المحلي ثم أعد المحاولة: PGlite تسمح بعملية واحدة فقط.\n");
  }
  process.exitCode = 1;
});
