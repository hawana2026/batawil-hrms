import {
  api,
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
import { friendlyError, pageEnter } from "../ui.js";
import {
  branchList,
  branchSelectOptions,
  departmentList,
  downloadFile,
  filterBar,
  hashParams,
  monthValue,
  navigateHash,
  printHeader,
  printPage,
  selectOptions,
  summaryStrip,
} from "../hr-common.js";

const REPORT_TYPES = {
  "daily-absent": { label: "الغياب اليومي", hint: "الغياب والغياب بعذر في يوم محدد من الكشوف المرسلة أو المعتمدة.", fields: ["date", "branch", "department"] },
  "monthly-absent": { label: "الغياب الشهري", hint: "ملخص أيام الغياب لكل موظف خلال شهر.", fields: ["month", "branch", "department"] },
  "most-absent": { label: "الأكثر غياباً", hint: "ترتيب الموظفين حسب أيام الغياب في فترة.", fields: ["month", "branch", "department"] },
  lateness: { label: "التأخير", hint: "دقائق ومرات التأخير للموظفين خلال فترة.", fields: ["month", "branch", "department"] },
  workdays: { label: "أيام العمل", hint: "أيام العمل المتوقعة مقابل الأيام المسجلة لكل موظف.", fields: ["month", "branch", "department"] },
  "employee-detail": { label: "سجل موظف", hint: "سجل حضور غياب تفصيلي لموظف واحد في فترة.", fields: ["employee", "from", "to"] },
  "branch-comparison": { label: "مقارنة الفروع", hint: "تغطية التحضير ومؤشرات الحضور بين الفروع.", fields: ["month"] },
};

export async function renderReports(host, token) {
  const params = hashParams();
  const type = REPORT_TYPES[params.get("type")] ? params.get("type") : "daily-absent";
  const spec = REPORT_TYPES[type];
  const now = new Date();
  const year = Number(params.get("year")) || now.getFullYear();
  const month = Number(params.get("month")) || now.getMonth() + 1;
  const dateValue = params.get("date") || now.toISOString().slice(0, 10);
  const fromValue = params.get("from") || `${year}-${String(month).padStart(2, "0")}-01`;
  const toValue = params.get("to") || new Date(year, month, 0).toISOString().slice(0, 10);
  const branchId = params.get("branch") || "";
  const departmentId = params.get("department") || "";
  const employeeId = params.get("employee") || "";

  const typeSelect = el(
    "select",
    { class: "select" },
    ...Object.entries(REPORT_TYPES).map(([value, meta]) => el("option", { value, selected: value === type }, meta.label)),
  );
  typeSelect.addEventListener("change", () => navigateHash("reports", { type: typeSelect.value }));

  const branchSelect = el("select", { class: "select" }, ...branchSelectOptions(branchId, { allLabel: "كل الفروع" }));
  const departmentSelect = el("select", { class: "select" }, ...selectOptions(departmentList().map((d) => ({ value: d.id, label: d.name })), departmentId, "كل الأقسام"));
  const monthInput = el("input", { class: "input", type: "month", value: `${year}-${String(month).padStart(2, "0")}` });
  const dateInput = el("input", { class: "input", type: "date", value: dateValue, max: now.toISOString().slice(0, 10) });
  const fromInput = el("input", { class: "input", type: "date", value: fromValue });
  const toInput = el("input", { class: "input", type: "date", value: toValue });
  const employeeSelect = el("select", { class: "select" }, ...selectOptions([], employeeId, "جارٍ تحميل الموظفين…"));
  employeeSelect.disabled = true;

  const fieldNodes = {
    month: { label: "الشهر", control: monthInput },
    date: { label: "التاريخ", control: dateInput },
    branch: { label: "الفرع", control: branchSelect },
    department: { label: "القسم", control: departmentSelect },
    from: { label: "من تاريخ", control: fromInput },
    to: { label: "إلى تاريخ", control: toInput },
    employee: { label: "الموظف", control: employeeSelect },
  };

  const filters = filterBar(
    [
      { label: "نوع التقرير", control: typeSelect },
      ...spec.fields.map((field) => fieldNodes[field]),
    ],
    {
      onApply: () => {
        const [y, m] = monthInput.value.split("-").map(Number);
        const next = { type };
        if (spec.fields.includes("month")) {
          next.year = y;
          next.month = m;
        }
        if (spec.fields.includes("date")) next.date = dateInput.value;
        if (spec.fields.includes("from")) next.from = fromInput.value;
        if (spec.fields.includes("to")) next.to = toInput.value;
        if (spec.fields.includes("branch") && branchSelect.value) next.branch = branchSelect.value;
        if (spec.fields.includes("department") && departmentSelect.value) next.department = departmentSelect.value;
        if (spec.fields.includes("employee") && employeeSelect.value) next.employee = employeeSelect.value;
        navigateHash("reports", next);
      },
      onReset: () => navigateHash("reports", { type }),
    },
  );

  const reportHost = el("div", {}, loadingBlock("جارٍ تجهيز التقرير…"));
  const heading = pageHeader({
    title: "التقارير والطباعة",
    subtitle: "تقارير الحضور والغياب والتأخير وتغطية الفروع — قابلة للطباعة A4 والتصدير إلى Excel.",
    actions: [],
  });

  host.replaceChildren(pageEnter(heading, filters, el("p", { class: "tiny muted", text: spec.hint }), reportHost));

  const employeeSelectHost = employeeSelect;
  api("/api/employees/options")
    .then((result) => {
      employeeSelectHost.replaceChildren(...selectOptions(result.items.map((item) => ({ value: item.id, label: `${item.fullName} — ${item.employeeNo}` })), employeeId, "اختر الموظف"));
      employeeSelectHost.disabled = false;
    })
    .catch(() => {
      employeeSelectHost.replaceChildren(el("option", { value: "" }, "تعذر تحميل الموظفين"));
    });

  const query = new URLSearchParams({ type });
  if (spec.fields.includes("year")) query.set("year", String(year));
  if (spec.fields.includes("month")) {
    query.set("year", String(year));
    query.set("month", String(month));
  }
  if (spec.fields.includes("date")) query.set("date", dateValue);
  if (spec.fields.includes("from")) query.set("from", fromValue);
  if (spec.fields.includes("to")) query.set("to", toValue);
  if (spec.fields.includes("branch") && branchId) query.set("branchId", branchId);
  if (spec.fields.includes("department") && departmentId) query.set("departmentId", departmentId);
  if (spec.fields.includes("employee") && employeeId) query.set("employeeId", employeeId);
  if (spec.fields.includes("employee") && !employeeId) {
    reportHost.replaceChildren(el("div", { class: "empty-inline", text: "اختر موظفاً لعرض سجله التفصيلي." }));
    return;
  }

  let report;
  try {
    report = await api(`/api/reports/${type}?${query.toString()}`);
  } catch (error) {
    if (token !== state.renderToken) return;
    reportHost.replaceChildren(errorBlock(friendlyError(error), () => renderReports(host, token)));
    return;
  }
  if (token !== state.renderToken) return;

  const actionsHost = heading.querySelector(".page-actions") ?? el("div", { class: "page-actions" });
  if (!actionsHost.parentNode) heading.append(actionsHost);
  actionsHost.append(
    el("button", { class: "btn btn-secondary", type: "button", onclick: () => printPage({ landscape: report.columns.length > 7 }) }, icon("printer"), "طباعة / PDF"),
    el("button", {
      class: "btn btn-secondary",
      type: "button",
      onclick: async (event) => {
        const button = event.currentTarget;
        setButtonLoading(button, true, "جارٍ التصدير…");
        try {
          await downloadFile(`/api/reports/${type}/export.xlsx?${query.toString()}`, `report-${type}.xlsx`);
        } catch (error) {
          toast(error.message, "error");
        } finally {
          setButtonLoading(button, false);
        }
      },
    }, icon("download"), "تصدير Excel"),
  );

  const printHead = printHeader({
    title: report.title,
    subtitle: report.subtitle || "",
    meta: [`الفترة: ${report.periodLabel}`, `النطاق: ${report.branchLabel || "كل الفروع"}`, `أُنشئ في: ${formatDateTime(report.generatedAt)}`],
  });

  const table = el(
    "table",
    { class: "att-table report-table" },
    el("thead", {}, el("tr", {}, el("th", { text: "#" }), ...report.columns.map((column) => el("th", { text: column.label })))),
    el(
      "tbody",
      {},
      ...(report.rows.length
        ? report.rows.map((row, index) =>
            el(
              "tr",
              {},
              el("td", { class: "num", text: formatNumber(index + 1) }),
              ...report.columns.map((column) => {
                const value = row[column.key];
                return el("td", { class: typeof value === "number" ? "num" : "", text: typeof value === "number" ? formatNumber(value) : String(value ?? "—") });
              }),
            ),
          )
        : [el("tr", {}, el("td", { colspan: String(report.columns.length + 1), class: "empty-inline", text: "لا توجد بيانات مطابقة للفترة المحددة." }))]),
    ),
  );

  reportHost.replaceChildren(
    printHead,
    summaryStrip((report.summary ?? []).map((item, index) => ({ label: item.label, value: item.value, tone: ["blue", "green", "orange", "purple"][index % 4], iconName: "activity" }))),
    el("div", { class: "card table-card" }, el("div", { class: "table-wrap" }, table)),
    el("p", { class: "report-footprint", text: `${report.company?.name || ""} · ${report.company?.printFooter || ""}` }),
  );
}
