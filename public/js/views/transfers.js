import {
  api,
  confirmDialog,
  el,
  errorBlock,
  formatDate,
  formatDateTime,
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
  TRANSFER_STATUS,
  attachmentsPanel,
  branchList,
  branchSelectOptions,
  departmentList,
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

let transferState = { page: 1, pageSize: 20, status: "all", branchId: "", q: "" };

async function loadEmployees(branchId = "") {
  const result = await api(`/api/employees/options${branchId ? `?branchId=${encodeURIComponent(branchId)}` : ""}`);
  return result.items;
}

function transferFields(employees, { employee = null } = {}) {
  const branches = branchList().filter((branch) => branch.active && branch.id !== employee?.branchId);
  return [
    {
      name: "employeeId",
      label: "الموظف",
      type: "select",
      required: true,
      options: employees.map((item) => ({ value: item.id, label: `${item.fullName} — ${item.employeeNo}` })),
      value: employee?.id ?? "",
    },
    {
      name: "toBranchId",
      label: "الفرع الجديد",
      type: "select",
      required: true,
      options: branches.map((branch) => ({ value: branch.id, label: branch.name })),
    },
    {
      name: "toDepartmentId",
      label: "القسم الجديد",
      type: "select",
      placeholder: "بدون قسم",
      options: departmentList().map((department) => ({ value: department.id, label: department.name })),
    },
    { name: "effectiveDate", label: "تاريخ السريان", type: "date", required: true, value: todayISO() },
    { name: "reason", label: "سبب النقل", type: "textarea", required: true, minlength: 3, maxlength: 1000, span: 2 },
    { name: "notes", label: "ملاحظات", type: "textarea", maxlength: 2000, span: 2 },
  ];
}

export async function renderTransfers(host, token) {
  host.replaceChildren(loadingBlock("جارٍ تحميل التحويلات الوظيفية…"));
  const params = new URLSearchParams();
  params.set("page", String(transferState.page));
  params.set("pageSize", String(transferState.pageSize));
  if (transferState.status !== "all") params.set("status", transferState.status);
  if (transferState.branchId) params.set("branchId", transferState.branchId);
  if (transferState.q) params.set("q", transferState.q);
  let data;
  try {
    data = await api(`/api/transfers?${params.toString()}`);
  } catch (error) {
    if (token !== state.renderToken) return;
    host.replaceChildren(errorBlock(friendlyError(error), () => renderTransfers(host, token)));
    return;
  }
  if (token !== state.renderToken) return;

  const caps = data.capabilities ?? {};
  const statusSelect = el(
    "select",
    { class: "select" },
    el("option", { value: "all", selected: transferState.status === "all" }, "كل الحالات"),
    ...Object.entries(TRANSFER_STATUS).map(([value, meta]) => el("option", { value, selected: transferState.status === value }, meta.label)),
  );
  const branchSelect = el("select", { class: "select" }, ...branchSelectOptions(transferState.branchId, { allLabel: "كل الفروع" }));
  const search = el("input", { class: "input", type: "search", value: transferState.q, placeholder: "الموظف أو الرقم…" });
  const filters = filterBar(
    [
      { label: "الحالة", control: statusSelect },
      { label: "الفرع", control: branchSelect },
      { label: "بحث", control: search },
    ],
    {
      onApply: () => {
        transferState = { ...transferState, status: statusSelect.value, branchId: branchSelect.value, q: search.value.trim(), page: 1 };
        renderTransfers(host, token);
      },
      onReset: () => {
        transferState = { page: 1, pageSize: 20, status: "all", branchId: "", q: "" };
        renderTransfers(host, token);
      },
    },
  );

  const rows = data.items.length
    ? data.items.map((transfer) =>
        el(
          "tr",
          {},
          el("td", {}, personCell(transfer.employeeName, transfer.employeeNo, "")),
          el("td", { class: "tiny" }, el("div", { class: "transfer-path" }, el("span", { text: transfer.fromBranch || "—" }), icon("arrow-left"), el("strong", { text: transfer.toBranch }))),
          el("td", { class: "tiny", text: transfer.toDepartment || "—" }),
          el("td", { class: "tiny nowrap", text: formatDate(transfer.effectiveDate) }),
          el("td", { class: "tiny", text: transfer.reason || "—" }),
          el("td", {}, statusTag(TRANSFER_STATUS, transfer.status)),
          el(
            "td",
            { class: "no-print" },
            el(
              "div",
              { class: "inline-actions" },
              el("button", { class: "icon-btn", type: "button", title: "التفاصيل", onclick: () => openDetail(transfer) }, icon("eye")),
              caps.canApprove && transfer.status === "pending"
                ? el("button", { class: "icon-btn success", type: "button", title: "اعتماد", onclick: (event) => decide(transfer, "approve", event.currentTarget) }, icon("circle-check"))
                : null,
              caps.canApprove && transfer.status === "pending"
                ? el("button", { class: "icon-btn danger", type: "button", title: "رفض", onclick: (event) => decide(transfer, "reject", event.currentTarget) }, icon("circle-x"))
                : null,
              caps.canManage && transfer.status === "pending"
                ? el("button", { class: "icon-btn", type: "button", title: "إلغاء", onclick: (event) => cancel(transfer, event.currentTarget) }, icon("close"))
                : null,
            ),
          ),
        ),
      )
    : [el("tr", {}, el("td", { colspan: "7", class: "empty-inline", text: "لا توجد تحويلات مطابقة." }))];

  const actions = caps.canManage
    ? [el("button", { class: "btn btn-primary", type: "button", onclick: () => openCreate() }, icon("plus"), "طلب نقل جديد")]
    : [];

  host.replaceChildren(
    pageEnter(
      pageHeader({ title: "التحويلات الوظيفية", subtitle: "نقل الموظف بين الفروع والأقسام بعد اعتماد الطلب، مع تطبيق تلقائي على الفرع الفعلي.", actions }),
      filters,
      summaryStrip([
        { label: "إجمالي الطلبات", value: data.total, tone: "blue", iconName: "arrow-left-right" },
        { label: "بانتظار الاعتماد", value: data.items.filter((item) => item.status === "pending").length, tone: "orange", iconName: "clock" },
        { label: "معتمدة", value: data.items.filter((item) => item.status === "approved").length, tone: "green", iconName: "circle-check" },
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
            el("thead", {}, el("tr", {}, ...["الموظف", "مسار النقل", "القسم الجديد", "تاريخ السريان", "السبب", "الحالة", "إجراءات"].map((label, index) => el("th", { class: index === 6 ? "no-print" : "", text: label })))),
            el("tbody", {}, ...rows),
          ),
        ),
        tablePagination({
          page: data.page,
          pageSize: data.pageSize,
          total: data.total,
          onPage: (page) => {
            transferState.page = page;
            renderTransfers(host, token);
          },
        }),
      ),
    ),
  );

  async function openCreate(employee = null) {
    let employees;
    try {
      employees = await loadEmployees(employee ? "" : transferState.branchId);
      if (employee) employees = [{ id: employee.id, employeeNo: employee.employeeNo, fullName: employee.fullName, branchId: employee.branchId }];
    } catch (error) {
      toast(friendlyError(error), "error");
      return;
    }
    openFormDialog({
      title: "طلب تحويل وظيفي",
      fields: transferFields(employees, { employee }),
      submitLabel: "إنشاء الطلب",
      size: "lg",
      onSubmit: async (values) => {
        await api("/api/transfers", {
          method: "POST",
          body: {
            employeeId: values.employeeId,
            toBranchId: values.toBranchId,
            toDepartmentId: values.toDepartmentId || "",
            effectiveDate: values.effectiveDate,
            reason: values.reason,
            notes: values.notes,
          },
        });
        toast("تم إنشاء طلب التحويل. ينتظر الاعتماد.", "success");
        renderTransfers(host, token);
      },
    });
  }

  function openDetail(transfer) {
    const attachments = attachmentsPanel({ ownerType: "transfer", ownerId: transfer.id, canEdit: caps.canManage && transfer.status === "pending" });
    openModal({
      title: `تحويل وظيفي — ${transfer.employeeName}`,
      size: "lg",
      body: el(
        "div",
        {},
        detailRows([
          ["الموظف", transfer.employeeName],
          ["الرقم الوظيفي", transfer.employeeNo],
          ["من فرع", transfer.fromBranch || "—"],
          ["إلى فرع", transfer.toBranch],
          ["من قسم", transfer.fromDepartment || "—"],
          ["إلى قسم", transfer.toDepartment || "—"],
          ["تاريخ السريان", formatDate(transfer.effectiveDate)],
          ["الحالة", statusTag(TRANSFER_STATUS, transfer.status)],
          ["مقدم الطلب", transfer.requestedBy || "—"],
          ["الاعتماد", transfer.approvedBy ? `${transfer.approvedBy} · ${formatDateTime(transfer.approvedAt)}` : "—"],
          ["تطبيق النقل", transfer.appliedAt ? formatDateTime(transfer.appliedAt) : "—"],
          ["ملاحظة القرار", transfer.decisionNote || "—"],
          ["السبب", transfer.reason || "—"],
          ["ملاحظات", transfer.notes || "—"],
        ]),
        attachments.node,
      ),
    });
  }

  async function decide(transfer, kind, button) {
    let reason = "";
    if (kind === "reject") {
      reason = await openReasonDialog({ title: "رفض طلب التحويل", label: "سبب الرفض", confirmLabel: "رفض", danger: true });
      if (!reason) return;
    }
    setButtonLoading(button, true, "جارٍ التنفيذ…");
    try {
      await api(`/api/transfers/${transfer.id}/${kind}`, { method: "POST", body: { reason } });
      toast(kind === "approve" ? "تم اعتماد التحويل وتطبيقه." : "تم رفض طلب التحويل.", "success");
      renderTransfers(host, token);
    } catch (error) {
      toast(friendlyError(error), "error");
      setButtonLoading(button, false);
    }
  }

  async function cancel(transfer, button) {
    const ok = await confirmDialog({ title: "إلغاء طلب التحويل", message: "سيُلغى الطلب ولن يُطبَّق النقل.", confirmLabel: "إلغاء", danger: true });
    if (!ok) return;
    setButtonLoading(button, true, "جارٍ الإلغاء…");
    try {
      await api(`/api/transfers/${transfer.id}/cancel`, { method: "POST", body: {} });
      toast("تم إلغاء طلب التحويل.", "success");
      renderTransfers(host, token);
    } catch (error) {
      toast(friendlyError(error), "error");
      setButtonLoading(button, false);
    }
  }
}
