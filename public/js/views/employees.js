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
import { can, refreshMeta, state } from "../state.js";
import { friendlyError, pageEnter, tablePagination } from "../ui.js";
import {
  EMP_STATUS,
  attachmentsPanel,
  branchList,
  branchSelectOptions,
  canDeleteRecords,
  deleteRecord,
  deleteRecordButton,
  departmentList,
  detailRows,
  downloadFile,
  empTag,
  filterBar,
  money,
  openFormDialog,
  openReasonDialog,
  personCell,
  statusTag,
  summaryStrip,
} from "../hr-common.js";

const PAGE_SIZE = 20;

function options(items, selected = "", placeholder = "") {
  const nodes = [];
  if (placeholder) nodes.push(el("option", { value: "" }, placeholder));
  for (const item of items) {
    const value = item.value ?? item.id;
    const label = item.label ?? item.name;
    nodes.push(el("option", { value, selected: value === selected, disabled: item.active === false }, label));
  }
  return nodes;
}

function employeeFields(employee = {}, { create = false } = {}) {
  return [
    ...(create
      ? [{ name: "employeeNo", label: "الرقم الوظيفي", hint: "اتركه فارغاً لتوليده تلقائياً", maxlength: 30, dir: "ltr" }]
      : []),
    { name: "fullName", label: "الاسم الكامل", required: true, minlength: 2, maxlength: 120, value: employee.fullName ?? "" },
    { name: "phone", label: "الهاتف", required: true, minlength: 6, maxlength: 30, dir: "ltr", value: employee.phone ?? "" },
    { name: "nationalId", label: "الرقم الوطني", maxlength: 30, dir: "ltr", value: employee.nationalId ?? "" },
    ...(create
      ? [{ name: "branchId", label: "الفرع", type: "select", required: true, options: branchList().filter((b) => b.active).map((b) => ({ value: b.id, label: b.name })), value: employee.branchId ?? branchList().find((b) => b.active)?.id ?? "" }]
      : []),
    {
      name: "departmentId",
      label: "القسم",
      type: "select",
      options: departmentList().map((d) => ({ value: d.id, label: d.name })),
      placeholder: "بدون قسم",
      value: employee.departmentId ?? "",
    },
    { name: "jobTitle", label: "المسمى الوظيفي", maxlength: 120, value: employee.jobTitle ?? "" },
    { name: "hireDate", label: "تاريخ التعيين", type: "date", required: true, value: employee.hireDate ?? "" },
    { name: "baseSalary", label: "الراتب الأساسي", type: "number", min: 0, max: 999999999, step: "0.01", required: true, value: employee.baseSalary ?? 0 },
    {
      name: "status",
      label: "الحالة الوظيفية",
      type: "select",
      options: Object.entries(EMP_STATUS).map(([value, meta]) => ({ value, label: meta.label })),
      value: employee.status ?? "active",
    },
    { name: "notes", label: "ملاحظات", type: "textarea", maxlength: 2000, span: 2, value: employee.notes ?? "" },
  ];
}

export async function renderEmployees(host, token) {
  const query = state.employees ?? {
    q: "",
    branchId: "",
    departmentId: "",
    status: "all",
    includeArchived: false,
    page: 1,
    pageSize: PAGE_SIZE,
  };
  state.employees = query;
  host.replaceChildren(loadingBlock("جارٍ تحميل الموظفين…"));
  let data;
  try {
    data = await loadEmployees(query);
  } catch (error) {
    if (token !== state.renderToken) return;
    host.replaceChildren(errorBlock(friendlyError(error), () => renderEmployees(host, token)));
    return;
  }
  if (token !== state.renderToken) return;

  const canManage = can("employees.manage");
  const canViewTransfers = can("transfers.view");
  const search = el("input", { class: "input", type: "search", value: query.q, placeholder: "الاسم، الرقم الوظيفي، الهاتف…", "aria-label": "بحث" });
  const branchSelect = el("select", { class: "select" }, ...branchSelectOptions(query.branchId, { allLabel: "كل الفروع" }));
  const departmentSelect = el("select", { class: "select" }, ...options(departmentList(), query.departmentId, "كل الأقسام"));
  const statusSelect = el(
    "select",
    { class: "select" },
    el("option", { value: "all", selected: query.status === "all" }, "كل الحالات"),
    ...Object.entries(EMP_STATUS).map(([value, meta]) => el("option", { value, selected: query.status === value }, meta.label)),
  );
  const archived = el("input", { type: "checkbox", checked: query.includeArchived });
  const applyFilters = () => {
    state.employees = {
      ...query,
      q: search.value.trim(),
      branchId: branchSelect.value,
      departmentId: departmentSelect.value,
      status: statusSelect.value,
      includeArchived: archived.checked,
      page: 1,
    };
    renderEmployees(host, token);
  };
  const filters = filterBar(
    [
      { label: "بحث", control: search },
      { label: "الفرع", control: branchSelect },
      { label: "القسم", control: departmentSelect },
      { label: "الحالة", control: statusSelect },
    ],
    {
      onApply: applyFilters,
      onReset: () => {
        state.employees = { q: "", branchId: "", departmentId: "", status: "all", includeArchived: false, page: 1, pageSize: PAGE_SIZE };
        renderEmployees(host, token);
      },
      extra: el("label", { class: "checkbox-row", style: "margin:0" }, archived, el("span", { text: "إظهار المؤرشفين" })),
    },
  );

  const actions = [];
  if (canManage) {
    actions.push(
      el("button", { class: "btn btn-primary", type: "button", onclick: () => openCreate() }, icon("user-plus"), "موظف جديد"),
      el("button", { class: "btn btn-secondary", type: "button", onclick: () => openImport() }, icon("upload"), "استيراد Excel"),
    );
  }
  actions.push(
    el("button", { class: "btn btn-secondary", type: "button", onclick: () => exportEmployees() }, icon("download"), "تصدير Excel"),
    el("button", { class: "btn btn-ghost", type: "button", onclick: () => downloadFile("/api/employees/import-template", "employees-template.xlsx") }, icon("file-text"), "قالب الاستيراد"),
    can("settings.manage") || canManage
      ? el("button", { class: "btn btn-ghost", type: "button", onclick: () => openDepartments() }, icon("building"), "الأقسام")
      : null,
  );

  const heading = pageHeader({
    title: "إدارة الموظفين",
    subtitle: "السجل المركزي للموظفين مع النقل والأرشفة والمرفقات — الأرقام الوظيفية تُولَّد تلقائياً عند تركها فارغة.",
    actions: actions.filter(Boolean),
  });

  const activeCount = data.items.filter((item) => !item.archivedAt).length;
  const archivedCount = data.items.filter((item) => item.archivedAt).length;

  const table = buildTable(data);
  host.replaceChildren(
    pageEnter(
      heading,
      filters,
      summaryStrip([
        { label: "إجمالي النتائج", value: data.total, tone: "blue", iconName: "users" },
        { label: "نشطون في الصفحة", value: activeCount, tone: "green", iconName: "user-check" },
        { label: "مؤرشفون في الصفحة", value: archivedCount, tone: "neutral", iconName: "archive" },
        { label: "أقسام مفعّلة", value: departmentList().length, tone: "purple", iconName: "building" },
      ]),
      el(
        "div",
        { class: "card table-card" },
        el(
          "div",
          { class: "card-head" },
          el("div", {}, el("h2", { class: "card-title", text: "قائمة الموظفين" }), el("p", { class: "card-subtitle", text: `صفحة ${formatNumber(data.page)} من ${formatNumber(Math.max(1, Math.ceil(data.total / data.pageSize)))}` })),
          el("span", { class: "tag", text: `${formatNumber(data.total)} موظفاً` }),
        ),
        data.items.length === 0
          ? el("div", { class: "empty-inline", text: "لا توجد نتائج مطابقة. جرّب تعديل عوامل التصفية." })
          : el("div", { class: "table-wrap" }, table),
        tablePagination({
          page: data.page,
          pageSize: data.pageSize,
          total: data.total,
          onPage: (page) => {
            state.employees.page = page;
            renderEmployees(host, token);
          },
        }),
      ),
    ),
  );

  function buildTable(result) {
    const head = el(
      "thead",
      {},
      el("tr", {}, ...["الموظف", "الفرع", "القسم", "المسمى", "التعيين", "الراتب الأساسي", "الحالة", "إجراءات"].map((label, index) => el("th", { class: index === 7 ? "no-print" : "", text: label }))),
    );
    const body = el("tbody");
    for (const employee of result.items) {
      body.append(
        el(
          "tr",
          { class: employee.archivedAt ? "row-muted" : "" },
          el("td", {}, personCell(employee.fullName, employee.jobTitle, employee.employeeNo), employee.archivedAt ? el("span", { class: "tag neutral", text: "مؤرشف" }) : null),
          el("td", { class: "tiny", text: employee.branchName || "—" }),
          el("td", { class: "tiny", text: employee.departmentName || "—" }),
          el("td", { class: "tiny", text: employee.jobTitle || "—" }),
          el("td", { class: "tiny nowrap", text: formatDate(employee.hireDate) }),
          el("td", { class: "num nowrap", text: money(employee.baseSalary) }),
          el("td", {}, empTag(employee.status)),
          el(
            "td",
            { class: "no-print" },
            el(
              "div",
              { class: "inline-actions" },
              el("button", { class: "icon-btn", type: "button", title: "عرض الملف", onclick: () => openDetail(employee.id) }, icon("eye")),
              canManage && !employee.archivedAt
                ? el("button", { class: "icon-btn", type: "button", title: "تعديل", onclick: () => openEdit(employee) }, icon("pencil"))
                : null,
              canManage && !employee.archivedAt
                ? el("button", { class: "icon-btn danger", type: "button", title: "أرشفة", onclick: () => archive(employee) }, icon("archive"))
                : null,
              canViewTransfers && !employee.archivedAt
                ? el("button", { class: "icon-btn", type: "button", title: "طلب نقل", onclick: () => openTransfer(employee) }, icon("arrow-left-right"))
                : null,
              deleteRecordButton({
                entity: "employee",
                id: employee.id,
                label: `ملف الموظف ${employee.fullName} (${employee.employeeNo})`,
                onDeleted: () => renderEmployees(host, token),
              }),
            ),
          ),
        ),
      );
    }
    return el("table", { class: "att-table" }, head, body);
  }

  async function openCreate() {
    openFormDialog({
      title: "إضافة موظف جديد",
      description: "سيُولَّد الرقم الوظيفي تلقائياً إذا تُرك فارغاً. يمكن إضافة مرفقات الملف بعد الحفظ.",
      fields: employeeFields({}, { create: true }),
      submitLabel: "إضافة الموظف",
      size: "lg",
      onSubmit: async (values) => {
        const body = {
          employeeNo: values.employeeNo || undefined,
          fullName: values.fullName,
          phone: values.phone,
          nationalId: values.nationalId,
          branchId: values.branchId,
          departmentId: values.departmentId || undefined,
          jobTitle: values.jobTitle,
          hireDate: values.hireDate,
          baseSalary: Number(values.baseSalary || 0),
          status: values.status,
          notes: values.notes,
        };
        await api("/api/employees", { method: "POST", body });
        toast("تمت إضافة الموظف.", "success");
        await refreshMeta();
        renderEmployees(host, token);
      },
    });
  }

  async function openEdit(employee) {
    let detail;
    try {
      detail = await api(`/api/employees/${employee.id}`);
    } catch (error) {
      toast(friendlyError(error), "error");
      return;
    }
    const current = detail.employee;
    openFormDialog({
      title: `تعديل بيانات — ${current.fullName}`,
      description: "تغيير الفرع لا يتم من هنا؛ استخدم طلب نقل موظف لضمان التدقيق والاعتماد.",
      fields: employeeFields(current),
      submitLabel: "حفظ التعديلات",
      size: "lg",
      onSubmit: async (values) => {
        await api(`/api/employees/${employee.id}`, {
          method: "PATCH",
          body: {
            fullName: values.fullName,
            phone: values.phone,
            nationalId: values.nationalId,
            departmentId: values.departmentId || "",
            jobTitle: values.jobTitle,
            hireDate: values.hireDate,
            baseSalary: Number(values.baseSalary || 0),
            status: values.status,
            notes: values.notes,
          },
        });
        toast("تم تحديث بيانات الموظف.", "success");
        await refreshMeta();
        renderEmployees(host, token);
      },
    });
  }

  async function archive(employee) {
    const controller = openFormDialog({
      title: `أرشفة الموظف — ${employee.fullName}`,
      description: "الأرشفة تُخفي الموظف من العمليات الجارية وتُبقي سجله في التقارير والتدقيق.",
      fields: [
        { name: "reason", label: "سبب الأرشفة (إلزامي)", type: "textarea", rows: 3, required: true, minlength: 3, maxlength: 500, span: 2 },
        { name: "terminationDate", label: "تاريخ انتهاء الخدمة", type: "date", value: new Date().toISOString().slice(0, 10) },
      ],
      submitLabel: "أرشفة",
      submitIcon: "archive",
      onSubmit: async (values) => {
        await api(`/api/employees/${employee.id}/archive`, { method: "POST", body: { reason: values.reason, terminationDate: values.terminationDate || "" } });
        toast("تمت أرشفة الموظف.", "success");
        renderEmployees(host, token);
      },
    });
    return controller;
  }

  function openTransfer(employee) {
    const branches = branchList().filter((b) => b.active);
    openFormDialog({
      title: `طلب نقل — ${employee.fullName}`,
      description: `الفرع الحالي: ${employee.branchName || "—"}. سيُنفَّذ النقل بعد اعتماد الطلب من صفحة التحويلات الوظيفية.`,
      fields: [
        { name: "toBranchId", label: "الفرع الجديد", type: "select", required: true, options: branches.filter((b) => b.id !== employee.branchId).map((b) => ({ value: b.id, label: b.name })) },
        { name: "toDepartmentId", label: "القسم الجديد", type: "select", placeholder: "بدون قسم", options: departmentList().map((d) => ({ value: d.id, label: d.name })) },
        { name: "effectiveDate", label: "تاريخ سريان النقل", type: "date", required: true, value: new Date().toISOString().slice(0, 10) },
        { name: "reason", label: "سبب النقل", type: "textarea", required: true, minlength: 3, maxlength: 1000, span: 2 },
        { name: "notes", label: "ملاحظات", type: "textarea", maxlength: 2000, span: 2 },
      ],
      submitLabel: "إنشاء طلب النقل",
      onSubmit: async (values) => {
        await api("/api/transfers", {
          method: "POST",
          body: {
            employeeId: employee.id,
            toBranchId: values.toBranchId,
            toDepartmentId: values.toDepartmentId || "",
            effectiveDate: values.effectiveDate,
            reason: values.reason,
            notes: values.notes,
          },
        });
        toast("تم إنشاء طلب نقل الموظف. تابع اعتماده من صفحة التحويلات.", "success");
      },
    });
  }

  async function openDetail(id) {
    let detail;
    try {
      detail = await api(`/api/employees/${id}`);
    } catch (error) {
      toast(friendlyError(error), "error");
      return;
    }
    const employee = detail.employee;
    const transfers = detail.transfers ?? [];
    const transferTable = transfers.length
      ? el(
          "div",
          { class: "table-wrap" },
          el(
            "table",
            { class: "att-table" },
            el("thead", {}, el("tr", {}, ...["من فرع", "إلى فرع", "التاريخ", "الحالة"].map((label) => el("th", { text: label })))),
            el(
              "tbody",
              {},
              ...transfers.map((transfer) =>
                el(
                  "tr",
                  {},
                  el("td", { text: transfer.fromBranch || "—" }),
                  el("td", { text: transfer.toBranch || "—" }),
                  el("td", { class: "tiny", text: formatDate(transfer.effectiveDate) }),
                  el("td", {}, statusTag({ pending: { label: "بانتظار الاعتماد", tone: "info" }, approved: { label: "معتمد", tone: "success" }, rejected: { label: "مرفوض", tone: "danger" }, cancelled: { label: "ملغى", tone: "neutral" } }, transfer.status)),
                ),
              ),
            ),
          ),
        )
      : el("p", { class: "tiny muted", text: "لا توجد تحويلات وظيفية لهذا الموظف." });

    const attachments = attachmentsPanel({ ownerType: "employee", ownerId: employee.id, canEdit: canManage });
    const body = el(
      "div",
      {},
      detailRows([
        ["الاسم", employee.fullName],
        ["الرقم الوظيفي", employee.employeeNo],
        ["الفرع", employee.branchName || "—"],
        ["القسم", employee.departmentName || "—"],
        ["المسمى الوظيفي", employee.jobTitle || "—"],
        ["الهاتف", employee.phone || "—"],
        ["الرقم الوطني", employee.nationalId || "—"],
        ["تاريخ التعيين", formatDate(employee.hireDate)],
        ["الراتب الأساسي", money(employee.baseSalary)],
        ["الحالة", empTag(employee.status)],
        ["أُنشئ في", formatDateTime(employee.createdAt)],
        employee.archivedAt ? ["أُرشف في", `${formatDateTime(employee.archivedAt)} — ${employee.archiveReason || ""}`] : null,
        ["ملاحظات", employee.notes || "—"],
      ]),
      el("div", { class: "section-head" }, el("h3", { class: "section-title" }, icon("arrow-left-right"), "التحويلات الوظيفية")),
      transferTable,
      attachments.node,
    );
    openModal({ title: `ملف الموظف — ${employee.fullName}`, body, size: "lg" });
  }

  function openImport() {
    const input = el("input", { type: "file", accept: ".xlsx", class: "visually-hidden" });
    const errorHost = el("div");
    const resultHost = el("div");
    let controller;
    const upload = el(
      "button",
      { class: "btn btn-primary", type: "button", onclick: () => input.click() },
      icon("upload"),
      "اختيار ملف Excel",
    );
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      errorHost.replaceChildren();
      resultHost.replaceChildren();
      setButtonLoading(upload, true, "جارٍ الاستيراد…");
      try {
        const response = await fetch("/api/employees/import", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": file.type || "application/octet-stream", "X-Requested-With": "XMLHttpRequest" },
          body: file,
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          const rows = payload?.error?.details?.rows;
          errorHost.append(alertBox(payload?.error?.message ?? "تعذر استيراد الملف.", "error"));
          if (Array.isArray(rows) && rows.length) {
            errorHost.append(
              el(
                "div",
                { class: "detail-grid" },
                ...rows.slice(0, 20).map((row) => el("div", { class: "detail-row" }, el("span", { class: "detail-label", text: `صف ${formatNumber(row.row)}` }), el("div", { class: "detail-value", text: row.message }))),
              ),
            );
          }
          return;
        }
        resultHost.append(
          el("div", { class: "alert alert-success", role: "status" }, icon("circle-check"), el("span", { text: `تم استيراد ${formatNumber(payload.imported)} موظفاً بنجاح.` })),
        );
        input.value = "";
        await refreshMeta();
        renderEmployees(host, token);
        toast("تم استيراد الموظفين.", "success");
      } catch {
        errorHost.append(alertBox("تعذر الاتصال بالخادم أثناء الاستيراد.", "error"));
      } finally {
        setButtonLoading(upload, false);
      }
    });
    const body = el(
      "div",
      {},
      el("p", { class: "confirm-text", text: "استخدم قالب الاستيراد لضمان أسماء الأعمدة. الحد الأقصى 500 صف وحجم 5 ميجابايت." }),
      el("div", { class: "inline-actions" }, upload, input, el("button", { class: "btn btn-ghost", type: "button", onclick: () => downloadFile("/api/employees/import-template", "employees-template.xlsx") }, icon("download"), "تنزيل القالب")),
      errorHost,
      resultHost,
    );
    controller = openModal({ title: "استيراد موظفين من Excel", body, size: "md" });
    void controller;
  }

  function exportEmployees() {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.branchId) params.set("branchId", query.branchId);
    if (query.departmentId) params.set("departmentId", query.departmentId);
    if (query.status && query.status !== "all") params.set("status", query.status);
    if (query.includeArchived) params.set("includeArchived", "true");
    downloadFile(`/api/employees/export.xlsx?${params.toString()}`, "employees.xlsx").catch((error) => toast(error.message, "error"));
  }

  async function openDepartments() {
    let result;
    try {
      result = await api("/api/departments?includeInactive=true");
    } catch (error) {
      toast(friendlyError(error), "error");
      return;
    }
    const listHost = el("div");
    const errorHost = el("div");
    const name = el("input", { class: "input", maxlength: 120, placeholder: "اسم القسم الجديد" });
    const addButton = el("button", { class: "btn btn-primary", type: "button" }, icon("plus"), "إضافة");
    const renderList = (items) => {
      listHost.replaceChildren(
        ...items.map((department) =>
          el(
            "div",
            { class: "attachment-item" },
            icon("building"),
            el("div", { class: "attachment-copy" }, el("strong", { text: department.name }), el("span", { text: `${formatNumber(department.employeesCount)} موظفاً` })),
            el(
              "div",
              { class: "inline-actions" },
              el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: async () => {
                const newName = prompt("اسم القسم", department.name);
                if (!newName || !newName.trim()) return;
                try {
                  await api(`/api/departments/${department.id}`, { method: "PATCH", body: { name: newName.trim() } });
                  await refreshMeta();
                  toast("تم تحديث اسم القسم.", "success");
                  const refreshed = await api("/api/departments?includeInactive=true");
                  renderList(refreshed.items);
                } catch (error) {
                  errorHost.replaceChildren(alertBox(friendlyError(error), "error"));
                }
              } }, "إعادة تسمية"),
              el("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: async () => {
                try {
                  await api(`/api/departments/${department.id}`, { method: "PATCH", body: { active: !department.active } });
                  const refreshed = await api("/api/departments?includeInactive=true");
                  renderList(refreshed.items);
                  toast(department.active ? "تم تعطيل القسم." : "تم تفعيل القسم.", "success");
                } catch (error) {
                  errorHost.replaceChildren(alertBox(friendlyError(error), "error"));
                }
              } }, department.active ? "تعطيل" : "تفعيل"),
              canDeleteRecords()
                ? el("button", { class: "btn btn-ghost btn-sm danger", type: "button", onclick: async () => {
                  await deleteRecord({
                    entity: "department",
                    id: department.id,
                    label: `قسم ${department.name}`,
                    onDeleted: async () => {
                      const refreshed = await api("/api/departments?includeInactive=true");
                      renderList(refreshed.items);
                      await refreshMeta();
                    },
                  });
                } }, icon("trash"), "حذف")
                : null,
            ),
          ),
        ),
      );
    };
    addButton.addEventListener("click", async () => {
      errorHost.replaceChildren();
      if (!name.value.trim()) {
        errorHost.append(alertBox("أدخل اسم القسم.", "error"));
        return;
      }
      setButtonLoading(addButton, true, "جارٍ الإضافة…");
      try {
        await api("/api/departments", { method: "POST", body: { name: name.value.trim(), active: true } });
        name.value = "";
        const refreshed = await api("/api/departments?includeInactive=true");
        renderList(refreshed.items);
        await refreshMeta();
        toast("تمت إضافة القسم.", "success");
      } catch (error) {
        errorHost.append(alertBox(friendlyError(error), "error"));
      } finally {
        setButtonLoading(addButton, false);
      }
    });
    renderList(result.items);
    openModal({
      title: "إدارة الأقسام",
      description: "الأقسام تُستخدم في تصنيف الموظفين وتصفية التحضير والتقارير.",
      body: el("div", {}, errorHost, el("div", { class: "inline-actions", style: "margin-bottom:12px" }, name, addButton), listHost),
      size: "md",
    });
  }
}

async function loadEmployees(query) {
  const params = new URLSearchParams();
  params.set("page", String(query.page));
  params.set("pageSize", String(query.pageSize || PAGE_SIZE));
  if (query.q) params.set("q", query.q);
  if (query.branchId) params.set("branchId", query.branchId);
  if (query.departmentId) params.set("departmentId", query.departmentId);
  if (query.status && query.status !== "all") params.set("status", query.status);
  if (query.includeArchived) params.set("includeArchived", "true");
  return api(`/api/employees?${params.toString()}`);
}
