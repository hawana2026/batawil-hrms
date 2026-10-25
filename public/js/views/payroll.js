import {
  api,
  confirmDialog,
  el,
  errorBlock,
  formatDateTime,
  formatNumber,
  icon,
  loadingBlock,
  pageHeader,
  setButtonLoading,
  toast,
} from "../core.js";
import { state } from "../state.js";
import { friendlyError, pageEnter, tablePagination } from "../ui.js";
import {
  PAYROLL_STATUS,
  branchSelectOptions,
  filterBar,
  money,
  monthLabel,
  monthValue,
  openFormDialog,
  personCell,
  printHeader,
  printPage,
  statusTag,
  summaryStrip,
} from "../hr-common.js";

let payrollState = { page: 1, pageSize: 50, year: new Date().getFullYear(), month: new Date().getMonth() + 1, branchId: "", reviewStatus: "all", q: "" };

export async function renderPayroll(host, token) {
  host.replaceChildren(loadingBlock("جارٍ تحميل الرواتب…"));
  const params = new URLSearchParams();
  params.set("year", String(payrollState.year));
  params.set("month", String(payrollState.month));
  params.set("page", String(payrollState.page));
  params.set("pageSize", String(payrollState.pageSize));
  if (payrollState.branchId) params.set("branchId", payrollState.branchId);
  if (payrollState.reviewStatus !== "all") params.set("reviewStatus", payrollState.reviewStatus);
  if (payrollState.q) params.set("q", payrollState.q);
  let data;
  try {
    data = await api(`/api/payroll?${params.toString()}`);
  } catch (error) {
    if (token !== state.renderToken) return;
    host.replaceChildren(errorBlock(friendlyError(error), () => renderPayroll(host, token)));
    return;
  }
  if (token !== state.renderToken) return;

  const caps = data.capabilities ?? {};
  const branchSelect = el("select", { class: "select" }, ...branchSelectOptions(payrollState.branchId, { allLabel: "كل الفروع" }));
  const monthInput = el("input", { class: "input", type: "month", value: `${payrollState.year}-${String(payrollState.month).padStart(2, "0")}` });
  const reviewSelect = el(
    "select",
    { class: "select" },
    el("option", { value: "all", selected: payrollState.reviewStatus === "all" }, "كل الحالات"),
    ...Object.entries(PAYROLL_STATUS).map(([value, meta]) => el("option", { value, selected: payrollState.reviewStatus === value }, meta.label)),
  );
  const search = el("input", { class: "input", type: "search", value: payrollState.q, placeholder: "الموظف أو الرقم…" });
  const filters = filterBar(
    [
      { label: "الشهر", control: monthInput },
      { label: "الفرع", control: branchSelect },
      { label: "حالة المراجعة", control: reviewSelect },
      { label: "بحث", control: search },
    ],
    {
      onApply: () => {
        const [year, month] = monthInput.value.split("-").map(Number);
        payrollState = { ...payrollState, year, month, branchId: branchSelect.value, reviewStatus: reviewSelect.value, q: search.value.trim(), page: 1 };
        renderPayroll(host, token);
      },
      onReset: () => {
        const now = new Date();
        payrollState = { page: 1, pageSize: 50, year: now.getFullYear(), month: now.getMonth() + 1, branchId: "", reviewStatus: "all", q: "" };
        renderPayroll(host, token);
      },
    },
  );

  const actions = [];
  if (caps.canManage) {
    actions.push(el("button", { class: "btn btn-primary", type: "button", onclick: (event) => generate(event.currentTarget) }, icon("refresh"), "توليد / تحديث الشهر"));
  }
  actions.push(el("button", { class: "btn btn-secondary", type: "button", onclick: () => printPage({ landscape: true }) }, icon("printer"), "طباعة"));

  const rows = data.items.length
    ? data.items.map((item) =>
        el(
          "tr",
          {},
          el("td", {}, personCell(item.employeeName, item.departmentName || item.jobTitle, item.employeeNo)),
          el("td", { class: "num nowrap", text: money(item.baseSalary) }),
          el("td", { class: "num nowrap", text: money(item.allowances) }),
          el("td", { class: "num nowrap", text: money(item.deductions) }),
          el("td", { class: "num nowrap", text: money(item.advanceDeduction) }),
          el("td", { class: "num nowrap", text: money(item.advanceOutstanding) }),
          el("td", { class: "num nowrap net-cell", text: money(item.net) }),
          el("td", { class: "num", title: "أيام الحضور / الغياب / الإجازة / مرات التأخير", text: `${formatNumber(item.presentDays)} / ${formatNumber(item.absentDays)} / ${formatNumber(item.leaveDays)} / ${formatNumber(item.lateCount)}` }),
          el("td", {}, statusTag(PAYROLL_STATUS, item.reviewStatus)),
          el(
            "td",
            { class: "no-print" },
            caps.canManage && item.reviewStatus !== "approved"
              ? el("button", { class: "icon-btn", type: "button", title: "تعديل المستحقات", onclick: () => editRow(item) }, icon("pencil"))
              : el(
                  "span",
                  { class: "tiny muted nowrap", title: item.reviewStatus === "approved" ? "سجل معتمد ومقفل" : undefined },
                  ...(item.reviewStatus === "approved" ? [icon("lock"), " مقفل"] : [item.generatedAt ? formatDateTime(item.generatedAt) : "—"]),
                ),
          ),
        ),
      )
    : [el("tr", {}, el("td", { colspan: "10", class: "empty-inline", text: "لم يُولَّد راتب هذا الشهر بعد." }))];

  host.replaceChildren(
    pageEnter(
      pageHeader({
        title: "الرواتب وبيانات الاستحقاق",
        subtitle: `${monthLabel(data.year, data.month)} · يُحسب الراتب من أيام الحضور والغياب والإجازات مع خصم السلف المصرح بها.`,
        actions,
      }),
      filters,
      printHeader({ title: "كشف الرواتب وبيانات الاستحقاق", subtitle: monthLabel(data.year, data.month), meta: [`الصفحة: ${data.page}`, `عدد السجلات: ${data.total}`] }),
      summaryStrip([
        { label: "إجمالي الأساسي", value: money(data.totals?.base ?? 0), tone: "blue", iconName: "wallet" },
        { label: "البدلات", value: money(data.totals?.allowances ?? 0), tone: "purple", iconName: "trending-up" },
        { label: "الخصومات", value: money(data.totals?.deductions ?? 0), tone: "orange", iconName: "circle-x" },
        { label: "خصم السلف", value: money(data.totals?.advanceDeduction ?? 0), tone: "orange", iconName: "banknote" },
        { label: "صافي المستحق", value: money(data.totals?.net ?? 0), tone: "green", iconName: "circle-check" },
        { label: "سلف قائمة", value: money(data.totals?.advanceOutstanding ?? 0), tone: "red", iconName: "alert-circle" },
      ]),
      el(
        "div",
        { class: "card table-card" },
        el(
          "div",
          { class: "table-wrap" },
          el(
            "table",
            { class: "att-table payroll-table" },
            el("thead", {}, el("tr", {}, ...["الموظف", "الأساسي", "بدلات", "خصومات", "خصم سلف", "سلف قائمة", "الصافي", "حضور/غياب/إجازة/تأخير", "المراجعة", "إجراءات"].map((label, index) => el("th", { class: index === 9 ? "no-print" : "", text: label })))),
            el("tbody", {}, ...rows),
          ),
        ),
        tablePagination({
          page: data.page,
          pageSize: data.pageSize,
          total: data.total,
          onPage: (page) => {
            payrollState.page = page;
            renderPayroll(host, token);
          },
        }),
      ),
      el("p", { class: "tiny muted no-print", text: "ملاحظة: الراتب المحسوب يغطي حضور الشهر وفق التحضير المعتمد. أي تعديل يدوي على البدلات أو الخصومات يُسجَّل في تدقيق النظام. عند اعتماد السجل يُسجَّل خصم السلف في سجل حركة السلف نهائياً." }),
    ),
  );

  async function generate(button) {
    const ok = await confirmDialog({
      title: "توليد رواتب الشهر",
      message: `سيُولَّد أو يُحدَّث راتب ${monthLabel(payrollState.year, payrollState.month)} للموظفين النشطين${payrollState.branchId ? " في الفرع المحدد" : " في جميع فروعك"}. السجلات المعتمدة لا تُعدَّل.`,
      confirmLabel: "توليد الرواتب",
    });
    if (!ok) return;
    setButtonLoading(button, true, "جارٍ التوليد…");
    try {
      const result = await api("/api/payroll/generate", {
        method: "POST",
        body: { branchId: payrollState.branchId || "", year: payrollState.year, month: payrollState.month },
      });
      toast(`تم إنشاء ${formatNumber(result.created)} سجل، وتحديث ${formatNumber(result.updated ?? 0)}، وتخطي ${formatNumber(result.skipped)} سجل معتمد.`, "success");
      renderPayroll(host, token);
    } catch (error) {
      toast(friendlyError(error), "error");
      setButtonLoading(button, false);
    }
  }

  function editRow(item) {
    openFormDialog({
      title: `بيانات استحقاق — ${item.employeeName}`,
      description: `الأساسي ${money(item.baseSalary)} · السلف القائمة ${money(item.advanceOutstanding)}.`,
      size: "md",
      fields: [
        { name: "allowances", label: "البدلات", type: "number", min: 0, max: 99999999, step: "0.01", value: item.allowances },
        { name: "deductions", label: "الخصومات", type: "number", min: 0, max: 99999999, step: "0.01", value: item.deductions },
        { name: "advanceDeduction", label: "خصم السلف", type: "number", min: 0, max: item.advanceOutstanding, step: "0.01", value: item.advanceDeduction, hint: `الحد الأقصى ${money(item.advanceOutstanding)} — يُسجَّل في سجل السلف عند الاعتماد` },
        {
          name: "reviewStatus",
          label: "حالة المراجعة",
          type: "select",
          options: Object.entries(PAYROLL_STATUS).map(([value, meta]) => ({ value, label: meta.label })),
          value: item.reviewStatus,
        },
        { name: "notes", label: "ملاحظات", type: "textarea", maxlength: 2000, span: 2, value: item.notes ?? "" },
      ],
      submitLabel: "حفظ المستحقات",
      onSubmit: async (values) => {
        await api(`/api/payroll/${item.id}`, {
          method: "PATCH",
          body: {
            allowances: Number(values.allowances || 0),
            deductions: Number(values.deductions || 0),
            advanceDeduction: Number(values.advanceDeduction || 0),
            reviewStatus: values.reviewStatus,
            notes: values.notes,
          },
        });
        toast("تم تحديث بيانات الاستحقاق.", "success");
        renderPayroll(host, token);
      },
    });
  }
}
