import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Row } from "../db/index.js";
import { hasPermission } from "../auth/types.js";
import { writeAudit } from "../lib/audit.js";
import { conflict, forbidden, notFound, parseBody, requestIp, requestUserAgent, unauthorized } from "../lib/errors.js";
import { branchScopeSql, canAccessBranch } from "../services/access.js";
import { APPROVAL_LABEL } from "../services/approvals.js";
import {
  decideAdvance,
  decideAttendanceDay,
  decideAttendanceMonth,
  decideLeave,
  decideNewHire,
  decideTransfer,
  type DecisionOutcome,
} from "../services/decisions.js";
import { createRequireAuth, createRequirePermission, requirePasswordReady, type AuthDeps } from "../middleware/auth.js";

const listQuerySchema = z.object({
  type: z.enum(["all", "attendance_day", "attendance_month", "leave", "advance", "transfer", "new_hire"]).default("all"),
  branchId: z.string().trim().max(64).default(""),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const rejectSchema = z.object({ reason: z.string().trim().min(3, "سبب الرفض أو الإعادة مطلوب.").max(1000) });

interface ApprovalRow extends Row {
  id: string;
  entity_type: string;
  entity_id: string;
  branch_id: string | null;
  branch_name: string | null;
  title: string;
  summary: string;
  status: string;
  requested_by: string | null;
  requester_name: string | null;
  requested_at: string | Date;
  decided_by: string | null;
  decider_name: string | null;
  decided_at: string | Date | null;
  decision_note: string | null;
}

const ENTITY_TABLE: Record<string, string> = {
  leave: "leave_requests",
  advance: "advance_requests",
  transfer: "employee_transfers",
  new_hire: "new_employee_requests",
};

function canDecide(actor: Parameters<typeof hasPermission>[0], type: string, stage?: string): boolean {
  if (type === "attendance_day" || type === "attendance_month") return hasPermission(actor, "attendance.approve");
  if (type === "leave") return hasPermission(actor, "leaves.approve");
  if (type === "transfer") return hasPermission(actor, "transfers.approve");
  if (type === "new_hire") return hasPermission(actor, "new_hires.approve");
  if (type === "advance") {
    return stage === "pending_finance" ? hasPermission(actor, "advances.approve_finance") : hasPermission(actor, "advances.approve_hr");
  }
  return false;
}

function stageLabel(type: string, stage?: string): string | null {
  if (type !== "advance") return null;
  return stage === "pending_finance" ? "بانتظار اعتماد المالية" : "بانتظار اعتماد الموارد البشرية";
}

export function createApprovalsRouter(deps: AuthDeps): Router {
  const { db, logger } = deps;
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);
  const requireView = createRequirePermission("approvals.view", deps);

  const loadHistory = async (entityId: string) => {
    const result = await db.query<Row & { action: string; actor_username: string; severity: string; details: unknown; created_at: string | Date }>(
      `SELECT action, actor_username, severity, details, created_at FROM audit_logs
       WHERE entity_id = $1 ORDER BY created_at DESC, id DESC LIMIT 40`,
      [entityId],
    );
    return result.rows.map((row) => ({
      action: row.action,
      actor: row.actor_username,
      severity: row.severity,
      details: row.details,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  };

  const loadEntityDetails = async (row: ApprovalRow) => {
    if (row.entity_type === "attendance_day") {
      const result = await db.query(
        `SELECT s.work_date::text AS work_date, s.status, s.notes, s.rejection_reason,
                (SELECT count(*)::int FROM daily_attendance d WHERE d.submission_id = s.id) AS row_count,
                (SELECT count(*)::int FROM daily_attendance d WHERE d.submission_id = s.id AND d.status IN ('absent')) AS absent_count
         FROM attendance_submissions s WHERE s.id = $1`,
        [row.entity_id],
      );
      return result.rows[0] ?? null;
    }
    if (row.entity_type === "attendance_month") {
      const result = await db.query(
        `SELECT year, month, status, notes, missing_days_confirmed, rejection_reason FROM monthly_attendance WHERE id = $1`,
        [row.entity_id],
      );
      return result.rows[0] ?? null;
    }
    if (row.entity_type === "leave") {
      const result = await db.query(
        `SELECT l.leave_type, l.start_date::text AS start_date, l.end_date::text AS end_date, l.days, l.reason, l.notes, l.status,
                e.full_name AS employee_name, e.employee_no
         FROM leave_requests l JOIN employees e ON e.id = l.employee_id WHERE l.id = $1`,
        [row.entity_id],
      );
      return result.rows[0] ?? null;
    }
    if (row.entity_type === "advance") {
      const result = await db.query(
        `SELECT a.amount, a.reason, a.notes, a.request_date::text AS request_date, a.installments, a.deduction_method, a.status,
                e.full_name AS employee_name, e.employee_no,
                COALESCE((SELECT sum(t.amount) FROM advance_transactions t WHERE t.advance_id = a.id AND t.type='deduction'), 0) AS deducted,
                COALESCE((SELECT sum(t.amount) FROM advance_transactions t WHERE t.advance_id = a.id AND t.type='disbursement'), 0) AS disbursed
         FROM advance_requests a JOIN employees e ON e.id = a.employee_id WHERE a.id = $1`,
        [row.entity_id],
      );
      return result.rows[0] ?? null;
    }
    if (row.entity_type === "transfer") {
      const result = await db.query(
        `SELECT e.full_name AS employee_name, e.employee_no, fb.name AS from_branch, tb.name AS to_branch,
                fd.name AS from_department, td.name AS to_department, t.effective_date::text AS effective_date,
                t.reason, t.notes, t.status
         FROM employee_transfers t
         JOIN employees e ON e.id = t.employee_id
         JOIN branches fb ON fb.id = t.from_branch_id
         JOIN branches tb ON tb.id = t.to_branch_id
         LEFT JOIN departments fd ON fd.id = t.from_department_id
         LEFT JOIN departments td ON td.id = t.to_department_id
         WHERE t.id = $1`,
        [row.entity_id],
      );
      return result.rows[0] ?? null;
    }
    if (row.entity_type === "new_hire") {
      const result = await db.query(
        `SELECT full_name, phone, job_title, proposed_salary, start_date::text AS start_date, notes, status
         FROM new_employee_requests WHERE id = $1`,
        [row.entity_id],
      );
      return result.rows[0] ?? null;
    }
    return null;
  };

  router.get("/", requireView, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const query = parseBody(listQuerySchema, req.query);
    const scope = branchScopeSql(actor, "ar", 1);
    const params: unknown[] = [...scope.params];
    const where = [scope.sql, "ar.status = 'pending'"];
    if (query.type !== "all") {
      params.push(query.type);
      where.push(`ar.entity_type = $${params.length}`);
    }
    if (query.branchId) {
      params.push(query.branchId);
      where.push(`ar.branch_id = $${params.length}::uuid`);
    }
    const result = await db.query<ApprovalRow>(
      `SELECT ar.id, ar.entity_type, ar.entity_id, ar.branch_id, b.name AS branch_name, ar.title, ar.summary, ar.status,
              ar.requested_by, ru.full_name AS requester_name, ar.requested_at,
              ar.decided_by, du.full_name AS decider_name, ar.decided_at, ar.decision_note
       FROM approval_requests ar
       LEFT JOIN branches b ON b.id = ar.branch_id
       LEFT JOIN users ru ON ru.id = ar.requested_by
       LEFT JOIN users du ON du.id = ar.decided_by
       WHERE ${where.join(" AND ")}
       ORDER BY ar.requested_at ASC
       LIMIT 1000`,
      params,
    );
    const advanceIds = result.rows.filter((row) => row.entity_type === "advance").map((row) => row.entity_id);
    const advanceStages = advanceIds.length
      ? await db.query<Row & { id: string; status: string }>("SELECT id, status FROM advance_requests WHERE id = ANY($1::uuid[])", [advanceIds])
      : { rows: [] as Array<Row & { id: string; status: string }> };
    const stageById = new Map(advanceStages.rows.map((row) => [row.id, row.status]));
    const items = result.rows.map((row) => {
      const stage = row.entity_type === "advance" ? stageById.get(row.entity_id) : undefined;
      return {
        id: row.id,
        entityType: row.entity_type,
        entityLabel: APPROVAL_LABEL[row.entity_type as keyof typeof APPROVAL_LABEL] ?? row.entity_type,
        entityId: row.entity_id,
        branchId: row.branch_id,
        branchName: row.branch_name,
        title: row.title,
        summary: row.summary,
        requestedBy: row.requester_name,
        requestedAt: new Date(row.requested_at).toISOString(),
        stage: stage ?? null,
        stageLabel: stageLabel(row.entity_type, stage),
        canDecide: canDecide(actor, row.entity_type, stage),
        decisionUrl:
          row.entity_type === "attendance_day"
            ? `#/attendance/daily?branch=${row.branch_id ?? ""}`
            : row.entity_type === "attendance_month"
              ? "#/attendance/follow-up"
              : row.entity_type === "leave"
                ? "#/leaves"
                : row.entity_type === "advance"
                  ? "#/advances"
                  : row.entity_type === "transfer"
                    ? "#/transfers"
                    : "#/new-hires",
      };
    });
    const counts = items.reduce<Record<string, number>>((acc, item) => {
      acc[item.entityType] = (acc[item.entityType] ?? 0) + 1;
      return acc;
    }, {});
    const start = (query.page - 1) * query.pageSize;
    res.json({
      items: items.slice(start, start + query.pageSize),
      total: items.length,
      page: query.page,
      pageSize: query.pageSize,
      counts,
    });
  });

  router.get("/:id", requireView, async (req, res) => {
    if (!req.auth) throw unauthorized();
    const id = z.uuid("معرّف اعتماد غير صالح.").parse(req.params.id);
    const result = await db.query<ApprovalRow>(
      `SELECT ar.id, ar.entity_type, ar.entity_id, ar.branch_id, b.name AS branch_name, ar.title, ar.summary, ar.status,
              ar.requested_by, ru.full_name AS requester_name, ar.requested_at,
              ar.decided_by, du.full_name AS decider_name, ar.decided_at, ar.decision_note
       FROM approval_requests ar
       LEFT JOIN branches b ON b.id = ar.branch_id
       LEFT JOIN users ru ON ru.id = ar.requested_by
       LEFT JOIN users du ON du.id = ar.decided_by
       WHERE ar.id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) throw notFound("عنصر الاعتماد غير موجود.");
    if (row.branch_id && !canAccessBranch(req.auth.user, row.branch_id)) throw notFound("العنصر خارج نطاق صلاحيتك.");
    let stage: string | undefined;
    if (row.entity_type === "advance") {
      const advance = await db.query<Row & { status: string }>("SELECT status FROM advance_requests WHERE id = $1", [row.entity_id]);
      stage = advance.rows[0]?.status;
    }
    const ownerType = row.entity_type === "new_hire" ? "new_hire" : row.entity_type;
    const attachments = ENTITY_TABLE[row.entity_type]
      ? await db.query<Row & { id: string; file_name: string; mime_type: string; size_bytes: number; created_at: string | Date; uploader_name: string | null }>(
          `SELECT a.id, a.file_name, a.mime_type, a.size_bytes, a.created_at, u.full_name AS uploader_name
           FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
           WHERE a.owner_type = $1 AND a.owner_id = $2 ORDER BY a.created_at DESC`,
          [ownerType, row.entity_id],
        )
      : { rows: [] as Array<Row & { id: string; file_name: string; mime_type: string; size_bytes: number; created_at: string | Date; uploader_name: string | null }> };
    res.json({
      item: {
        id: row.id,
        entityType: row.entity_type,
        entityLabel: APPROVAL_LABEL[row.entity_type as keyof typeof APPROVAL_LABEL] ?? row.entity_type,
        entityId: row.entity_id,
        branchId: row.branch_id,
        branchName: row.branch_name,
        title: row.title,
        summary: row.summary,
        status: row.status,
        requestedBy: row.requester_name,
        requestedAt: new Date(row.requested_at).toISOString(),
        decidedBy: row.decider_name,
        decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
        decisionNote: row.decision_note,
        stage: stage ?? null,
        stageLabel: stageLabel(row.entity_type, stage),
        canDecide: row.status === "pending" && canDecide(req.auth.user, row.entity_type, stage),
        details: await loadEntityDetails(row),
      },
      attachments: attachments.rows.map((attachment) => ({
        id: attachment.id,
        fileName: attachment.file_name,
        mimeType: attachment.mime_type,
        sizeBytes: attachment.size_bytes,
        uploadedBy: attachment.uploader_name,
        createdAt: new Date(attachment.created_at).toISOString(),
      })),
      history: await loadHistory(row.entity_id),
    });
  });

  const decide = async (req: Request, res: Response, decision: "approved" | "rejected") => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const approvalId = z.uuid("معرّف اعتماد غير صالح.").parse(req.params.id);
    const note = decision === "rejected" ? parseBody(rejectSchema, req.body).reason : String(req.body?.reason ?? "").trim();
    const result = await db.query<ApprovalRow>(
      `SELECT ar.*, b.name AS branch_name FROM approval_requests ar LEFT JOIN branches b ON b.id = ar.branch_id WHERE ar.id = $1`,
      [approvalId],
    );
    const approval = result.rows[0];
    if (!approval) throw notFound("عنصر الاعتماد غير موجود.");
    if (approval.status !== "pending") throw conflict("تمت معالجة هذا العنصر مسبقاً.");
    if (approval.branch_id && !canAccessBranch(actor, approval.branch_id)) throw forbidden("العنصر خارج نطاق صلاحيتك.");

    let outcome: DecisionOutcome;
    if (approval.entity_type === "attendance_day") {
      if (!hasPermission(actor, "attendance.approve")) throw forbidden();
      outcome = await decideAttendanceDay(db, actor, approval.entity_id, decision, note);
    } else if (approval.entity_type === "attendance_month") {
      if (!hasPermission(actor, "attendance.approve")) throw forbidden();
      outcome = await decideAttendanceMonth(db, actor, approval.entity_id, decision, note);
    } else if (approval.entity_type === "leave") {
      if (!hasPermission(actor, "leaves.approve")) throw forbidden();
      outcome = await decideLeave(db, actor, approval.entity_id, decision, note);
    } else if (approval.entity_type === "transfer") {
      if (!hasPermission(actor, "transfers.approve")) throw forbidden();
      outcome = await decideTransfer(db, actor, approval.entity_id, decision, note);
    } else if (approval.entity_type === "new_hire") {
      if (!hasPermission(actor, "new_hires.approve")) throw forbidden();
      outcome = await decideNewHire(db, actor, approval.entity_id, decision, note);
    } else if (approval.entity_type === "advance") {
      const canHr = hasPermission(actor, "advances.approve_hr");
      const canFinance = hasPermission(actor, "advances.approve_finance");
      if (!canHr && !canFinance) throw forbidden();
      outcome = await decideAdvance(db, actor, approval.entity_id, decision, note, { canHr, canFinance });
    } else {
      throw conflict("نوع الاعتماد غير مدعوم.");
    }
    await writeAudit(db, logger, {
      action: outcome.action,
      actor: { id: actor.id, username: actor.username },
      entityType: approval.entity_type,
      entityId: approval.entity_id,
      branchId: outcome.branchId,
      severity: decision === "rejected" ? "warning" : "info",
      details: { ...outcome.details, viaApprovalsInbox: true, approvalId },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    if (approval.entity_type === "advance" && decision === "approved" && outcome.details.stage === "hr") {
      res.json({ ok: true, stage: "pending_finance" });
      return;
    }
    res.json({ ok: true });
  };

  router.post("/:id/approve", requireView, (req, res) => decide(req, res, "approved"));
  router.post("/:id/reject", requireView, (req, res) => decide(req, res, "rejected"));

  return router;
}
