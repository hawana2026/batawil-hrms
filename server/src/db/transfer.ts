import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Db, Row } from "./index.js";

export const TRANSFER_FORMAT = "batawil-hrms-transfer";
export const TRANSFER_VERSION = 1;

// Sessions and login attempts must never be copied to another environment.
export const SKIPPED_TABLES = new Set(["schema_migrations", "sessions", "login_attempts"]);

export interface ManifestTable {
  name: string;
  rowCount: number;
  sha256: string;
}

export interface ManifestSequence {
  name: string;
  lastValue: string;
  isCalled: boolean;
}

export interface TransferManifest {
  format: typeof TRANSFER_FORMAT;
  version: typeof TRANSFER_VERSION;
  createdAt: string;
  sourceDriver: "pglite" | "postgres";
  skippedTables: string[];
  tables: ManifestTable[];
  sequences: ManifestSequence[];
}

export interface LoadedTable {
  name: string;
  rowCount: number;
  content: string;
}

export function assertSafeIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`معرّف جدول أو تسلسل غير صالح: ${value}`);
  }
  return value;
}

export function quoteIdent(value: string): string {
  return `"${assertSafeIdentifier(value)}"`;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function listPublicTables(db: Db): Promise<string[]> {
  const result = await db.query<Row & { table_name: string }>(
    `SELECT c.relname AS table_name
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relispartition = false
     ORDER BY c.relname`,
  );
  return result.rows.map((row) => row.table_name);
}

export async function listPublicSequences(db: Db): Promise<ManifestSequence[]> {
  const list = await db.query<Row & { sequence_name: string }>(
    `SELECT c.relname AS sequence_name
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'S'
     ORDER BY c.relname`,
  );
  const sequences: ManifestSequence[] = [];
  for (const row of list.rows) {
    const name = assertSafeIdentifier(row.sequence_name);
    const state = await db.query<Row & { last_value: string; is_called: boolean }>(
      `SELECT last_value::text AS last_value, is_called FROM public.${quoteIdent(name)}`,
    );
    const value = state.rows[0];
    if (!value) throw new Error(`تعذر قراءة حالة التسلسل ${name}.`);
    sequences.push({ name, lastValue: value.last_value, isCalled: value.is_called });
  }
  return sequences;
}

export async function dependencyOrder(db: Db, tables: string[]): Promise<string[]> {
  const selected = new Set(tables);
  const foreignKeys = await db.query<Row & { child: string; parent: string }>(
    `SELECT child.relname AS child, parent.relname AS parent
     FROM pg_constraint c
     JOIN pg_class child ON child.oid = c.conrelid
     JOIN pg_class parent ON parent.oid = c.confrelid
     JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE c.contype = 'f' AND n.nspname = 'public'`,
  );

  const dependents = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const table of tables) {
    dependents.set(table, new Set());
    indegree.set(table, 0);
  }
  for (const fk of foreignKeys.rows) {
    // Self references are safe inside one INSERT statement and must not create a cycle.
    if (fk.child === fk.parent || !selected.has(fk.child) || !selected.has(fk.parent)) continue;
    const children = dependents.get(fk.parent);
    if (!children || children.has(fk.child)) continue;
    children.add(fk.child);
    indegree.set(fk.child, (indegree.get(fk.child) ?? 0) + 1);
  }

  const ready = tables.filter((table) => indegree.get(table) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const table = ready.shift();
    if (!table) break;
    order.push(table);
    for (const child of [...(dependents.get(table) ?? [])].sort()) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }

  if (order.length !== tables.length) {
    const remaining = tables.filter((table) => !order.includes(table)).sort();
    throw new Error(`تعذر ترتيب الجداول بسبب دورة مفاتيح أجنبية: ${remaining.join(", ")}`);
  }
  return order;
}

export async function readManifest(exportDir: string): Promise<TransferManifest> {
  const raw = await readFile(path.join(exportDir, "manifest.json"), "utf8");
  const parsed = JSON.parse(raw) as Partial<TransferManifest>;
  if (parsed.format !== TRANSFER_FORMAT || parsed.version !== TRANSFER_VERSION) {
    throw new Error("ملف التصدير غير متوافق مع هذه النسخة من أداة النقل.");
  }
  if (!Array.isArray(parsed.tables) || !Array.isArray(parsed.sequences)) {
    throw new Error("بيان التصدير تالف: قوائم الجداول أو السلاسل مفقودة.");
  }
  if (parsed.skippedTables?.some((table) => !SKIPPED_TABLES.has(table))) {
    throw new Error("بيان التصدير يعلن تخطي جداول غير مسموح بها.");
  }

  const seen = new Set<string>();
  for (const table of parsed.tables) {
    assertSafeIdentifier(table.name);
    if (SKIPPED_TABLES.has(table.name)) throw new Error(`الجدول ${table.name} يجب ألا يكون داخل التصدير.`);
    if (seen.has(table.name)) throw new Error(`جدول مكرر في البيان: ${table.name}`);
    if (!Number.isInteger(table.rowCount) || table.rowCount < 0) {
      throw new Error(`عدد صفوف غير صالح للجدول ${table.name}.`);
    }
    if (!/^[a-f0-9]{64}$/.test(table.sha256)) {
      throw new Error(`بصمة غير صالحة للجدول ${table.name}.`);
    }
    seen.add(table.name);
  }
  for (const sequence of parsed.sequences) {
    assertSafeIdentifier(sequence.name);
    if (!/^\d+$/.test(sequence.lastValue)) {
      throw new Error(`قيمة تسلسل غير صالحة: ${sequence.name}`);
    }
  }

  return parsed as TransferManifest;
}

export async function loadAndVerifyTables(exportDir: string, manifest: TransferManifest): Promise<LoadedTable[]> {
  const loaded: LoadedTable[] = [];
  for (const table of manifest.tables) {
    const content = await readFile(path.join(exportDir, `${table.name}.ndjson`), "utf8");
    if (sha256(content) !== table.sha256) {
      throw new Error(`فشل التحقق من بصمة الجدول ${table.name}. أعد إنشاء التصدير.`);
    }
    const rowCount = content.length === 0 ? 0 : content.split(/\r?\n/).filter((line) => line.length > 0).length;
    if (rowCount !== table.rowCount) {
      throw new Error(`عدد صفوف ${table.name} لا يطابق البيان (${rowCount} بدل ${table.rowCount}).`);
    }
    loaded.push({ name: table.name, rowCount, content });
  }
  return loaded;
}
