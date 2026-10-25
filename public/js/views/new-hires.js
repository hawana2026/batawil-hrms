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
  NEW_HIRE_STATUS,
  attachmentsPanel,
  branchList,
  branchSelectOptions,
  departmentList,
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

let hireState = { page: 1, pageSize: 20, status: "all", branchId: "", q: "" };

function hireFields(hire = {}) {
  return [
    { name: "fullName", label: "اسم الموظف الجديد", required: true, minlength: 2, maxlength: 120, value: hire.fullName ?? "" },
    { name: "phone", label: "الهاتف", required: true, minlength: 6, maxlength: 30, dir: "ltr", value: hire.phone ?? "" },
    { name: "branchId", label: "الفرع", type: "select", required: true, options: branchList().filter((b) => b.active).map((b) => ({ value: b.id, label: b.name })), value: hire.branchId ?? branchList().find((b) => b.active)?.id ?? "" },
    { name: "departmentId", label: "القسم", type: "select", placeholder: "بدون قسم", options: departmentList().map((d) => ({ value: d.id, label: d.name })), value: hire.departmentId ?? "" },
    { name: "jobTitle", label: "المسمى الوظيفي", maxlength: 120, value: hire.jobTitle ?? "" },
    { name: "proposedSalary", label: "الراتب المقترح", type: "number", required: true, min: 0, max: 999999999, step: "0.01", value: hire.proposedSalary ?? 0 },
    { name: "startDate", label: "تاريخ المباشرة", type: "date", required: true, value: hire.startDate ?? todayISO() },
    { name: "notes", label: "ملاحظات", type: "textarea", maxlength: 2000, span: 2, value: hire.notes ?? "" },
  ];
}

export async function renderNewHires(host, token) {
  host.replaceChildren(loadingBlock("جارٍ تحميل الموظفين الجدد…"));
  const params = new URLSearchParams();
  params.set("page", String(hireState.page));
  params.set("pageSize", String(hireState.pageSize));
  if (hireState.status !== "all") params.set("status", hireState.status);
  if (hireState.branchId) params.set("branchId", hireState.branchId);
  if (hireState.q) params.set("q", hireState.q);
  let data;
  try {
    data = await api(`/api/new-hires?${params.toString()}`);
  } catch (error) {
    if (token !== state.renderToken) return;
    host.replaceChildren(errorBlock(friendlyError(error), () => renderNewHires(host, token)));
    return;
  }
  if (token !== state.renderToken) return;

  const caps = data.capabilities ?? {};
  const statusSelect = el(
    "select",
    { class: "select" },
    el("option", { value: "all", selected: hireState.status === "all" }, "كل الحالات"),
    ...Object.entries(NEW_HIRE_STATUS).map(([value, meta]) => el("option", { value, selected: hireState.status === value }, meta.label)),
  );
  const branchSelect = el("select", { class: "select" }, ...branchSelectOptions(hireState.branchId, { allLabel: "كل الفروع" }));
  const search = el("input", { class: "input", type: "search", value: hireState.q, placeholder: "الاسم أو الهاتف…" });
  const filters = filterBar(
    [
      { label: "الحالة", control: statusSelect },
      { label: "الفرع", control: branchSelect },
      { label: "بحث", control: search },
    ],
    {
      onApply: () => {
        hireState = { ...hireState, status: statusSelect.value, branchId: branchSelect.value, q: search.value.trim(), page: 1 };
        renderNewHires(host, token);
      },
      onReset: () => {
        hireState = { page: 1, pageSize: 20, status: "all", branchId: "", q: "" };
        renderNewHires(host, token);
      },
    },
  );

  const rows = data.items.length
    ? data.items.map((hire) =>
        el(
          "tr",
          {},
          el("td", {}, personCell(hire.fullName, hire.jobTitle, hire.employeeNo || "")),
          el("td", { class: "tiny", text: hire.branchName }),
          el("td", { class: "tiny", text: hire.departmentName || "—" }),
          el("td", { class: "num nowrap", text: money(hire.proposedSalary) }),
          el("td", { class: "tiny nowrap", text: formatDate(hire.startDate) }),
          el("td", {}, statusTag(NEW_HIRE_STATUS, hire.status)),
          el("td", { class: "tiny", text: hire.requestedBy || "—" }),
          el(
            "td",
            { class: "no-print" },
            el(
              "div",
              { class: "inline-actions" },
              el("button", { class: "icon-btn", type: "button", title: "التفاصيل", onclick: () => openDetail(hire) }, icon("eye")),
              caps.canManage && ["draft", "rejected"].includes(hire.status)
                ? el("button", { class: "icon-btn", type: "button", title: "تعديل", onclick: () => openEdit(hire) }, icon("pencil"))
                : null,
              caps.canManage && ["draft", "rejected"].includes(hire.status)
                ? el("button", { class: "icon-btn", type: "button", title: "إرسال", onclick: (event) => submitHire(hire, event.currentTarget) }, icon("send"))
                : null,
              caps.canApprove && hire.status === "pending"
                ? el("button", { class: "icon-btn success", type: "button", title: "اعتماد وتوظيف", onclick: (event) => decide(hire, "approve", event.currentTarget) }, icon("circle-check"))
                : null,
              caps.canApprove && hire.status === "pending"
                ? el("button", { class: "icon-btn danger", type: "button", title: "رفض", onclick: (event) => decide(hire, "reject", event.currentTarget) }, icon("circle-x"))
                : null,
              caps.canManage && ["draft", "pending"].includes(hire.status)
                ? el("button", { class: "icon-btn", type: "button", title: "إلغاء", onclick: (event) => cancelHire(hire, event.currentTarget) }, icon("close"))
                : null,
            ),
          ),
        ),
      )
    : [el("tr", {}, el("td", { colspan: "8", class: "empty-inline", text: "لا توجد طلبات توظيف مطابقة." }))];

  const actions = caps.canManage
    ? [el("button", { class: "btn btn-primary", type: "button", onclick: () => openCreate() }, icon("user-plus"), "موظف جديد")]
    : [];

  host.replaceChildren(
    pageEnter(
      pageHeader({ title: "الموظفون الجدد", subtitle: "طلبات التوظيف تُنشئ سجل الموظف ورقيبه الوظيفي تلقائياً بعد الاعتماد.", actions }),
      filters,
      summaryStrip([
        { label: "إجمالي الطلبات", value: data.total, tone: "blue", iconName: "user-plus" },
        { label: "بانتظار الاعتماد", value: data.items.filter((item) => item.status === "pending").length, tone: "orange", iconName: "clock" },
        { label: "معتمدة", value: data.items.filter((item) => item.status === "approved").length, tone: "green", iconName: "circle-check" },
        { label: "مؤرشفة كمسودة", value: data.items.filter((item) => item.status === "draft").length, tone: "neutral", iconName: "file-text" },
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
            el("thead", {}, el("tr", {}, ...["الاسم", "الفرع", "القسم", "الراتب المقترح", "المباشرة", "الحالة", "مقدم الطلب", "إجراءات"].map((label, index) => el("th", { class: index === 7 ? "no-print" : "", text: label })))),
            el("tbody", {}, ...rows),
          ),
        ),
        tablePagination({
          page: data.page,
          pageSize: data.pageSize,
          total: data.total,
          onPage: (page) => {
            hireState.page = page;
            renderNewHires(host, token);
          },
        }),
      ),
    ),
  );

  function openCreate() {
    openFormDialog({
      title: "طلب توظيف موظف جديد",
      description: "بعد الاعتماد يُنشأ سجل موظف فعلي برقم وظيفي ويظهر في التحضير والرواتب.",
      fields: hireFields(),
      submitLabel: "حفظ الطلب",
      size: "lg",
      onSubmit: async (values) => {
        await api("/api/new-hires", {
          method: "POST",
          body: {
            fullName: values.fullName,
            phone: values.phone,
            branchId: values.branchId,
            departmentId: values.departmentId || undefined,
            jobTitle: values.jobTitle,
            proposedSalary: Number(values.proposedSalary || 0),
            startDate: values.startDate,
            notes: values.notes,
          },
        });
        toast("تم حفظ طلب التوظيف.", "success");
        renderNewHires(host, token);
      },
    });
  }

  function openEdit(hire) {
    openFormDialog({
      title: `تعديل طلب التوظيف — ${hire.fullName}`,
      fields: hireFields(hire),
      submitLabel: "حفظ التعديلات",
      size: "lg",
      onSubmit: async (values) => {
        await api(`/api/new-hires/${hire.id}`, {
          method: "PATCH",
          body: {
            fullName: values.fullName,
            phone: values.phone,
            branchId: values.branchId,
            departmentId: values.departmentId || "",
            jobTitle: values.jobTitle,
            proposedSalary: Number(values.proposedSalary || 0),
            startDate: values.startDate,
            notes: values.notes,
          },
        });
        toast("تم تحديث طلب التوظيف.", "success");
        renderNewHires(host, token);
      },
    });
  }

  function openDetail(hire) {
    const attachments = attachmentsPanel({ ownerType: "new_hire", ownerId: hire.id, canEdit: caps.canManage && ["draft", "rejected"].includes(hire.status) });
    openModal({
      title: `طلب توظيف — ${hire.fullName}`,
      size: "lg",
      body: el(
        "div",
        {},
        detailRows([
          ["الاسم", hire.fullName],
          ["الهاتف", hire.phone],
          ["الفرع", hire.branchName],
          ["القسم", hire.departmentName || "—"],
          ["المسمى", hire.jobTitle || "—"],
          ["الراتب المقترح", money(hire.proposedSalary)],
          ["تاريخ المباشرة", formatDate(hire.startDate)],
          ["الحالة", statusTag(NEW_HIRE_STATUS, hire.status)],
          ["مقدم الطلب", hire.requestedBy || "—"],
          ["الاعتماد", hire.approvedBy ? `${hire.approvedBy} · ${formatDateTime(hire.approvedAt)}` : "—"],
          ["الرقم الوظيفي الناتج", hire.employeeNo || "—"],
          ["ملاحظة القرار", hire.decisionNote || "—"],
          ["ملاحظات", hire.notes || "—"],
        ]),
        attachments.node,
      ),
    });
  }

  async function submitHire(hire, button) {
    setButtonLoading(button, true, "جارٍ الإرسال…");
    try {
      await api(`/api/new-hires/${hire.id}/submit`, { method: "POST", body: {} });
      toast("تم إرسال طلب التوظيف للاعتماد.", "success");
      renderNewHires(host, token);
    } catch (error) {
      toast(friendlyError(error), "error");
      setButtonLoading(button, false);
    }
  }

  async function decide(hire, kind, button) {
    let reason = "";
    if (kind === "reject") {
      reason = await openReasonDialog({ title: "رفض طلب التوظيف", label: "سبب الرفض", confirmLabel: "رفض", danger: true });
      if (!reason) return;
    } else {
      const ok = await confirmDialog({ title: "اعتماد التوظيف", message: `سيُنشأ سجل موظف لـ ${hire.fullName} برقم وظيفي جديد.`, confirmLabel: "اعتماد وتوظيف" });
      if (!ok) return;
    }
    setButtonLoading(button, true, "جارٍ التنفيذ…");
    try {
      const result = await api(`/api/new-hires/${hire.id}/${kind}`, { method: "POST", body: { reason } });
      toast(kind === "approve" ? `تم اعتماد التوظيف. الرقم الوظيفي: ${result.employeeNo}.` : "تم رفض طلب التوظيف.", "success");
      renderNewHires(host, token);
    } catch (error) {
      toast(friendlyError(error), "error");
      setButtonLoading(button, false);
    }
  }

  async function cancelHire(hire, button) {
    const ok = await confirmDialog({ title: "إلغاء طلب التوظيف", message: "سيُلغى الطلب ولا يمكن اعتماده لاحقاً.", confirmLabel: "إلغاء", danger: true });
    if (!ok) return;
    setButtonLoading(button, true, "جارٍ الإلغاء…");
    try {
      await api(`/api/new-hires/${hire.id}/cancel`, { method: "POST", body: {} });
      toast("تم إلغاء طلب التوظيف.", "success");
      renderNewHires(host, token);
    } catch (error) {
      toast(friendlyError(error), "error");
      setButtonLoading(button, false);
    }
  }
}
