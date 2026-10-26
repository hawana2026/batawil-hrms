import {
  alertBox,
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
import { refreshMeta, state } from "../state.js";
import { friendlyError, pageEnter, tablePagination } from "../ui.js";
import {
  LEAVE_STATUS,
  LEAVE_TYPES,
  attachmentsPanel,
  branchList,
  branchSelectOptions,
  deleteRecordButton,
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

function leaveTypeOptions() {
  const types = state.meta?.leaveTypes ?? [];
  if (types.length) return types;
  return Object.entries(LEAVE_TYPES).map(([code, name]) => ({ id: code, code, name, annualEntitlement: 0, trackBalance: false }));
}

function leaveTypeLabel(type) {
  return leaveTypeOptions().find((item) => item.code === type)?.name ?? LEAVE_TYPES[type] ?? type;
}

function leaveTypeIdForCode(code) {
  return leaveTypeOptions().find((item) => item.code === code)?.id ?? "";
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function leaveTypeBody(selected) {
  const type = leaveTypeOptions().find((item) => (item.id && item.id === selected) || item.code === selected);
  return {
    ...(UUID_PATTERN.test(selected) ? { leaveTypeId: selected } : {}),
    ...(type ? { leaveType: type.code } : {}),
  };
}

async function loadEmployees() {
  const result = await api("/api/employees/options");
  return result.items.map((item) => ({ value: item.id, label: `${item.fullName} — ${item.employeeNo}` }));
}

function leaveFields(leave, employeeOptions) {
  const types = leaveTypeOptions();
  const selected = leave.leaveType ? leaveTypeIdForCode(leave.leaveType) || leave.leaveType : types[0]?.id || types[0]?.code || "";
  return [
    { name: "employeeId", label: "الموظف", type: "select", required: true, options: employeeOptions, value: leave.employeeId ?? "" },
    {
      name: "leaveTypeId",
      label: "نوع الطلب",
      type: "select",
      required: true,
      options: types.map((type) => ({
        value: type.id || type.code,
        label: type.trackBalance ? `${type.name} (${formatNumber(type.annualEntitlement)} يوم)` : type.name,
      })),
      value: selected,
    },
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
    ...leaveTypeOptions().map((type) => el("option", { value: type.code, selected: leaveState.type === type.code }, type.name)),
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
    actions.push(el("button", { class: "btn btn-ghost", type: "button", onclick: () => openLeaveTypes() }, icon("calendar"), "أنواع الإجازات"));
    actions.push(el("button", { class: "btn btn-primary", type: "button", onclick: () => openCreate() }, icon("plus"), "طلب جديد"));
  }

  const rows = data.items.length
    ? data.items.map((leave) =>
        el(
          "tr",
          {},
          el("td", {}, personCell(leave.employeeName, leave.branchName, leave.employeeNo)),
          el("td", {}, el("span", { class: "tag", text: leave.leaveTypeName ?? leaveTypeLabel(leave.leaveType) })),
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
              deleteRecordButton({
                entity: "leave",
                id: leave.id,
                label: `طلب ${leaveTypeLabel(leave.leaveType)} للموظف ${leave.employeeName}`,
                onDeleted: () => renderLeaves(host, token),
              }),
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
      description: "تُخصم أرصدة الأنواع المحسوبة عند الاعتماد، ويُمنع الاعتماد إذا كان الرصيد غير كافٍ.",
      fields: leaveFields({}, employees),
      submitLabel: "حفظ الطلب",
      size: "lg",
      onSubmit: async (values) => {
        await api("/api/leaves", {
          method: "POST",
          body: {
            employeeId: values.employeeId,
            ...leaveTypeBody(values.leaveTypeId),
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
            ...leaveTypeBody(values.leaveTypeId),
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
          ["النوع", leave.leaveTypeName ?? leaveTypeLabel(leave.leaveType)],
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

  async function openLeaveTypes() {
    let result;
    try {
      result = await api("/api/leave-types");
    } catch (error) {
      toast(friendlyError(error), "error");
      return;
    }
    const listHost = el("div");
    const errorHost = el("div");
    const addButton = el("button", { class: "btn btn-primary", type: "button" }, icon("plus"), "نوع جديد");

    const typeFormFields = (type) => [
      { name: "name", label: "اسم النوع", required: true, maxlength: 120, value: type?.name ?? "" },
      { name: "code", label: "الرمز (إنجليزي)", required: true, maxlength: 40, dir: "ltr", value: type?.code ?? "" },
      { name: "annualEntitlement", label: "الاستحقاق السنوي (يوم)", type: "number", min: 0, max: 366, step: "1", value: type?.annualEntitlement ?? 0 },
      { name: "sortOrder", label: "ترتيب العرض", type: "number", min: 0, max: 9999, step: "1", value: type?.sortOrder ?? 0 },
      { name: "trackBalance", label: "يحسب رصيداً ويُخصم عند الاعتماد", type: "checkbox", checked: type ? type.trackBalance : true, span: 2 },
      { name: "paid", label: "إجازة مدفوعة", type: "checkbox", checked: type ? type.paid : true },
      { name: "requiresDocument", label: "يتطلب مستنداً قبل الإرسال", type: "checkbox", checked: type?.requiresDocument ?? false },
      ...(type ? [{ name: "active", label: "نشط للاختيار", type: "checkbox", checked: type.active, span: 2 }] : []),
    ];

    const openForm = (type = null) => {
      openFormDialog({
        title: type ? `تعديل نوع الإجازة — ${type.name}` : "إضافة نوع إجازة",
        description: "الاستحقاق يُطبَّق على الأرصدة الجديدة، والتعديلات اليدوية تُسجَّل في حركات الرصيد.",
        fields: typeFormFields(type),
        submitLabel: type ? "حفظ التعديلات" : "إضافة النوع",
        size: "lg",
        onSubmit: async (values) => {
          const body = {
            name: values.name,
            code: values.code,
            annualEntitlement: Number(values.annualEntitlement || 0),
            sortOrder: Number(values.sortOrder || 0),
            trackBalance: Boolean(values.trackBalance),
            paid: Boolean(values.paid),
            requiresDocument: Boolean(values.requiresDocument),
            ...(type ? { active: Boolean(values.active) } : { active: true }),
          };
          if (type) {
            await api(`/api/leave-types/${type.id}`, { method: "PATCH", body });
            toast("تم تحديث نوع الإجازة.", "success");
          } else {
            await api("/api/leave-types", { method: "POST", body });
            toast("تمت إضافة نوع الإجازة.", "success");
          }
          await refreshMeta();
          const refreshed = await api("/api/leave-types");
          renderList(refreshed.items);
        },
      });
    };

    const renderList = (items) => {
      if (!items.length) {
        listHost.replaceChildren(el("p", { class: "tiny muted", text: "لا توجد أنواع إجازات بعد." }));
        return;
      }
      listHost.replaceChildren(
        ...items.map((type) =>
          el(
            "div",
            { class: "attachment-item" },
            icon("calendar"),
            el(
              "div",
              { class: "attachment-copy" },
              el("strong", { text: `${type.name} · ${type.code}` }),
              el("span", {
                text: [
                  type.trackBalance ? `رصيد ${formatNumber(type.annualEntitlement)} يوم` : "بدون رصيد",
                  type.paid ? "مدفوعة" : "بدون راتب",
                  type.requiresDocument ? "تتطلب مستنداً" : "",
                  `${formatNumber(type.requestsCount)} طلب`,
                  type.active ? "" : "معطّل",
                ]
                  .filter(Boolean)
                  .join(" · "),
              }),
            ),
            el(
              "div",
              { class: "inline-actions" },
              el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => openForm(type) }, "تعديل"),
              el(
                "button",
                {
                  class: "btn btn-ghost btn-sm",
                  type: "button",
                  onclick: async () => {
                    try {
                      await api(`/api/leave-types/${type.id}`, { method: "PATCH", body: { active: !type.active } });
                      await refreshMeta();
                      const refreshed = await api("/api/leave-types");
                      renderList(refreshed.items);
                      toast(type.active ? "تم تعطيل النوع." : "تم تفعيل النوع.", "success");
                    } catch (error) {
                      errorHost.replaceChildren(alertBox(friendlyError(error), "error"));
                    }
                  },
                },
                type.active ? "تعطيل" : "تفعيل",
              ),
            ),
          ),
        ),
      );
    };

    addButton.addEventListener("click", () => openForm());
    renderList(result.items);
    openModal({
      title: "أنواع الإجازات والأرصدة",
      description: "الأنواع المعتمدة تظهر في نموذج الطلب. الأنواع التي تحسب رصيداً تُخصم عند الاعتماد وتُمنع إذا كان الرصيد غير كافٍ.",
      body: el("div", {}, errorHost, el("div", { class: "page-tools", style: "margin-bottom:12px" }, addButton), listHost),
      size: "lg",
    });
  }
}
