import {
  api,
  confirmDialog,
  el,
  errorBlock,
  formatDate,
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
  LEAVE_STATUS,
  LEAVE_TYPES,
  attachmentsPanel,
  branchList,
  branchSelectOptions,
  detailRows,
  filterBar,
  openFormDialog,
  openReasonDialog,
  personCell,
  selectOptions,
  statusTag,
  summaryStrip,
  todayISO,
} from "../hr-common.js";

let leaveState = { page: 1, pageSize: 20, status: "all", type: "all", branchId: "", q: "" };

function leaveTypeLabel(type) {
  return LEAVE_TYPES[type] ?? type;
}

async function loadEmployees() {
  const result = await api("/api/employees/options");
  return result.items.map((item) => ({ value: item.id, label: `${item.fullName} — ${item.employeeNo}` }));
}

function leaveFields(leave, employeeOptions) {
  return [
    { name: "employeeId", label: "الموظف", type: "select", required: true, options: employeeOptions, value: leave.employeeId ?? "" },
    { name: "leaveType", label: "نوع الطلب", type: "select", required: true, options: Object.entries(LEAVE_TYPES).map(([value, label]) => ({ value, label })), value: leave.leaveType ?? "annual" },
    { name: "startDate", label: "من تاريخ", type: "date", required: true, value: leave.startDate ?? todayISO() },
    { name: "endDate", label: "إلى تاريخ", type: "date", required: true, value: leave.endDate ?? todayISO() },
    { name: "reason", label: "سبب الطلب", type: "textarea", required: true, minlength: 3, maxlength: 1000, span: 2, value: leave.reason ?? "" },
    { name: "notes", label: "ملاحظات", type: "textarea", maxlength: 2000, span: 2, value: leave.notes ?? "" },
  ];
}

export async function renderLeaves(host, token) {
  host.replaceChildren(loadingBlock("جارٍ تحميل الإجازات والأذونات…"));
  const params = new URLSearchParams();
  params.set("page", String(leaveState.page));
  params.set("pageSize", String(leaveState.pageSize));
  if (leaveState.status !== "all") params.set("status", leaveState.status);
  if (leaveState.type !== "all") params.set("type", leaveState.type);
  if (leaveState.branchId) params.set("branchId", leaveState.branchId);
  if (leaveState.q) params.set("q", leaveState.q);
  let data;
  try {
    data = await api(`/api/leaves?${params.toString()}`);
  } catch (error) {
    if (token !== state.renderToken) return;
    host.replaceChildren(errorBlock(friendlyError(error), () => renderLeaves(host, token)));
    return;
  }
  if (token !== state.renderToken) return;

  const canManage = Boolean(data.capabilities?.canManage);
  const canApprove = Boolean(data.capabilities?.canApprove);
  const statusSelect = el(
    "select",
    { class: "select" },
    el("option", { value: "all", selected: leaveState.status === "all" }, "كل الحالات"),
    ...Object.entries(LEAVE_STATUS).map(([value, meta]) => el("option", { value, selected: leaveState.status === value }, meta.label)),
  );
  const typeSelect = el(
    "select",
    { class: "select" },
    el("option", { value: "all", selected: leaveState.type === "all" }, "كل الأنواع"),
    ...Object.entries(LEAVE_TYPES).map(([value, label]) => el("option", { value, selected: leaveState.type === value }, label)),
  );
  const branchSelect = el("select", { class: "select" }, ...branchSelectOptions(leaveState.branchId, { allLabel: "كل الفروع" }));
  const search = el("input", { class: "input", type: "search", value: leaveState.q, placeholder: "الموظف أو الرقم الوظيفي…" });
  const filters = filterBar(
    [
      { label: "الحالة", control: statusSelect },
      { label: "النوع", control: typeSelect },
      { label: "الفرع", control: branchSelect },
      { label: "بحث", control: search },
    ],
    {
      onApply: () => {
        leaveState = { ...leaveState, status: statusSelect.value, type: typeSelect.value, branchId: branchSelect.value, q: search.value.trim(), page: 1 };
        renderLeaves(host, token);
      },
      onReset: () => {
        leaveState = { page: 1, pageSize: 20, status: "all", type: "all", branchId: "", q: "" };
        renderLeaves(host, token);
      },
    },
  );

  const actions = [];
  if (canManage) {
    actions.push(el("button", { class: "btn btn-primary", type: "button", onclick: () => openCreate() }, icon("plus"), "طلب جديد"));
  }

  const rows = data.items.length
    ? data.items.map((leave) =>
        el(
          "tr",
          {},
          el("td", {}, personCell(leave.employeeName, leave.branchName, leave.employeeNo)),
          el("td", {}, el("span", { class: "tag", text: leaveTypeLabel(leave.leaveType) })),
          el("td", { class: "tiny nowrap", text: `${formatDate(leave.startDate)} — ${formatDate(leave.endDate)}` }),
          el("td", { class: "num", text: formatNumber(leave.days) }),
          el("td", { class: "tiny", text: leave.reason || "—" }),
          el("td", {}, statusTag(LEAVE_STATUS, leave.status)),
          el("td", { class: "tiny muted", text: leave.decidedBy ? `${leave.decidedBy} · ${formatDate(leave.decidedAt)}` : leave.requestedBy || "—" }),
          el(
            "td",
            { class: "no-print" },
            el(
              "div",
              { class: "inline-actions" },
              el("button", { class: "icon-btn", type: "button", title: "عرض الطلب", onclick: () => openDetail(leave) }, icon("eye")),
              canManage && ["draft", "rejected"].includes(leave.status)
                ? el("button", { class: "icon-btn", type: "button", title: "تعديل", onclick: () => openEdit(leave) }, icon("pencil"))
                : null,
              canManage && ["draft", "rejected"].includes(leave.status)
                ? el("button", { class: "icon-btn", type: "button", title: "إرسال للاعتماد", onclick: (event) => submitLeave(leave, event.currentTarget) }, icon("send"))
                : null,
              canApprove && leave.status === "pending"
                ? el("button", { class: "icon-btn success", type: "button", title: "اعتماد", onclick: (event) => decide(leave, "approve", event.currentTarget) }, icon("circle-check"))
                : null,
              canApprove && leave.status === "pending"
                ? el("button", { class: "icon-btn danger", type: "button", title: "رفض", onclick: (event) => decide(leave, "reject", event.currentTarget) }, icon("circle-x"))
                : null,
              canManage && ["draft", "pending"].includes(leave.status)
                ? el("button", { class: "icon-btn", type: "button", title: "إلغاء", onclick: (event) => cancelLeave(leave, event.currentTarget) }, icon("close"))
                : null,
            ),
          ),
        ),
      )
    : [el("tr", {}, el("td", { colspan: "8", class: "empty-inline", text: "لا توجد طلبات مطابقة." }))];

  host.replaceChildren(
    pageEnter(
      pageHeader({
        title: "الإجازات والأذونات",
        subtitle: "طلبات الإجازات والأذونات مرتبطة تلقائياً بالتحضير اليومي بعد الاعتماد.",
        actions,
      }),
      filters,
      summaryStrip([
        { label: "إجمالي الطلبات", value: data.total, tone: "blue", iconName: "calendar" },
        { label: "بانتظار الاعتماد", value: data.counts?.pending ?? 0, tone: "orange", iconName: "clock" },
        { label: "معتمدة", value: data.counts?.approved ?? 0, tone: "green", iconName: "circle-check" },
        { label: "مرفوضة", value: data.counts?.rejected ?? 0, tone: "red", iconName: "circle-x" },
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
            el("thead", {}, el("tr", {}, ...["الموظف", "النوع", "الفترة", "الأيام", "السبب", "الحالة", "الاعتماد", "إجراءات"].map((label, index) => el("th", { class: index === 7 ? "no-print" : "", text: label })))),
            el("tbody", {}, ...rows),
          ),
        ),
        tablePagination({
          page: data.page,
          pageSize: data.pageSize,
          total: data.total,
          onPage: (page) => {
            leaveState.page = page;
            renderLeaves(host, token);
          },
        }),
      ),
    ),
  );

  async function openCreate() {
    let employees;
    try {
      employees = await loadEmployees();
    } catch (error) {
      toast(friendlyError(error), "error");
      return;
    }
    openFormDialog({
      title: "طلب إجازة أو إذن جديد",
      fields: leaveFields({}, employees),
      submitLabel: "حفظ الطلب",
      size: "lg",
      onSubmit: async (values) => {
        await api("/api/leaves", {
          method: "POST",
          body: {
            employeeId: values.employeeId,
            leaveType: values.leaveType,
            startDate: values.startDate,
            endDate: values.endDate,
            reason: values.reason,
            notes: values.notes,
          },
        });
        toast("تم حفظ الطلب. أرسله للاعتماد عند الجاهزية.", "success");
        renderLeaves(host, token);
      },
    });
  }

  async function openEdit(leave) {
    let employees;
    try {
      employees = await loadEmployees();
    } catch (error) {
      toast(friendlyError(error), "error");
      return;
    }
    openFormDialog({
      title: `تعديل الطلب — ${leave.employeeName}`,
      fields: leaveFields(leave, employees),
      submitLabel: "حفظ التعديلات",
      size: "lg",
      onSubmit: async (values) => {
        await api(`/api/leaves/${leave.id}`, {
          method: "PATCH",
          body: {
            employeeId: values.employeeId,
            leaveType: values.leaveType,
            startDate: values.startDate,
            endDate: values.endDate,
            reason: values.reason,
            notes: values.notes,
          },
        });
        toast("تم تحديث الطلب.", "success");
        renderLeaves(host, token);
      },
    });
  }

  function openDetail(leave) {
    const attachments = attachmentsPanel({ ownerType: "leave", ownerId: leave.id, canEdit: canManage && ["draft", "rejected"].includes(leave.status) });
    openModal({
      title: `طلب ${leaveTypeLabel(leave.leaveType)} — ${leave.employeeName}`,
      size: "lg",
      body: el(
        "div",
        {},
        detailRows([
          ["الموظف", leave.employeeName],
          ["الرقم الوظيفي", leave.employeeNo],
          ["الفرع", leave.branchName],
          ["النوع", leaveTypeLabel(leave.leaveType)],
          ["من", formatDate(leave.startDate)],
          ["إلى", formatDate(leave.endDate)],
          ["عدد الأيام", formatNumber(leave.days)],
          ["الحالة", statusTag(LEAVE_STATUS, leave.status)],
          ["مقدم الطلب", leave.requestedBy || "—"],
          ["الاعتماد", leave.decidedBy ? `${leave.decidedBy} · ${formatDateTime(leave.decidedAt)}` : "—"],
          ["ملاحظة القرار", leave.decisionNote || "—"],
          ["السبب", leave.reason || "—"],
          ["ملاحظات", leave.notes || "—"],
          ["تاريخ الإنشاء", formatDateTime(leave.createdAt)],
        ]),
        attachments.node,
      ),
    });
  }

  async function submitLeave(leave, button) {
    setButtonLoading(button, true, "جارٍ الإرسال…");
    try {
      await api(`/api/leaves/${leave.id}/submit`, { method: "POST", body: {} });
      toast("تم إرسال الطلب للاعتماد.", "success");
      renderLeaves(host, token);
    } catch (error) {
      toast(friendlyError(error), "error");
      setButtonLoading(button, false);
    }
  }

  async function decide(leave, kind, button) {
    let reason = "";
    if (kind === "reject") {
      reason = await openReasonDialog({ title: "رفض الطلب", message: "سيُعلم مقدم الطلب بسبب الرفض.", label: "سبب الرفض", confirmLabel: "رفض", danger: true });
      if (!reason) return;
    }
    setButtonLoading(button, true, "جارٍ التنفيذ…");
    try {
      await api(`/api/leaves/${leave.id}/${kind}`, { method: "POST", body: { reason } });
      toast(kind === "approve" ? "تم اعتماد الطلب." : "تم رفض الطلب.", "success");
      renderLeaves(host, token);
    } catch (error) {
      toast(friendlyError(error), "error");
      setButtonLoading(button, false);
    }
  }

  async function cancelLeave(leave, button) {
    const ok = await confirmDialog({ title: "إلغاء الطلب", message: "سيُلغى الطلب ولا يمكن اعتماده لاحقاً.", confirmLabel: "إلغاء الطلب", danger: true });
    if (!ok) return;
    setButtonLoading(button, true, "جارٍ الإلغاء…");
    try {
      await api(`/api/leaves/${leave.id}/cancel`, { method: "POST", body: {} });
      toast("تم إلغاء الطلب.", "success");
      renderLeaves(host, token);
    } catch (error) {
      toast(friendlyError(error), "error");
      setButtonLoading(button, false);
    }
  }
}
