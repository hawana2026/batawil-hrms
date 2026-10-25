import { api, toast } from "./core.js";

export const ROUTES = [
  { id: "dashboard", title: "لوحة التحكم", group: "الرئيسية", icon: "dashboard", allowed: () => true },
  { id: "employees", title: "إدارة الموظفين", group: "الموارد البشرية", icon: "users", allowed: () => can("employees.view") },
  { id: "attendance-daily", title: "التحضير اليومي", group: "الحضور والإجازات", icon: "calendar-check", allowed: () => can("attendance.view") },
  { id: "attendance-monthly", title: "التحضير الشهري", group: "الحضور والإجازات", icon: "calendar-range", allowed: () => can("attendance.view") },
  { id: "attendance-reports", title: "الحضور والغياب", group: "الحضور والإجازات", icon: "activity", allowed: () => can("attendance.view") || can("reports.view") },
  { id: "leaves", title: "الإجازات والأذونات", group: "الحضور والإجازات", icon: "calendar", allowed: () => can("leaves.view") },
  { id: "advances", title: "السلف المالية", group: "العمليات", icon: "wallet", allowed: () => can("advances.view") },
  { id: "transfers", title: "التحويلات الوظيفية", group: "العمليات", icon: "arrow-left-right", allowed: () => can("transfers.view") },
  { id: "new-hires", title: "الموظفون الجدد", group: "العمليات", icon: "user-plus", allowed: () => can("new_hires.view") },
  { id: "payroll", title: "الرواتب وبيانات الاستحقاق", group: "الرواتب", icon: "banknote", allowed: () => can("payroll.view") },
  { id: "branches", title: "إدارة الفروع", group: "إدارة النظام", icon: "building", allowed: () => can("branches.view") },
  { id: "users", title: "المستخدمون", group: "إدارة النظام", icon: "shield-check", allowed: () => can("users.view") },
  { id: "roles", title: "الأدوار والصلاحيات", group: "إدارة النظام", icon: "shield", allowed: () => can("roles.view") || can("users.manage") },
  { id: "approvals", title: "الاعتمادات والطلبات", group: "الاعتماد والتقارير", icon: "inbox", allowed: () => can("approvals.view") },
  { id: "reports", title: "التقارير والطباعة", group: "الاعتماد والتقارير", icon: "file-text", allowed: () => can("reports.view") },
  { id: "audit", title: "سجل التدقيق", group: "المراجعة والنظام", icon: "scroll", allowed: () => can("audit.view") },
  { id: "account", title: "الحساب والأمان", group: "المراجعة والنظام", icon: "account", allowed: () => true },
  { id: "settings", title: "إعدادات النظام", group: "المراجعة والنظام", icon: "sliders", allowed: () => can("settings.view") },
];

export const ROUTE_ALIASES = {
  "attendance/daily": "attendance-daily",
  "attendance/monthly": "attendance-monthly",
  "attendance/follow-up": "attendance-monthly",
};

export const state = {
  screen: "boot",
  user: null,
  session: null,
  meta: null,
  status: null,
  route: null,
  renderToken: 0,
  users: {
    page: 1,
    pageSize: 20,
    total: 0,
    items: [],
    filters: { q: "", branchId: "", roleKey: "", status: "all" },
  },
  employees: {
    q: "",
    branchId: "",
    departmentId: "",
    status: "all",
    includeArchived: false,
    page: 1,
    pageSize: 20,
  },
  audit: {
    page: 1,
    pageSize: 50,
    total: 0,
    items: [],
    filters: { q: "", severity: "all", from: "", to: "" },
  },
};

export function can(permission) {
  const user = state.user;
  if (!user) return false;
  return Boolean(user.role?.allPermissions) || (Array.isArray(user.permissions) && user.permissions.includes(permission));
}

export function routeById(id) {
  return ROUTES.find((route) => route.id === id) ?? null;
}

export function routeAllowed(id) {
  const route = routeById(id);
  return Boolean(route && route.allowed());
}

export function defaultRoute() {
  return "dashboard";
}

export function currentHashRaw() {
  return window.location.hash.replace(/^#\/?/, "");
}

export function currentHashRoute() {
  const raw = currentHashRaw().split("?")[0];
  const id = ROUTE_ALIASES[raw] ?? raw;
  return routeById(id)?.id ?? null;
}

export function navigate(id) {
  if (!routeAllowed(id)) {
    toast("هذه الصفحة غير متاحة ضمن صلاحيات حسابك.", "warning");
    return;
  }
  if (window.location.hash === `#/${id}`) return;
  window.location.hash = `#/${id}`;
}

export async function refreshMeta() {
  state.meta = await api("/api/meta");
  return state.meta;
}

export function resetSessionState() {
  state.user = null;
  state.session = null;
  state.meta = null;
  state.route = null;
  state.users = {
    page: 1,
    pageSize: 20,
    total: 0,
    items: [],
    filters: { q: "", branchId: "", roleKey: "", status: "all" },
  };
  state.employees = {
    q: "",
    branchId: "",
    departmentId: "",
    status: "all",
    includeArchived: false,
    page: 1,
    pageSize: 20,
  };
  state.audit = {
    page: 1,
    pageSize: 50,
    total: 0,
    items: [],
    filters: { q: "", severity: "all", from: "", to: "" },
  };
}

export function endSession(notice = "") {
  resetSessionState();
  state.screen = "login";
  if (window.location.hash) {
    window.history.replaceState(null, "", window.location.pathname);
  }
  window.dispatchEvent(new CustomEvent("app:signed-out", { detail: { notice } }));
}

export function scopedBranches() {
  return state.meta?.branches ?? state.user?.branches ?? [];
}

export function availableRoles() {
  return state.meta?.roles ?? [];
}

export function branchName(branchId) {
  return scopedBranches().find((branch) => branch.id === branchId)?.name ?? "";
}

export function permissionLabel(permission) {
  const labels = {
    "users.view": "عرض المستخدمين",
    "users.manage": "إدارة المستخدمين",
    "branches.view": "عرض الفروع",
    "branches.manage": "إدارة الفروع",
    "roles.view": "عرض الأدوار",
    "audit.view": "عرض سجل التدقيق",
    "employees.view": "عرض الموظفين",
    "employees.manage": "إدارة الموظفين",
    "employees.import": "استيراد الموظفين",
    "employees.export": "تصدير الموظفين",
    "attendance.view": "عرض الحضور",
    "attendance.manage": "إدارة التحضير",
    "attendance.submit": "إرسال التحضير",
    "attendance.approve": "اعتماد التحضير",
    "attendance.correct": "تصحيح التحضير",
    "leaves.view": "عرض الإجازات",
    "leaves.manage": "إدارة الإجازات",
    "leaves.approve": "اعتماد الإجازات",
    "advances.view": "عرض السلف",
    "advances.manage": "إدارة السلف",
    "advances.approve_hr": "اعتماد السلف — الموارد البشرية",
    "advances.approve_finance": "اعتماد السلف — المالية",
    "advances.disburse": "صرف السلف والاستقطاعات",
    "transfers.view": "عرض التحويلات",
    "transfers.manage": "إدارة التحويلات",
    "transfers.approve": "اعتماد التحويلات",
    "new_hires.view": "عرض الموظفين الجدد",
    "new_hires.manage": "إدارة الموظفين الجدد",
    "new_hires.approve": "اعتماد الموظفين الجدد",
    "payroll.view": "عرض الرواتب",
    "payroll.manage": "إدارة الرواتب",
    "approvals.view": "عرض الاعتمادات",
    "reports.view": "عرض التقارير",
    "reports.export": "تصدير التقارير",
    "settings.view": "عرض الإعدادات",
    "settings.manage": "إدارة الإعدادات",
  };
  return labels[permission] ?? permission;
}
