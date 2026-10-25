import type { Db, Row } from "../db/index.js";

export interface CompanySettings {
  name: string;
  currency: string;
  printFooter: string;
}

export interface AttendanceSettings {
  workStart: string;
  workEnd: string;
  lateGraceMinutes: number;
  weekendDays: number[];
}

export const DEFAULT_COMPANY: CompanySettings = {
  name: "BATAWIL",
  currency: "YER",
  printFooter: "نظام الموارد البشرية BATAWIL",
};

export const DEFAULT_ATTENDANCE: AttendanceSettings = {
  workStart: "08:00",
  workEnd: "16:00",
  lateGraceMinutes: 10,
  weekendDays: [5, 6],
};

function mergeSettings<T extends object>(fallback: T, value: unknown): T {
  if (!value || typeof value !== "object") return { ...fallback };
  return { ...fallback, ...(value as Partial<T>) };
}

export async function getSettings(db: Db): Promise<{ company: CompanySettings; attendance: AttendanceSettings }> {
  const result = await db.query<Row & { key: string; value: unknown }>("SELECT key, value FROM system_settings");
  const map = new Map(result.rows.map((row) => [row.key, row.value]));
  return {
    company: mergeSettings(DEFAULT_COMPANY, map.get("company")),
    attendance: mergeSettings(DEFAULT_ATTENDANCE, map.get("attendance")),
  };
}

export function minutesFromTime(value: string): number {
  const [hours, minutes] = value.split(":").map((part) => Number(part));
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

export function isWeekend(date: string, weekendDays: number[]): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekendDays.includes(day);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function dateOnly(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function monthRange(year: number, month: number): { start: string; end: string; days: number } {
  const days = daysInMonth(year, month);
  return { start: dateOnly(year, month, 1), end: dateOnly(year, month, days), days };
}
