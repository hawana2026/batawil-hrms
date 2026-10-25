import {
  api,
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
  ADVANCE_STATUS,
  attachmentsPanel,
  branchSelectOptions,
  detailRows,
  filterBar,
  money,
  openFormDialog,
  openReasonDialog,
  personCell,
  statusTag,
  summaryStrip,
  todayISO,
} from "../hr-common.js";

let advanceState = { page: 1, pageSize: 20, status: "all", branchId: "", q: "" };

async function loadEmployees() {
  const result = await api("/api/employees/options");
  return result.items.map((item) => ({ value: item.id, label: `${item.fullName} — ${item.employeeNo}` }));
}

function advanceFields(advance, employees) {
  return [
    { name: "employeeId", label: "الموظف", type: "select", required: true, options: employees, value: advance.employeeId ?? "" },
    { name: "amount", label: "قيمة السلفة", type: "number", required: true, min: 1, max: 99999999, step: "0.01", value: advance.amount ?? "" },
    { name: "requestDate", label: "تاريخ الطلب", type: "date", required: true, value: advance.requestDate ?? todayISO() },
    { name: "installments", label: "عدد الأقساط", type: "number", required: true, min: 1, max: 60, value: advance.installments ?? 1 },
    { name: "deductionMethod", label: "طريقة الخصم", type: "select", required: true, options: [{ value: "installments", label: "أقساط" }, { value: "one_time", label: "خصم دفعة واحدة" }], value: advance.deductionMethod ?? "installments" },
    { name: "reason", label: "سبب السلفة", type: "textarea", required: true, minlength: 3, maxlength: 1000, span: 2, value: advance.reason ?? "" },
    { name: "notes", label: "ملاحظات", type: "textarea", maxlength: 2000, span: 2, value: advance.notes ?? "" },
  ];
}

export async function renderAdvances(host, token) {
  host.replaceChildren(loadingBlock("جارٍ تحميل السلف المالية…"));
  const params = new URLSearchParams();
  params.set("page", String(advanceState.page));
  params.set("pageSize", String(advanceState.pageSize));
  if (advanceState.status !== "all") params.set("status", advanceState.status);
  if (advanceState.branchId) params.set("branchId", advanceState.branchId);
  if (advanceState.q) params.set("q", advanceState.q);
  let data;
  try {
    data = await api(`/api/advances?${params.toString()}`);
  } catch (error) {
    if (token !== state.renderToken) return;
    host.replaceChildren(errorBlock(friendlyError(error), () => renderAdvances(host, token)));
    return;
  }
  if (token !== state.renderToken) return;

  const caps = data.capabilities ?? {};
  const statusSelect = el(
    "select",
    { class: "select" },
    el("option", { value: "all", selected: advanceState.status === "all" }, "كل الحالات"),
    ...Object.entries(ADVANCE_STATUS).map(([value, meta]) => el("option", { value, selected: advanceState.status === value }, meta.label)),
  );
  const branchSelect = el("select", { class: "select" }, ...branchSelectOptions(advanceState.branchId, { allLabel: "كل الفروع" }));
  const search = el("input", { class: "input", type: "search", value: advanceState.q, placeholder: "الموظف أو الرقم…" });
  const filters = filterBar(
    [
      { label: "الحالة", control: statusSelect },
      { label: "الفرع", control: branchSelect },
      { label: "بحث", control: search },
    ],
    {
      onApply: () => {
        advanceState = { ...advanceState, status: statusSelect.value, branchId: branchSelect.value, q: search.value.trim(), page: 1 };
        renderAdvances(host, token);
      },
      onReset: () => {
        advanceState = { page: 1, pageSize: 20, status: "all", branchId: "", q: "" };
        renderAdvances(host, token);
      },
    },
  );

  const rows = data.items.length
    ? data.items.map((advance) => {
        const approveStage =
          (advance.status === "pending_hr" && caps.canApproveHr) || (advance.status === "pending_finance" && caps.canApproveFinance);
        return el(
          "tr",
          {},
          el("td", {}, personCell(advance.employeeName, advance.branchName, advance.employeeNo)),
          el("td", { class: "num nowrap", text: money(advance.amount) }),
          el("td", { class: "num nowrap", text: money(advance.deducted) }),
          el("td", { class: "num nowrap", text: money(advance.remaining) }),
          el("td", { class: "num", text: formatNumber(advance.installments) }),
          el("td", { class: "tiny nowrap", text: formatDate(advance.requestDate) }),
          el("td", {}, statusTag(ADVANCE_STATUS, advance.status)),
          el(
            "td",
            { class: "no-print" },
            el(
              "div",
              { class: "inline-actions" },
              el("button", { class: "icon-btn", type: "button", title: "التفاصيل والحركات", onclick: () => openDetail(advance) }, icon("eye")),
              caps.canManage && ["draft", "rejected"].includes(advance.status)
                ? el("button", { class: "icon-btn", type: "button", title: "تعديل", onclick: () => openEdit(advance) }, icon("pencil"))
                : null,
              caps.canManage && ["draft", "rejected"].includes(advance.status)
                ? el("button", { class: "icon-btn", type: "button", title: "إرسال", onclick: (event) => submitAdvance(advance, event.currentTarget) }, icon("send"))
                : null,
              approveStage
                ? el("button", { class: "icon-btn success", type: "button", title: "اعتماد المرحلة", onclick: (event) => approve(advance, event.currentTarget) }, icon("circle-check"))
                : null,
              approveStage || (advance.status === "pending_hr" && caps.canApproveHr)
                ? el("button", { class: "icon-btn danger", type: "button", title: "رفض", onclick: (event) => reject(advance, event.currentTarget) }, icon("circle-x"))
                : null,
              caps.canDisburse && ["approved", "disbursed"].includes(advance.status)
                ? el("button", { class: "icon-btn", type: "button", title: "صرف السلفة", onclick: () => disburse(advance) }, icon("banknote"))
                : null,
              caps.canDisburse && advance.status === "disbursed" && advance.remaining > 0
                ? el("button", { class: "icon-btn", type: "button", title: "تسجيل خصم", onclick: () => addDeduction(advance) }, icon("wallet"))
                : null,
            ),
          ),
        );
      })
    : [el("tr", {}, el("td", { colspan: "8", class: "empty-inline", text: "لا توجد سلف مطابقة." }))];

  const actions = caps.canManage
    ? [el("button", { class: "btn btn-primary", type: "button", onclick: () => openCreate() }, icon("plus"), "سلفة جديدة")]
    : [];

  host.replaceChildren(
    pageEnter(
      pageHeader({
        title: "السلف المالية",
        subtitle: "دورة كاملة: طلب، اعتماد موارد بشرية، اعتماد مالية، صرف، ثم خصم الأقساط.",
        actions,
      }),
      filters,
      summaryStrip([
        { label: "السلف المعتمدة", value: data.totals?.approvedCount ?? 0, tone: "blue", iconName: "wallet" },
        { label: "إجمالي المعتمد", value: money(data.totals?.approvedAmount ?? 0), tone: "green", iconName: "banknote" },
        { label: "المخصوم", value: money(data.totals?.deducted ?? 0), tone: "purple", iconName: "check" },
        { label: "المتبقي", value: money(data.totals?.outstanding ?? 0), tone: "orange", iconName: "trending-up" },
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
            el("thead", {}, el("tr", {}, ...["الموظف", "القيمة", "المخصوم", "المتبقي", "الأقساط", "تاريخ الطلب", "الحالة", "إجراءات"].map((label, index) => el("th", { class: index === 7 ? "no-print" : "", text: label })))),
            el("tbody", {}, ...rows),
          ),
        ),
        tablePagination({
          page: data.page,
          pageSize: data.pageSize,
          total: data.total,
          onPage: (page) => {
            advanceState.page = page;
            renderAdvances(host, token);
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
      title: "طلب سلفة مالية",
      fields: advanceFields({}, employees),
      submitLabel: "حفظ الطلب",
      size: "lg",
      onSubmit: async (values) => {
        await api("/api/advances", {
          method: "POST",
          body: {
            employeeId: values.employeeId,
            amount: Number(values.amount || 0),
            reason: values.reason,
            requestDate: values.requestDate,
            installments: Number(values.installments || 1),
            deductionMethod: values.deductionMethod,
            notes: values.notes,
          },
        });
        toast("تم حفظ طلب السلفة. أرسله للاعتماد.", "success");
        renderAdvances(host, token);
      },
    });
  }

  async function openEdit(advance) {
    let employees;
    try {
      employees = await loadEmployees();
    } catch (error) {
      toast(friendlyError(error), "error");
      return;
    }
    openFormDialog({
      title: `تعديل سلفة — ${advance.employeeName}`,
      fields: advanceFields(advance, employees),
      submitLabel: "حفظ التعديلات",
      size: "lg",
      onSubmit: async (values) => {
        await api(`/api/advances/${advance.id}`, {
          method: "PATCH",
          body: {
            employeeId: values.employeeId,
            amount: Number(values.amount || 0),
            reason: values.reason,
            requestDate: values.requestDate,
            installments: Number(values.installments || 1),
            deductionMethod: values.deductionMethod,
            notes: values.notes,
          },
        });
        toast("تم تحديث طلب السلفة.", "success");
        renderAdvances(host, token);
      },
    });
  }

  async function openDetail(advance) {
    let detail;
    try {
      detail = await api(`/api/advances/${advance.id}/movements`);
    } catch (error) {
      toast(friendlyError(error), "error");
      return;
    }
    const movements = detail.movements ?? [];
    const movementsTable = movements.length
      ? el(
          "div",
          { class: "table-wrap" },
          el(
            "table",
            { class: "att-table" },
            el("thead", {}, el("tr", {}, ...["النوع", "المبلغ", "التاريخ", "ملاحظات", "بواسطة"].map((label) => el("th", { text: label })))),
            el(
              "tbody",
              {},
              ...movements.map((movement) =>
                el(
                  "tr",
                  {},
                  el("td", {}, el("span", { class: `tag ${movement.type === "disbursement" ? "brand" : "success"}`.trim(), text: movement.type === "disbursement" ? "صرف" : "خصم" })),
                  el("td", { class: "num", text: money(movement.amount) }),
                  el("td", { class: "tiny", text: formatDate(movement.transactionDate) }),
                  el("td", { class: "tiny", text: movement.notes || "—" }),
                  el("td", { class: "tiny", text: movement.createdBy || "—" }),
                ),
              ),
            ),
          ),
        )
      : el("p", { class: "tiny muted", text: "لا توجد حركات صرف أو خصم بعد." });
    const attachments = attachmentsPanel({ ownerType: "advance", ownerId: advance.id, canEdit: caps.canManage && ["draft", "rejected"].includes(advance.status) });
    openModal({
      title: `سلفة — ${advance.employeeName}`,
      size: "lg",
      body: el(
        "div",
        {},
        detailRows([
          ["الموظف", advance.employeeName],
          ["الفرع", advance.branchName],
          ["القيمة", money(advance.amount)],
          ["تاريخ الطلب", formatDate(advance.requestDate)],
          ["الأقساط", formatNumber(advance.installments)],
          ["طريقة الخصم", advance.deductionMethod === "one_time" ? "خصم دفعة واحدة" : "أقساط"],
          ["الحالة", statusTag(ADVANCE_STATUS, advance.status)],
          ["المصروف", money(advance.disbursedAmount)],
          ["المخصوم", money(advance.deducted)],
          ["المتبقي", money(advance.remaining)],
          ["اعتماد الموارد البشرية", advance.hrApprovedBy ? `${advance.hrApprovedBy} · ${formatDateTime(advance.hrApprovedAt)}` : "—"],
          ["اعتماد المالية", advance.financeApprovedBy ? `${advance.financeApprovedBy} · ${formatDateTime(advance.financeApprovedAt)}` : "—"],
          ["الصرف", advance.disbursedBy ? `${advance.disbursedBy} · ${formatDateTime(advance.disbursedAt)}` : "—"],
          ["ملاحظة القرار", advance.decisionNote || "—"],
          ["السبب", advance.reason || "—"],
        ]),
        el("div", { class: "section-head" }, el("h3", { class: "section-title" }, icon("wallet"), "حركات الصرف والخصم")),
        movementsTable,
        attachments.node,
      ),
    });
  }

  async function submitAdvance(advance, button) {
    setButtonLoading(button, true, "جارٍ الإرسال…");
    try {
      await api(`/api/advances/${advance.id}/submit`, { method: "POST", body: {} });
      toast("تم إرسال طلب السلفة للاعتماد.", "success");
      renderAdvances(host, token);
    } catch (error) {
      toast(friendlyError(error), "error");
      setButtonLoading(button, false);
    }
  }

  async function approve(advance, button) {
    setButtonLoading(button, true, "جارٍ الاعتماد…");
    try {
      const result = await api(`/api/advances/${advance.id}/approve`, { method: "POST", body: {} });
      toast(result.stage === "pending_finance" ? "تم اعتماد الموارد البشرية. السلفة الآن بانتظار المالية." : "تم اعتماد السلفة.", "success");
      renderAdvances(host, token);
    } catch (error) {
      toast(friendlyError(error), "error");
      setButtonLoading(button, false);
    }
  }

  async function reject(advance, button) {
    const reason = await openReasonDialog({ title: "رفض طلب السلفة", label: "سبب الرفض", confirmLabel: "رفض", danger: true });
    if (!reason) return;
    setButtonLoading(button, true, "جارٍ الرفض…");
    try {
      await api(`/api/advances/${advance.id}/reject`, { method: "POST", body: { reason } });
      toast("تم رفض طلب السلفة.", "success");
      renderAdvances(host, token);
    } catch (error) {
      toast(friendlyError(error), "error");
      setButtonLoading(button, false);
    }
  }

  function disburse(advance) {
    openFormDialog({
      title: `صرف سلفة — ${advance.employeeName}`,
      description: `القيمة المعتمدة ${money(advance.amount)}. سيُسجَّل الصرف في حركات السلفة.`,
      fields: [
        { name: "transactionDate", label: "تاريخ الصرف", type: "date", required: true, value: todayISO() },
        { name: "notes", label: "ملاحظات", type: "textarea", maxlength: 1000, span: 2 },
      ],
      submitLabel: "تسجيل الصرف",
      submitIcon: "banknote",
      onSubmit: async (values) => {
        await api(`/api/advances/${advance.id}/disburse`, { method: "POST", body: { transactionDate: values.transactionDate, notes: values.notes } });
        toast("تم تسجيل صرف السلفة.", "success");
        renderAdvances(host, token);
      },
    });
  }

  function addDeduction(advance) {
    openFormDialog({
      title: `تسجيل خصم — ${advance.employeeName}`,
      description: `المتبقي ${money(advance.remaining)}. لن يُسمح بتجاوز المتبقي.`,
      fields: [
        { name: "amount", label: "مبلغ الخصم", type: "number", required: true, min: 1, max: advance.remaining, step: "0.01" },
        { name: "transactionDate", label: "تاريخ الخصم", type: "date", required: true, value: todayISO() },
        { name: "notes", label: "ملاحظات", type: "textarea", maxlength: 2000, span: 2 },
      ],
      submitLabel: "تسجيل الخصم",
      submitIcon: "wallet",
      onSubmit: async (values) => {
        const result = await api(`/api/advances/${advance.id}/deductions`, {
          method: "POST",
          body: { amount: Number(values.amount || 0), transactionDate: values.transactionDate, notes: values.notes },
        });
        toast(`تم تسجيل الخصم. المتبقي: ${money(result.remaining)}.`, "success");
        renderAdvances(host, token);
      },
    });
  }
}
