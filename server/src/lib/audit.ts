import type { Db } from "../db/index.js";
import type { Logger } from "../logger.js";

export type AuditSeverity = "info" | "warning" | "critical";

export interface AuditActor {
  id: string | null;
  username: string;
}

export interface AuditEvent {
  action: string;
  actor: AuditActor;
  entityType?: string;
  entityId?: string;
  branchId?: string | null;
  severity?: AuditSeverity;
  details?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

export async function writeAudit(db: Db, logger: Logger, event: AuditEvent): Promise<void> {
  try {
    await db.query(
      `INSERT INTO audit_logs
        (actor_user_id, actor_username, action, entity_type, entity_id, branch_id, severity, details, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
      [
        event.actor.id,
        event.actor.username.slice(0, 100),
        event.action,
        event.entityType ?? "",
        event.entityId ?? "",
        event.branchId ?? null,
        event.severity ?? "info",
        JSON.stringify(event.details ?? {}),
        (event.ip ?? "").slice(0, 100),
        (event.userAgent ?? "").slice(0, 400),
      ],
    );
  } catch (error) {
    logger.error("Failed to write audit log", {
      action: event.action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
