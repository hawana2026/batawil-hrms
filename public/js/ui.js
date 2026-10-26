import { ApiError, el, errorFields, formatDate, formatNumber, icon, statusBadge } from "./core.js";

export function friendlyError(error) {
  const message = error instanceof Error && error.message ? error.message : "تعذر إكمال العملية.";
  if (!(error instanceof ApiError)) return "تعذر الاتصال بالخادم. تحقق من الشبكة وحاول مجدداً.";
  const fields = errorFields(error);
  const extras = [...new Set(Object.values(fields).filter((value) => typeof value === "string" && value && !message.includes(value)))];
  if (extras.length === 0) return message;
  return `${message} ${extras.slice(0, 3).join(" ")}`;
}

export function pageEnter(...children) {
  const node = el("div", { class: "page-enter" });
  node.append(...children.flat().filter(Boolean));
  return node;
}

export function metricCard({ iconName, tone = "blue", value, label, note = "" }) {
  return el(
    "div",
    { class: "card metric-card" },
    el(
      "div",
      { class: "metric-top" },
      el("span", { class: `metric-icon ${tone}` }, icon(iconName)),
      el("span", { class: "metric-trend" }, el("i", { class: `severity-dot ${tone === "green" ? "" : ""}` }), "مباشر"),
    ),
    el("div", { class: "metric-value num", text: formatNumber(value) }),
    el("div", { class: "metric-label", text: label }),
    note ? el("div", { class: "metric-note", text: note }) : null,
  );
}

export function userStatus(user) {
  if (!user.active) return { label: "معطل", tone: "danger", iconName: "circle-x" };
  if (user.isLocked) return { label: "مقفل مؤقتاً", tone: "warning", iconName: "lock" };
  if (user.mustChangePassword) return { label: "كلمة مرور مؤقتة", tone: "info", iconName: "key" };
  return { label: "نشط", tone: "success", iconName: "circle-check" };
}

export function branchScopeTags(user, max = 2) {
  if (user.allBranches) return [el("span", { class: "tag brand" }, icon("globe"), "كل الفروع")];
  const branches = Array.isArray(user.branches) ? user.branches : [];
  if (branches.length === 0) return [el("span", { class: "tag", text: "بدون فروع" })];
  const shown = branches.slice(0, max).map((branch) => el("span", { class: "tag", title: branch.name, text: branch.name }));
  if (branches.length > max) {
    shown.push(el("span", { class: "tag", title: branches.map((branch) => branch.name).join("، "), text: `+${formatNumber(branches.length - max)}` }));
  }
  return shown;
}

export function tablePagination({ page, pageSize, total, onPage }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  const previous = el(
    "button",
    {
      class: "btn btn-secondary btn-sm",
      type: "button",
      disabled: page <= 1,
      onclick: () => onPage(page - 1),
    },
    icon("chevron-right"),
    "السابق",
  );
  const next = el(
    "button",
    {
      class: "btn btn-secondary btn-sm",
      type: "button",
      disabled: page >= totalPages,
      onclick: () => onPage(page + 1),
    },
    "التالي",
    icon("chevron-left"),
  );
  return el(
    "div",
    { class: "pagination" },
    el("span", { class: "pagination-info", text: `عرض ${formatNumber(start)}–${formatNumber(end)} من ${formatNumber(total)}` }),
    el(
      "div",
      { class: "pagination-actions" },
      previous,
      el("span", { class: "page-indicator", text: `الصفحة ${formatNumber(page)} من ${formatNumber(totalPages)}` }),
      next,
    ),
  );
}

export function actionButton(iconName, label, onClick, { danger = false, disabled = false } = {}) {
  return el(
    "button",
    {
      class: `icon-btn${danger ? " danger" : ""}`,
      type: "button",
      title: label,
      "aria-label": label,
      disabled,
      onclick: onClick,
    },
    icon(iconName),
  );
}

const ACTION_LABELS = {
  "auth.login": "تسجيل دخول ناجح",
  "auth.logout": "تسجيل خروج",
  "auth.logout_all": "إنهاء جميع الجلسات",
  "auth.login_failed": "فشل تسجيل دخول",
  "auth.account_locked": "قفل حساب مؤقتاً",
  "auth.login_blocked": "محاولة دخول إلى حساب مقفل",
  "auth.password_changed": "تغيير كلمة المرور",
  "auth.password_change_failed": "فشل تغيير كلمة المرور",
  "user.created": "إنشاء مستخدم",
  "user.updated": "تحديث مستخدم",
  "user.activated": "تفعيل مستخدم",
  "user.deactivated": "تعطيل مستخدم",
  "user.password_reset": "إعادة تعيين كلمة المرور",
  "user.sessions_revoked": "إنهاء جلسات مستخدم",
  "branch.created": "إنشاء فرع",
  "branch.updated": "تحديث فرع",
  "branch.activated": "تفعيل فرع",
  "branch.deactivated": "تعطيل فرع",
  "leave.deleted": "حذف طلب إجازة نهائيًا",
  "advance.deleted": "حذف طلب سلفة نهائيًا",
  "transfer.deleted": "حذف طلب تحويل نهائيًا",
  "new_hire.deleted": "حذف طلب توظيف نهائيًا",
  "attendance_daily.deleted": "حذف كشف تحضير يومي",
  "attendance_monthly.deleted": "حذف كشف تحضير شهري",
  "employee.deleted": "حذف موظف نهائيًا",
  "department.deleted": "حذف قسم نهائيًا",
  "branch.deleted": "حذف فرع نهائيًا",
  "payroll.deleted": "حذف سجل راتب نهائيًا",
  "user.deleted": "حذف مستخدم نهائيًا",
  "security.permission_denied": "محاولة وصول مرفوضة",
  "setup.admin_created": "تهيئة مدير النظام",
};

export function auditActionLabel(action) {
  return ACTION_LABELS[action] ?? action;
}

export function severityBadge(severity) {
  if (severity === "critical") return statusBadge("حرجة", "danger", "alert-triangle");
  if (severity === "warning") return statusBadge("تحذيرية", "warning", "alert-triangle");
  return statusBadge("معلوماتية", "neutral", "info");
}

const REASON_LABELS = {
  unknown_user: "مستخدم غير معروف",
  invalid_password: "كلمة مرور خاطئة",
  account_locked: "الحساب مقفل",
  account_disabled: "الحساب معطل",
  invalid_current_password: "كلمة المرور الحالية خاطئة",
};

export function auditSummary(details) {
  if (!details || typeof details !== "object") return "—";
  const parts = [];
  if (details.username) parts.push(`المستخدم: ${details.username}`);
  if (details.permission) parts.push(`الصلاحية: ${details.permission}`);
  if (details.permissions && Array.isArray(details.permissions) && details.permissions.length > 0) {
    parts.push(`الصلاحيات: ${details.permissions.join("، ")}`);
  }
  if (details.reason) parts.push(`السبب: ${REASON_LABELS[details.reason] ?? details.reason}`);
  if (details.changes && typeof details.changes === "object") {
    const keys = Object.keys(details.changes);
    if (keys.length > 0) parts.push(`الحقول المتغيرة: ${keys.join("، ")}`);
  }
  if (details.employeeName) parts.push(`الموظف: ${details.employeeName}${details.employeeNo ? ` (${details.employeeNo})` : ""}`);
  if (details.fullName && !details.employeeName) parts.push(`الاسم: ${details.fullName}`);
  if (details.name) parts.push(`الاسم: ${details.name}`);
  if (details.workDate) parts.push(`التاريخ: ${details.workDate}`);
  if (details.year && details.month) parts.push(`الشهر: ${details.month}/${details.year}`);
  if (details.roleKey) parts.push(`الدور: ${details.roleKey}`);
  if (details.code) parts.push(`الرمز: ${details.code}`);
  if (details.branches && Array.isArray(details.branches) && details.branches.length > 0) {
    parts.push(`الفروع: ${details.branches.join("، ")}`);
  }
  if (typeof details.remember === "boolean") parts.push(details.remember ? "جلسة ممتدة" : "جلسة قياسية");
  if (details.sessionsRevoked === true) parts.push("تم إنهاء الجلسات الأخرى");
  if (Number.isInteger(details.attempts)) parts.push(`المحاولات: ${details.attempts}`);
  if (parts.length === 0) {
    const keys = Object.keys(details).filter((key) => ["from", "to", "newRole"].includes(key) === false);
    if (keys.length === 0) return "—";
    return keys.slice(0, 3).join("، ");
  }
  return parts.join(" • ");
}

export function statusFromScope(branch) {
  return branch.active ? statusBadge("نشط", "success", "circle-check") : statusBadge("معطل", "danger", "circle-x");
}

export function dateText(value) {
  return value ? formatDate(value) : "—";
}
