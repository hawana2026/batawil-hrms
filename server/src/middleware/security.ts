import type { RequestHandler } from "express";
import type { AppConfig } from "../config.js";
import { ApiError } from "../lib/errors.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function createOriginGuard(config: AppConfig): RequestHandler {
  return (req, _res, next) => {
    if (!MUTATING_METHODS.has(req.method)) {
      next();
      return;
    }
    const origin = req.get("origin");
    if (origin) {
      if (!config.allowedOrigins.includes(origin)) {
        throw new ApiError(403, "CSRF_BLOCKED", "طلب غير مصرح به من مصدر خارجي.");
      }
      next();
      return;
    }
    if (req.get("x-requested-with") !== "XMLHttpRequest") {
      throw new ApiError(403, "CSRF_BLOCKED", "طلب غير مصرح به. أعد تحميل الصفحة وحاول مجدداً.");
    }
    next();
  };
}
