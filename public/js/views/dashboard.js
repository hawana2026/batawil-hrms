import { api, avatar, el, formatFullDay, formatNumber, formatRelative, greeting, icon } from "../core.js";
import { can, navigate, state } from "../state.js";
import { auditActionLabel, metricCard, pageEnter } from "../ui.js";

function activityItem(item) {
  return el(
    "div",
    { class: "activity-item" },
    el("span", { class: `activity-dot ${item.severity}` }),
    el(
      "div",
      { class: "activity-copy" },
      el("strong", { text: auditActionLabel(item.action) }),
      el("span", {
        text: [item.actorUsername ? `بواسطة ${item.actorUsername}` : "", item.branchName ?? ""].filter(Boolean).join(" · ") || "نشاط نظام",
      }),
    ),
    el("span", { class: "activity-time", title: item.createdAt, text: formatRelative(item.createdAt) }),
  );
}

function welcomeBanner(data, firstName) {
  const actions = [];
  if (can("users.view")) {
    actions.push(
      el("button", { class: "btn btn-white", type: "button", onclick: () => navigate("users") }, icon("users"), "إدارة المستخدمين"),
    );
  }
  if (can("audit.view")) {
    actions.push(
      el("button", { class: "btn btn-outline-light", type: "button", onclick: () => navigate("audit") }, icon("scroll"), "سجل التدقيق"),
    );
  } else {
    actions.push(
      el("button", { class: "btn btn-outline-light", type: "button", onclick: () => navigate("account") }, icon("account"), "حسابي"),
    );
  }
  return el(
    "section",
    { class: "welcome-banner" },
    el(
      "div",
      { class: "welcome-content" },
      el("div", { class: "welcome-overline" }, icon("calendar"), formatFullDay(new Date())),
      el("h2", { text: `${greeting()}، ${firstName}` }),
      el("p", {
        text: can("attendance.view")
          ? "إليك ملخص العمليات اليومية والتحضير والاعتمادات ضمن نطاق صلاحيتك — ابدأ بالتحضير اليومي أو راجع ما ينتظر قرارك."
          : data.capabilities.canViewUsers
            ? "إليك ملخص الحسابات والفروع والنشاط الإداري ضمن نطاق صلاحيتك."
            : "مرحباً بك في مساحة العمل الآمنة. يمكنك مراجعة حسابك وإعدادات الأمان من هنا.",
      }),
    ),
    el("div", { class: "welcome-actions" }, actions),
  );
}

function metrics(data) {
  const cards = [];
  if (data.users) {
    cards.push(
      metricCard({
        iconName: "user-check",
        tone: "green",
        value: data.users.active,
        label: "مستخدمون نشطون",
        note: `من أصل ${formatNumber(data.users.total)} حساباً ضمن نطاقك`,
      }),
      metricCard({
        iconName: "lock",
        tone: "orange",
        value: data.users.locked,
        label: "حسابات مقفلة مؤقتاً",
        note: "حماية تلقائية عند تكرار المحاولات",
      }),
      metricCard({
        iconName: "key",
        tone: "purple",
        value: data.users.must_change,
        label: "بانتظار تغيير كلمة المرور",
        note: "حسابات ما زالت تستخدم كلمة مرور مؤقتة",
      }),
    );
  }
  if (data.branches) {
    cards.push(
      metricCard({
        iconName: "building",
        tone: "blue",
        value: data.branches.active,
        label: "فروع نشطة",
        note: `من أصل ${formatNumber(data.branches.total)} فروع في نطاقك`,
      }),
    );
  }
  if (cards.length === 0) return null;
  return el("div", { class: "metrics-grid" }, cards);
}

function activityCard(data) {
  const card = el("div", { class: "card" });
  const head = el(
    "div",
    { class: "card-head" },
    el(
      "div",
      {},
      el("h3", { class: "card-title", text: "النشاط الإداري الحديث" }),
      el("div", { class: "card-subtitle", text: "آخر العمليات الحساسة المسجلة مركزياً" }),
    ),
    el(
      "button",
      { class: "btn btn-ghost btn-sm", type: "button", onclick: () => navigate("audit") },
      "عرض السجل",
      icon("chevron-left"),
    ),
  );
  const body = el("div", { class: "card-body" });
  if (data.recentActivity.length === 0) {
    body.append(
      el(
        "div",
        { class: "empty-state", style: "padding:26px 10px" },
        el("span", { class: "empty-icon" }, icon("scroll")),
        el("h3", { class: "empty-title", text: "لا توجد أنشطة مسجلة بعد" }),
        el("p", { class: "empty-text", text: "ستظهر هنا عمليات الدخول وإدارة الحسابات والفروع." }),
      ),
    );
  } else {
    body.append(el("div", { class: "activity-list" }, data.recentActivity.map(activityItem)));
  }
  card.append(head, body);
  return card;
}

function branchesCard(data) {
  const card = el("div", { class: "card" });
  card.append(
    el(
      "div",
      { class: "card-head" },
      el(
        "div",
        {},
        el("h3", { class: "card-title", text: "الفروع في نطاقك" }),
        el("div", { class: "card-subtitle", text: "نطاق البيانات الذي يمكنك الوصول إليه" }),
      ),
      el("span", { class: "tag brand" }, icon("building"), `${formatNumber(data.branchList.length)} فرع`),
    ),
  );
  const body = el("div", { class: "card-body" });
  if (data.branchList.length === 0) {
    body.append(
      el(
        "div",
        { class: "empty-state", style: "padding:24px 10px" },
        el("span", { class: "empty-icon" }, icon("building")),
        el("h3", { class: "empty-title", text: "لا توجد فروع" }),
        el("p", { class: "empty-text", text: "ابدأ بإنشاء فرع ثم أسنِد المستخدمين إليه." }),
        can("branches.manage")
          ? el("button", { class: "btn btn-primary btn-sm", type: "button", onclick: () => navigate("branches") }, icon("plus"), "إدارة الفروع")
          : null,
      ),
    );
  } else {
    body.append(
      el(
        "div",
        { class: "branches-grid" },
        data.branchList.map((branch) =>
          el(
            "div",
            { class: "branch-chip" },
            el("span", { class: "metric-icon blue" }, icon("building")),
            el(
              "div",
              { class: "branch-chip-copy" },
              el("strong", { text: branch.name }),
              el("span", { text: branch.code }),
            ),
            el("span", { class: "status-badge " + (branch.active ? "status-success" : "status-danger"), text: branch.active ? "نشط" : "معطل" }),
          ),
        ),
      ),
    );
  }
  card.append(body);
  return card;
}

function accountCard(data) {
  const user = state.user;
  const card = el("div", { class: "card" });
  card.append(
    el(
      "div",
      { class: "card-head" },
      el("div", {}, el("h3", { class: "card-title", text: "حسابك" }), el("div", { class: "card-subtitle", text: "ملخص الصلاحيات والجلسة الحالية" })),
      el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => navigate("account") }, "الأمان", icon("chevron-left")),
    ),
    el(
      "div",
      { class: "card-body" },
      el(
        "div",
        { class: "account-summary", style: "padding:4px 0 14px" },
        avatar(user.fullName, "lg"),
        el(
          "div",
          { class: "account-summary-copy" },
          el("h3", { text: user.fullName }),
          el("p", { text: user.role.nameAr }),
          el(
            "div",
            { class: "tag-row" },
            el("span", { class: "tag brand" }, icon("globe"), user.allBranches ? "كل الفروع" : `${formatNumber(user.branches.length)} فرع`),
            el("span", { class: "tag" }, icon("shield-check"), user.role.allPermissions ? "صلاحيات كاملة" : `${formatNumber(user.permissions.length)} صلاحية`),
          ),
        ),
      ),
      el(
        "div",
        { class: "profile-rows", style: "padding-top:14px;border-top:1px solid var(--border)" },
        el("div", { class: "profile-row" }, el("span", { text: "آخر دخول" }), el("span", { text: formatRelative(user.lastLoginAt) })),
        el(
          "div",
          { class: "profile-row" },
          el("span", { text: "انتهاء الجلسة" }),
          el("span", { text: data.serverTime ? new Intl.DateTimeFormat("ar-EG", { numberingSystem: "latn", hour: "numeric", minute: "2-digit" }).format(new Date(state.session?.expiresAt ?? data.serverTime)) : "—" }),
        ),
        el("div", { class: "profile-row" }, el("span", { text: "اسم المستخدم" }), el("span", { dir: "ltr", text: user.username })),
      ),
    ),
  );
  return card;
}

function quickActions(data) {
  const actions = [];
  if (can("attendance.view")) {
    actions.push(
      el(
        "button",
        { class: "quick-action", type: "button", onclick: () => navigate("attendance-daily") },
        el("span", { class: "metric-icon green" }, icon("calendar-check")),
        el("span", {}, el("strong", { text: "التحضير اليومي" }), el("span", { text: "تسجيل حضور الفرع وتعديله وإرساله" })),
      ),
      el(
        "button",
        { class: "quick-action", type: "button", onclick: () => navigate("attendance-monthly") },
        el("span", { class: "metric-icon purple" }, icon("calendar-range")),
        el("span", {}, el("strong", { text: "التحضير الشهري" }), el("span", { text: "مصفوفة الرموز وتجاوزات الشهر" })),
      ),
    );
  }
  if (can("approvals.view")) {
    actions.push(
      el(
        "button",
        { class: "quick-action", type: "button", onclick: () => navigate("approvals") },
        el("span", { class: "metric-icon orange" }, icon("inbox")),
        el("span", {}, el("strong", { text: "الاعتمادات الواردة" }), el("span", { text: "راجع واعتمد الطلبات المعلّقة" })),
      ),
    );
  }
  if (can("users.manage")) {
    actions.push(
      el(
        "button",
        { class: "quick-action", type: "button", onclick: () => navigate("users") },
        el("span", { class: "metric-icon blue" }, icon("user-plus")),
        el("span", {}, el("strong", { text: "إضافة مستخدم جديد" }), el("span", { text: "إنشاء حساب بكلمة مرور مؤقتة" })),
      ),
    );
  }
  if (can("branches.manage")) {
    actions.push(
      el(
        "button",
        { class: "quick-action", type: "button", onclick: () => navigate("branches") },
        el("span", { class: "metric-icon green" }, icon("building")),
        el("span", {}, el("strong", { text: "إدارة الفروع" }), el("span", { text: "إضافة فرع أو تحديث بياناته" })),
      ),
    );
  }
  if (can("audit.view")) {
    actions.push(
      el(
        "button",
        { class: "quick-action", type: "button", onclick: () => navigate("audit") },
        el("span", { class: "metric-icon purple" }, icon("scroll")),
        el("span", {}, el("strong", { text: "مراجعة سجل التدقيق" }), el("span", { text: "تتبع العمليات الحساسة" })),
      ),
    );
  }
  if (can("reports.view")) {
    actions.push(
      el(
        "button",
        { class: "quick-action", type: "button", onclick: () => navigate("reports") },
        el("span", { class: "metric-icon blue" }, icon("file-text")),
        el("span", {}, el("strong", { text: "التقارير والطباعة" }), el("span", { text: "تصدير وطباعة تقارير الحضور" })),
      ),
    );
  }
  actions.push(
    el(
      "button",
      { class: "quick-action", type: "button", onclick: () => navigate("account") },
      el("span", { class: "metric-icon orange" }, icon("shield-check")),
      el("span", {}, el("strong", { text: "أمان الحساب" }), el("span", { text: "تغيير كلمة المرور وإنهاء الجلسات" })),
    ),
  );
  return el("div", { class: "quick-grid" }, actions);
}

export async function renderDashboard(host, token) {
  const data = await api("/api/dashboard");
  if (token !== state.renderToken) return;
  const firstName = String(state.user.fullName || "").trim().split(/\s+/)[0] ?? "";
  const node = pageEnter(welcomeBanner(data, firstName));

  const metricsNode = metrics(data);
  if (metricsNode) node.append(metricsNode);

  const grid = el("div", { class: "dashboard-grid" });
  if (data.capabilities.canViewAudit) {
    grid.append(activityCard(data));
    if (data.capabilities.canViewBranches) grid.append(branchesCard(data));
    else grid.append(accountCard(data));
  } else {
    grid.append(accountCard(data));
    if (data.capabilities.canViewBranches) grid.append(branchesCard(data));
  }
  node.append(grid);

  if (data.capabilities.canViewBranches && data.capabilities.canViewAudit) {
    node.append(accountCard(data));
  }

  node.append(quickActions(data));
  host.replaceChildren(node);
}
