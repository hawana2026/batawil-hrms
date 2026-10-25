import path from "node:path";
import { z } from "zod";

export type NodeEnv = "development" | "test" | "production";

export interface AppConfig {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  port: number;
  publicOrigin: string;
  allowedOrigins: string[];
  trustProxy: boolean;
  migrationsDir: string;
  db: {
    driver: "pglite" | "postgres";
    pgliteDir: string;
    databaseUrl: string | null;
    ssl: "disable" | "require" | "no-verify";
  };
  session: {
    cookieName: string;
    idleMinutes: number;
    absoluteHours: number;
    rememberDays: number;
    secure: boolean;
  };
  security: {
    maxLoginAttempts: number;
    lockMinutes: number;
    maxIpFailures: number;
    ipWindowMinutes: number;
  };
  setup: {
    username: string;
    fullName: string;
    email: string | null;
    password: string | null;
  };
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_ORIGIN: z.string().url().optional(),
  DB_DRIVER: z.enum(["pglite", "postgres"]).default("pglite"),
  PGLITE_DIR: z.string().default("./.data/pglite"),
  DATABASE_URL: z.string().optional(),
  DATABASE_SSL: z.enum(["disable", "require", "no-verify"]).default("disable"),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(1440).default(45),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(720).default(12),
  SESSION_REMEMBER_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  TRUST_PROXY: z.enum(["0", "1"]).default("0"),
  MIGRATIONS_DIR: z.string().optional(),
  ADMIN_USERNAME: z.string().default("admin"),
  ADMIN_FULL_NAME: z.string().default("مدير النظام"),
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
});

export function loadEnvFileIfPresent(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`إعدادات البيئة غير صالحة: ${details}`);
  }
  const value = parsed.data;
  const isProduction = value.NODE_ENV === "production";

  if (isProduction && value.DB_DRIVER !== "postgres") {
    throw new Error("في بيئة الإنتاج يجب استخدام DB_DRIVER=postgres وقاعدة بيانات PostgreSQL مُدارة.");
  }
  if (value.DB_DRIVER === "postgres" && !value.DATABASE_URL) {
    throw new Error("DATABASE_URL مطلوب عند استخدام DB_DRIVER=postgres.");
  }
  const fallbackOrigin = env.RENDER_EXTERNAL_URL?.trim() || "http://localhost:3000";
  const publicUrl = new URL(value.PUBLIC_ORIGIN ?? fallbackOrigin);
  if (isProduction && publicUrl.protocol !== "https:") {
    throw new Error("يجب أن يكون عنوان الموقع العام (PUBLIC_ORIGIN أو RENDER_EXTERNAL_URL) https:// في بيئة الإنتاج.");
  }
  const allowedOrigins = new Set<string>([publicUrl.origin]);
  if (!isProduction) {
    const port = value.PORT;
    allowedOrigins.add(`http://localhost:${port}`);
    allowedOrigins.add(`http://127.0.0.1:${port}`);
  }

  return {
    nodeEnv: value.NODE_ENV,
    isProduction,
    port: value.PORT,
    publicOrigin: publicUrl.origin,
    allowedOrigins: [...allowedOrigins],
    trustProxy: value.TRUST_PROXY === "1",
    migrationsDir: path.resolve(process.cwd(), value.MIGRATIONS_DIR ?? "migrations"),
    db: {
      driver: value.DB_DRIVER,
      pgliteDir: value.PGLITE_DIR,
      databaseUrl: value.DATABASE_URL ?? null,
      ssl: value.DATABASE_SSL,
    },
    session: {
      cookieName: "batawil_session",
      idleMinutes: value.SESSION_IDLE_MINUTES,
      absoluteHours: value.SESSION_ABSOLUTE_HOURS,
      rememberDays: value.SESSION_REMEMBER_DAYS,
      secure: publicUrl.protocol === "https:",
    },
    security: {
      maxLoginAttempts: 5,
      lockMinutes: 15,
      maxIpFailures: 30,
      ipWindowMinutes: 15,
    },
    setup: {
      username: value.ADMIN_USERNAME,
      fullName: value.ADMIN_FULL_NAME,
      email: value.ADMIN_EMAIL?.trim() || null,
      password: value.ADMIN_PASSWORD || null,
    },
  };
}

export function loadConfigForCli(): AppConfig {
  loadEnvFileIfPresent();
  return loadConfig();
}
