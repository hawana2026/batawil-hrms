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
  branchList,
  branchSelectOptions,
  canDeleteRecords,
  deleteRecord,
  deleteRecordButton,
  departmentList,
  detailRows,
  downloadFile,
  empTag,
  fileSize,
  filterBar,
  money,
  openFormDialog,
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

function employeeFields(employee = {}, { create = false, managers = [] } = {}) {
  const titles = state.meta?.jobTitles ?? [];
  const titleOptions = titles.map((title) => ({ value: title.id, label: title.name }));
  if (employee.jobTitleId && !titles.some((title) => title.id === employee.jobTitleId)) {
    titleOptions.push({ value: employee.jobTitleId, label: `${employee.jobTitle || "مسمى غير مفعّل"} (غير مفعّل)` });
  }
  const managerOptions = managers
    .filter((manager) => manager.id !== employee.id)
    .filter((manager) => create || manager.branchId === employee.branchId)
    .map((manager) => {
      const branchName = branchList().find((branch) => branch.id === manager.branchId)?.name;
      return {
        value: manager.id,
        label: `${manager.fullName} — ${manager.employeeNo}${manager.departmentName ? ` · ${manager.departmentName}` : ""}${create && branchName ? ` · ${branchName}` : ""}`,
      };
    });
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
    {
      name: "jobTitleId",
      label: "المسمى الوظيفي المعتمد",
      type: "select",
      options: titleOptions,
      placeholder: "بدون مسمى معتمد",
      hint: "تُدار المسميات من زر «المسميات الوظيفية».",
      value: employee.jobTitleId ?? "",
    },
    {
      name: "managerId",
      label: "المدير المباشر",
      type: "select",
      options: managerOptions,
      placeholder: "بدون مدير مباشر",
      hint: create ? "يجب أن يكون المدير المباشر في نفس فرع الموظف." : undefined,
      value: employee.managerId ?? "",
    },
    { name: "jobTitle", label: "أو مسمى نصي حر", maxlength: 120, value: employee.jobTitle ?? "", hint: "يُستخدم فقط عند عدم اختيار مسمى معتمد." },
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

async function loadManagerOptions() {
  try {
    const data = await api("/api/employees/options");
    return data.items ?? [];
  } catch {
    return [];
  }
}

const CONTRACT_TYPES = { permanent: "دائم", fixed: "محدد المدة", probation: "تحت التجربة", part_time: "دوام جزئي" };
const CONTRACT_STATUS = {
  active: { label: "نشط", tone: "success" },
  ended: { label: "منتهٍ", tone: "neutral" },
  terminated: { label: "ملغي", tone: "danger" },
};
const DOCUMENT_TYPES = { contract: "عقد", national_id: "هوية وطنية", certificate: "شهادة", medical: "تقرير طبي", other: "مستند آخر" };
const HISTORY_TYPES = {
  hired: "تعيين",
  updated: "تعديل بيانات",
  status_changed: "تغيير الحالة",
  salary_changed: "تغيير الراتب",
  transferred: "نقل وظيفي",
  contract_added: "إضافة عقد",
  contract_updated: "تعديل عقد",
  archived: "أرشفة",
  document_added: "إضافة مستند",
  document_updated: "تعديل مستند",
  document_deleted: "حذف مستند",
};

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
    canManage
      ? el("button", { class: "btn btn-ghost", type: "button", onclick: () => openJobTitles() }, icon("user-check"), "المسميات الوظيفية")
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
    const managers = await loadManagerOptions();
    openFormDialog({
      title: "إضافة موظف جديد",
      description: "سيُولَّد الرقم الوظيفي تلقائياً إذا تُرك فارغاً. يمكن إضافة العقود والمستندات من ملف الموظف بعد الحفظ.",
      fields: employeeFields({}, { create: true, managers }),
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
          jobTitleId: values.jobTitleId || undefined,
          managerId: values.managerId || undefined,
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
    const managers = await loadManagerOptions();
    openFormDialog({
      title: `تعديل بيانات — ${current.fullName}`,
      description: "تغيير الفرع لا يتم من هنا؛ استخدم طلب نقل موظف لضمان التدقيق والاعتماد.",
      fields: employeeFields(current, { managers }),
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
            jobTitleId: values.jobTitleId,
            managerId: values.managerId,
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
    let activeTab = "data";
    const tabsHost = el("div", { class: "tabs" });
    const contentHost = el("div");

    const reload = async () => {
      try {
        detail = await api(`/api/employees/${id}`);
        render();
      } catch (error) {
        toast(friendlyError(error), "error");
      }
    };

    const openContractForm = (contract = null) => {
      const employee = detail.employee;
      openFormDialog({
        title: contract ? `تعديل العقد — ${contract.contractNo || "بدون رقم"}` : `إضافة عقد — ${employee.fullName}`,
        description: "العقد النشط يحدّث الراتب الأساسي في ملف الموظف تلقائياً، ويُحفظ كل تغيير في السجل الوظيفي.",
        fields: [
          { name: "contractNo", label: "رقم العقد", maxlength: 60, dir: "ltr", value: contract?.contractNo ?? "" },
          {
            name: "contractType",
            label: "نوع العقد",
            type: "select",
            options: Object.entries(CONTRACT_TYPES).map(([value, label]) => ({ value, label })),
            value: contract?.contractType ?? "permanent",
          },
          { name: "startDate", label: "تاريخ البداية", type: "date", required: true, value: contract?.startDate ?? employee.hireDate ?? "" },
          { name: "endDate", label: "تاريخ النهاية (اختياري)", type: "date", value: contract?.endDate ?? "" },
          {
            name: "baseSalary",
            label: "الراتب في العقد",
            type: "number",
            min: 0,
            max: 999999999,
            step: "0.01",
            required: true,
            value: contract?.baseSalary ?? employee.baseSalary ?? 0,
          },
          {
            name: "status",
            label: "حالة العقد",
            type: "select",
            options: Object.entries(CONTRACT_STATUS).map(([value, meta]) => ({ value, label: meta.label })),
            value: contract?.status ?? "active",
          },
          { name: "notes", label: "ملاحظات", type: "textarea", maxlength: 2000, span: 2, value: contract?.notes ?? "" },
        ],
        submitLabel: contract ? "حفظ العقد" : "إضافة العقد",
        size: "lg",
        onSubmit: async (values) => {
          const body = {
            contractNo: values.contractNo,
            contractType: values.contractType,
            startDate: values.startDate,
            endDate: values.endDate || "",
            baseSalary: Number(values.baseSalary || 0),
            status: values.status,
            notes: values.notes,
          };
          if (contract) {
            await api(`/api/employees/${employee.id}/contracts/${contract.id}`, { method: "PATCH", body });
            toast("تم تحديث العقد.", "success");
          } else {
            await api(`/api/employees/${employee.id}/contracts`, { method: "POST", body });
            toast("تمت إضافة العقد.", "success");
          }
          await reload();
        },
      });
    };

    const openDocumentForm = (document) => {
      openFormDialog({
        title: "بيانات المستند",
        fields: [
          { name: "title", label: "عنوان المستند", maxlength: 160, value: document.title ?? "" },
          {
            name: "documentType",
            label: "نوع المستند",
            type: "select",
            options: Object.entries(DOCUMENT_TYPES).map(([value, label]) => ({ value, label })),
            value: document.documentType ?? "other",
          },
          { name: "expiresAt", label: "تاريخ الانتهاء (اختياري)", type: "date", value: document.expiresAt ?? "" },
        ],
        submitLabel: "حفظ البيانات",
        onSubmit: async (values) => {
          await api(`/api/attachments/${document.id}`, {
            method: "PATCH",
            body: { title: values.title, documentType: values.documentType, expiresAt: values.expiresAt || "" },
          });
          toast("تم تحديث بيانات المستند.", "success");
          await reload();
        },
      });
    };

    const deleteDocument = async (document) => {
      const ok = await confirmDialog({
        title: "حذف المستند",
        message: `سيتم حذف "${document.title || document.fileName}" نهائياً. سيبقى أثر الحذف في السجل الوظيفي.`,
        confirmLabel: "حذف",
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/attachments/${document.id}`, { method: "DELETE" });
        toast("تم حذف المستند.", "success");
        await reload();
      } catch (error) {
        toast(friendlyError(error), "error");
      }
    };

    const buildDataTab = () => {
      const employee = detail.employee;
      return el(
        "div",
        {},
        detailRows([
          ["الاسم", employee.fullName],
          ["الرقم الوظيفي", employee.employeeNo],
          ["الفرع", employee.branchName || "—"],
          ["القسم", employee.departmentName || "—"],
          ["المسمى الوظيفي", employee.jobTitle || "—"],
          ["المدير المباشر", employee.managerName ? `${employee.managerName}${employee.managerNo ? ` (${employee.managerNo})` : ""}` : "—"],
          ["الهاتف", employee.phone || "—"],
          ["الرقم الوطني", employee.nationalId || "—"],
          ["تاريخ التعيين", formatDate(employee.hireDate)],
          ["الراتب الأساسي", money(employee.baseSalary)],
          ["الحالة", empTag(employee.status)],
          ["أُنشئ في", formatDateTime(employee.createdAt)],
          employee.archivedAt ? ["أُرشف في", `${formatDateTime(employee.archivedAt)} — ${employee.archiveReason || ""}`] : null,
          ["ملاحظات", employee.notes || "—"],
        ]),
      );
    };

    const buildContractsTab = () => {
      const employee = detail.employee;
      const contracts = detail.contracts ?? [];
      const canEdit = canManage && !employee.archivedAt;
      const table = contracts.length
        ? el(
            "div",
            { class: "table-wrap" },
            el(
              "table",
              { class: "att-table" },
              el(
                "thead",
                {},
                el("tr", {}, ...["رقم العقد", "النوع", "البداية", "النهاية", "الراتب", "الحالة", ""].map((label) => el("th", { text: label }))),
              ),
              el(
                "tbody",
                {},
                ...contracts.map((contract) =>
                  el(
                    "tr",
                    {},
                    el("td", { class: "tiny", dir: "ltr", text: contract.contractNo || "—" }),
                    el("td", { class: "tiny", text: CONTRACT_TYPES[contract.contractType] ?? contract.contractType }),
                    el("td", { class: "tiny nowrap", text: formatDate(contract.startDate) }),
                    el("td", { class: "tiny nowrap", text: contract.endDate ? formatDate(contract.endDate) : "—" }),
                    el("td", { class: "num nowrap", text: money(contract.baseSalary) }),
                    el("td", {}, statusTag(CONTRACT_STATUS, contract.status)),
                    el(
                      "td",
                      {},
                      canEdit
                        ? el("button", { class: "icon-btn", type: "button", title: "تعديل العقد", onclick: () => openContractForm(contract) }, icon("pencil"))
                        : null,
                    ),
                  ),
                ),
              ),
            ),
          )
        : el("p", { class: "tiny muted", text: "لا توجد عقود مسجلة لهذا الموظف." });
      return el(
        "div",
        {},
        el(
          "div",
          { class: "section-head" },
          el("h3", { class: "section-title" }, icon("calendar"), "العقود"),
          canEdit ? el("button", { class: "btn btn-primary btn-sm", type: "button", onclick: () => openContractForm() }, icon("plus"), "إضافة عقد") : null,
        ),
        table,
      );
    };

    const buildDocumentsTab = () => {
      const employee = detail.employee;
      const documents = detail.documents ?? [];
      const canEdit = canManage && !employee.archivedAt;
      const errorHost = el("div");
      const listHost = el("div");

      const renderList = () => {
        if (!documents.length) {
          listHost.replaceChildren(el("p", { class: "tiny muted", text: "لا توجد مستندات مرفوعة." }));
          return;
        }
        listHost.replaceChildren(
          ...documents.map((document) =>
            el(
              "div",
              { class: "attachment-item" },
              icon("file-text"),
              el(
                "div",
                { class: "attachment-copy" },
                el("strong", { text: document.title || document.fileName }),
                el(
                  "span",
                  {
                    text: `${DOCUMENT_TYPES[document.documentType] ?? document.documentType} · ${document.fileName} · ${fileSize(document.sizeBytes)}${document.expiresAt ? ` · ينتهي ${formatDate(document.expiresAt)}` : ""}`,
                  },
                ),
              ),
              el(
                "div",
                { class: "attachment-actions" },
                el(
                  "button",
                  {
                    class: "icon-btn",
                    type: "button",
                    title: "تنزيل المستند",
                    onclick: () => downloadFile(`/api/attachments/${document.id}/download`, document.fileName).catch((error) => toast(error.message, "error")),
                  },
                  icon("download"),
                ),
                canEdit ? el("button", { class: "icon-btn", type: "button", title: "تعديل البيانات", onclick: () => openDocumentForm(document) }, icon("pencil")) : null,
                canEdit ? el("button", { class: "icon-btn danger", type: "button", title: "حذف المستند", onclick: () => deleteDocument(document) }, icon("trash")) : null,
              ),
            ),
          ),
        );
      };
      renderList();

      if (!canEdit) {
        return el("div", {}, el("h3", { class: "section-title" }, icon("file-text"), "المستندات"), listHost);
      }

      let chosenFile = null;
      const fileInput = el("input", {
        type: "file",
        accept: ".pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx",
        class: "visually-hidden",
      });
      const fileLabel = el("span", { class: "tiny muted", text: "لم يتم اختيار ملف" });
      const titleInput = el("input", { class: "input", maxlength: 160, placeholder: "عنوان المستند (اختياري)" });
      const typeSelect = el(
        "select",
        { class: "select" },
        ...Object.entries(DOCUMENT_TYPES).map(([value, label]) => el("option", { value }, label)),
      );
      const expiryInput = el("input", { class: "input", type: "date", title: "تاريخ الانتهاء" });
      const chooseButton = el("button", { class: "btn btn-secondary btn-sm", type: "button", onclick: () => fileInput.click() }, icon("upload"), "اختيار ملف");
      fileInput.addEventListener("change", () => {
        chosenFile = fileInput.files?.[0] ?? null;
        fileLabel.textContent = chosenFile ? `${chosenFile.name} · ${fileSize(chosenFile.size)}` : "لم يتم اختيار ملف";
      });
      const uploadButton = el("button", { class: "btn btn-primary btn-sm", type: "button" }, icon("upload"), "رفع المستند");
      uploadButton.addEventListener("click", async () => {
        errorHost.replaceChildren();
        if (!chosenFile) {
          errorHost.append(alertBox("اختر ملفاً أولاً.", "error"));
          return;
        }
        if (chosenFile.size > 2 * 1024 * 1024) {
          errorHost.append(alertBox("الحد الأقصى لحجم الملف 2 ميجابايت.", "error"));
          return;
        }
        const params = new URLSearchParams({
          ownerType: "employee",
          ownerId: employee.id,
          fileName: chosenFile.name,
          title: titleInput.value.trim() || chosenFile.name,
          documentType: typeSelect.value,
        });
        if (expiryInput.value) params.set("expiresAt", expiryInput.value);
        setButtonLoading(uploadButton, true, "جارٍ الرفع…");
        try {
          const response = await fetch(`/api/attachments?${params.toString()}`, {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "Content-Type": chosenFile.type || "application/octet-stream",
              "X-Requested-With": "XMLHttpRequest",
            },
            body: chosenFile,
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => null);
            throw new Error(payload?.error?.message ?? "تعذر رفع المستند.");
          }
          toast("تم رفع المستند.", "success");
          await reload();
        } catch (error) {
          errorHost.replaceChildren(alertBox(friendlyError(error), "error"));
        } finally {
          setButtonLoading(uploadButton, false);
        }
      });

      return el(
        "div",
        {},
        el("div", { class: "section-head" }, el("h3", { class: "section-title" }, icon("file-text"), "المستندات")),
        el(
          "div",
          { class: "form-grid" },
          el("div", { class: "form-field" }, el("label", { class: "form-label", text: "الملف" }), el("div", { class: "inline-actions" }, chooseButton, fileInput, fileLabel)),
          el("div", { class: "form-field" }, el("label", { class: "form-label", text: "العنوان" }), titleInput),
          el("div", { class: "form-field" }, el("label", { class: "form-label", text: "النوع" }), typeSelect),
          el("div", { class: "form-field" }, el("label", { class: "form-label", text: "تاريخ الانتهاء" }), expiryInput),
        ),
        el("div", { class: "inline-actions", style: "margin:12px 0" }, uploadButton),
        errorHost,
        listHost,
      );
    };

    const buildHistoryTab = () => {
      const history = detail.history ?? [];
      if (!history.length) return el("p", { class: "tiny muted", text: "لا يوجد سجل تغييرات بعد." });
      return el(
        "div",
        { class: "table-wrap" },
        el(
          "table",
          { class: "att-table" },
          el("thead", {}, el("tr", {}, ...["العملية", "الوصف", "تاريخ السريان", "بواسطة", "وقت التسجيل"].map((label) => el("th", { text: label })))),
          el(
            "tbody",
            {},
            ...history.map((row) =>
              el(
                "tr",
                {},
                el("td", {}, el("span", { class: "tag neutral", text: HISTORY_TYPES[row.changeType] ?? row.changeType })),
                el("td", { class: "tiny", text: row.summary }),
                el("td", { class: "tiny nowrap", text: row.effectiveDate ? formatDate(row.effectiveDate) : "—" }),
                el("td", { class: "tiny", text: row.createdBy || "—" }),
                el("td", { class: "tiny nowrap", text: formatDateTime(row.createdAt) }),
              ),
            ),
          ),
        ),
      );
    };

    const buildTransfersTab = () => {
      const transfers = detail.transfers ?? [];
      if (!transfers.length) return el("p", { class: "tiny muted", text: "لا توجد تحويلات وظيفية لهذا الموظف." });
      return el(
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
      );
    };

    const TAB_LABELS = [
      ["data", "البيانات الأساسية", "user-check"],
      ["contracts", "العقود", "calendar"],
      ["documents", "المستندات", "file-text"],
      ["history", "السجل الوظيفي", "scroll"],
      ["transfers", "التحويلات", "arrow-left-right"],
    ];

    const render = () => {
      const employee = detail.employee;
      tabsHost.replaceChildren(
        ...TAB_LABELS.map(([key, label, iconName]) =>
          el(
            "button",
            {
              class: `tab-btn ${activeTab === key ? "active" : ""}`,
              type: "button",
              onclick: () => {
                activeTab = key;
                render();
              },
            },
            icon(iconName),
            label,
          ),
        ),
      );
      const content =
        activeTab === "contracts"
          ? buildContractsTab()
          : activeTab === "documents"
            ? buildDocumentsTab()
            : activeTab === "history"
              ? buildHistoryTab()
              : activeTab === "transfers"
                ? buildTransfersTab()
                : buildDataTab();
      contentHost.replaceChildren(content);
      const title = tabsHost.parentElement?.querySelector?.(".modal-title");
      if (title) title.textContent = `ملف الموظف — ${employee.fullName}`;
    };

    render();
    openModal({ title: `ملف الموظف — ${detail.employee.fullName}`, body: el("div", {}, tabsHost, contentHost), size: "lg" });
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

  async function openJobTitles() {
    let result;
    try {
      result = await api("/api/job-titles");
    } catch (error) {
      toast(friendlyError(error), "error");
      return;
    }
    const listHost = el("div");
    const errorHost = el("div");
    const name = el("input", { class: "input", maxlength: 120, placeholder: "اسم المسمى الوظيفي" });
    const department = el(
      "select",
      { class: "select" },
      el("option", { value: "" }, "بدون قسم محدد"),
      ...departmentList().map((item) => el("option", { value: item.id }, item.name)),
    );
    const addButton = el("button", { class: "btn btn-primary", type: "button" }, icon("plus"), "إضافة");
    const renderList = (items) => {
      if (!items.length) {
        listHost.replaceChildren(el("p", { class: "tiny muted", text: "لا توجد مسميات وظيفية بعد." }));
        return;
      }
      listHost.replaceChildren(
        ...items.map((title) =>
          el(
            "div",
            { class: "attachment-item" },
            icon("user-check"),
            el(
              "div",
              { class: "attachment-copy" },
              el("strong", { text: title.name }),
              el("span", { text: `${title.departmentName || "بدون قسم"} · ${formatNumber(title.employeesCount)} موظفاً${title.active ? "" : " · معطّل"}` }),
            ),
            el(
              "div",
              { class: "inline-actions" },
              el(
                "button",
                {
                  class: "btn btn-ghost btn-sm",
                  type: "button",
                  onclick: async () => {
                    const newName = prompt("اسم المسمى الوظيفي", title.name);
                    if (!newName || !newName.trim() || newName.trim() === title.name) return;
                    try {
                      await api(`/api/job-titles/${title.id}`, { method: "PATCH", body: { name: newName.trim() } });
                      await refreshMeta();
                      toast("تم تحديث المسمى الوظيفي.", "success");
                      const refreshed = await api("/api/job-titles");
                      renderList(refreshed.items);
                    } catch (error) {
                      errorHost.replaceChildren(alertBox(friendlyError(error), "error"));
                    }
                  },
                },
                "إعادة تسمية",
              ),
              el(
                "button",
                {
                  class: "btn btn-ghost btn-sm",
                  type: "button",
                  onclick: async () => {
                    try {
                      await api(`/api/job-titles/${title.id}`, { method: "PATCH", body: { active: !title.active } });
                      await refreshMeta();
                      const refreshed = await api("/api/job-titles");
                      renderList(refreshed.items);
                      toast(title.active ? "تم تعطيل المسمى الوظيفي." : "تم تفعيل المسمى الوظيفي.", "success");
                    } catch (error) {
                      errorHost.replaceChildren(alertBox(friendlyError(error), "error"));
                    }
                  },
                },
                title.active ? "تعطيل" : "تفعيل",
              ),
            ),
          ),
        ),
      );
    };
    addButton.addEventListener("click", async () => {
      errorHost.replaceChildren();
      if (!name.value.trim()) {
        errorHost.append(alertBox("أدخل اسم المسمى الوظيفي.", "error"));
        return;
      }
      setButtonLoading(addButton, true, "جارٍ الإضافة…");
      try {
        await api("/api/job-titles", {
          method: "POST",
          body: { name: name.value.trim(), departmentId: department.value || "", active: true },
        });
        name.value = "";
        const refreshed = await api("/api/job-titles");
        renderList(refreshed.items);
        await refreshMeta();
        toast("تمت إضافة المسمى الوظيفي.", "success");
      } catch (error) {
        errorHost.append(alertBox(friendlyError(error), "error"));
      } finally {
        setButtonLoading(addButton, false);
      }
    });
    renderList(result.items);
    openModal({
      title: "إدارة المسميات الوظيفية",
      description: "المسميات المعتمدة تُستخدم في ملف الموظف وتُحدّث تلقائياً عند إعادة تسميتها. التعطيل يمنع اختيارها لموظفين جدد.",
      body: el("div", {}, errorHost, el("div", { class: "inline-actions", style: "margin-bottom:12px" }, name, department, addButton), listHost),
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
