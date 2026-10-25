import {
  ApiError,
  alertBox,
  api,
  avatar,
  el,
  errorBlock,
  formatFullDay,
  formatNumber,
  formatRelative,
  icon,
  loadingBlock,
  setButtonLoading,
  showPasswordToggle,
  toast,
} from "./core.js";
import {
  currentHashRoute,
  defaultRoute,
  endSession,
  navigate,
  refreshMeta,
  routeById,
  routeAllowed,
  ROUTES,
  state,
} from "./state.js";
import { logout } from "./session.js";
import { friendlyError } from "./ui.js";
import { renderAccount } from "./views/account.js";
import { renderAdvances } from "./views/advances.js";
import { renderApprovals } from "./views/approvals.js";
import { renderAttendanceDaily } from "./views/attendance-daily.js";
import { renderAttendanceMonthly } from "./views/attendance-monthly.js";
import { renderAttendanceReports } from "./views/attendance-reports.js";
import { renderAudit } from "./views/audit.js";
import { renderBranches } from "./views/branches.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderEmployees } from "./views/employees.js";
import { renderLeaves } from "./views/leaves.js";
import { renderNewHires } from "./views/new-hires.js";
import { renderPayroll } from "./views/payroll.js";
import { renderReports } from "./views/reports.js";
import { renderRoles } from "./views/roles.js";
import { renderSettings } from "./views/settings.js";
import { renderTransfers } from "./views/transfers.js";
import { renderUsers } from "./views/users.js";

const appRoot = document.getElementById("app");

const RENDERERS = {
  dashboard: renderDashboard,
  employees: renderEmployees,
  "attendance-daily": renderAttendanceDaily,
  "attendance-monthly": renderAttendanceMonthly,
  "attendance-reports": renderAttendanceReports,
  leaves: renderLeaves,
  advances: renderAdvances,
  transfers: renderTransfers,
  "new-hires": renderNewHires,
  payroll: renderPayroll,
  branches: renderBranches,
  users: renderUsers,
  roles: renderRoles,
  approvals: renderApprovals,
  reports: renderReports,
  audit: renderAudit,
  account: renderAccount,
  settings: renderSettings,
};

let currentShell = null;

function brandLockup() {
  return el(
    "div",
    { class: "brand-lockup" },
    el("span", { class: "brand-mark" }, icon("shield-check")),
    el(
      "span",
      { class: "brand-copy" },
      el("strong", { text: "BATAWIL" }),
      el("span", { text: "نظام الموارد البشرية" }),
    ),
  );
}

function brandAside() {
  const feature = (iconName, title, text) =>
    el(
      "div",
      { class: "auth-feature" },
      el("span", { class: "auth-feature-icon" }, icon(iconName)),
      el("span", {}, el("strong", { text: title }), el("span", { text })),
    );
  return el(
    "aside",
    { class: "auth-brand" },
    brandLockup(),
    el(
      "div",
      { class: "auth-hero" },
      el("span", { class: "auth-eyebrow" }, icon("shield-check"), "المرحلة الثانية · العمليات اليومية"),
      el("h1", {}, "نظام موارد بشرية مركزي،", el("br"), "بصلاحيات دقيقة."),
      el("p", {
        text: "أساس آمن لإدارة الحسابات والفروع والصلاحيات، بجلسات محمية وتدقيق كامل، قبل الانتقال إلى وحدات الموارد البشرية التشغيلية.",
      }),
      el(
        "div",
        { class: "auth-features" },
        feature("globe", "بيانات مركزية", "الحسابات والفروع في قاعدة بيانات واحدة، لا في متصفح الموظف."),
        feature("shield", "نطاق فروع صارم", "كل مستخدم يرى فقط ما تسمح به صلاحياته وفروعه."),
        feature("scroll", "تدقيق غير قابل للتعديل", "سجل مركزي لكل عملية حساسة ومحاولة وصول مرفوضة."),
      ),
    ),
    el(
      "div",
      { class: "auth-brand-foot" },
      el("span", { text: `© ${formatNumber(new Date().getFullYear())} BATAWIL — جميع الحقوق محفوظة` }),
      el("span", { class: "phase-pill" }, el("i"), "المرحلة الثانية"),
    ),
  );
}

function passwordInput({ id, name, label, autocomplete, hint = "" }) {
  const input = el("input", {
    class: "input",
    id,
    name,
    type: "password",
    required: true,
    autocomplete,
    dir: "ltr",
    maxlength: 128,
  });
  const toggle = el(
    "button",
    { class: "password-toggle", type: "button", "aria-label": "إظهار كلمة المرور" },
    icon("eye"),
  );
  showPasswordToggle(input, toggle);
  return {
    input,
    group: el(
      "div",
      { class: "form-field" },
      el("label", { class: "form-label", for: id, text: label }),
      el("div", { class: "password-wrap" }, input, toggle),
      hint ? el("span", { class: "form-hint", text: hint }) : null,
    ),
  };
}

function clearHash() {
  if (window.location.hash) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}

function closeAllModals() {
  document.querySelectorAll(".modal-overlay").forEach((overlay) => overlay.remove());
  document.body.classList.remove("modal-open");
}

function renderLogin(notice = "") {
  state.screen = "login";
  clearHash();
  closeAllModals();
  currentShell = null;
  document.title = "تسجيل الدخول — BATAWIL HRMS";

  const initialized = state.status?.initialized !== false;
  const errorHost = el("div");
  const username = el("input", {
    class: "input",
    id: "login-username",
    name: "username",
    placeholder: "اسم المستخدم",
    autocomplete: "username",
    dir: "ltr",
    required: true,
    maxlength: 32,
    disabled: !initialized,
  });
  const password = el("input", {
    class: "input",
    id: "login-password",
    name: "password",
    type: "password",
    placeholder: "كلمة المرور",
    autocomplete: "current-password",
    dir: "ltr",
    required: true,
    maxlength: 128,
    disabled: !initialized,
  });
  const passwordToggle = el(
    "button",
    { class: "password-toggle", type: "button", "aria-label": "إظهار كلمة المرور", disabled: !initialized },
    icon("eye"),
  );
  showPasswordToggle(password, passwordToggle);
  const remember = el("input", { type: "checkbox", id: "login-remember", disabled: !initialized });
  const submit = el(
    "button",
    { class: "btn btn-primary", type: "submit", disabled: !initialized },
    icon("log-in"),
    initialized ? "تسجيل الدخول" : "بانتظار تهيئة النظام",
  );

  const form = el(
    "form",
    { class: "auth-form", novalidate: true },
    notice ? alertBox(notice, "info") : null,
    errorHost,
    el(
      "div",
      { class: "form-field" },
      el("label", { class: "form-label", for: "login-username", text: "اسم المستخدم" }),
      username,
    ),
    el(
      "div",
      { class: "form-field" },
      el("label", { class: "form-label", for: "login-password", text: "كلمة المرور" }),
      el("div", { class: "password-wrap" }, password, passwordToggle),
    ),
    el(
      "div",
      { class: "auth-options" },
      el(
        "label",
        { class: "checkbox-row", style: "margin:0" },
        remember,
        el("span", { text: "إبقاء الجلسة على هذا الجهاز" }),
      ),
      el("span", { class: "tiny muted", text: "لا تستخدمه على أجهزة مشتركة" }),
    ),
    submit,
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorHost.replaceChildren();
    const usernameValue = username.value.trim().toLowerCase();
    if (!usernameValue || !password.value) {
      errorHost.append(alertBox("أدخل اسم المستخدم وكلمة المرور.", "error"));
      (!usernameValue ? username : password).focus();
      return;
    }
    setButtonLoading(submit, true, "جارٍ التحقق…");
    try {
      const data = await api("/api/auth/login", {
        method: "POST",
        body: { username: usernameValue, password: password.value, remember: remember.checked },
      });
      state.user = data.user;
      state.session = data.session;
      if (data.user.mustChangePassword) {
        renderForcedPassword();
        return;
      }
      await enterApp();
    } catch (error) {
      if (state.screen !== "login") return;
      errorHost.append(alertBox(friendlyError(error), "error"));
      setButtonLoading(submit, false);
      password.value = "";
      password.focus();
    }
  });

  const setupNote = initialized
    ? null
    : el(
        "div",
        { class: "setup-note" },
        icon("alert-triangle"),
        el(
          "div",
          {},
          el("strong", { text: "النظام بانتظار التهيئة الأولية" }),
          el(
            "p",
            {},
            "لم يُنشأ حساب مدير النظام بعد. نفّذ أمر التهيئة على الخادم ",
            el("code", { dir: "ltr", text: "npm run setup" }),
            " ثم أعد تحميل الصفحة. لا توجد أي بيانات دخول افتراضية.",
          ),
        ),
      );

  const page = el(
    "div",
    { class: "auth-page" },
    brandAside(),
    el(
      "div",
      { class: "auth-panel" },
      el(
        "div",
        { class: "auth-card" },
        el(
          "div",
          { class: "auth-mobile-brand" },
          el("span", { class: "brand-mark" }, icon("shield-check")),
          el(
            "span",
            { class: "brand-copy" },
            el("strong", { text: "BATAWIL" }),
            el("span", { text: "نظام الموارد البشرية" }),
          ),
        ),
        el(
          "div",
          { class: "auth-head" },
          el("h2", { text: "تسجيل الدخول" }),
          el("p", { text: "أدخل بيانات حسابك المؤسسي للمتابعة." }),
        ),
        setupNote,
        form,
        el(
          "div",
          { class: "auth-security-note" },
          icon("shield-check"),
          el("span", {
            text: "جلسات محمية على الخادم، ولا تُخزَّن كلمة المرور في المتصفح. تُسجَّل محاولات الدخول مركزياً.",
          }),
        ),
        el(
          "p",
          { class: "auth-footnote" },
          "لإعادة تعيين كلمة المرور، تواصل مع مدير النظام.",
        ),
      ),
    ),
  );

  appRoot.replaceChildren(page);
  if (initialized) username.focus();
}

function renderForcedPassword() {
  state.screen = "password";
  clearHash();
  closeAllModals();
  currentShell = null;
  document.title = "تحديث كلمة المرور — BATAWIL HRMS";
  const minLength = state.meta?.passwordMinLength ?? state.status?.passwordMinLength ?? 10;
  const user = state.user;
  if (!user) {
    renderLogin();
    return;
  }

  const current = passwordInput({
    id: "forced-current-password",
    name: "currentPassword",
    label: "كلمة المرور المؤقتة الحالية",
    autocomplete: "current-password",
  });
  const next = passwordInput({
    id: "forced-new-password",
    name: "newPassword",
    label: "كلمة المرور الجديدة",
    autocomplete: "new-password",
    hint: "ستُنهي العملية جميع الجلسات الأخرى وتُبقي هذه الجلسة فقط.",
  });
  const confirm = passwordInput({
    id: "forced-confirm-password",
    name: "confirmPassword",
    label: "تأكيد كلمة المرور الجديدة",
    autocomplete: "new-password",
  });
  const errorHost = el("div");
  const submit = el("button", { class: "btn btn-primary", type: "submit" }, icon("shield-check"), "تحديث كلمة المرور والمتابعة");

  const form = el(
    "form",
    { novalidate: true },
    current.group,
    next.group,
    el(
      "div",
      { class: "password-requirements" },
      el("span", { class: "requirement" }, icon("check"), `${formatNumber(minLength)} أحرف على الأقل`),
      el("span", { class: "requirement" }, icon("check"), "حرف ورقم"),
      el("span", { class: "requirement" }, icon("check"), "ليست الكلمة الحالية"),
    ),
    confirm.group,
    errorHost,
    el(
      "div",
      { class: "form-actions" },
      submit,
      el(
        "button",
        { class: "btn btn-ghost", type: "button", onclick: () => logout() },
        icon("logout"),
        "تسجيل الخروج",
      ),
    ),
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorHost.replaceChildren();
    if (!current.input.value || !next.input.value) {
      errorHost.append(alertBox("أدخل كلمة المرور المؤقتة وكلمة المرور الجديدة.", "error"));
      current.input.focus();
      return;
    }
    if (next.input.value.length < minLength) {
      errorHost.append(alertBox(`كلمة المرور الجديدة يجب ألا تقل عن ${formatNumber(minLength)} أحرف.`, "error"));
      next.input.focus();
      return;
    }
    if (next.input.value !== confirm.input.value) {
      errorHost.append(alertBox("تأكيد كلمة المرور لا يطابق الكلمة الجديدة.", "error"));
      confirm.input.focus();
      return;
    }
    setButtonLoading(submit, true, "جارٍ التحديث…");
    try {
      const data = await api("/api/auth/change-password", {
        method: "POST",
        body: { currentPassword: current.input.value, newPassword: next.input.value },
      });
      state.user = data.user;
      state.session = data.session;
      toast("تم تحديث كلمة المرور. يمكنك المتابعة الآن.", "success");
      await enterApp();
    } catch (error) {
      if (state.screen !== "password") return;
      errorHost.append(alertBox(friendlyError(error), "error"));
      setButtonLoading(submit, false);
    }
  });

  appRoot.replaceChildren(
    el(
      "div",
      { class: "center-page" },
      el(
        "div",
        { class: "center-card" },
        brandLockup(),
        el("span", { class: "tag brand" }, icon("account"), `${user.fullName} · ${user.username}`),
        el("h1", { class: "center-title", style: "margin-top:14px", text: "تحديث كلمة المرور مطلوب" }),
        el("p", {
          class: "center-subtitle",
          text: "تستخدم هذا الحساب كلمة مرور مؤقتة. اختر كلمة مرور شخصية جديدة قبل المتابعة إلى مساحة العمل.",
        }),
        form,
      ),
    ),
  );
  current.input.focus();
}

function renderBootScreen() {
  state.screen = "boot";
  currentShell = null;
  document.title = "BATAWIL HRMS — نظام الموارد البشرية";
  appRoot.replaceChildren(
    el(
      "div",
      { class: "center-page" },
      el(
        "div",
        { class: "center-card" },
        brandLockup(),
        loadingBlock("جارٍ التحقق من الاتصال والجلسة…"),
      ),
    ),
  );
}

function renderFatal(title, message, retry) {
  state.screen = "boot";
  currentShell = null;
  document.title = "تعذر تحميل النظام — BATAWIL HRMS";
  appRoot.replaceChildren(
    el(
      "div",
      { class: "center-page" },
      el(
        "div",
        { class: "center-card" },
        brandLockup(),
        el("h1", { class: "center-title", text: title }),
        el("p", { class: "center-subtitle", text: "تعذر إكمال تهيئة الواجهة. تحقق من تشغيل الخادم ثم أعد المحاولة." }),
        el("div", { style: "margin-top:18px" }, alertBox(message, "error")),
        el(
          "div",
          { class: "form-actions", style: "margin-top:18px" },
          el("button", { class: "btn btn-primary", type: "button", onclick: retry }, icon("refresh"), "إعادة المحاولة"),
        ),
      ),
    ),
  );
}

function buildNotificationsMenu() {
  const badge = el("span", { class: "notification-badge", hidden: true });
  const listHost = el("div", { class: "notification-list" }, el("span", { class: "tiny muted", text: "جارٍ التحميل…" }));
  const menu = el("details", { class: "user-menu notifications-menu" });
  const summary = el("summary", { "aria-label": "الإشعارات" }, icon("bell"), badge);
  let loaded = false;

  async function refreshCount() {
    try {
      const result = await api("/api/notifications/unread-count");
      badge.hidden = !result.unread;
      badge.textContent = result.unread > 99 ? "99+" : String(result.unread);
    } catch {
      /* notifications are non-critical */
    }
  }

  async function load() {
    listHost.replaceChildren(el("span", { class: "tiny muted", text: "جارٍ التحميل…" }));
    try {
      const result = await api("/api/notifications?limit=30");
      badge.hidden = !result.unread;
      badge.textContent = result.unread > 99 ? "99+" : String(result.unread);
      if (!result.items.length) {
        listHost.replaceChildren(el("div", { class: "empty-notify" }, icon("bell"), el("span", { text: "لا توجد إشعارات." })));
        return;
      }
      listHost.replaceChildren(
        ...result.items.map((item) =>
          el(
            "button",
            {
              class: `notification-item ${item.read ? "" : "unread"}`.trim(),
              type: "button",
              onclick: async () => {
                menu.open = false;
                if (!item.read) {
                  try {
                    await api(`/api/notifications/${item.id}/read`, { method: "POST", body: {} });
                    await refreshCount();
                  } catch {
                    /* ignore */
                  }
                }
                if (item.link) {
                  const target = item.link.startsWith("#") ? item.link.slice(1) : item.link;
                  if (window.location.hash === target) window.dispatchEvent(new HashChangeEvent("hashchange"));
                  else window.location.hash = target;
                }
              },
            },
            el("strong", { text: item.title }),
            el("span", { text: item.body }),
            el("small", { text: formatRelative(item.createdAt) }),
          ),
        ),
      );
    } catch {
      listHost.replaceChildren(el("span", { class: "tiny muted", text: "تعذر تحميل الإشعارات." }));
    }
  }

  const markAll = el(
    "button",
    {
      class: "btn btn-ghost btn-sm",
      type: "button",
      onclick: async () => {
        try {
          await api("/api/notifications/read-all", { method: "POST", body: {} });
          toast("تم تعليم جميع الإشعارات كمقروءة.", "success");
          await load();
        } catch {
          toast("تعذر تحديث الإشعارات.", "error");
        }
      },
    },
    "تعليم الكل كمقروء",
  );

  menu.append(summary, el("div", { class: "notification-pop" }, el("div", { class: "notification-head" }, el("strong", { text: "الإشعارات" }), markAll), listHost));
  menu.addEventListener("toggle", () => {
    if (menu.open && !loaded) {
      loaded = true;
      load();
    }
  });
  refreshCount();
  const interval = window.setInterval(() => {
    if (state.screen !== "app") {
      window.clearInterval(interval);
      return;
    }
    if (!menu.open) refreshCount();
  }, 60_000);
  return menu;
}

function startShell() {
  if (!state.user || state.screen !== "app") return;
  const user = state.user;

  const pageHost = el("main", { class: "page", id: "page-content", tabindex: "-1" });
  const pageTitle = el("div", { class: "topbar-title" });
  const eyebrow = el("span", { class: "topbar-eyebrow" });
  const navButtons = [];

  const navGroups = new Map();
  for (const route of ROUTES) {
    if (!route.allowed()) continue;
    const list = navGroups.get(route.group) ?? [];
    list.push(route);
    navGroups.set(route.group, list);
  }
  const nav = el("nav", { class: "sidebar-nav", "aria-label": "التنقل الرئيسي" });
  for (const [group, routes] of navGroups) {
    nav.append(el("div", { class: "nav-group-label", text: group }));
    for (const route of routes) {
      const button = el(
        "button",
        {
          class: "nav-item",
          type: "button",
          dataset: { route: route.id },
          onclick: () => {
            navigate(route.id);
            closeSidebar();
          },
        },
        icon(route.icon),
        el("span", { text: route.title }),
      );
      navButtons.push(button);
      nav.append(button);
    }
  }

  const sidebar = el(
    "aside",
    { class: "sidebar", id: "sidebar" },
    el(
      "div",
      { class: "sidebar-brand" },
      el("span", { class: "brand-mark" }, icon("shield-check")),
      el(
        "span",
        { class: "brand-copy" },
        el("strong", { text: "BATAWIL" }),
        el("span", { text: "نظام الموارد البشرية" }),
      ),
    ),
    nav,
    el(
      "div",
      { class: "sidebar-foot" },
      el(
        "div",
        { class: "sidebar-phase" },
        el("span", { text: "المرحلة الثانية" }),
        el("strong", { text: "العمليات اليومية" }),
      ),
    ),
  );

  const overlay = el("div", { class: "sidebar-overlay", id: "sidebar-overlay" });
  const setSidebar = (open) => {
    sidebar.classList.toggle("open", open);
    overlay.classList.toggle("show", open);
    menuButton.setAttribute("aria-expanded", String(open));
  };
  const closeSidebar = () => setSidebar(false);
  overlay.addEventListener("click", closeSidebar);

  const menuButton = el(
    "button",
    {
      class: "icon-btn menu-toggle",
      type: "button",
      "aria-label": "فتح القائمة",
      "aria-controls": "sidebar",
      "aria-expanded": "false",
      onclick: () => setSidebar(!sidebar.classList.contains("open")),
    },
    icon("menu"),
  );

  const userMenu = el("details", { class: "user-menu" });
  userMenu.append(
    el(
      "summary",
      { "aria-label": "قائمة الحساب" },
      avatar(user.fullName),
      el(
        "div",
        { class: "user-meta" },
        el("strong", { text: user.fullName }),
        el("span", { text: user.role.nameAr }),
      ),
      icon("chevron-down"),
    ),
    el(
      "div",
      { class: "user-dropdown" },
      el(
        "div",
        { class: "dropdown-head" },
        el("strong", { text: user.fullName }),
        el("span", { text: `${user.username}${user.email ? ` · ${user.email}` : ""}` }),
      ),
      el(
        "button",
        {
          class: "dropdown-item",
          type: "button",
          onclick: () => {
            userMenu.open = false;
            navigate("account");
          },
        },
        icon("account"),
        "الحساب والأمان",
      ),
      el(
        "button",
        {
          class: "dropdown-item danger",
          type: "button",
          onclick: async () => {
            userMenu.open = false;
            await logout();
          },
        },
        icon("logout"),
        "تسجيل الخروج",
      ),
    ),
  );

  const notificationsMenu = buildNotificationsMenu();

  const topbar = el(
    "header",
    { class: "topbar" },
    menuButton,
    el("div", { class: "topbar-titles" }, eyebrow, pageTitle),
    el(
      "div",
      { class: "topbar-end" },
      el("span", { class: "topbar-date" }, icon("calendar"), formatFullDay(new Date())),
      notificationsMenu,
      userMenu,
    ),
  );

  appRoot.replaceChildren(
    el(
      "div",
      { class: "app-shell" },
      sidebar,
      overlay,
      el("div", { class: "main-wrap" }, topbar, pageHost),
    ),
  );

  async function renderRoute() {
    if (state.screen !== "app" || !state.user) return;
    const requested = currentHashRoute();
    const route = requested && routeAllowed(requested) ? routeById(requested) : routeById(defaultRoute());
    if (!route) return;
    if (requested !== route.id) {
      window.history.replaceState(null, "", `#/${route.id}`);
    }
    state.route = route.id;
    closeSidebar();
    for (const button of navButtons) {
      const active = button.dataset.route === route.id;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    eyebrow.textContent = route.group;
    pageTitle.textContent = route.title;
    document.title = `${route.title} — BATAWIL HRMS`;
    const token = ++state.renderToken;
    pageHost.replaceChildren(loadingBlock("جارٍ تحميل الصفحة…"));
    try {
      await RENDERERS[route.id](pageHost, token);
    } catch (error) {
      if (token !== state.renderToken) return;
      pageHost.replaceChildren(errorBlock(friendlyError(error), () => renderRoute()));
    }
    if (token === state.renderToken) pageHost.focus({ preventScroll: true });
  }

  currentShell = { sidebar, overlay, pageHost, renderRoute, closeSidebar };
  renderRoute();
}

async function enterApp() {
  state.screen = "app";
  try {
    await refreshMeta();
  } catch (error) {
    if (state.screen !== "app") return;
    renderFatal("تعذر تحميل مساحة العمل", friendlyError(error), boot);
    return;
  }
  if (state.screen !== "app" || !state.user) return;
  startShell();
}

async function boot() {
  renderBootScreen();
  try {
    state.status = await api("/api/public/status");
  } catch (error) {
    renderFatal("تعذر الاتصال بالخادم", friendlyError(error), boot);
    return;
  }
  if (state.status?.initialized === false) {
    state.user = null;
    state.session = null;
    renderLogin();
    return;
  }
  try {
    const data = await api("/api/auth/session");
    state.user = data.user;
    state.session = data.session;
    if (data.user.mustChangePassword) {
      renderForcedPassword();
      return;
    }
    await enterApp();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      state.user = null;
      state.session = null;
      renderLogin();
      return;
    }
    renderFatal("تعذر التحقق من الجلسة", friendlyError(error), boot);
  }
}

window.addEventListener("hashchange", () => {
  if (state.screen === "app") currentShell?.renderRoute();
});

window.addEventListener("app:unauthorized", () => {
  if (state.screen === "login" || state.screen === "boot") return;
  endSession("انتهت جلسة الدخول أو تم إلغاؤها. سجّل الدخول من جديد.");
});

window.addEventListener("app:password-required", () => {
  if (state.screen === "app") renderForcedPassword();
});

window.addEventListener("app:signed-out", (event) => {
  currentShell = null;
  closeAllModals();
  renderLogin(event.detail?.notice ?? "");
});

document.addEventListener("click", (event) => {
  for (const menu of document.querySelectorAll("details.user-menu[open]")) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  currentShell?.closeSidebar();
  document.querySelectorAll("details.user-menu[open]").forEach((menu) => {
    menu.open = false;
  });
});

boot();
