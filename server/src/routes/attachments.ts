import { Router, raw } from "express";
import { z } from "zod";
import type { Db, Row } from "../db/index.js";
import type { AuthUser } from "../auth/types.js";
import { hasPermission } from "../auth/types.js";
import { writeAudit } from "../lib/audit.js";
import { ApiError, forbidden, notFound, parseBody, requestIp, requestUserAgent, unauthorized } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { isoDateSchema } from "../lib/hr-schemas.js";
import { canAccessBranch } from "../services/access.js";
import { writeEmployeeHistory } from "../services/employees.js";
import { createRequireAuth, requirePasswordReady, type AuthDeps } from "../middleware/auth.js";

const OWNER_TYPES = ["employee", "leave", "advance", "new_hire", "transfer"] as const;
type OwnerType = (typeof OWNER_TYPES)[number];

const ALLOWED_MIME = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream",
];

const OWNER_PERMISSIONS: Record<OwnerType, { view: string; manage: string; label: string }> = {
  employee: { view: "employees.view", manage: "employees.manage", label: "employee" },
  leave: { view: "leaves.view", manage: "leaves.manage", label: "leave" },
  advance: { view: "advances.view", manage: "advances.manage", label: "advance" },
  new_hire: { view: "new_hires.view", manage: "new_hires.manage", label: "new_hire" },
  transfer: { view: "transfers.view", manage: "transfers.manage", label: "transfer" },
};

const ownerQuerySchema = z.object({
  ownerType: z.enum(OWNER_TYPES),
  ownerId: z.uuid("معرّف العنصر غير صالح."),
});

const DOCUMENT_TYPES = ["contract", "national_id", "certificate", "medical", "other"] as const;
const documentTypeSchema = z.enum(DOCUMENT_TYPES);

const uploadQuerySchema = ownerQuerySchema.extend({
  fileName: z.string().trim().min(1).max(200).default("attachment"),
  title: z.string().trim().max(160).default(""),
  documentType: documentTypeSchema.default("other"),
  expiresAt: z.union([z.literal(""), isoDateSchema]).transform((value) => value || null).optional(),
});

const documentUpdateSchema = z.object({
  title: z.string().trim().max(160).optional(),
  documentType: documentTypeSchema.optional(),
  expiresAt: z.union([z.literal(""), isoDateSchema]).transform((value) => value || null).optional(),
});

interface AttachmentRow extends Row {
  id: string;
  owner_type: OwnerType;
  owner_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  title: string;
  document_type: string;
  expires_at: string | null;
  uploaded_by_name: string | null;
  created_at: string | Date;
}

function decodeFileName(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 200) || "attachment";
  } catch {
    return "attachment";
  }
}

async function resolveOwnerBranch(db: Db, actor: AuthUser, ownerType: OwnerType, ownerId: string): Promise<string | null> {
  let result;
  if (ownerType === "employee") {
    result = await db.query<Row & { branch_id: string }>("SELECT branch_id FROM employees WHERE id = $1", [ownerId]);
    if (!result.rows[0] || !canAccessBranch(actor, result.rows[0].branch_id)) throw notFound("الموظف غير موجود أو خارج نطاق صلاحيتك.");
    return result.rows[0].branch_id;
  }
  if (ownerType === "leave") {
    result = await db.query<Row & { branch_id: string }>("SELECT branch_id FROM leave_requests WHERE id = $1", [ownerId]);
    if (!result.rows[0] || !canAccessBranch(actor, result.rows[0].branch_id)) throw notFound("الطلب غير موجود أو خارج نطاق صلاحيتك.");
    return result.rows[0].branch_id;
  }
  if (ownerType === "advance") {
    result = await db.query<Row & { branch_id: string }>("SELECT branch_id FROM advance_requests WHERE id = $1", [ownerId]);
    if (!result.rows[0] || !canAccessBranch(actor, result.rows[0].branch_id)) throw notFound("الطلب غير موجود أو خارج نطاق صلاحيتك.");
    return result.rows[0].branch_id;
  }
  if (ownerType === "new_hire") {
    result = await db.query<Row & { branch_id: string }>("SELECT branch_id FROM new_employee_requests WHERE id = $1", [ownerId]);
    if (!result.rows[0] || !canAccessBranch(actor, result.rows[0].branch_id)) throw notFound("الطلب غير موجود أو خارج نطاق صلاحيتك.");
    return result.rows[0].branch_id;
  }
  result = await db.query<Row & { from_branch_id: string; to_branch_id: string }>(
    "SELECT from_branch_id, to_branch_id FROM employee_transfers WHERE id = $1",
    [ownerId],
  );
  const transfer = result.rows[0];
  if (!transfer || (!canAccessBranch(actor, transfer.from_branch_id) && !canAccessBranch(actor, transfer.to_branch_id))) {
    throw notFound("طلب التحويل غير موجود أو خارج نطاق صلاحيتك.");
  }
  return null;
}

function assertPermission(actor: AuthUser, ownerType: OwnerType, action: "view" | "manage"): void {
  if (!hasPermission(actor, OWNER_PERMISSIONS[ownerType][action])) throw forbidden();
}

async function assertOwnerAccess(
  db: Db,
  actor: AuthUser,
  ownerType: OwnerType,
  ownerId: string,
  action: "view" | "manage",
): Promise<string | null> {
  if (actor.employeeId) {
    if (ownerType === "leave") {
      const own = await db.query<Row & { employee_id: string; branch_id: string; status: string }>(
        "SELECT employee_id, branch_id, status FROM leave_requests WHERE id = $1",
        [ownerId],
      );
      const leave = own.rows[0];
      if (leave && leave.employee_id === actor.employeeId) {
        if (action === "manage" && leave.status !== "draft" && leave.status !== "rejected") {
          throw forbidden("لا يمكن تعديل مرفقات طلب أُرسل للاعتماد.");
        }
        return leave.branch_id;
      }
    }
    if (ownerType === "employee" && ownerId === actor.employeeId) {
      if (action === "manage") throw forbidden();
      const own = await db.query<Row & { branch_id: string }>("SELECT branch_id FROM employees WHERE id = $1", [ownerId]);
      if (own.rows[0]) return own.rows[0].branch_id;
    }
  }
  assertPermission(actor, ownerType, action);
  return resolveOwnerBranch(db, actor, ownerType, ownerId);
}

function presentAttachment(row: AttachmentRow) {
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    title: row.title,
    documentType: row.document_type,
    expiresAt: row.expires_at ?? null,
    uploadedBy: row.uploaded_by_name,
    createdAt: new Date(row.created_at).toISOString(),
    downloadUrl: `/api/attachments/${row.id}/download`,
  };
}

const DOCUMENT_TYPES_AR: Record<string, string> = {
  contract: "عقد",
  national_id: "هوية وطنية",
  certificate: "شهادة",
  medical: "تقرير طبي",
  other: "مستند آخر",
};

export function createAttachmentsRouter(deps: AuthDeps): Router {
  const { db, logger } = deps;
  const router = Router();
  router.use(createRequireAuth(deps), requirePasswordReady);

  router.get("/", async (req, res) => {
    if (!req.auth) throw unauthorized();
    const query = parseBody(ownerQuerySchema, req.query);
    await assertOwnerAccess(db, req.auth.user, query.ownerType, query.ownerId, "view");
    const result = await db.query<AttachmentRow>(
      `SELECT a.id, a.owner_type, a.owner_id, a.file_name, a.mime_type, a.size_bytes,
              a.title, a.document_type, a.expires_at::text AS expires_at,
              u.full_name AS uploaded_by_name, a.created_at
       FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
       WHERE a.owner_type = $1 AND a.owner_id = $2
       ORDER BY a.created_at DESC`,
      [query.ownerType, query.ownerId],
    );
    res.json({ items: result.rows.map(presentAttachment) });
  });

  router.get("/:id/download", async (req, res) => {
    if (!req.auth) throw unauthorized();
    const id = z.uuid("معرّف مرفق غير صالح.").parse(req.params.id);
    const result = await db.query<Row & { owner_type: OwnerType; owner_id: string; file_name: string; mime_type: string; content: Uint8Array | Buffer }>(
      "SELECT owner_type, owner_id, file_name, mime_type, content FROM attachments WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    if (!row) throw notFound("المرفق غير موجود.");
    await assertOwnerAccess(db, req.auth.user, row.owner_type, row.owner_id, "view");
    const content = Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content);
    res.setHeader("Content-Type", row.mime_type === "application/octet-stream" ? "application/octet-stream" : row.mime_type);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(row.file_name)}`);
    res.setHeader("Content-Length", String(content.length));
    res.setHeader("Cache-Control", "no-store");
    res.send(content);
  });

  router.post(
    "/",
    raw({ type: ALLOWED_MIME, limit: "2mb" }),
    async (req, res) => {
      if (!req.auth) throw unauthorized();
      const actor = req.auth.user;
      const query = parseBody(uploadQuerySchema, req.query);
      const branchId = await assertOwnerAccess(db, req.auth.user, query.ownerType, query.ownerId, "manage");
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new ApiError(400, "FILE_REQUIRED", "أرفق ملفاً صالحاً بحجم أقصى 2 ميجابايت.");
      }
      const mimeType = (req.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      if (!ALLOWED_MIME.includes(mimeType)) {
        throw new ApiError(400, "INVALID_FILE_TYPE", "نوع الملف غير مسموح. المسموح: PDF أو صورة أو Word أو Excel.");
      }
      if (req.body.length > 2 * 1024 * 1024) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "حجم الملف أكبر من 2 ميجابايت.");
      const count = await db.query<Row & { total: number }>(
        "SELECT count(*)::int AS total FROM attachments WHERE owner_type = $1 AND owner_id = $2",
        [query.ownerType, query.ownerId],
      );
      if ((count.rows[0]?.total ?? 0) >= 10) {
        throw new ApiError(400, "ATTACHMENT_LIMIT", "الحد الأقصى للمرفقات لكل عنصر هو 10 ملفات.");
      }
      const fileName = decodeFileName(query.fileName);
      const title = query.title || fileName;
      const id = newId();
      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO attachments (id, owner_type, owner_id, file_name, mime_type, size_bytes, content, uploaded_by, title, document_type, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, query.ownerType, query.ownerId, fileName, mimeType, req.body.length, req.body, actor.id, title, query.documentType, query.expiresAt ?? null],
        );
        if (query.ownerType === "employee") {
          await writeEmployeeHistory(tx, {
            employeeId: query.ownerId,
            changeType: "document_added",
            summary: `إضافة مستند: ${title}`,
            details: {
              attachmentId: id,
              fileName,
              documentType: query.documentType,
              expiresAt: query.expiresAt ?? null,
            },
            actorId: actor.id,
          });
        }
      });
      await writeAudit(db, logger, {
        action: "attachment.uploaded",
        actor: { id: actor.id, username: actor.username },
        entityType: query.ownerType,
        entityId: query.ownerId,
        branchId,
        severity: "info",
        details: { attachmentId: id, fileName, title, documentType: query.documentType, sizeBytes: req.body.length },
        ip: requestIp(req),
        userAgent: requestUserAgent(req),
      });
      res.status(201).json({ id, fileName, title, documentType: query.documentType, expiresAt: query.expiresAt ?? null, mimeType, sizeBytes: req.body.length });
    },
  );

  router.patch("/:id", async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const id = z.uuid("معرّف مرفق غير صالح.").parse(req.params.id);
    const input = parseBody(documentUpdateSchema, req.body);
    const result = await db.query<AttachmentRow>(
      `SELECT a.id, a.owner_type, a.owner_id, a.file_name, a.mime_type, a.size_bytes,
              a.title, a.document_type, a.expires_at::text AS expires_at,
              u.full_name AS uploaded_by_name, a.created_at
       FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
       WHERE a.id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) throw notFound("المرفق غير موجود.");
    const branchId = await assertOwnerAccess(db, actor, row.owner_type, row.owner_id, "manage");
    const next = {
      title: input.title ?? row.title,
      document_type: input.documentType ?? row.document_type,
      expires_at: input.expiresAt !== undefined ? (input.expiresAt ?? null) : row.expires_at,
    };
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (next.title !== row.title) changes["العنوان"] = { from: row.title, to: next.title };
    if (next.document_type !== row.document_type) {
      changes["نوع المستند"] = {
        from: DOCUMENT_TYPES_AR[row.document_type] ?? row.document_type,
        to: DOCUMENT_TYPES_AR[next.document_type] ?? next.document_type,
      };
    }
    if (String(next.expires_at ?? "") !== String(row.expires_at ?? "")) {
      changes["تاريخ الانتهاء"] = { from: row.expires_at ?? "—", to: next.expires_at ?? "—" };
    }
    if (Object.keys(changes).length === 0) throw new ApiError(400, "NO_CHANGES", "لا توجد تغييرات لحفظها.");
    await db.transaction(async (tx) => {
      await tx.query(
        "UPDATE attachments SET title = $2, document_type = $3, expires_at = $4 WHERE id = $1",
        [id, next.title, next.document_type, next.expires_at],
      );
      if (row.owner_type === "employee") {
        await writeEmployeeHistory(tx, {
          employeeId: row.owner_id,
          changeType: "document_updated",
          summary: `تحديث بيانات المستند: ${next.title || row.file_name}`,
          details: { attachmentId: id, fileName: row.file_name, changes },
          actorId: actor.id,
        });
      }
    });
    await writeAudit(db, logger, {
      action: "attachment.updated",
      actor: { id: actor.id, username: actor.username },
      entityType: row.owner_type,
      entityId: row.owner_id,
      branchId,
      severity: "info",
      details: { attachmentId: id, fileName: row.file_name, changes },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    const updated = await db.query<AttachmentRow>(
      `SELECT a.id, a.owner_type, a.owner_id, a.file_name, a.mime_type, a.size_bytes,
              a.title, a.document_type, a.expires_at::text AS expires_at,
              u.full_name AS uploaded_by_name, a.created_at
       FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
       WHERE a.id = $1`,
      [id],
    );
    const updatedRow = updated.rows[0];
    if (!updatedRow) throw notFound("المرفق غير موجود.");
    res.json({ attachment: presentAttachment(updatedRow) });
  });

  router.delete("/:id", async (req, res) => {
    if (!req.auth) throw unauthorized();
    const actor = req.auth.user;
    const id = z.uuid("معرّف مرفق غير صالح.").parse(req.params.id);
    const result = await db.query<Row & { owner_type: OwnerType; owner_id: string; file_name: string; title: string; document_type: string }>(
      "SELECT owner_type, owner_id, file_name, title, document_type FROM attachments WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    if (!row) throw notFound("المرفق غير موجود.");
    const branchId = await assertOwnerAccess(db, actor, row.owner_type, row.owner_id, "manage");
    await db.transaction(async (tx) => {
      await tx.query("DELETE FROM attachments WHERE id = $1", [id]);
      if (row.owner_type === "employee") {
        await writeEmployeeHistory(tx, {
          employeeId: row.owner_id,
          changeType: "document_deleted",
          summary: `حذف مستند: ${row.title || row.file_name}`,
          details: { attachmentId: id, fileName: row.file_name, documentType: row.document_type },
          actorId: actor.id,
        });
      }
    });
    await writeAudit(db, logger, {
      action: "attachment.deleted",
      actor: { id: actor.id, username: actor.username },
      entityType: row.owner_type,
      entityId: row.owner_id,
      branchId,
      severity: "warning",
      details: { attachmentId: id, fileName: row.file_name, title: row.title },
      ip: requestIp(req),
      userAgent: requestUserAgent(req),
    });
    res.json({ ok: true });
  });

  return router;
}
