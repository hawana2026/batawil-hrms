import { api, el, errorBlock, formatNumber, icon, loadingBlock, pageHeader } from "../core.js";
import { can, navigate, state } from "../state.js";
import { friendlyError, pageEnter } from "../ui.js";

function roleCard(role, permissionTotal) {
  const isCurrent = role.key === state.user?.role?.key;
  const granted = Array.isArray(role.permissionKeys) ? role.permissionKeys.length : 0;
  const scope = role.allPermissions ? "كل الصلاحيات" : `${formatNumber(granted)} من ${formatNumber(permissionTotal)}`;
  return el(
    "div",
    { class: `card role-card${isCurrent ? " current" : ""}` },
    el(
      "div",
      { class: "tag-row", style: "margin-top:0;margin-bottom:9px" },
      isCurrent ? el("span", { class: "tag brand" }, icon("check"), "دورك الحالي") : null,
      role.allPermissions
        ? el("span", { class: "tag purple" }, icon("shield-check"), "صلاحيات كاملة")
        : el("span", { class: "tag" }, icon("key"), `${formatNumber(granted)} صلاحية`),
    ),
    el("h3", { text: role.nameAr }),
    el("p", { text: role.descriptionAr || "دور نظامي ضمن المرحلة الأولى." }),
    el(
      "div",
      { class: "role-card-foot" },
      el("span", { class: "tiny muted", dir: "ltr", text: role.key }),
      el("span", { class: "tiny muted", text: scope }),
    ),
  );
}

function summaryStrip(roles, permissions) {
  const fullRoles = roles.filter((role) => role.allPermissions).length;
  const currentRole = roles.find((role) => role.key === state.user?.role?.key);
  return el(
    "div",
    { class: "summary-strip" },
    el(
      "div",
      { class: "summary-item" },
      el("span", { class: "metric-icon blue" }, icon("shield")),
      el("div", {}, el("strong", { class: "num", text: formatNumber(roles.length) }), el("span", { text: "أدوار نظامية" })),
    ),
    el(
      "div",
      { class: "summary-item" },
      el("span", { class: "metric-icon purple" }, icon("sliders")),
      el("div", {}, el("strong", { class: "num", text: formatNumber(permissions.length) }), el("span", { text: "صلاحيات معرّفة" })),
    ),
    el(
      "div",
      { class: "summary-item" },
      el("span", { class: "metric-icon green" }, icon("shield-check")),
      el("div", {}, el("strong", { class: "num", text: formatNumber(fullRoles) }), el("span", { text: "أدوار بصلاحيات كاملة" })),
    ),
    el(
      "div",
      { class: "summary-item" },
      el("span", { class: "metric-icon orange" }, icon("account")),
      el("div", {}, el("strong", { text: currentRole?.nameAr ?? "—" }), el("span", { text: "دورك الحالي" })),
    ),
  );
}

function permissionCell(granted, label) {
  return el(
    "td",
    { title: label },
    granted
      ? el("span", { class: "matrix-check", "aria-label": "ممنوحة" }, icon("check"))
      : el("span", { class: "matrix-none", "aria-label": "غير ممنوحة", text: "—" }),
  );
}

function matrixCard(roles, permissions) {
  const header = el(
    "tr",
    {},
    el("th", { scope: "col", text: "الصلاحية" }),
    roles.map((role) =>
      el(
        "th",
        { scope: "col" },
        el(
          "span",
          { class: "role-col-head" },
          role.nameAr,
          el("small", { dir: "ltr", text: role.allPermissions ? "ALL" : role.key }),
        ),
      ),
    ),
  );

  const body = permissions.map((permission) =>
    el(
      "tr",
      {},
      el(
        "td",
        {},
        el("strong", { class: "matrix-perm", text: permission.nameAr }),
        el("div", { class: "tiny muted", dir: "ltr", style: "text-align:start", text: permission.key }),
      ),
      roles.map((role) => {
        const granted = role.allPermissions || (Array.isArray(role.permissionKeys) && role.permissionKeys.includes(permission.key));
        return permissionCell(granted, `${role.nameAr}: ${permission.nameAr}`);
      }),
    ),
  );

  return el(
    "div",
    { class: "card table-card" },
    el(
      "div",
      { class: "card-head" },
      el(
        "div",
        {},
        el("h3", { class: "card-title", text: "مصفوفة الصلاحيات" }),
        el("div", { class: "card-subtitle", text: "ما يمكن لكل دور الوصول إليه ضمن وحدات المرحلة الأولى." }),
      ),
      el("span", { class: "tag", text: `${formatNumber(roles.length)} أدوار × ${formatNumber(permissions.length)} صلاحية` }),
    ),
    el("div", { class: "table-wrap matrix-wrap" }, el("table", { class: "matrix-table" }, el("thead", {}, header), el("tbody", {}, body))),
    el(
      "div",
      { class: "card-footer" },
      el("span", {}, icon("lock", "icon icon-xs"), " عرض مرجعي — تُدار الأدوار النظامية ضمن تهيئة المرحلة الأولى."),
    ),
  );
}

export async function renderRoles(host, token) {
  const node = pageEnter(
    pageHeader({
      title: "الأدوار والصلاحيات",
      subtitle: "الصلاحيات الفعلية لكل دور، ونطاق الوصول الممنوح لحسابك.",
      actions: [
        el("button", { class: "btn btn-secondary", type: "button", onclick: () => load() }, icon("refresh"), "تحديث"),
        can("users.manage")
          ? el("button", { class: "btn btn-primary", type: "button", onclick: () => navigate("users") }, icon("users"), "إدارة المستخدمين")
          : null,
      ].filter(Boolean),
    }),
  );
  const contentHost = el("div");
  node.append(contentHost);
  host.replaceChildren(node);

  async function load() {
    contentHost.replaceChildren(loadingBlock("جارٍ تحميل الأدوار والصلاحيات…"));
    try {
      const data = await api("/api/roles");
      if (token !== state.renderToken) return;
      contentHost.replaceChildren(
        el(
          "div",
          { class: "readonly-banner" },
          icon("info"),
          el(
            "div",
            {},
            el("strong", { text: "أدوار المرحلة الأولى ثابتة ومُدققة" }),
            el("p", {
              text: "لا يمكن إنشاء أدوار مخصصة أو تعديل صلاحياتها من الواجهة في هذه المرحلة. إسناد الأدوار للمستخدمين يتم من صفحة المستخدمين ضمن حدود صلاحياتك.",
            }),
          ),
        ),
        summaryStrip(data.roles, data.permissions),
        el("div", { class: "roles-grid" }, data.roles.map((role) => roleCard(role, data.permissions.length))),
        matrixCard(data.roles, data.permissions),
      );
    } catch (error) {
      if (token !== state.renderToken) return;
      contentHost.replaceChildren(errorBlock(friendlyError(error), load));
    }
  }

  await load();
}
