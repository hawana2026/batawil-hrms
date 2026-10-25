import {
  alertBox,
  api,
  avatar,
  confirmDialog,
  el,
  formatDate,
  formatDateTime,
  formatNumber,
  formatRelative,
  icon,
  pageHeader,
  setButtonLoading,
  showPasswordToggle,
  toast,
} from "../core.js";
import { logout, logoutEverywhere } from "../session.js";
import { state, permissionLabel } from "../state.js";
import { friendlyError, pageEnter, userStatus } from "../ui.js";

function passwordField({ id, label, autocomplete, hint = "" }) {
  const input = el("input", {
    class: "input",
    id,
    name: id,
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

function permissionTags(user) {
  if (user.role.allPermissions) {
    return el(
      "div",
      { class: "permission-chips" },
      el("span", { class: "tag purple" }, icon("shield-check"), "كل صلاحيات النظام"),
    );
  }
  const permissions = Array.isArray(user.permissions) ? user.permissions : [];
  if (permissions.length === 0) {
    return el("div", { class: "permission-chips" }, el("span", { class: "tag", text: "لا توجد صلاحيات إدارية إضافية" }));
  }
  return el(
    "div",
    { class: "permission-chips" },
    permissions.map((permission) =>
      el("span", { class: "tag", title: permission, text: permissionLabel(permission) }),
    ),
  );
}

function profileCard(user) {
  const status = userStatus(user);
  const branchesText = user.allBranches
    ? "كل الفروع"
    : Array.isArray(user.branches) && user.branches.length > 0
      ? user.branches.map((branch) => branch.name).join("، ")
      : "بدون فروع";
  const card = el(
    "div",
    { class: "card profile-card" },
    el(
      "div",
      { class: "profile-head" },
      avatar(user.fullName, "lg"),
      el(
        "div",
        {},
        el("h2", { text: user.fullName }),
        el("p", { dir: "ltr", text: user.username }),
        user.email ? el("p", { dir: "ltr", text: user.email }) : null,
      ),
    ),
    el(
      "div",
      { class: "profile-rows" },
      el("div", { class: "profile-row" }, el("span", { text: "الدور" }), el("span", { text: user.role.nameAr })),
      el("div", { class: "profile-row" }, el("span", { text: "الحالة" }), el("span", {}, status.label)),
      el("div", { class: "profile-row" }, el("span", { text: "نطاق الفروع" }), el("span", { text: branchesText })),
      el("div", { class: "profile-row" }, el("span", { text: "آخر دخول" }), el("span", { text: formatRelative(user.lastLoginAt) })),
      el("div", { class: "profile-row" }, el("span", { text: "تاريخ إنشاء الحساب" }), el("span", { text: formatDate(user.createdAt) })),
    ),
    el("div", { class: "section-label", style: "margin-top:20px" }, "الصلاحيات الفعلية"),
    permissionTags(user),
    el(
      "div",
      { class: "profile-actions" },
      el(
        "button",
        { class: "btn btn-secondary", type: "button", onclick: () => logout() },
        icon("logout"),
        "تسجيل الخروج",
      ),
    ),
  );
  return card;
}

function securityCard(host, token) {
  const minLength = state.meta?.passwordMinLength ?? state.status?.passwordMinLength ?? 10;
  const current = passwordField({ id: "current-password", label: "كلمة المرور الحالية", autocomplete: "current-password" });
  const next = passwordField({
    id: "new-password",
    label: "كلمة المرور الجديدة",
    autocomplete: "new-password",
    hint: "ستُنهي العملية جميع جلساتك الأخرى وتُبقي هذه الجلسة فقط.",
  });
  const confirm = passwordField({ id: "confirm-password", label: "تأكيد كلمة المرور الجديدة", autocomplete: "new-password" });
  const errorHost = el("div");

  const form = el(
    "form",
    { class: "security-form", novalidate: true },
    current.group,
    next.group,
    el(
      "div",
      { class: "password-requirements" },
      el("span", { class: "requirement" }, icon("check"), `${formatNumber(minLength)} أحرف على الأقل`),
      el("span", { class: "requirement" }, icon("check"), "حرف ورقم"),
      el("span", { class: "requirement" }, icon("check"), "ليست كلمة المرور الحالية"),
    ),
    confirm.group,
    errorHost,
    el(
      "div",
      { class: "form-actions" },
      el("button", { class: "btn btn-primary", type: "submit" }, icon("shield-check"), "تحديث كلمة المرور"),
    ),
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorHost.replaceChildren();
    if (!current.input.value || !next.input.value) {
      errorHost.append(alertBox("أدخل كلمة المرور الحالية والجديدة.", "error"));
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
    const button = form.querySelector('button[type="submit"]');
    setButtonLoading(button, true, "جارٍ التحديث…");
    try {
      const data = await api("/api/auth/change-password", {
        method: "POST",
        body: { currentPassword: current.input.value, newPassword: next.input.value },
      });
      state.user = data.user;
      state.session = data.session;
      toast("تم تحديث كلمة المرور وإنهاء الجلسات الأخرى.", "success");
      await renderAccount(host, token);
    } catch (error) {
      errorHost.append(alertBox(friendlyError(error), "error"));
      setButtonLoading(button, false);
    }
  });

  return el(
    "div",
    { class: "card security-card" },
    el("h3", { text: "تغيير كلمة المرور" }),
    el("p", {
      text: "اختر كلمة مرور قوية لا تستخدمها في خدمات أخرى. سيتم إنهاء جميع الجلسات الأخرى فوراً بعد التغيير.",
    }),
    form,
  );
}

function sessionCard() {
  const session = state.session;
  const remember = Boolean(session?.remember);
  return el(
    "div",
    { class: "card security-card" },
    el(
      "div",
      { class: "card-head", style: "padding:0;border:0;margin-bottom:2px" },
      el(
        "div",
        {},
        el("h3", { class: "card-title", text: "الجلسة الحالية" }),
        el("div", { class: "card-subtitle", text: "بيانات الاتصال النشط لهذا المتصفح" }),
      ),
      el("span", { class: "status-badge status-success" }, icon("circle-check", "icon icon-xs"), el("span", { text: "نشطة" })),
    ),
    el(
      "div",
      { class: "session-info" },
      el(
        "div",
        { class: "session-info-row" },
        el("span", { text: "نوع الجلسة" }),
        el("strong", { text: remember ? "جلسة ممتدة" : "جلسة قياسية" }),
      ),
      el(
        "div",
        { class: "session-info-row" },
        el("span", { text: "تنتهي عند عدم النشاط" }),
        el("strong", { text: session?.expiresAt ? formatDateTime(session.expiresAt) : "—" }),
      ),
      el(
        "div",
        { class: "session-info-row" },
        el("span", { text: "الحد الأقصى للجلسة" }),
        el("strong", { text: session?.absoluteExpiresAt ? formatDateTime(session.absoluteExpiresAt) : "—" }),
      ),
      el(
        "div",
        { class: "session-info-row" },
        el("span", { text: "آخر دخول" }),
        el("strong", { text: formatRelative(state.user.lastLoginAt) }),
      ),
    ),
    el(
      "div",
      { class: "form-note", style: "margin-top:14px" },
      icon("info"),
      el("span", { text: "الجلسات تُحفظ على الخادم فقط، ولا تُخزن كلمة المرور أو رمز الجلسة في المتصفح." }),
    ),
    el(
      "div",
      { class: "profile-actions" },
      el(
        "button",
        {
          class: "btn btn-danger",
          type: "button",
          onclick: async () => {
            const confirmed = await confirmDialog({
              title: "إنهاء جميع الجلسات",
              message: "سيتم تسجيل الخروج من جميع الأجهزة، بما فيها هذا الجهاز. ستحتاج إلى إدخال كلمة المرور مجدداً.",
              confirmLabel: "إنهاء جميع الجلسات",
              danger: true,
            });
            if (!confirmed) return;
            try {
              await logoutEverywhere();
            } catch (error) {
              toast(friendlyError(error), "error");
            }
          },
        },
        icon("refresh"),
        "إنهاء جميع الجلسات",
      ),
    ),
  );
}

export async function renderAccount(host, token) {
  const user = state.user;
  if (!user) return;
  const node = pageEnter(
    pageHeader({
      title: "الحساب والأمان",
      subtitle: "بيانات حسابك وصلاحياتك وإدارة أمان الجلسة الحالية.",
    }),
  );
  const grid = el(
    "div",
    { class: "account-grid" },
    profileCard(user),
    el("div", { style: "display:grid;gap:18px" }, securityCard(host, token), sessionCard()),
  );
  node.append(grid);
  if (token !== state.renderToken) return;
  host.replaceChildren(node);
}
