import path from "node:path";
import type { Express } from "express";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createDb, type Db, type Row } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { createLogger, silentLogger } from "../src/logger.js";
import { hashPassword } from "../src/auth/password.js";
import { newId } from "../src/lib/ids.js";

export const XHR_HEADER = "XMLHttpRequest";
export type TestAgent = ReturnType<typeof request.agent>;

export interface TestContext {
  db: Db;
  app: Express;
  config: AppConfig;
}

export async function createTestContext(): Promise<TestContext> {
  const logger = process.env.TEST_LOG === "1" ? createLogger({ production: false }) : silentLogger;
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "3000",
    PUBLIC_ORIGIN: "http://localhost:3000",
    PGLITE_DIR: ":memory:",
  });
  const db = await createDb(config.db, logger);
  await runMigrations(db, config.migrationsDir, logger);
  const app = createApp({ db, config, logger }, { publicDir: path.resolve(process.cwd(), "public") });
  return { db, app, config };
}

export interface TestBranch {
  id: string;
  code: string;
  name: string;
}

export async function createBranch(db: Db, code: string, name: string, city = ""): Promise<TestBranch> {
  const id = newId();
  await db.query("INSERT INTO branches (id, code, name, city) VALUES ($1, $2, $3, $4)", [id, code, name, city]);
  return { id, code, name };
}

export interface SeedUserOptions {
  username: string;
  password: string;
  roleKey: string;
  fullName?: string;
  email?: string;
  branchIds?: string[];
  allBranches?: boolean;
  mustChangePassword?: boolean;
  active?: boolean;
}

export interface SeededUser {
  id: string;
  username: string;
  password: string;
}

export async function seedUser(db: Db, options: SeedUserOptions): Promise<SeededUser> {
  const role = await db.query<Row & { id: string }>("SELECT id FROM roles WHERE key = $1", [options.roleKey]);
  const roleId = role.rows[0]?.id;
  if (!roleId) throw new Error(`Unknown role: ${options.roleKey}`);
  const id = newId();
  const passwordHash = await hashPassword(options.password);
  await db.query(
    `INSERT INTO users
      (id, username, full_name, email, password_hash, must_change_password, role_id, active, all_branches)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      options.username,
      options.fullName ?? options.username,
      options.email ?? null,
      passwordHash,
      options.mustChangePassword ?? false,
      roleId,
      options.active ?? true,
      options.allBranches ?? false,
    ],
  );
  for (const branchId of options.branchIds ?? []) {
    await db.query("INSERT INTO user_branch_access (user_id, branch_id) VALUES ($1, $2)", [id, branchId]);
  }
  return { id, username: options.username, password: options.password };
}

export async function login(app: Express, username: string, password: string, remember = false) {
  const agent = request.agent(app);
  const response = await agent
    .post("/api/auth/login")
    .set("X-Requested-With", XHR_HEADER)
    .send({ username, password, remember });
  return { agent, response };
}

export async function loginAs(app: Express, username: string, password: string, remember = false): Promise<TestAgent> {
  const { agent, response } = await login(app, username, password, remember);
  if (response.status !== 200) {
    throw new Error(`Login failed for ${username}: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return agent;
}

export async function countAudit(db: Db, action: string): Promise<number> {
  const result = await db.query<Row & { count: number }>(
    "SELECT count(*)::int AS count FROM audit_logs WHERE action = $1",
    [action],
  );
  return result.rows[0]?.count ?? 0;
}

export function post(agent: TestAgent, url: string, body?: string | object) {
  return agent.post(url).set("X-Requested-With", XHR_HEADER).send(body);
}

export function patch(agent: TestAgent, url: string, body?: string | object) {
  return agent.patch(url).set("X-Requested-With", XHR_HEADER).send(body);
}

export function del(agent: TestAgent, url: string) {
  return agent.delete(url).set("X-Requested-With", XHR_HEADER);
}
