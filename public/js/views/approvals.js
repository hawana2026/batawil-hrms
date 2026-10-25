import {
  api,
  el,
  errorBlock,
  formatDateTime,
  formatNumber,
  icon,
  loadingBlock,
  openModal,
  pageHeader,
  setButtonLoading,
  toast,
} from "../core.js";
import { state } from "../state.js";
import { friendlyError, pageEnter, tablePagination } from "../ui.js";
import {
  branchSelectOptions,
  detailRows,
  downloadFile,
  fileSize,
  filterBar,
  openReasonDialog,
  summaryStrip,
} from "../hr-common.js";

const TYPES = {
  all: "كل الطلبات",
  attendance_day: "تحضير يومي",
  attendance_month: "تحضير شهري",
  leave: "إجازات وأذونات",
  advance: "سلف مالية",
  transfer: "تحويلات وظيفية",
  new_hire: "موظفون جدد",
};

const DETAIL_LABELS = {
  employeeName: "الموظف",
  employeeNo: "الرقم الوظيفي",
  branchName: "الفرع",
  departmentName: "القسم",
  leaveType: "النوع",
  startDate: "من تاريخ",
  endDate: "إلى تاريخ",
  days: "عدد الأيام",
  work_date: "تاريخ التحضير",
  year: "السنة",
  month: "الشهر",
  status: "الحالة",
  notes: "ملاحظات",
  amount: "المبلغ",
  installments: "الأقساط",
  deduction_method: "طريقة الخصم",
  request_date: "تاريخ الطلب",
  from_branch: "من فرع",
  to_branch: "إلى فرع",
  effective_date: "تاريخ السريان",
  proposed_salary: "الراتب المقترح",
  start_date: "تاريخ المباشرة",
  reason: "السبب",
  rejection_reason: "سبب الإعادة",
  missing_days_confirmed: "تأكيد الأيام الناقصة",
};

let approvalState = { page: 1, pageSize: 20, type: "all", branchId: "" };

function detailValue(value) {
  if (typeof value === "boolean") return value ? "نعم" : "لا";
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, inner]) => `${DETAIL_LABELS[key] ?? key}: ${detailValue(inner)}`)
      .join(" · ");
  }
  return String(value);
}

export async function renderApprovals(host, token) {
  host.replaceChildren(loadingBlock("جارٍ تحميل الاعتمادات…"));
  const params = new URLSearchParams();
  params.set("page", String(approvalState.page));
  params.set("pageSize", String(approvalState.pageSize));
  if (approvalState.type !== "all") params.set("type", approvalState.type);
  if (approvalState.branchId) params.set("branchId", approvalState.branchId);
  let data;
  try {
    data = await api(`/api/approvals?${params.toString()}`);
  } catch (error) {
    if (token !== state.renderToken) return;
    host.replaceChildren(errorBlock(friendlyError(error), () => renderApprovals(host, token)));
    return;
  }
  if (token !== state.renderToken) return;

  const typeSelect = el("select", { class: "select" }, ...Object.entries(TYPES).map(([value, label]) => el("option", { value, selected: approvalState.type === value }, label)));
  const branchSelect = el("select", { class: "select" }, ...branchSelectOptions(approvalState.branchId, { allLabel: "كل الفروع" }));
  const filters = filterBar(
    [
      { label: "نوع الطلب", control: typeSelect },
      { label: "الفرع", control: branchSelect },
    ],
    {
      onApply: () => {
        approvalState = { ...approvalState, type: typeSelect.value, branchId: branchSelect.value, page: 1 };
        renderApprovals(host, token);
      },
      onReset: () => {
        approvalState = { page: 1, pageSize: 20, type: "all", branchId: "" };
        renderApprovals(host, token);
      },
    },
  );

  const rows = data.items.length
    ? data.items.map((item) =>
        el(
          "tr",
          {},
          el("td", {}, el("span", { class: "tag brand", text: item.entityLabel })),
          el("td", {}, el("div", { class: "cell-person" }, el("div", {}, el("strong", { text: item.title }), el("span", { text: item.summary || "—" })))),
          el("td", { class: "tiny", text: item.branchName || "—" }),
          el("td", { class: "tiny", text: item.requestedBy || "—" }),
          el("td", { class: "tiny nowrap", text: formatDateTime(item.requestedAt) }),
          el("td", {}, el("span", { class: "tag", text: item.stageLabel })),
          el(
            "td",
            { class: "no-print" },
            el(
              "button",
              { class: "btn btn-secondary btn-sm", type: "button", onclick: () => openDetail(item) },
              icon("eye"),
              "مراجعة",
            ),
          ),
        ),
      )
    : [el("tr", {}, el("td", { colspan: "7", class: "empty-inline", text: "لا توجد طلبات بانتظار اعتمادك." }))];

  const counts = data.counts ?? {};
  const total = Number(data.total ?? 0);
  const countFor = (key) => {
    const value = counts[key];
    if (typeof value === "number") return value;
    if (value && typeof value === "object") return Number(Object.values(value)[0] ?? 0);
    return 0;
  };

  host.replaceChildren(
    pageEnter(
      pageHeader({
        title: "الاعتمادات والطلبات",
        subtitle: "صندوق موحد لكل ما ينتظر قرارك: التحضير اليومي والشهري، الإجازات، السلف، التحويلات، والموظفون الجدد.",
        actions: [el("button", { class: "btn btn-ghost", type: "button", onclick: () => renderApprovals(host, token) }, icon("refresh"), "تحديث")],
      }),
      filters,
      summaryStrip([
        { label: "إجمالي الطلبات", value: total, tone: "blue", iconName: "inbox" },
        { label: "تحضير يومي", value: countFor("attendance_day"), tone: "purple", iconName: "calendar-check" },
        { label: "تحضير شهري", value: countFor("attendance_month"), tone: "purple", iconName: "calendar-range" },
        { label: "إجازات وسلف", value: countFor("leave") + countFor("advance"), tone: "orange", iconName: "wallet" },
      ]),
      el(
        "div",
        { class: "card table-card" },
        el(
          "div",
          { class: "table-wrap" },
          el(
            "table",
            { class: "att-table" },
            el("thead", {}, el("tr", {}, ...["النوع", "الطلب", "الفرع", "مقدم الطلب", "التاريخ", "المرحلة", "إجراء"].map((label, index) => el("th", { class: index === 6 ? "no-print" : "", text: label })))),
            el("tbody", {}, ...rows),
          ),
        ),
        tablePagination({
          page: data.page,
          pageSize: data.pageSize,
          total: data.total,
          onPage: (page) => {
            approvalState.page = page;
            renderApprovals(host, token);
          },
        }),
      ),
    ),
  );

  async function openDetail(summaryItem) {
    let detail;
    try {
      detail = await api(`/api/approvals/${summaryItem.id}`);
    } catch (error) {
      toast(friendlyError(error), "error");
      return;
    }
    const item = detail.item;
    const details = item.details && typeof item.details === "object" ? Object.entries(item.details) : [];
    const attachments = detail.attachments ?? [];
    const history = detail.history ?? [];
    const attachmentList = attachments.length
      ? el(
          "div",
          { class: "attachment-list" },
          ...attachments.map((attachment) =>
            el(
              "div",
              { class: "attachment-item" },
              icon("file-text"),
              el("div", { class: "attachment-copy" }, el("strong", { text: attachment.fileName }), el("span", { text: `${fileSize(attachment.sizeBytes)} · ${attachment.uploadedBy || "—"} · ${formatDateTime(attachment.createdAt)}` })),
              el(
                "button",
                { class: "icon-btn", type: "button", title: "تنزيل", onclick: () => downloadFile(`/api/attachments/${attachment.id}/download`, attachment.fileName).catch((error) => toast(error.message, "error")) },
                icon("download"),
              ),
            ),
          ),
        )
      : el("p", { class: "tiny muted", text: "لا توجد مرفقات." });
    const historyList = history.length
      ? el(
          "div",
          { class: "timeline" },
          ...history.map((entry) =>
            el(
              "div",
              { class: "timeline-item" },
              el("span", { class: `severity-dot ${entry.severity === "critical" ? "danger" : entry.severity === "warning" ? "warning" : ""}`.trim() }),
              el(
                "div",
                {},
                el("strong", { text: entry.action }),
                el("span", { class: "tiny muted", text: `${entry.actor || "—"} · ${formatDateTime(entry.createdAt)}` }),
                entry.details ? el("p", { class: "timeline-note", text: detailValue(entry.details) }) : null,
              ),
            ),
          ),
        )
      : el("p", { class: "tiny muted", text: "لا توجد حركات مسجلة." });

    let controller;
    const footer = [];
    if (item.canDecide) {
      footer.push(
        el(
          "button",
          { class: "btn btn-danger", type: "button", onclick: async (event) => {
            const reason = await openReasonDialog({ title: "رفض الطلب", label: "سبب الرفض", confirmLabel: "رفض", danger: true });
            if (!reason) return;
            const button = event.currentTarget;
            setButtonLoading(button, true, "جارٍ الرفض…");
            try {
              await api(`/api/approvals/${item.id}/reject`, { method: "POST", body: { reason } });
              toast("تم رفض الطلب.", "success");
              controller.close();
              renderApprovals(host, token);
            } catch (error) {
              toast(friendlyError(error), "error");
              setButtonLoading(button, false);
            }
          } },
          icon("circle-x"),
          "رفض",
        ),
        el(
          "button",
          { class: "btn btn-primary", type: "button", onclick: async (event) => {
            const button = event.currentTarget;
            setButtonLoading(button, true, "جارٍ الاعتماد…");
            try {
              await api(`/api/approvals/${item.id}/approve`, { method: "POST", body: {} });
              toast("تم اعتماد الطلب.", "success");
              controller.close();
              renderApprovals(host, token);
            } catch (error) {
              toast(friendlyError(error), "error");
              setButtonLoading(button, false);
            }
          } },
          icon("circle-check"),
          "اعتماد",
        ),
      );
    }

    const body = el(
      "div",
      {},
      el(
        "div",
        { class: "sheet-state" },
        el(
          "div",
          { class: "state-copy" },
          el("strong", {}, item.entityLabel, " · ", item.title),
          el("p", { text: item.summary || "" }),
          el("div", { class: "sheet-meta" }, el("span", {}, "الفرع: ", el("b", { text: item.branchName || "—" })), el("span", {}, "مقدم الطلب: ", el("b", { text: item.requestedBy || "—" })), el("span", {}, "المرحلة: ", el("b", { text: item.stageLabel || "—" }))),
        ),
      ),
      el("div", { class: "section-head" }, el("h3", { class: "section-title" }, icon("file-text"), "تفاصيل الطلب")),
      detailRows(details.map(([key, value]) => [DETAIL_LABELS[key] ?? key, detailValue(value)])),
      el("div", { class: "section-head" }, el("h3", { class: "section-title" }, icon("upload"), "المرفقات")),
      attachmentList,
      el("div", { class: "section-head" }, el("h3", { class: "section-title" }, icon("scroll"), "سجل الحركة")),
      historyList,
    );
    controller = openModal({ title: "مراجعة الطلب", body, footer: footer.length ? footer : null, size: "lg" });
    void controller;
  }
}
