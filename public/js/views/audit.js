import { api, el, errorBlock, formatDateTime, formatNumber, icon, loadingBlock, pageHeader, statusBadge } from "../core.js";
import { state } from "../state.js";
import { auditActionLabel, auditSummary, friendlyError, pageEnter, tablePagination } from "../ui.js";

function optionsMarkup(items, selectedValue) {
  return items.map((item) => el("option", { value: item.value, selected: item.value === selectedValue }, item.label));
}

function filterForm(onApply) {
  const filters = state.audit.filters;
  const search = el("input", {
    class: "input",
    type: "search",
    name: "q",
    value: filters.q,
    placeholder: "المستخدم، الحدث، المعرّف…",
    "aria-label": "بحث في سجل التدقيق",
    maxlength: 100,
  });
  const severity = el(
    "select",
    { class: "select", name: "severity", "aria-label": "مستوى الخطورة" },
    ...optionsMarkup(
      [
        { value: "all", label: "كل المستويات" },
        { value: "info", label: "معلوماتية" },
        { value: "warning", label: "تحذيرية" },
        { value: "critical", label: "حرجة" },
      ],
      filters.severity,
    ),
  );
  const from = el("input", {
    class: "input",
    type: "date",
    name: "from",
    value: filters.from,
    dir: "ltr",
    "aria-label": "من تاريخ",
  });
  const to = el("input", {
    class: "input",
    type: "date",
    name: "to",
    value: filters.to,
    dir: "ltr",
    "aria-label": "إلى تاريخ",
  });

  return el(
    "form",
    {
      class: "card filter-bar",
      onsubmit: async (event) => {
        event.preventDefault();
        state.audit.filters = {
          q: search.value.trim(),
          severity: severity.value,
          from: from.value,
          to: to.value,
        };
        state.audit.page = 1;
        await onApply();
      },
    },
    el("div", { class: "form-field" }, el("label", { class: "form-label", text: "بحث" }), search),
    el("div", { class: "form-field" }, el("label", { class: "form-label", text: "الخطورة" }), severity),
    el("div", { class: "form-field" }, el("label", { class: "form-label", text: "من تاريخ" }), from),
    el("div", { class: "form-field" }, el("label", { class: "form-label", text: "إلى تاريخ" }), to),
    el(
      "div",
      { class: "filter-actions" },
      el("button", { class: "btn btn-primary", type: "submit" }, icon("search"), "تطبيق"),
      el(
        "button",
        {
          class: "btn btn-ghost",
          type: "button",
          onclick: async () => {
            search.value = "";
            severity.value = "all";
            from.value = "";
            to.value = "";
            state.audit.filters = { q: "", severity: "all", from: "", to: "" };
            state.audit.page = 1;
            await onApply();
          },
        },
        "مسح",
      ),
    ),
  );
}

function severityOf(value) {
  if (value === "critical") return statusBadge("حرجة", "danger", "alert-triangle");
  if (value === "warning") return statusBadge("تحذيرية", "warning", "alert-triangle");
  return statusBadge("معلوماتية", "neutral", "info");
}

function detailsCell(item) {
  const summary = auditSummary(item.details);
  const hasDetails = item.details && typeof item.details === "object" && Object.keys(item.details).length > 0;
  return el(
    "td",
    {},
    el("div", { class: "tiny", text: summary }),
    hasDetails
      ? el(
          "details",
          { class: "audit-details" },
          el("summary", { text: "البيانات الكاملة" }),
          el("pre", { dir: "ltr", text: JSON.stringify(item.details, null, 2) }),
        )
      : null,
  );
}

function auditRow(item) {
  const entityText = [item.entityType, item.entityId ? String(item.entityId).slice(0, 8) : ""].filter(Boolean).join(" · ");
  return el(
    "tr",
    {},
    el(
      "td",
      { class: "nowrap" },
      el("div", { class: "audit-date", title: item.createdAt, text: formatDateTime(item.createdAt) }),
      item.ip ? el("div", { class: "tiny muted", dir: "ltr", style: "text-align:start", text: item.ip }) : null,
    ),
    el(
      "td",
      {},
      el("strong", { style: "font-size:12px;color:var(--text);", text: item.actorUsername || "النظام" }),
      item.actorUserId ? el("div", { class: "tiny muted", dir: "ltr", style: "text-align:start", text: `#${String(item.actorUserId).slice(0, 8)}` }) : null,
    ),
    el(
      "td",
      {},
      el("div", { class: "tag-row", style: "margin-top:0;flex-direction:column;align-items:flex-start;gap:4px" },
        el("strong", { style: "font-size:12px;", text: auditActionLabel(item.action) }),
        el("code", { class: "audit-action", text: item.action }),
      ),
    ),
    el(
      "td",
      {},
      item.branchName
        ? el("div", { class: "tiny" }, icon("building", "icon icon-xs"), ` ${item.branchName}`)
        : el("div", { class: "tiny muted", text: "النطاق المركزي" }),
      entityText ? el("div", { class: "tiny muted", dir: "ltr", style: "text-align:start", text: entityText }) : null,
    ),
    el("td", {}, severityOf(item.severity)),
    detailsCell(item),
  );
}

function buildTable(listHost, token, reload) {
  const { items, page, pageSize, total } = state.audit;
  const card = el("div", { class: "card table-card" });
  if (items.length === 0) {
    card.append(
      el(
        "div",
        { class: "empty-state" },
        el("span", { class: "empty-icon" }, icon("scroll")),
        el("h3", { class: "empty-title", text: "لا توجد سجلات مطابقة" }),
        el("p", { class: "empty-text", text: "جرّب توسيع نطاق التاريخ أو تغيير كلمة البحث أو مستوى الخطورة." }),
      ),
    );
    return card;
  }

  const table = el(
    "table",
    {},
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        ["الوقت", "المنفّذ", "الحدث", "النطاق", "الخطورة", "التفاصيل"].map((label) => el("th", { text: label })),
      ),
    ),
    el("tbody", {}, items.map(auditRow)),
  );

  card.append(
    el("div", { class: "table-wrap" }, table),
    tablePagination({
      page,
      pageSize,
      total,
      onPage: (nextPage) => {
        if (nextPage < 1) return;
        state.audit.page = nextPage;
        loadAuditList(listHost, token, reload);
      },
    }),
    el(
      "div",
      { class: "card-footer" },
      el("span", { text: `إجمالي السجلات في نطاقك: ${formatNumber(total)}` }),
      el("span", { class: "tag" }, icon("lock"), "سجل للعرض فقط"),
    ),
  );
  return card;
}

async function loadAuditList(listHost, token, reload = () => loadAuditList(listHost, token)) {
  listHost.replaceChildren(loadingBlock("جارٍ تحميل سجل التدقيق…"));
  const params = new URLSearchParams();
  const filters = state.audit.filters;
  if (filters.q) params.set("q", filters.q);
  if (filters.severity !== "all") params.set("severity", filters.severity);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  params.set("page", String(state.audit.page));
  params.set("pageSize", String(state.audit.pageSize));

  try {
    const data = await api(`/api/audit?${params.toString()}`);
    if (token !== state.renderToken) return;
    state.audit.items = data.items;
    state.audit.total = data.total;
    state.audit.page = data.page;
    state.audit.pageSize = data.pageSize;
    listHost.replaceChildren(buildTable(listHost, token, reload));
  } catch (error) {
    if (token !== state.renderToken) return;
    listHost.replaceChildren(errorBlock(friendlyError(error), () => loadAuditList(listHost, token)));
  }
}

export async function renderAudit(host, token) {
  let listHost = null;
  let reload = null;
  const node = pageEnter(
    pageHeader({
      title: "سجل التدقيق",
      subtitle: "سجل مركزي غير قابل للتعديل للعمليات الحساسة ضمن نطاق صلاحيتك.",
      actions: [
        el("button", { class: "btn btn-secondary", type: "button", onclick: () => reload?.() }, icon("refresh"), "تحديث"),
      ],
    }),
    el(
      "div",
      { class: "readonly-banner" },
      icon("shield-check"),
      el(
        "div",
        {},
        el("strong", { text: "سجل إلحاقي محمي ضد التعديل والحذف" }),
        el("p", {
          text: "تُعرض السجلات وفق نطاق الفروع المسموح لحسابك فقط. لا توفر الواجهة أي إمكانية لتعديل السجل أو حذفه، ويُسجَّل كل وصول إداري مرفوض تلقائياً.",
        }),
      ),
    ),
  );
  const filters = filterForm(async () => loadAuditList(listHost, token, reload));
  listHost = el("div");
  reload = () => loadAuditList(listHost, token, reload);
  node.append(filters, listHost);
  host.replaceChildren(node);
  await loadAuditList(listHost, token, reload);
}
