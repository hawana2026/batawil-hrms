import type { ErrorRequestHandler, Request } from "express";
import { ZodError, type ZodType } from "zod";
import type { Logger } from "../logger.js";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function unauthorized(message = "يجب تسجيل الدخول للمتابعة."): ApiError {
  return new ApiError(401, "UNAUTHENTICATED", message);
}

export function forbidden(message = "ليست لديك الصلاحية لتنفيذ هذا الإجراء."): ApiError {
  return new ApiError(403, "FORBIDDEN", message);
}

export function notFound(message = "العنصر المطلوب غير موجود."): ApiError {
  return new ApiError(404, "NOT_FOUND", message);
}

export function conflict(message: string, details?: unknown): ApiError {
  return new ApiError(409, "CONFLICT", message, details);
}

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const fields: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "form";
    fields[key] ??= issue.message;
  }
  throw new ApiError(400, "VALIDATION_ERROR", "تحقق من البيانات المدخلة.", { fields });
}

export function requestIp(req: Request): string {
  return (req.ip ?? "").slice(0, 100);
}

export function requestUserAgent(req: Request): string {
  return (req.get("user-agent") ?? "").slice(0, 400);
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error, _req, res, _next) => {
    if (res.headersSent) return;
    if (error instanceof ApiError) {
      res.status(error.status).json({
        error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
      });
      return;
    }
    if (error instanceof ZodError) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "تحقق من البيانات المدخلة.",
          details: { fields: Object.fromEntries(error.issues.map((issue) => [issue.path.join("."), issue.message])) },
        },
      });
      return;
    }
    const type = (error as { type?: string }).type;
    if (type === "entity.parse.failed") {
      res.status(400).json({ error: { code: "INVALID_JSON", message: "صيغة الطلب غير صالحة." } });
      return;
    }
    if (type === "entity.too.large") {
      res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "حجم الطلب أكبر من الحد المسموح." } });
      return;
    }
    const pgCode = (error as { code?: string }).code;
    if (pgCode === "23505") {
      res.status(409).json({ error: { code: "DUPLICATE", message: "توجد قيمة مكررة تمنع حفظ البيانات." } });
      return;
    }
    if (pgCode === "23503") {
      res.status(409).json({ error: { code: "REFERENCE_ERROR", message: "العنصر مرتبط ببيانات أخرى ولا يمكن إتمام العملية." } });
      return;
    }
    logger.error("Unhandled request error", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "حدث خطأ غير متوقع. حاول لاحقاً." } });
  };
}
