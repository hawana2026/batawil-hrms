import {
  api,
  el,
  errorBlock,
  formatFullDay,
  formatNumber,
  icon,
  loadingBlock,
  pageHeader,
  toast,
} from "../core.js";
import { state } from "../state.js";
import { friendlyError, pageEnter } from "../ui.js";
import {
  ATT_ORDER,
  ATT_STATUS,
  attTag,
  branchList,
  branchSelectOptions,
  downloadFile,
  filterBar,
  hashParams,
  navigateHash,
  personCell,
  printHeader,
  printPage,
  summaryStrip,
  todayISO,
} from "../hr-common.js";

export async function renderAttendanceReports(host, token) {
  const params = hashParams();
  const branches = branchList();
  if (!branches.length) {
    host.replaceChildren(pageEnter(pageHeader({ title: "تقارير الحضور" }), el("div", { class: "card" }, el("div", { class: "empty-inline", text: "لا توجد فروع متاحة." }))));
    return;
  }
  const branchId = branches.some((b) => b.id === params.get("branch")) ? params.get("branch") : branches.find((b) => b.active)?.id ?? branches[0].id;
  const date = params.get("date") || todayISO();
  const status = params.get("status") || "all";
  const searchQuery = params.get("q") || "";
  host.replaceChildren(loadingBlock("جارٍ تحميل سجل الحضور…"));

  let data;
  try {
    data = await api(`/api/attendance/daily?branchId=${encodeURIComponent(branchId)}&date=${encodeURIComponent(date)}`);
  } catch (error) {
    if (token !== state.renderToken) return;
    host.replaceChildren(errorBlock(friendlyError(error), () => renderAttendanceReports(host, token)));
    return;
  }
  if (token !== state.renderToken) return;

  const branchSelect = el("select", { class: "select" }, ...branchSelectOptions(branchId));
  const dateInput = el("input", { class: "input", type: "date", value: date, max: data.today });
  const statusSelect = el(
    "select",
    { class: "select" },
    el("option", { value: "all", selected: status === "all" }, "كل الحالات"),
    ...ATT_ORDER.map((code) => el("option", { value: code, selected: code === status }, ATT_STATUS[code].label)),
  );
  const search = el("input", { class: "input", type: "search", value: searchQuery, placeholder: "اسم الموظف أو الرقم الوظيفي…" });
  const filters = filterBar(
    [
      { label: "الفرع", control: branchSelect },
      { label: "التاريخ", control: dateInput },
      { label: "الحالة", control: statusSelect },
      { label: "بحث", control: search },
    ],
    {
      onApply: () =>
        navigateHash("attendance-reports", {
          branch: branchSelect.value,
          date: dateInput.value,
          status: statusSelect.value,
          q: search.value.trim(),
        }),
      onReset: () => navigateHash("attendance-reports", {}),
    },
  );

  const rows = (data.rows || []).filter((row) => {
    if (status !== "all" && row.status !== status) return false;
    if (searchQuery) {
      const haystack = `${row.fullName || ""} ${row.manualName || ""} ${row.employeeNo || ""}`.toLowerCase();
      if (!haystack.includes(searchQuery.toLowerCase())) return false;
    }
    return true;
  });

  const header = pageHeader({
    title: "بحث وتقارير الحضور",
    subtitle: `${data.branch.name} · ${formatFullDay(`${date}T00:00:00`)} — بحث فوري في كشف اليوم مع روابط التقارير التحليلية.`,
    actions: [
      el("button", { class: "btn btn-secondary", type: "button", onclick: () => printPage({ landscape: true }) }, icon("printer"), "طباعة"),
      el("button", {
        class: "btn btn-ghost",
        type: "button",
        onclick: async (event) => {
          try {
            await downloadFile(`/api/attendance/daily/export.xlsx?branchId=${encodeURIComponent(branchId)}&date=${encodeURIComponent(date)}`, `attendance-${date}.xlsx`);
          } catch (error) {
            toast(error.message, "error");
            event.currentTarget.disabled = false;
          }
        },
      }, icon("download"), "Excel"),
    ],
  });

  const table = el(
    "table",
    { class: "att-table" },
    el("thead", {}, el("tr", {}, ...["الموظف", "الرقم الوظيفي", "القسم", "الحالة", "الحضور", "الانصراف", "التأخير", "ساعات العمل", "السبب", "ملاحظات"].map((label) => el("th", { text: label })))),
    el(
      "tbody",
      {},
      ...(rows.length
        ? rows.map((row) =>
            el(
              "tr",
              { class: row.status === "absent" ? "row-absent" : "" },
              el("td", {}, personCell(row.fullName || row.manualName || "—", "", row.employeeNo || "")),
              el("td", {}, el("span", { class: "code-chip", text: row.employeeNo || "—" })),
              el("td", { class: "tiny", text: row.departmentName || "—" }),
              el("td", {}, attTag(row.status)),
              el("td", { class: "num nowrap", text: row.checkIn || "—" }),
              el("td", { class: "num nowrap", text: row.checkOut || "—" }),
              el("td", { class: "num", text: row.lateMinutes ? `${formatNumber(row.lateMinutes)} د` : "—" }),
              el("td", { class: "num", text: row.workHours ? formatNumber(row.workHours) : "—" }),
              el("td", { class: "tiny", text: row.reason || "—" }),
              el("td", { class: "tiny", text: row.notes || "—" }),
            ),
          )
        : [el("tr", {}, el("td", { colspan: "10", class: "empty-inline", text: "لا توجد صفوف مطابقة." }))]),
    ),
  );

  const counts = {};
  for (const row of data.rows || []) counts[row.status] = (counts[row.status] || 0) + 1;

  host.replaceChildren(
    pageEnter(
      header,
      filters,
      printHeader({ title: `سجل حضور — ${data.branch.name}`, subtitle: formatFullDay(`${date}T00:00:00`), meta: [`الفرع: ${data.branch.name}`, `التاريخ: ${date}`, `عدد الصفوف: ${rows.length}`] }),
      summaryStrip([
        { label: "صفوف معروضة", value: rows.length, tone: "blue", iconName: "users" },
        { label: "حاضر", value: counts.present ?? 0, tone: "green", iconName: "user-check" },
        { label: "غائب", value: counts.absent ?? 0, tone: "red", iconName: "circle-x" },
        { label: "تأخير", value: counts.late ?? 0, tone: "orange", iconName: "clock" },
        { label: "إجازة", value: counts.leave ?? 0, tone: "purple", iconName: "calendar" },
      ]),
      el("div", { class: "card table-card" }, el("div", { class: "table-wrap" }, table)),
      el(
        "div",
        { class: "section-card card" },
        el("div", { class: "section-head" }, el("div", {}, el("h3", { class: "section-title" }, icon("file-text"), "تقارير تحليلية جاهزة"), el("p", { class: "tiny muted", text: "تُحسب من الكشوف المرسلة والمعتمدة فقط." }))),
        el(
          "div",
          { class: "report-links" },
          link("daily-absent", "الغياب اليومي", "circle-x", { date, branch: branchId }),
          link("monthly-absent", "الغياب الشهري", "calendar-range", { year: date.slice(0, 4), month: Number(date.slice(5, 7)), branch: branchId }),
          link("lateness", "تقرير التأخير", "clock", { year: date.slice(0, 4), month: Number(date.slice(5, 7)), branch: branchId }),
          link("most-absent", "الأكثر غياباً", "alert-triangle", { year: date.slice(0, 4), month: Number(date.slice(5, 7)), branch: branchId }),
          link("workdays", "أيام العمل", "calendar-check", { year: date.slice(0, 4), month: Number(date.slice(5, 7)), branch: branchId }),
          link("branch-comparison", "مقارنة الفروع", "building", { year: date.slice(0, 4), month: Number(date.slice(5, 7)) }),
        ),
      ),
    ),
  );
}

function link(type, label, iconName, params) {
  return el(
    "button",
    { class: "report-link", type: "button", onclick: () => navigateHash("reports", { type, ...params }) },
    icon(iconName),
    el("span", { text: label }),
    icon("chevron-left"),
  );
}
